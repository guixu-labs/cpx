// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// opencode 子代理旅程（x-parent-session-id 声明式路由——与 claude 的
// system 标记路由相对的另一半形态）：
//   · 主会话请求带 x-session-id（openai 协议的 sid 头）
//   · 主响应 tool_calls 派发（task 工具族）→ taskDispatch 收集
//   · 子会话请求带自己的 x-session-id + x-parent-session-id → 落
//     <父sid>/subagents/<子x-session-id>.jsonl（resume-safe：以头声明的
//     真实父 id 归树，不依赖运行起点）
//   · 子 meta 回链派发（toolUseId/name/agentType——子首条 user 与派发
//     prompt 精确匹配）

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { startUpstreamStub, sseBody, type UpstreamStub, type UpstreamScript } from './harness/upstream-stub';
import { protocolAgent } from './harness/fake-agent';
import { readCaptureLines, captureFile, assertClaudeJsonlContract } from './harness/capture';
import { runCpx } from './harness/session';
import { ENV, ROUTES } from './harness/constants';

let sandbox: Sandbox;
let stub: UpstreamStub;

beforeAll(async () => {
  sandbox = createSandbox('cpx-subagent-openai-');
  stub = await startUpstreamStub();
});

afterAll(() => {
  sandbox.cleanup();
  return stub.close();
});

const MAIN_SID = 'e2e-opsub-main';
const CHILD_SID = 'e2e-opsub-child';
const TASK = '调研任务Y';

/** 主响应：task 工具派发（openai 流式 tool_calls 形态）。 */
function taskDispatchSse(): UpstreamScript {
  return {
    kind: 'sse',
    text: sseBody([
      { id: 'cmpl-opsub', model: 'gpt-o4', choices: [{ index: 0, delta: { role: 'assistant', content: '开始派发' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_task_1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: '调研', prompt: TASK, subagent_type: 'researcher' }) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } },
    ], { openAIDone: true }),
  };
}

/** 子响应：纯文本流。 */
function childTextSse(text: string): UpstreamScript {
  return {
    kind: 'sse',
    text: sseBody([
      { id: 'cmpl-opsub-child', model: 'gpt-o4', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ], { openAIDone: true }),
  };
}

describe('cpx opencode 子代理（x-parent-session-id 声明式路由 + task 派发回链）', () => {
  it('子会话落 <父>/subagents/<子x-session-id>，meta 回链 task 派发', async () => {
    stub.scriptQueue(ROUTES.openai, [taskDispatchSse(), childTextSse('调研完成Y')]);
    const agent = protocolAgent(sandbox, {
      mode: 'openai',
      name: 'fake-opsub',
      requests: [
        {
          sid: MAIN_SID,
          body: { model: 'gpt-o4', max_tokens: 32, stream: true, messages: [{ role: 'user', content: '派发调研' }] },
        },
        {
          sid: CHILD_SID,
          parentSid: MAIN_SID,
          body: { model: 'gpt-o4', max_tokens: 32, stream: true, messages: [{ role: 'user', content: TASK }] },
        },
      ],
    });

    const r = await runCpx(sandbox, [agent.path], {
      env: { [ENV.OPENAI_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    // ── 主会话文件：user + assistant(task tool_use) ──────────────
    const main = readCaptureLines(sandbox, MAIN_SID);
    assertClaudeJsonlContract(main);
    expect(JSON.stringify(main)).toContain('派发调研');
    const mainAssistant = main.find((l) => l.type === 'assistant');
    expect(mainAssistant).toBeDefined();
    const tuBlocks = (mainAssistant!.message as { content: Array<Record<string, unknown>> }).content
      .filter((b) => b.type === 'tool_use');
    expect(tuBlocks).toHaveLength(1);
    expect(tuBlocks[0].name).toBe('task');
    expect(tuBlocks[0].input).toEqual({ description: '调研', prompt: TASK, subagent_type: 'researcher' });
    expect((mainAssistant as { source: string }).source).toBe('opencode-proxy');

    // ── 主会话 meta：framework=opencode / protocol=openai ─────────
    const mainMetaPath = captureFile(sandbox, MAIN_SID).replace(/\.jsonl(\.7z|\.gz)?$/, '.meta.json');
    const mainMeta = JSON.parse(fs.readFileSync(mainMetaPath, 'utf8')) as { x_lake: { schema: string; data: { framework: string; protocol: string } } };
    expect(mainMeta.x_lake.schema).toBe('cc-session-meta');
    expect(mainMeta.x_lake.data.framework).toBe('opencode');
    expect(mainMeta.x_lake.data.protocol).toBe('openai');

    // ── 子会话文件：<父>/subagents/<子x-session-id> ───────────────
    const childRel = `${MAIN_SID}/subagents/${CHILD_SID}`;
    const child = readCaptureLines(sandbox, MAIN_SID, childRel);
    assertClaudeJsonlContract(child);
    expect(JSON.stringify(child)).toContain(TASK);
    expect((child.find((l) => l.type === 'user') as { source: string }).source).toBe('opencode-proxy');

    // ── 子 meta：回链 task 派发（首条 user 与 prompt 精确匹配）─────
    const childMetaPath = captureFile(sandbox, MAIN_SID, childRel).replace(/\.jsonl(\.7z|\.gz)?$/, '.meta.json');
    expect(fs.existsSync(childMetaPath), `child meta ${childMetaPath}`).toBe(true);
    const childMeta = JSON.parse(fs.readFileSync(childMetaPath, 'utf8')) as {
      toolUseId: string | null; name: string | null; agentType: string | null;
      x_lake: { schema: string; data: Record<string, unknown> };
    };
    expect(childMeta.toolUseId).toBe('call_task_1');
    expect(childMeta.name).toBe('调研');
    expect(childMeta.agentType).toBe('researcher');
    expect(childMeta.x_lake.schema).toBe('cc-subagent-meta');
    expect(childMeta.x_lake.data).toEqual({
      toolUseId: 'call_task_1', name: '调研', agentType: 'researcher', subagentSessionId: CHILD_SID,
    });
  }, 120_000);
});
