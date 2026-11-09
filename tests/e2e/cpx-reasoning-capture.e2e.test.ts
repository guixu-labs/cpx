// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// DeepSeek 思考流捕获 E2E IT（真行为锁）：现场 ses_f4da12dc —— cpx 件 vs
// opencode native 件按 tool_use id 对齐，109/182 轮 assistant 的 <thinking>
// 整块丢失（DeepSeek 系网关思考走 delta.reasoning_content 独立字段，旧
// OpenAIReassembler 只收 delta.content/tool_calls → 捕获件只剩工具调用，
// insight 查看大量 turn 没有 LLM Output）。单测锁重组器纯函数，本 IT 锁
// 全链路：真 cpx-cli → 真 proxy → mock 网关 SSE 思考流 → 重组 → emitter →
// 捕获 jsonl 落盘（防"单测过、链路丢"）。
// （openai chat 协议的旅程级代表——harness 三件套：sandbox / upstream-stub /
//  fake-agent；本用例即收编自 ad-hoc 形态的模板原型。）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { startUpstreamStub, sseBody, type UpstreamStub } from './harness/upstream-stub';
import { openaiAgent } from './harness/fake-agent';
import { readCaptureLines, assertClaudeJsonlContract } from './harness/capture';
import { runCpx, readSidDump } from './harness/session';
import { ENV, ROUTES } from './harness/constants';

let sandbox: Sandbox;
let stub: UpstreamStub;

// mock 网关：/v1/chat/completions → DeepSeek 形态 SSE（思考 → 工具 → 计费
// usage 含 completion_tokens_details.reasoning_tokens —— 与现场网关同构）
const SSE_EVENTS = [
  { id: 'cmpl-e2e-rsn', model: 'deepseek-v4-pro', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '让我先想想' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { reasoning_content: '再确认一下' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_e2e_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 4 } } },
];

beforeAll(async () => {
  sandbox = createSandbox('cpx-reasoning-e2e-');
  stub = await startUpstreamStub();
  stub.script(ROUTES.openai, { kind: 'sse', text: sseBody(SSE_EVENTS, { openAIDone: true }) });
});

afterAll(() => {
  sandbox.cleanup();
  return stub.close();
});

describe('cpx DeepSeek 思考流捕获 E2E（reasoning_content → thinking 块全链路）', () => {
  it('捕获 jsonl：thinking 块置首 + tool_use + reasoning tokens 双通道', async () => {
    // 假 agent（generic profile：OPENAI_BASE_URL 直注入；不带 sid 头 →
    // 捕获落 cpx 钉定文件）
    const agent = openaiAgent(sandbox, {
      body: { model: 'deepseek-v4-pro', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    const r = await runCpx(sandbox, [agent.path], {
      env: { [ENV.OPENAI_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    const sid = readSidDump(sandbox, 'fake-openai');
    expect(sid, 'agent did not receive CPX_SESSION_ID').not.toBe('MISSING');
    const lines = readCaptureLines(sandbox, sid);
    // 契约哨兵：insight 零改动消费（每行可解析 + 形状齐备 + x_lake 声明）
    assertClaudeJsonlContract(lines);

    // user 轮落盘（wire 输入 delta 发射）
    expect(lines.some(l => l.type === 'user' && JSON.stringify((l.message as { content?: unknown })?.content).includes('hi'))).toBe(true);

    const asst = lines.find(l => l.type === 'assistant') as Record<string, any> | undefined;
    expect(asst, 'assistant line missing').toBeDefined();
    expect(asst!.source).toBe('opencode-proxy');
    expect(asst!.message.model).toBe('deepseek-v4-pro');
    // thinking 块置首 + 工具调用（修复前：content 只剩 tool_use，LLM Output 空）
    expect(asst!.message.content[0]).toEqual({ type: 'thinking', thinking: '让我先想想再确认一下' });
    expect(asst!.message.content[1]).toMatchObject({ type: 'tool_use', id: 'call_e2e_1', name: 'bash' });
    // usage：openai 网关计费字段全量映射（含思考 token）
    expect(asst!.message.usage).toMatchObject({ input_tokens: 11, output_tokens: 6, cache_read_input_tokens: 2, reasoning_tokens: 4 });
    // 声明式通道：insight claude-jsonl 既有 reasoningTokens 读取
    expect(asst!.x_lake.schema).toBe('cc-wire-round');
    expect(asst!.x_lake.version).toBe(1);
    expect(asst!.x_lake.data.reasoningTokens).toBe(4);
    // 思考首 token 即计时起点（ttftMs 存在而非 null）
    expect(typeof asst!.ttftMs).toBe('number');
  }, 120_000);
});
