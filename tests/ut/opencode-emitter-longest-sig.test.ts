// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 派发签名包含式回退的最长匹配回归锁：派发 prompt 常有模板化前缀——短 sig 是
// 长 sig 的前缀时（如「请分析 P1 需求文档…」与「请分析 P1 需求文档…并产出
// 结构化报告」），子会话首条 user 会同时包含两条 sig。旧实现取「收集序第一条
// 被包含的 sig」，先收集的短 sig 先命中 → 长 prompt 子会话的 meta.name/agentType
// 被写成短派发的值（名字链错配）。修复后命中的候选里取长度最大（最特异）者。
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emit } from '../../src/opencode-emitter.ts';
import { sessionFilePath } from '../../src/writer.ts';

const SID = 'sid-longest';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-longest-sig-'));
process.env.CONTEXT_PROXY_DIR = tmpDir; // BEFORE sessionFilePath is evaluated at module scope
sessionFilePath(SID); // warm the module-level dir capture
const subagentsDir = path.join(tmpDir, SID, 'subagents');

const SHORT = '请分析 P1 需求文档并梳理算子语义和输入输出约束';
const LONG = '请分析 P1 需求文档并梳理算子语义和输入输出约束，产出结构化分析报告';

const BOOTSTRAP = 'You are a subagent spawned by another session.\n\n';

function rec(over: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol: 'openai',
    receivedAt: 1700000100000,
    completedAt: 1700000101000,
    latencyMs: 1000,
    ...over,
  };
}

const mainRec = rec({
  sid: SID,
  xSessionId: 'ses_longest_main',
  request: {
    path: '/chat/completions',
    model: 'glm-5.3',
    body: {
      model: 'glm-5.3',
      messages: [
        { role: 'system', content: 'You are opencode.' },
        { role: 'user', content: '开始 P1 流程' },
      ],
      tools: [
        { type: 'function', function: { name: 'subagent', description: 'Dispatch a task to a subagent session.' } },
      ],
    },
  },
  response: {
    status: 200,
    model: 'glm-5.3',
    stop_reason: 'tool_calls',
    content: [
      {
        type: 'tool_use',
        id: 'call_short',
        name: 'subagent',
        input: { agent: 'short-agent', description: '短派发', prompt: SHORT, sessionID: 'ses_longest_short' },
      },
      {
        type: 'tool_use',
        id: 'call_long',
        name: 'subagent',
        input: { agent: 'long-agent', description: '长派发', prompt: LONG, sessionID: 'ses_longest_long' },
      },
    ],
    usage: { input_tokens: 80, output_tokens: 15 },
  },
});

function subRec(xid: string, prompt: string): Record<string, unknown> {
  return rec({
    sid: SID,
    xSessionId: xid,
    request: {
      path: '/chat/completions',
      model: 'glm-5.3',
      body: {
        model: 'glm-5.3',
        messages: [
          { role: 'system', content: 'You are a subagent. Focus on the assigned step.' },
          { role: 'user', content: BOOTSTRAP + prompt },
        ],
        tools: [{ type: 'function', function: { name: 'read', description: 'Reads a file.' } }],
      },
    },
    response: {
      status: 200,
      model: 'glm-5.3',
      stop_reason: 'stop',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 40, output_tokens: 10 },
    },
  });
}

function readMeta(subId: string): { name: string | null; agentType: string | null; toolUseId: string | null } {
  return JSON.parse(fs.readFileSync(path.join(subagentsDir, `${subId}.meta.json`), 'utf-8'));
}

beforeAll(() => {
  emit(mainRec as never);
  emit(subRec('ses_longest_short', SHORT) as never);
  emit(subRec('ses_longest_long', LONG) as never);
});

describe('opencode-emitter：派发签名包含式回退取最长（最特异）sig', () => {
  it('长 prompt 子会话命中长 sig（短 sig 是其前缀，不得写成短派发的 name/agentType）', () => {
    const longMeta = readMeta('ses_longest_long');
    expect(longMeta.toolUseId).toBe('call_long');
    expect(longMeta.name).toBe('长派发');
    expect(longMeta.agentType).toBe('long-agent');
  });

  it('短 prompt 子会话仍命中短 sig（唯一包含者，最长匹配不回归）', () => {
    const shortMeta = readMeta('ses_longest_short');
    expect(shortMeta.toolUseId).toBe('call_short');
    expect(shortMeta.name).toBe('短派发');
    expect(shortMeta.agentType).toBe('short-agent');
  });
});
