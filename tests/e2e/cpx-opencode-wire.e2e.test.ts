// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// opencode provider 隧道全链路（既有 custom/provider 系列 spec 只锁注入面，
// 本 spec 补齐「注入 → 隧道路由 → 透传 → 捕获」的完整旅程）：
//   ① 注入反解：agent 从 OPENCODE_CONFIG_CONTENT 取 gateway 的 baseURL
//      （proxy/<pid>/ 前缀）→ POST /<pid>/chat/completions
//   ② 隧道路由：proxy 剥 /<pid>/ 前缀转发 PROVIDER_UPSTREAMS[pid]——上游
//      台账的 path 必须是 /chat/completions（前缀零残留）
//   ③ 捕获面：x-session-id 头路由 → cpx-<sid>.jsonl，source=opencode-proxy
//   ④ cannbot UA 分流：同一 openai wire，仅 User-Agent=cannbot/<ver> 之差
//      → framework=cannbot + source=cannbot-proxy + ccVersion（行级 source
//      是 insight 泳道图的框架判定源——协议≠框架）

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { startUpstreamStub, sseBody, type UpstreamStub } from './harness/upstream-stub';
import { protocolAgent } from './harness/fake-agent';
import { readCaptureLines, captureFile, assertClaudeJsonlContract } from './harness/capture';
import { runCpx, readAgentResponse } from './harness/session';


let sandbox: Sandbox;
let stub: UpstreamStub;

beforeAll(async () => {
  sandbox = createSandbox('cpx-opencode-wire-');
  stub = await startUpstreamStub();
  // 用户配置：自定义 gateway provider——baseURL 直接指向桩（PROVIDER_UPSTREAMS
  // 从配置本体解析，故隧道真实上游即桩）
  fs.mkdirSync(path.join(sandbox.config, 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(sandbox.config, 'opencode', 'opencode.jsonc'), JSON.stringify({
    provider: {
      gateway: {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: stub.url, apiKey: 'k-e2e-gw-000000' },
        models: { 'model-a1': { name: 'Model A1' } },
      },
    },
  }, null, 2));
  fs.mkdirSync(path.join(sandbox.data, 'opencode'), { recursive: true });
  fs.mkdirSync(path.join(sandbox.cache, 'opencode'), { recursive: true });
});

afterAll(() => {
  sandbox.cleanup();
  return stub.close();
});

const SSE_TEXT = sseBody([
  { id: 'cmpl-ocwire', model: 'model-a1', choices: [{ index: 0, delta: { role: 'assistant', content: 'tunnel answer' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } },
], { openAIDone: true });

function launchEnv(): Record<string, string> {
  return {
    XDG_CONFIG_HOME: sandbox.config,
    XDG_DATA_HOME: sandbox.data,
    XDG_CACHE_HOME: sandbox.cache,
  };
}

describe('cpx opencode provider 隧道全链路（注入反解 → 前缀路由 → 透传 → 捕获）', () => {
  it('① opencode：gateway 隧道剥前缀直达上游，捕获按 x-session-id 落盘', async () => {
    // 桩路由键是 /chat/completions：配置 baseURL 无 /v1 前缀，隧道剥
    // /gateway/ 后转发 = stub + /chat/completions（前缀零残留的实证面）
    stub.script('/chat/completions', { kind: 'sse', text: SSE_TEXT });
    const agent = protocolAgent(sandbox, {
      mode: 'opencode-config',
      name: 'fake-ocwire',
      requests: [
        { sid: 'e2e-ocwire-main', body: { model: 'model-a1', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'opencode 隧道提问' }] } },
      ],
    });

    const r = await runCpx(sandbox, ['--agent', 'opencode', '--', agent.path], { env: launchEnv() });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    // ── 上游台账：前缀零残留（/<pid>/ 剥净），body 原样到达 ─────────
    const hits = stub.requests.filter((q) => q.path.includes('/chat/completions'));
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('/chat/completions');
    expect(hits[0].body).toContain('opencode 隧道提问');

    // ── agent 侧：tee 零干预（收到 == 桩发出）─────────────────────
    expect(readAgentResponse(sandbox, 'fake-ocwire')).toBe(`=== HTTP 200\n${SSE_TEXT}\n`);

    // ── 捕获面：x-session-id 头路由 + opencode-proxy 标记 ───────────
    const lines = readCaptureLines(sandbox, 'e2e-ocwire-main');
    assertClaudeJsonlContract(lines);
    expect(JSON.stringify(lines)).toContain('opencode 隧道提问');
    expect(JSON.stringify(lines)).toContain('tunnel answer');
    expect((lines.find((l) => l.type === 'user') as { source: string }).source).toBe('opencode-proxy');
    const metaPath = captureFile(sandbox, 'e2e-ocwire-main').replace(/\.jsonl(\.7z|\.gz)?$/, '.meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { x_lake: { schema: string; data: { framework: string; protocol: string; ccVersion?: string } } };
    expect(meta.x_lake.data.framework).toBe('opencode');
    expect(meta.x_lake.data.protocol).toBe('openai');
    expect(meta.x_lake.data.ccVersion).toBeUndefined();
  }, 120_000);

  it('② cannbot UA 分流：同 wire 同协议，User-Agent 之差 → framework=cannbot + ccVersion', async () => {
    stub.script('/chat/completions', { kind: 'sse', text: SSE_TEXT });
    const agent = protocolAgent(sandbox, {
      mode: 'opencode-config',
      name: 'fake-ocwire-cb',
      requests: [
        {
          sid: 'e2e-ocwire-cb',
          headers: { 'user-agent': 'cannbot/1.2.3' },
          body: { model: 'model-a1', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'cannbot 隧道提问' }] },
        },
      ],
    });

    const r = await runCpx(sandbox, ['--agent', 'opencode', '--', agent.path], { env: launchEnv() });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    const lines = readCaptureLines(sandbox, 'e2e-ocwire-cb');
    assertClaudeJsonlContract(lines);
    // 行级 source 与 meta framework 都随 UA 分流（协议仍是 openai——协议≠框架）
    expect((lines.find((l) => l.type === 'user') as { source: string }).source).toBe('cannbot-proxy');
    const metaPath = captureFile(sandbox, 'e2e-ocwire-cb').replace(/\.jsonl(\.7z|\.gz)?$/, '.meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { x_lake: { schema: string; data: { framework: string; protocol: string; ccVersion?: string } } };
    expect(meta.x_lake.data.framework).toBe('cannbot');
    expect(meta.x_lake.data.protocol).toBe('openai');
    expect(meta.x_lake.data.ccVersion).toBe('1.2.3');
  }, 120_000);
});
