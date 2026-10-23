// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex-emitter 父线程甄别守卫 IT：主线程首条 user 消息恰好等于某 spawn
// 任务文本（机械式委派：「把这个任务交给子代理：〈用户原文〉」）时，
// 旧路由按 identity 无条件命中派发登记——主线程后续全部请求误入子代理
// 文件，双流共享子代理游标，主文件断流。守卫的两条父证据：
//   A. 本记录响应里的 spawn tool_use（任务文本 === identity）
//   B. 后续轮 input 里该 spawn 的 function_call_output（call_id → 任务文本）
// 本 IT 用 A、B 两条链各锁一轮，外加子代理线程正常路由不回归。
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emit } from '../../src/codex-emitter.ts';
import { sessionFilePath } from '../../src/writer.ts';

const SID = 'cpx-codex-parent-guard';
// 机械式委派场景：用户原文 === spawn 任务文本（逐字节相同）
const T = '分析这个仓库并给出结论';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-codex-pguard-'));
process.env.CONTEXT_PROXY_DIR = tmpDir; // BEFORE sessionFilePath 评估（模块级懒读）

const mainFile = sessionFilePath(SID);
const subagentsDir = path.join(tmpDir, SID, 'subagents');

function readJsonl(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const userMsg = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const ENV = userMsg('<environment_context>\n  <cwd>/workspace/demo</cwd>\n</environment_context>');

function rec(input: any[], content: any[], receivedAt: number) {
  return {
    sid: SID,
    protocol: 'responses' as const,
    receivedAt,
    completedAt: receivedAt + 500,
    latencyMs: 500,
    ttftMs: 100,
    request: {
      path: '/v1/responses',
      model: 'deepseek-v4-pro',
      body: {
        model: 'deepseek-v4-pro',
        stream: true,
        instructions: 'You are a coding agent running in the Codex CLI.',
        tools: [{ type: 'function', name: 'spawn_agent' }],
        input,
      },
    },
    response: {
      status: 200,
      model: 'deepseek-v4-pro',
      stop_reason: 'completed',
      content,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

beforeAll(() => {
  // 轮 1（主线程派发轮）：首条 user 消息 === T，响应 spawn 任务文本 === T。
  // 守卫链 A：本记录响应携带 spawn tool_use → 父证据 → 留主文件。
  emit(rec(
    [ENV, userMsg(T)],
    [{ type: 'tool_use', id: 'call-guard-1', name: 'spawn_agent', input: { message: T } }],
    1760000000000,
  ));
  // 轮 2（子代理线程）：新鲜线程，任务文本是它的首条 user 消息——正常路由子文件。
  emit(rec(
    [userMsg(T)],
    [{ type: 'text', text: '开始分析' }],
    1760000001000,
  ));
  // 轮 3（主线程下一轮）：identity 仍 === T（首条 user 消息不变），但 input
  // 里携带该 spawn 的 function_call_output。守卫链 B：call_id → 任务文本
  // → 父证据 → 留主文件（旧实现此轮误入子代理文件，「汇总结果」丢失）。
  emit(rec(
    [
      ENV,
      userMsg(T),
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我来派发。' }] },
      { type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ message: T }), call_id: 'call-guard-1' },
      { type: 'function_call_output', call_id: 'call-guard-1', output: JSON.stringify({ agent_id: 'ag-guard-1', nickname: 'Kong' }) },
      userMsg('汇总结果'),
    ],
    [{ type: 'text', text: '汇总完成' }],
    1760000002000,
  ));
});

describe('codex-emitter: 父线程甄别守卫（主线程 identity === spawn 任务文本）', () => {
  it('链 A：派发轮（响应含 spawn tool_use，任务 === identity）留主文件', () => {
    const mainRows = readJsonl(mainFile);
    const userTexts = mainRows
      .filter((r) => r.type === 'user')
      .map((r) => (typeof r.message?.content === 'string' ? r.message.content : JSON.stringify(r.message?.content ?? '')));
    // 主线程自己的首条 user 消息必须在主文件（旧实现误入子代理文件）
    expect(userTexts.some((t) => t.includes(T))).toBe(true);
  });

  it('链 B：主线程后续轮（input 携带该 spawn 的 function_call_output）仍留主文件', () => {
    const mainRows = readJsonl(mainFile);
    const userTexts = mainRows
      .filter((r) => r.type === 'user')
      .map((r) => (typeof r.message?.content === 'string' ? r.message.content : JSON.stringify(r.message?.content ?? '')));
    expect(userTexts.some((t) => t.includes('汇总结果'))).toBe(true);
  });

  it('子代理线程不受守卫影响：正常路由进自己的文件', () => {
    const files = fs.existsSync(subagentsDir)
      ? fs.readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl'))
      : [];
    expect(files).toHaveLength(1);
    const subRows = readJsonl(path.join(subagentsDir, files[0]));
    const texts = subRows.map((r) => JSON.stringify(r.message?.content ?? ''));
    expect(texts.some((t) => t.includes('开始分析'))).toBe(true);
  });

  it('主文件轮次完整：派发轮（spawn tool_use）与汇总轮的 assistant 输出都在（主文件不断流）', () => {
    const mainRows = readJsonl(mainFile);
    const assistantTexts = mainRows
      .filter((r) => r.type === 'assistant')
      .map((r) => JSON.stringify(r.message?.content ?? ''));
    // 派发轮的响应是 spawn tool_use（“我来派发。”只是 input 回显，delta-emit
    // 按设计跳过 assistant 回显）——它必须作为主线程的一轮落在主文件
    expect(assistantTexts.some((t) => t.includes('spawn_agent'))).toBe(true);
    expect(assistantTexts.some((t) => t.includes('汇总完成'))).toBe(true);
  });
});
