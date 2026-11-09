// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 对话连续性旅程（单轮 spec 之外的会话级语义——真实 agent 是多轮、会滚
// 动会话、会重复注入、会发 title-gen 噪声的四类形态）：
//   ① 多轮增量：每轮重发全量历史（含 assistant 回显）——只发增量 user，
//      assistant 回显绝不重复落盘，roundIndex 随轮递增
//   ② /resume 侧滚动：中途换 x-claude-code-session-id → 自然滚出新捕获
//      文件（双文件并存，manifest 双 sid）
//   ③ 注入去重：agent 注册表/skills 清单逐轮 byte 级重发 → 第二轮起发
//      [已压缩] 占位（deduped/originalChars/fingerprint），全文只落一次
//   ④ title-gen 跳过：claude 的标题生成请求（system 含特征串）零捕获

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { startUpstreamStub, sseBody, type UpstreamStub, type UpstreamScript } from './harness/upstream-stub';
import { protocolAgent } from './harness/fake-agent';
import { readCaptureLines, captureFile, assertClaudeJsonlContract } from './harness/capture';
import { runCpx, readSidDump } from './harness/session';
import { ENV, ROUTES } from './harness/constants';

let sandbox: Sandbox;
let stub: UpstreamStub;

beforeAll(async () => {
  sandbox = createSandbox('cpx-multi-round-');
  stub = await startUpstreamStub();
});

afterAll(() => {
  sandbox.cleanup();
  return stub.close();
});

/** anthropic 纯文本流式应答（各轮同构）。 */
function textResponse(text: string): UpstreamScript {
  return {
    kind: 'sse',
    text: sseBody([
      { type: 'message_start', message: { model: 'claude-opus-x', usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]),
  };
}

const INJECTION = 'Available agent types for the Agent tool: researcher, coder';

describe('cpx 对话连续性（多轮增量 / 会话滚动 / 注入去重 / title-gen 跳过）', () => {
  it('① 多轮增量：assistant 回显不重复落盘，roundIndex 递增', async () => {
    stub.scriptQueue(ROUTES.anthropic, [textResponse('第一轮回答'), textResponse('第二轮回答')]);
    const agent = protocolAgent(sandbox, {
      mode: 'claude',
      name: 'fake-mr-2rounds',
      requests: [
        {
          sid: 'e2e-mr-2rounds',
          body: { model: 'claude-opus-x', max_tokens: 32, stream: true, messages: [{ role: 'user', content: '第一轮问题' }] },
        },
        {
          sid: 'e2e-mr-2rounds',
          body: {
            model: 'claude-opus-x', max_tokens: 32, stream: true,
            messages: [
              { role: 'user', content: '第一轮问题' },
              { role: 'assistant', content: '第一轮回答' },
              { role: 'user', content: '第二轮问题' },
            ],
          },
        },
      ],
    });

    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    const lines = readCaptureLines(sandbox, 'e2e-mr-2rounds');
    assertClaudeJsonlContract(lines);
    const users = lines.filter((l) => l.type === 'user');
    expect(users.map((u) => (u.message as { content?: string }).content)).toEqual(['第一轮问题', '第二轮问题']);
    // assistant 回显绝不作为 user 行重复落盘
    expect(lines.filter((l) => JSON.stringify(l).includes('第一轮回答'))).toHaveLength(1);
    const assistants = lines.filter((l) => l.type === 'assistant');
    expect(assistants).toHaveLength(2);
    expect((assistants[0].x_lake as { data: { roundIndex: number } }).data.roundIndex).toBe(0);
    expect((assistants[1].x_lake as { data: { roundIndex: number } }).data.roundIndex).toBe(1);
  }, 120_000);

  it('② /resume 侧滚动：中途换 sid 头 → 双捕获文件并存', async () => {
    stub.scriptQueue(ROUTES.anthropic, [textResponse('会话A回答'), textResponse('会话B回答')]);
    const agent = protocolAgent(sandbox, {
      mode: 'claude',
      name: 'fake-mr-roll',
      requests: [
        { sid: 'e2e-mr-ses-a', body: { model: 'claude-opus-x', max_tokens: 32, stream: true, messages: [{ role: 'user', content: '会话A提问' }] } },
        { sid: 'e2e-mr-ses-b', body: { model: 'claude-opus-x', max_tokens: 32, stream: true, messages: [{ role: 'user', content: '会话B提问' }] } },
      ],
    });

    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    // 双文件并存（各自 1:1 对应 agent 原生会话——/resume 的产品语义）
    const linesA = readCaptureLines(sandbox, 'e2e-mr-ses-a');
    const linesB = readCaptureLines(sandbox, 'e2e-mr-ses-b');
    expect(JSON.stringify(linesA)).toContain('会话A提问');
    expect(JSON.stringify(linesA)).not.toContain('会话B提问');
    expect(JSON.stringify(linesB)).toContain('会话B提问');

    // 钉定占位清理（流量全走头路由）
    const pinned = readSidDump(sandbox, 'fake-mr-roll');
    expect(fs.existsSync(`${sandbox.captures}/cpx-${pinned}.jsonl`)).toBe(false);
    expect(fs.existsSync(`${sandbox.captures}/cpx-${pinned}.jsonl.7z`)).toBe(false);
  }, 120_000);

  it('③ 注入去重：byte 级重发的注册表注入 → [已压缩] 占位，全文只落一次', async () => {
    stub.scriptQueue(ROUTES.anthropic, [textResponse('去重轮1回答'), textResponse('去重轮2回答')]);
    const agent = protocolAgent(sandbox, {
      mode: 'claude',
      name: 'fake-mr-dedup',
      requests: [
        {
          sid: 'e2e-mr-dedup',
          body: { model: 'claude-opus-x', max_tokens: 32, stream: true, messages: [{ role: 'system', content: INJECTION }, { role: 'user', content: '去重轮1' }] },
        },
        {
          sid: 'e2e-mr-dedup',
          body: {
            model: 'claude-opus-x', max_tokens: 32, stream: true,
            messages: [
              { role: 'system', content: INJECTION },
              { role: 'user', content: '去重轮1' },
              { role: 'assistant', content: '去重轮1回答' },
              { role: 'user', content: '去重轮2' },
            ],
          },
        },
      ],
    });

    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: {
        [ENV.ANTHROPIC_UPSTREAM]: stub.url,
        // 测试显式 override（dedupEnabled 的最高层）：默认 off，本用例开
        CONTEXT_PROXY_DEDUP_INJECTION: '1',
      },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    const lines = readCaptureLines(sandbox, 'e2e-mr-dedup');
    assertClaudeJsonlContract(lines);
    // 注入全文只落一次（第一轮，kind=injection）
    const fullInjections = lines.filter((l) => JSON.stringify(l.message ?? {}).includes('Available agent types'));
    expect(fullInjections).toHaveLength(1);
    expect((fullInjections[0].x_lake as { data: { kind: string } }).data.kind).toBe('injection');
    // 第二轮的 byte 级重发 → 恰一个 [已压缩] 占位（deduped/originalChars/fingerprint）
    const markers = lines.filter((l) => l.deduped === true);
    expect(markers).toHaveLength(1);
    const markerMsg = markers[0].message as { content: Array<{ type: string; text: string }> };
    expect(markerMsg.content[0].text).toContain('[已压缩]');
    expect(markers[0].originalChars).toBe(INJECTION.length);
    const xl = markers[0].x_lake as { data: { kind: string; dedup: { originalChars: number; fingerprint: string } } };
    expect(xl.data.kind).toBe('dedup-placeholder');
    expect(xl.data.dedup.originalChars).toBe(INJECTION.length);
    expect(xl.data.dedup.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  }, 120_000);

  it('④ title-gen 跳过：标题生成请求零捕获（不留空文件）', async () => {
    stub.script(ROUTES.anthropic, {
      kind: 'json',
      body: { id: 'msg_titlegen', model: 'claude-haiku', content: [{ type: 'text', text: 'A Good Title' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const agent = protocolAgent(sandbox, {
      mode: 'claude',
      name: 'fake-mr-titlegen',
      requests: [
        {
          sid: 'e2e-mr-titlegen',
          body: {
            model: 'claude-haiku', max_tokens: 16,
            system: 'Generate a concise, sentence-case title for this conversation.',
            messages: [{ role: 'user', content: '帮我看看这个报错' }],
          },
        },
      ],
    });

    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    // 零捕获：无 cpx-<sid> 文件（三形态全无），钉定占位同被清理
    for (const ext of ['.jsonl', '.jsonl.7z', '.jsonl.gz']) {
      expect(fs.existsSync(`${sandbox.captures}/cpx-e2e-mr-titlegen${ext}`), `titlegen capture ${ext} must not exist`).toBe(false);
    }
    const pinned = readSidDump(sandbox, 'fake-mr-titlegen');
    expect(fs.existsSync(captureFile(sandbox, pinned))).toBe(false);
  }, 120_000);
});
