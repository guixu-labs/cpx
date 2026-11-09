// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex 子代理 + 压缩旅程（responses 协议的会话级深水区）：
//   ① spawn_agent 派发全链：主响应 tool_use 注册 → 次轮 function_call_output
//      富化（agent_id/nickname → 子 meta 重写）→ 子代理线程首条 user = 任务
//      文本（byte 级）→ subagents/<sub-md5> 落盘 + meta 回链 → 父守卫
//      （主线程带 spawn 证据，绝不误入子文件）
//   ② 压缩 resync：append-only 锚失配（input 前缀被重建）→ 内容哈希
//      multiset 差分——压缩摘要有、重发历史无、后续指令有，零重复

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { startUpstreamStub, sseBody, type UpstreamStub, type UpstreamScript } from './harness/upstream-stub';
import { protocolAgent } from './harness/fake-agent';
import { readCaptureLines, captureFile, assertClaudeJsonlContract } from './harness/capture';
import { runCpx, readSidDump } from './harness/session';
import { ENV } from './harness/constants';

let sandbox: Sandbox;
let stub: UpstreamStub;

beforeAll(async () => {
  sandbox = createSandbox('cpx-subagent-codex-');
  stub = await startUpstreamStub();
});

afterAll(() => {
  sandbox.cleanup();
  return stub.close();
});

const TASK = '编译任务Z';
function subIdOf(task: string): string {
  return 'sub-' + crypto.createHash('md5').update(task).digest('hex').slice(0, 12);
}

/** codex responses 协议纯文本流应答。 */
function codexTextSse(text: string): UpstreamScript {
  return {
    kind: 'sse',
    text: sseBody([
      { type: 'response.created', response: { model: 'deepseek-v4-pro' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant' } },
      { type: 'response.output_text.delta', output_index: 0, delta: text },
      { type: 'response.completed', response: { model: 'deepseek-v4-pro', status: 'completed', usage: { input_tokens: 10, output_tokens: 4 } } },
    ]),
  };
}

/** 主响应：spawn_agent 函数调用（0.161 message 直传形态）。 */
function spawnDispatchSse(): UpstreamScript {
  return {
    kind: 'sse',
    text: sseBody([
      { type: 'response.created', response: { model: 'deepseek-v4-pro' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'spawn_agent', call_id: 'call_spawn_1' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: JSON.stringify({ message: TASK }) },
      { type: 'response.completed', response: { model: 'deepseek-v4-pro', status: 'completed', usage: { input_tokens: 10, output_tokens: 4 } } },
    ]),
  };
}

function userItem(text: string): Record<string, unknown> {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
}

describe('cpx codex 子代理 + 压缩（spawn_agent 派发/富化/父守卫 + 锚失配 resync）', () => {
  it('① spawn_agent 派发：富化回链 + 子文件落位 + 父守卫', async () => {
    stub.scriptQueue('/responses', [
      spawnDispatchSse(), // 主轮1：spawn 派发
      codexTextSse('已派发'), // 主轮2：fc_output 富化
      codexTextSse('子代理结果'), // 子代理轮
      codexTextSse('主线程继续回答'), // 主轮3：父守卫
    ]);
    const agent = protocolAgent(sandbox, {
      mode: 'codex',
      name: 'fake-codex-sub',
      requests: [
        {
          body: { model: 'deepseek-v4-pro', instructions: 'You are codex.', stream: true, input: [userItem('派发spawn')] },
        },
        {
          body: {
            model: 'deepseek-v4-pro', instructions: 'You are codex.', stream: true,
            input: [
              userItem('派发spawn'),
              { type: 'function_call_output', call_id: 'call_spawn_1', output: JSON.stringify({ agent_id: 'agt_9', nickname: 'Helper' }) },
            ],
          },
        },
        {
          body: { model: 'deepseek-v4-pro', instructions: 'You are codex.', stream: true, input: [userItem(TASK)] },
        },
        {
          body: {
            model: 'deepseek-v4-pro', instructions: 'You are codex.', stream: true,
            input: [
              userItem('派发spawn'),
              { type: 'function_call_output', call_id: 'call_spawn_1', output: JSON.stringify({ agent_id: 'agt_9', nickname: 'Helper' }) },
              userItem('主线程继续'),
            ],
          },
        },
      ],
    });

    const r = await runCpx(sandbox, ['--agent', 'codex', agent.path], {
      env: { [ENV.RESPONSES_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    const pinned = readSidDump(sandbox, 'fake-codex-sub');
    // ── 主文件：父守卫——spawn 证据在，全程留在主文件 ───────────────
    const main = readCaptureLines(sandbox, pinned);
    assertClaudeJsonlContract(main);
    expect(JSON.stringify(main)).toContain('派发spawn');
    expect(JSON.stringify(main)).toContain('主线程继续');
    // fc_output 落成 tool_result user 行（回填 tool_use_id）
    const tr = main.find((l) => JSON.stringify(l.message ?? {}).includes('tool_result'));
    expect(tr).toBeDefined();
    expect(JSON.stringify(tr!.message)).toContain('call_spawn_1');
    expect(JSON.stringify(tr!.message)).toContain('agt_9');
    // 任务文本绝不作为主线程 user 行（父守卫的双向证明）
    expect(main.some((l) => l.type === 'user' && JSON.stringify(l.message ?? {}).includes(TASK))).toBe(false);

    // ── 子文件：subagents/<sub-md5(task)12> ──────────────────────
    const subId = subIdOf(TASK);
    const rel = `${pinned}/subagents/${subId}`;
    const sub = readCaptureLines(sandbox, pinned, rel);
    assertClaudeJsonlContract(sub);
    expect(JSON.stringify(sub)).toContain(TASK);
    expect(JSON.stringify(sub)).toContain('子代理结果');

    // ── 子 meta：富化后整文件重写（agentId/nickname 到货）─────────
    const metaPath = captureFile(sandbox, pinned, rel).replace(/\.jsonl(\.7z|\.gz)?$/, '.meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
      toolUseId: string | null; name: string | null; agentType: null; agentId: string | null; nickname: string | null;
      x_lake: { schema: string; data: Record<string, unknown> };
    };
    expect(meta.toolUseId).toBe('call_spawn_1');
    expect(meta.name).toBe('Helper');
    expect(meta.agentId).toBe('agt_9');
    expect(meta.nickname).toBe('Helper');
    expect(meta.x_lake.schema).toBe('cc-subagent-meta');
    expect(meta.x_lake.data).toEqual({
      toolUseId: 'call_spawn_1', name: 'Helper', agentType: null,
      subagentSessionId: subId, agentId: 'agt_9', nickname: 'Helper',
    });

    // ── 主会话 meta：framework=codex / protocol=responses ────────
    const mainMetaPath = captureFile(sandbox, pinned).replace(/\.jsonl(\.7z|\.gz)?$/, '.meta.json');
    const mainMeta = JSON.parse(fs.readFileSync(mainMetaPath, 'utf8')) as { x_lake: { schema: string; data: { framework: string; protocol: string } } };
    expect(mainMeta.x_lake.data.framework).toBe('codex');
    expect(mainMeta.x_lake.data.protocol).toBe('responses');
  }, 120_000);

  it('② 压缩 resync：锚失配 → multiset 差分（摘要有/历史无/零重复）', async () => {
    const Q1 = '多轮问题1';
    const Q2 = '多轮问题2';
    const SUMMARY = '<compaction>先前对话已压缩：用户进行了两轮提问</compaction>';
    stub.scriptQueue('/responses', [
      codexTextSse('回答1'),
      codexTextSse('回答2'),
      codexTextSse('回答3'),
    ]);
    const agent = protocolAgent(sandbox, {
      mode: 'codex',
      name: 'fake-codex-compact',
      requests: [
        { body: { model: 'deepseek-v4-pro', instructions: 'You are codex.', stream: true, input: [userItem(Q1)] } },
        { body: { model: 'deepseek-v4-pro', instructions: 'You are codex.', stream: true, input: [userItem(Q1), userItem(Q2)] } },
        // 压缩重建：前缀被换（Q1 → 摘要），Q2 保留——锚必然失配
        { body: { model: 'deepseek-v4-pro', instructions: 'You are codex.', stream: true, input: [userItem(SUMMARY), userItem(Q2)] } },
      ],
    });

    const r = await runCpx(sandbox, ['--agent', 'codex', agent.path], {
      env: { [ENV.RESPONSES_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    const pinned = readSidDump(sandbox, 'fake-codex-compact');
    const lines = readCaptureLines(sandbox, pinned);
    assertClaudeJsonlContract(lines);
    const users = lines.filter((l) => l.type === 'user');
    const userTexts = users.map((u) => {
      const c = (u.message as { content: unknown }).content;
      return typeof c === 'string' ? c : JSON.stringify(c);
    });
    // 零重复：Q1/Q2 各恰一次；压缩摘要恰一次（差分发射的新鲜项）
    expect(userTexts.filter((t) => t.includes(Q1) && !t.includes('compaction'))).toHaveLength(1);
    expect(userTexts.filter((t) => t === Q2 || t.includes(`"${Q2}"`))).toHaveLength(1);
    expect(userTexts.filter((t) => t.includes('先前对话已压缩'))).toHaveLength(1);
    // 三轮 assistant 全在，roundIndex 0/1/2
    const assistants = lines.filter((l) => l.type === 'assistant');
    expect(assistants).toHaveLength(3);
    expect(assistants.map((a) => (a.x_lake as { data: { roundIndex: number } }).data.roundIndex)).toEqual([0, 1, 2]);
  }, 120_000);
});
