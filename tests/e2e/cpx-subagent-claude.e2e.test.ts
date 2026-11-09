// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// claude 子代理旅程（cc_is_subagent=true 的目录化捕获——泳道图/泳道 meta
// 的数据源）：Agent 工具派发 → 子代理请求落 <父sid>/subagents/sub-<md5(task)12>
// .jsonl + cc-subagent-meta 回链派发（toolUseId/name/agentType）。
//
// 两种真实时序都锁：
//   ① 常规序——父响应先完成（tool_use 已收集），子代理 meta 即时回链
//   ② 异步回填序——真实竞态：父响应仍在流尾时子代理首请求已到且先完成
//      （dispatch 未见 → meta 挂起 pendingSubMeta），父 emit 收集派发后补写

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { startUpstreamStub, type UpstreamStub, type UpstreamScript } from './harness/upstream-stub';
import { protocolAgent } from './harness/fake-agent';
import { readCaptureLines, captureFile, assertClaudeJsonlContract } from './harness/capture';
import { runCpx } from './harness/session';
import { ENV, ROUTES } from './harness/constants';

let sandbox: Sandbox;
let stub: UpstreamStub;

beforeAll(async () => {
  sandbox = createSandbox('cpx-subagent-claude-');
  stub = await startUpstreamStub();
});

afterAll(() => {
  sandbox.cleanup();
  return stub.close();
});

const TASK = '研究任务X';
/** 子代理分桶键：任务文本 md5 前 12 位（subIdFor 的镜像公式）。 */
function subIdOf(task: string): string {
  return 'sub-' + crypto.createHash('md5').update(task).digest('hex').slice(0, 12);
}

/** 父侧 Agent 工具派发应答（非流 JSON：content 携 tool_use 块）。 */
function agentDispatchResponse(): UpstreamScript {
  return {
    kind: 'json',
    body: {
      id: 'msg_parent', model: 'claude-opus-x',
      content: [{
        type: 'tool_use', id: 'toolu_agent_1', name: 'Agent',
        input: { description: '研究', subagent_type: 'researcher', prompt: TASK },
      }],
      stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

/** 子代理请求体（system 携 cc_is_subagent=true 标记 + 首条 user = 任务文本）。 */
function subagentBody(): Record<string, unknown> {
  return {
    model: 'claude-opus-x', max_tokens: 32,
    system: 'You are a subagent. cc_is_subagent=true. Complete the task.',
    messages: [{ role: 'user', content: TASK }],
  };
}

/** 断言子代理落盘三件：目录化 jsonl + 双信封 meta + 派发回链字段。 */
function assertSubagentArtifacts(sid: string, task: string): void {
  const subId = subIdOf(task);
  const rel = `${sid}/subagents/${subId}`;
  const lines = readCaptureLines(sandbox, sid, rel);
  assertClaudeJsonlContract(lines);
  expect(JSON.stringify(lines)).toContain(task);

  // meta（.meta.json 明文——不参与 7z at-rest）
  const metaPath = captureFile(sandbox, sid, rel).replace(/\.jsonl(\.7z|\.gz)?$/, '.meta.json');
  expect(fs.existsSync(metaPath), `subagent meta ${metaPath}`).toBe(true);
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
    toolUseId: string | null; name: string | null; agentType: string | null;
    x_lake: { schema: string; data: { toolUseId: string | null; name: string | null; agentType: string | null; subagentSessionId: string } };
  };
  expect(meta.toolUseId).toBe('toolu_agent_1');
  expect(meta.name).toBe('研究');
  expect(meta.agentType).toBe('researcher');
  expect(meta.x_lake.schema).toBe('cc-subagent-meta');
  expect(meta.x_lake.data).toEqual({
    toolUseId: 'toolu_agent_1', name: '研究', agentType: 'researcher', subagentSessionId: subId,
  });
}

describe('cpx claude 子代理（Agent 工具派发 → 目录化捕获 + meta 回链）', () => {
  it('① 常规序：父响应先完成，子代理 meta 即时回链', async () => {
    stub.scriptQueue(ROUTES.anthropic, [
      agentDispatchResponse(),
      { kind: 'json', body: { id: 'msg_sub', model: 'claude-opus-x', content: [{ type: 'text', text: '研究结果Y' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } } },
    ]);
    const agent = protocolAgent(sandbox, {
      mode: 'claude',
      name: 'fake-sub-claude-1',
      requests: [
        // 父侧：主会话请求 → 应答带 Agent tool_use 派发
        { sid: 'e2e-subclaude-1', body: { model: 'claude-opus-x', max_tokens: 32, messages: [{ role: 'user', content: '派发子代理' }] } },
        // 子代理侧：同一主 sid 头（子代理请求带主会话 id——已验证的 wire 事实）+ cc_is_subagent 标记
        { sid: 'e2e-subclaude-1', body: subagentBody() },
      ],
    });

    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    // 主会话文件：user + assistant(tool_use)。任务文本只出现在父侧
    // tool_use 的 input.prompt 里——子代理的 user 行绝不落主文件
    const main = readCaptureLines(sandbox, 'e2e-subclaude-1');
    assertClaudeJsonlContract(main);
    expect(JSON.stringify(main)).toContain('派发子代理');
    expect(JSON.stringify(main)).toContain('toolu_agent_1');
    const taskInUserLine = main.some(
      (l) => l.type === 'user' && JSON.stringify(l.message ?? {}).includes(TASK),
    );
    expect(taskInUserLine, 'subagent user line must not land in the main capture').toBe(false);

    assertSubagentArtifacts('e2e-subclaude-1', TASK);
  }, 120_000);

  it('② 异步回填序：子代理 emit 先于父派发收集，meta 挂起后补写', async () => {
    // 编排「后到先答」：父请求先到但应答慢（600ms），子代理请求 300ms 后到
    // 且应答即时 → 子代理 record 先 emit（dispatch 未见 → pendingSubMeta），
    // 父 record 后 emit（收集派发 → 回填补写 meta）。
    stub.scriptQueue(ROUTES.anthropic, [
      { ...agentDispatchResponse(), delayMs: 600 },
      { kind: 'json', body: { id: 'msg_sub2', model: 'claude-opus-x', content: [{ type: 'text', text: '回填研究结果' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } } },
    ]);
    const agent = protocolAgent(sandbox, {
      mode: 'claude',
      name: 'fake-sub-claude-2',
      requests: [
        { sid: 'e2e-subclaude-2', body: { model: 'claude-opus-x', max_tokens: 32, messages: [{ role: 'user', content: '派发子代理2' }] } },
        { sid: 'e2e-subclaude-2', body: subagentBody(), delayMs: 300 },
      ],
      // 并发形态：子代理请求不等父响应完成（复刻真实派发竞态）
      concurrent: true,
    });

    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    // 主会话文件仍齐备（父 tool_use 派发行在）
    const main = readCaptureLines(sandbox, 'e2e-subclaude-2');
    expect(JSON.stringify(main)).toContain('toolu_agent_1');

    // 回填后的 meta 与常规序完全同形（单点写 writeSubagentMeta）
    assertSubagentArtifacts('e2e-subclaude-2', TASK);
  }, 120_000);
});
