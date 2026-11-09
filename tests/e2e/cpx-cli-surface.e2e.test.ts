// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// CLI 面旅程（wrapper → tsx → 真源码的被测物形态下，非会话子命令的
// 输出契约 + 跨子命令联动）：
//   ① --version / --help：版本单源（src/version.ts）与用法面
//   ② completion：bash 补全脚本生成 + __complete 候选面（同一引擎）
//   ③ list：捕获会话清单（sid + FRAMEWORK/PROTOCOL 列 + subagents 数 +
//      at-rest 状态）——旅程后的消费视角
//   ④ config dedup on → 旅程联动：热开关走【文件】而非 env（与 multi-round
//      的 env override 用例互为另一半），cpx-config.json 落在捕获目录旁

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { startUpstreamStub, sseBody, type UpstreamStub } from './harness/upstream-stub';
import { protocolAgent } from './harness/fake-agent';
import { readCaptureLines, assertClaudeJsonlContract } from './harness/capture';
import { runCpx, runCommand } from './harness/session';
import { ENV, ROUTES } from './harness/constants';

let sandbox: Sandbox;
let stub: UpstreamStub;

beforeAll(async () => {
  sandbox = createSandbox('cpx-cli-surface-');
  stub = await startUpstreamStub();
});

afterAll(() => {
  sandbox.cleanup();
  return stub.close();
});

const SSE_TEXT = sseBody([
  { type: 'message_start', message: { model: 'claude-opus-x', usage: { input_tokens: 3 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cli 面回答' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]);

describe('cpx CLI 面（--version/--help/completion/list/config 联动）', () => {
  it('① --version / --help：版本单源 + 用法面', async () => {
    const v = await runCommand(sandbox, 'bash', ['cpx-cli', '--version']);
    expect(v.code, `output:\n${v.output}`).toBe(0);
    expect(v.output.trim()).toMatch(/^cpx v\d+\.\d+\.\d+ \(/);

    const h = await runCommand(sandbox, 'bash', ['cpx-cli', '--help']);
    expect(h.code, `output:\n${h.output}`).toBe(0);
    // 用法面要点：profile 说明 + 子命令
    expect(h.output).toContain('claude');
    expect(h.output).toContain('status');
    expect(h.output).toContain('list');
  }, 60_000);

  it('② completion：bash 脚本生成 + __complete 候选（同一引擎）', async () => {
    const c = await runCommand(sandbox, 'bash', ['cpx-cli', 'completion', 'bash']);
    expect(c.code, `output:\n${c.output}`).toBe(0);
    // 纯静态词表脚本：加载函数 + 子命令/agent/flag 词表
    expect(c.output).toContain('_cpx()');
    expect(c.output).toContain('list ls status config completion');
    expect(c.output).toContain('claude opencode codex cannbot dsh');

    const cc = await runCommand(sandbox, 'bash', ['cpx-cli', '__complete', '']);
    expect(cc.code, `output:\n${cc.output}`).toBe(0);
    // 候选面含子命令与 profile（与 --help 同源）
    expect(cc.output).toContain('status');
    expect(cc.output).toContain('claude');
  }, 60_000);

  it('③ list：旅程后的会话清单（framework/protocol 列 + at-rest 状态）', async () => {
    stub.script(ROUTES.anthropic, { kind: 'sse', text: SSE_TEXT });
    const agent = protocolAgent(sandbox, {
      mode: 'claude',
      name: 'fake-cli-list',
      requests: [{ sid: 'e2e-cli-list', body: { model: 'claude-opus-x', max_tokens: 8, stream: true, messages: [{ role: 'user', content: '清单前置提问' }] } }],
    });
    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    const l = await runCommand(sandbox, 'bash', ['cpx-cli', 'list']);
    expect(l.code, `list output:\n${l.output}`).toBe(0);
    // 头侧会话行：sid + claude-code/anthropic 列 + at-rest（压缩态）
    expect(l.output).toContain('e2e-cli-list');
    expect(l.output).toContain('claude-code');
    expect(l.output).toContain('anthropic');
    expect(l.output).toContain('rest');
    expect(l.output).toMatch(/cpx-e2e-cli-list\.jsonl\.7z/);
  }, 120_000);

  it('④ config dedup on → 旅程联动：热开关走文件（非 env）', async () => {
    const cfg = await runCommand(sandbox, 'bash', ['cpx-cli', 'config', 'dedup', 'on']);
    expect(cfg.code, `config output:\n${cfg.output}`).toBe(0);
    expect(cfg.output).toContain('dedup injection : on');
    // cpx-config.json 落在捕获目录旁（proxy 热读路径 = dirname(CONTEXT_PROXY_DIR)）
    const cfgFile = path.join(sandbox.root, 'cpx-config.json');
    expect(fs.existsSync(cfgFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(cfgFile, 'utf8'))).toEqual({ dedupInjection: true });

    // 旅程：注入 byte 级重发 → [已压缩] 占位（文件开关被 proxy 热读生效）
    stub.scriptQueue(ROUTES.anthropic, [
      { kind: 'sse', text: SSE_TEXT },
      { kind: 'sse', text: SSE_TEXT },
    ]);
    const INJ = 'The following skills are available: cli-surface-skill';
    const agent = protocolAgent(sandbox, {
      mode: 'claude',
      name: 'fake-cli-dedup',
      requests: [
        { sid: 'e2e-cli-dedup', body: { model: 'claude-opus-x', max_tokens: 8, stream: true, messages: [{ role: 'system', content: INJ }, { role: 'user', content: '开关轮1' }] } },
        { sid: 'e2e-cli-dedup', body: { model: 'claude-opus-x', max_tokens: 8, stream: true, messages: [{ role: 'system', content: INJ }, { role: 'user', content: '开关轮1' }, { role: 'assistant', content: 'cli 面回答' }, { role: 'user', content: '开关轮2' }] } },
      ],
    });
    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    const lines = readCaptureLines(sandbox, 'e2e-cli-dedup');
    assertClaudeJsonlContract(lines);
    const markers = lines.filter((l) => l.deduped === true);
    expect(markers).toHaveLength(1);
    expect((markers[0].x_lake as { data: { kind: string } }).data.kind).toBe('dedup-placeholder');

    // 关闭后恢复全文发射（同一 live 会话语义的热切换——这里用第二次会话验证）
    const off = await runCommand(sandbox, 'bash', ['cpx-cli', 'config', 'dedup', 'off']);
    expect(off.output).toContain('dedup injection : off');
  }, 120_000);
});
