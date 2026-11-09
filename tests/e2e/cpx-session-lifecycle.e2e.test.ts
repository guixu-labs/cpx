// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 会话生命周期收尾旅程（cpx-cli 退出链整链一次锁——insight「播种即冒烟」
// 的 cpx 镜像：捕获的出口价值 = 退出后的归档 + 自动导入，链上任何一环
// 断裂都让「捕获」白干）：
//   ① .sids manifest：proxy 头路由写入的 sid 清单被 cpx-cli 消费后删除
//   ② 钉定占位清理：流量全走头 sid 时，pinned 占位文件（含压缩态）不留
//   ③ at-rest 压缩：明文 .jsonl → .jsonl.7z（明文删除）+ meta 打 governed
//      标记（字节流已过落盘入口 redactor，lake 上行走直传快路径）
//   ④ insight 自动导入：mock insight 双端点（probe /api/observe/data →
//      POST /api/ingest/import-file）对账——source=claude-jsonl、
//      sessionId=头 sid、filePath=压缩态路径；导入成功不弹浏览器
//      （CONTEXT_NO_BROWSER 熔断，本用例顺带锁该副作用）
// mock 而非真 insight：跨仓耦合不属于本仓单层真栈纪律（insight 侧的
// claude-jsonl 消费另有其测）；本用例锁的是 cpx 侧的请求契约。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { startUpstreamStub, sseBody, type UpstreamStub } from './harness/upstream-stub';
import { claudeAgent } from './harness/fake-agent';
import { readCaptureLines, assertClaudeJsonlContract } from './harness/capture';
import { runCpx, readSidDump } from './harness/session';
import { ENV, ROUTES } from './harness/constants';

const SID = 'e2e-lifecycle-01';

interface ImportCall { source: string; sessionId: string; filePath: string }

let sandbox: Sandbox;
let stub: UpstreamStub;
let insight: http.Server;
let insightUrl = '';
let imports: ImportCall[] = [];

beforeAll(async () => {
  sandbox = createSandbox('cpx-lifecycle-');
  stub = await startUpstreamStub();

  // mock insight：probe 端点 + 导入端点（契约对账台账）
  imports = [];
  insight = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url.startsWith('/api/observe/data')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.method === 'POST' && url === '/api/ingest/import-file') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        imports.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ imported: true, query: 'e2e-mock-import' }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => insight.listen(0, '127.0.0.1', r));
  insightUrl = `http://127.0.0.1:${(insight.address() as AddressInfo).port}`;
});

afterAll(() => {
  sandbox.cleanup();
  void stub.close();
  return new Promise<void>((r) => insight.close(() => r()));
});

describe('cpx 会话生命周期收尾（manifest → 占位清理 → 7z at-rest → 自动导入）', () => {
  it('退出链整链：压缩归档 + governed 标记 + mock insight 导入契约', async () => {
    stub.script(ROUTES.anthropic, {
      kind: 'sse',
      text: sseBody([
        { type: 'message_start', message: { model: 'claude-opus-x', usage: { input_tokens: 4 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lifecycle done' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]),
    });
    const agent = claudeAgent(sandbox, {
      sid: SID,
      body: {
        model: 'claude-opus-x',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'lifecycle journey' }],
      },
    });

    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: {
        [ENV.ANTHROPIC_UPSTREAM]: stub.url,
        // 沙箱默认钉不可达；本用例显式指向 mock insight（被测的自动导入链）
        [ENV.INSIGHT_BASE]: insightUrl,
      },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    const stem = `${sandbox.captures}/cpx-${SID}`;
    const pinned = readSidDump(sandbox, 'fake-claude');
    expect(pinned).not.toBe('MISSING');

    // ③ at-rest 压缩：.jsonl.7z 在、明文 .jsonl 删
    expect(fs.existsSync(`${stem}.jsonl.7z`), 'capture must be compressed to .jsonl.7z at rest').toBe(true);
    expect(fs.existsSync(`${stem}.jsonl`), 'plaintext .jsonl must be removed after compression').toBe(false);

    // ① manifest 消费后删除（键是钉定 sid）
    expect(fs.existsSync(`${sandbox.captures}/cpx-${pinned}.sids`), '.sids manifest must be consumed and removed').toBe(false);

    // ② 钉定占位清理：头路由流量不落 pinned → 三形态全清
    for (const ext of ['.jsonl', '.jsonl.7z', '.jsonl.gz']) {
      expect(fs.existsSync(`${sandbox.captures}/cpx-${pinned}${ext}`), `pinned placeholder ${ext} must be dropped`).toBe(false);
    }

    // ③ governed 标记（redactor 已洗 → lake 直传快路径资格）
    const meta = JSON.parse(fs.readFileSync(`${stem}.meta.json`, 'utf8'));
    expect(meta.x_lake.schema).toBe('cc-session-meta');
    expect(meta.x_lake.data.governed).toBe(true);

    // 压缩态可透明消费（readCaptureText 三形态解压 → 契约哨兵仍成立）
    const lines = readCaptureLines(sandbox, SID);
    assertClaudeJsonlContract(lines);
    const asst = lines.find((l) => l.type === 'assistant');
    expect(asst, 'assistant line missing').toBeDefined();

    // ④ 自动导入契约：source / sessionId（头 sid 非 pinned）/ filePath（压缩态）
    expect(imports.length, 'mock insight must receive exactly one import').toBe(1);
    expect(imports[0]).toEqual({
      source: 'claude-jsonl',
      sessionId: SID,
      filePath: `${stem}.jsonl.7z`,
    });
  }, 120_000);
});
