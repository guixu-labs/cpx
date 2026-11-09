// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Anthropic Messages 协议全链路旅程（本套件最大的覆盖缺口——claude 是旗舰
// agent，anthropic 却只有单测没有旅程）：真 cpx-cli（--agent claude）→ 真
// proxy → 假 agent（从 --settings 反解注入的 ANTHROPIC_BASE_URL）→ 桩上游
// SSE → claude-emitter → claude-jsonl 捕获。锁四层契约：
//   ① 注入面：--settings 只影响本进程（agent 从 argv 拿到 base URL）
//   ② 路由面：sid 头路由——捕获文件按 x-claude-code-session-id 命名
//      （≠ cpx 钉定 sid，钉定占位被清）
//   ③ 转换面：SSE → claude-format 行（text+tool_use 双块、usage 全量映射、
//      ttft/duration 计时、system/tools 逐字随行）
//   ④ 消费面：claude-jsonl 契约哨兵（insight 零改动消费的产品承诺）
// 第二用例锁非流路径（stream:false 一次性 JSON 应答）。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { startUpstreamStub, sseBody, type UpstreamStub } from './harness/upstream-stub';
import { claudeAgent } from './harness/fake-agent';
import { readCaptureLines, captureFile, assertClaudeJsonlContract } from './harness/capture';
import { runCpx, readSidDump } from './harness/session';
import { ENV, ROUTES } from './harness/constants';

const SID = 'e2e-claude-wire-01';
const SID_NONSTREAM = 'e2e-claude-wire-02';

let sandbox: Sandbox;
let stub: UpstreamStub;

beforeAll(async () => {
  sandbox = createSandbox('cpx-wire-anthropic-');
  stub = await startUpstreamStub();
});

afterAll(() => {
  sandbox.cleanup();
  return stub.close();
});

const TOOLS = [{
  name: 'Read',
  description: 'read a file',
  input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
}];

const STREAM_EVENTS = [
  { type: 'message_start', message: { model: 'claude-opus-x', usage: { input_tokens: 12, cache_read_input_tokens: 3 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'wire' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_e2e_1', name: 'Read' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/e2e' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '.txt"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
];

describe('cpx anthropic 协议全链路（--agent claude → /v1/messages → claude-jsonl）', () => {
  it('流式旅程：SSE text+tool_use → 捕获行形状 + sid 头路由 + 契约哨兵', async () => {
    stub.script(ROUTES.anthropic, { kind: 'sse', text: sseBody(STREAM_EVENTS) });
    const agent = claudeAgent(sandbox, {
      sid: SID,
      body: {
        model: 'claude-opus-x',
        max_tokens: 64,
        stream: true,
        system: 'You are a helpful e2e agent.',
        messages: [{ role: 'user', content: '你好 wire journey' }],
        tools: TOOLS,
      },
    });

    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    // ② 路由面：头 sid 命名捕获文件；钉定 sid 的占位文件被清（无头流量）
    const pinned = readSidDump(sandbox, 'fake-claude');
    expect(pinned, 'agent did not receive CPX_SESSION_ID').not.toBe('MISSING');
    expect(fs.existsSync(captureFile(sandbox, SID)), `capture for header sid ${SID}`).toBe(true);
    expect(fs.existsSync(`${sandbox.captures}/cpx-${pinned}.jsonl`), 'pinned placeholder must be dropped').toBe(false);

    // ④ 消费面：契约哨兵（每行可解析 + 形状齐备 + x_lake 声明信封）
    const lines = readCaptureLines(sandbox, SID);
    assertClaudeJsonlContract(lines);

    // ③ 转换面：user 行（wire 输入）+ assistant 行（重组输出）
    const user = lines.find((l) => l.type === 'user');
    expect(user, 'user line missing').toBeDefined();
    expect(JSON.stringify(user!.message)).toContain('你好 wire journey');

    const asst = lines.find((l) => l.type === 'assistant');
    expect(asst, 'assistant line missing').toBeDefined();
    expect(asst!.source).toBe('claude-proxy');
    const msg = asst!.message as { model: string; content: Array<Record<string, unknown>>; usage: Record<string, number> };
    expect(msg.model).toBe('claude-opus-x');
    expect(msg.content[0]).toEqual({ type: 'text', text: 'Hello wire' });
    expect(msg.content[1]).toMatchObject({ type: 'tool_use', id: 'toolu_e2e_1', name: 'Read', input: { file_path: '/tmp/e2e.txt' } });
    expect(msg.usage).toMatchObject({ input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 3 });
    expect(asst!.stopReason).toBe('tool_use');
    expect(typeof asst!.duration_ms).toBe('number');
    expect(typeof asst!.ttftMs).toBe('number');
    // system/tools 逐字随行（Full Context 消费面）
    expect(JSON.stringify(asst!.system)).toContain('helpful e2e agent');
    expect(JSON.stringify(asst!.tools)).toContain('Read');
    const xl = asst!.x_lake as { schema: string; data: { protocol: string; roundIndex: number; ttftMs: number } };
    expect(xl.schema).toBe('cc-wire-round');
    expect(xl.data.protocol).toBe('anthropic');
    expect(xl.data.roundIndex).toBe(0);
    expect(typeof xl.data.ttftMs).toBe('number');

    // 会话级声明：cc-session-meta（framework/protocol 双向锚）
    const meta = JSON.parse(fs.readFileSync(`${sandbox.captures}/cpx-${SID}.meta.json`, 'utf8'));
    expect(meta.x_lake.schema).toBe('cc-session-meta');
    expect(meta.x_lake.data).toMatchObject({ producer: 'cpx', framework: 'claude-code', protocol: 'anthropic', sid: SID });
  }, 120_000);

  it('非流旅程：stream:false 一次性 JSON → 同一捕获契约', async () => {
    stub.script(ROUTES.anthropic, {
      kind: 'json',
      body: {
        id: 'msg_e2e_nonstream',
        model: 'claude-opus-x',
        content: [{ type: 'text', text: 'plain json answer' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 7, output_tokens: 2 },
      },
    });
    const agent = claudeAgent(sandbox, {
      sid: SID_NONSTREAM,
      body: {
        model: 'claude-opus-x',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'nonstream hi' }],
      },
    });

    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    const lines = readCaptureLines(sandbox, SID_NONSTREAM);
    assertClaudeJsonlContract(lines);
    const asst = lines.find((l) => l.type === 'assistant');
    expect(asst, 'assistant line missing').toBeDefined();
    const msg = asst!.message as { content: Array<Record<string, unknown>>; usage: Record<string, number> };
    expect(msg.content[0]).toEqual({ type: 'text', text: 'plain json answer' });
    expect(msg.usage).toMatchObject({ input_tokens: 7, output_tokens: 2 });
    expect(asst!.stopReason).toBe('end_turn');
  }, 120_000);
});
