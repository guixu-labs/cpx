// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// OpenAI Responses API 协议全链路旅程（codex 通道）：真 cpx-cli（--agent codex）
// → 真 proxy → 假 codex agent（从 -c openai_base_url 反解注入）→ 桩上游
// /v1/responses SSE → codex-emitter → claude-jsonl 捕获。锁三层：
//   ① 注入面：ChatGPT 登录分支——-c openai_base_url="<proxy>/v1" 进 argv
//      （HOME 隔离使 codexProviderTable 为空、OPENAI_API_KEY 剥净）
//   ② 路由面：responses 协议无 sid 头 → 捕获落 cpx 钉定文件
//   ③ 转换面：reasoning_summary + output_text + function_call 三态块重组、
//      usage（cached/reasoning tokens）映射、消费契约哨兵
// （openai chat 协议旅程已由 cpx-reasoning-capture.e2e 覆盖，本仓不重复。）

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { startUpstreamStub, sseBody, type UpstreamStub } from './harness/upstream-stub';
import { codexAgent } from './harness/fake-agent';
import { readCaptureLines, assertClaudeJsonlContract } from './harness/capture';
import { runCpx, readSidDump } from './harness/session';
import { ENV } from './harness/constants';

let sandbox: Sandbox;
let stub: UpstreamStub;

beforeAll(async () => {
  sandbox = createSandbox('cpx-wire-responses-');
  stub = await startUpstreamStub();
});

afterAll(() => {
  sandbox.cleanup();
  return stub.close();
});

const RESPONSES_EVENTS = [
  { type: 'response.created', response: { model: 'deepseek-v4-pro' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '先分析' },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '任务' },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant' } },
  { type: 'response.output_text.delta', output_index: 1, delta: 'responses wire ' },
  { type: 'response.output_text.delta', output_index: 1, delta: 'answer' },
  { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', name: 'bash', call_id: 'call_e2e_r1' } },
  { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"command":"ls"}' },
  { type: 'response.completed', response: { model: 'deepseek-v4-pro', status: 'completed', usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 12 } } } },
];

describe('cpx responses 协议全链路（--agent codex → /v1/responses → claude-jsonl）', () => {
  it('流式旅程：注入面 + 钉定路由 + thinking/text/tool_use 三态块 + usage 映射', async () => {
    // 桩路由键是 /responses 而非 /v1/responses：proxy 转发时剥 /v1 前缀，
    // 还原 codex 直连 base + /responses 的字节形态（server.ts 契约）
    stub.script('/responses', { kind: 'sse', text: sseBody(RESPONSES_EVENTS) });
    const agent = codexAgent(sandbox, {
      body: {
        model: 'deepseek-v4-pro',
        instructions: 'You are an e2e codex agent.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi responses wire' }] }],
        stream: true,
      },
    });

    const r = await runCpx(sandbox, ['--agent', 'codex', agent.path], {
      env: { [ENV.RESPONSES_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    // ② 路由面：responses 无 sid 头 → 捕获落 cpx 钉定文件（CPX_SESSION_ID）
    const pinned = readSidDump(sandbox, 'fake-codex');
    expect(pinned, 'agent did not receive CPX_SESSION_ID').not.toBe('MISSING');
    const lines = readCaptureLines(sandbox, pinned);
    assertClaudeJsonlContract(lines);

    // ③ 转换面：input items → user 行
    const user = lines.find((l) => l.type === 'user');
    expect(user, 'user line missing').toBeDefined();
    expect(user!.source).toBe('codex-proxy');
    expect(JSON.stringify(user!.message)).toContain('hi responses wire');

    // ③ 转换面：响应 → assistant 行（thinking + text + tool_use 三态块）
    const asst = lines.find((l) => l.type === 'assistant');
    expect(asst, 'assistant line missing').toBeDefined();
    expect(asst!.source).toBe('codex-proxy');
    const msg = asst!.message as { model: string; content: Array<Record<string, unknown>>; usage: Record<string, number> };
    expect(msg.model).toBe('deepseek-v4-pro');
    expect(msg.content.map((c) => c.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(msg.content[0]).toEqual({ type: 'thinking', thinking: '先分析任务' });
    expect(msg.content[1]).toEqual({ type: 'text', text: 'responses wire answer' });
    expect(msg.content[2]).toMatchObject({ type: 'tool_use', id: 'call_e2e_r1', name: 'bash', input: { command: 'ls' } });
    expect(msg.usage).toMatchObject({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, reasoning_tokens: 12 });
    const xl = asst!.x_lake as { schema: string; data: { roundIndex: number; stopReason?: string; status?: string } };
    expect(xl.schema).toBe('cc-wire-round');
    expect(xl.data.roundIndex).toBe(0);
    // codex 通道无 legacy 顶层 stopReason——声明式权威源在 x_lake（读方 x_lake 优先）
    expect(xl.data.stopReason).toBe('completed');
    expect(xl.data.status).toBe(200);

    // 会话级声明：cc-session-meta（codex 框架锚）
    const meta = JSON.parse(fs.readFileSync(`${sandbox.captures}/cpx-${pinned}.meta.json`, 'utf8'));
    expect(meta.x_lake.data).toMatchObject({ producer: 'cpx', framework: 'codex', protocol: 'responses' });
  }, 120_000);
});
