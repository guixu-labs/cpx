// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex-emitter 压缩（compaction）重同步单测。真机 20 分钟长会话（codex
// 0.161 + remote_compaction_v2）证伪了「input append-only」假设：线程填满
// 上下文窗口后 input 被重建为少量条目（实测 106→5），且条目顺序不保持。
// 旧实现的纯位置游标在此场景静默丢失压缩摘要与新增指令。fixture 模拟：
//   rec1 r0  首轮（dev 注入 + env_ctx + 用户 prompt）
//   rec2 r1  追加 fc/fco（exec 工具轮）
//   rec3 r2  再追加一轮 fc/fco
//   rec4 r3  ★压缩：input 缩为 [dev, env_ctx, prompt, 摘要]（4 < 7）
//   rec5 r4  压缩后继续追加 fc/fco（锚点=摘要，恢复正常 delta）
//   rec6 r5  ★同长重写：末位 fco 内容变化（长度不变，锚点失配路径）
//   rec7 r6  ★send_input 同文重发（append 路径 verbatim，不做内容去重）
// 关键回归：压缩摘要恰好捕获一次、静态注入/任务文本不被重建重发、
// 轮次号跨压缩连续、重写后的新内容不丢、同文重发保持如实记录。

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emit } from '../../src/codex-emitter.ts';
import { sessionFilePath } from '../../src/writer.ts';

const SID = 'cpx-codex-compaction';
const FIXTURE = path.resolve(__dirname, 'data/cpx-codex-compaction.jsonl');
const P1 = '请分析这个项目的架构并给出报告';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-codex-cmp-'));
process.env.CONTEXT_PROXY_DIR = tmpDir; // BEFORE sessionFilePath 评估（模块级懒读）

const mainFile = sessionFilePath(SID);

function readJsonl(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

beforeAll(() => {
  const lines = fs.readFileSync(FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
  for (const line of lines) {
    emit(JSON.parse(line));
  }
});

describe('codex-emitter: 压缩重建重同步', () => {
  it('每个 wire 请求恰产生一行 assistant（压缩轮不丢响应）', () => {
    const assistants = readJsonl(mainFile).filter((r) => r.type === 'assistant');
    expect(assistants.length).toBe(7);
  });

  it('压缩摘要恰好捕获一次，盖在压缩发生的轮次上', () => {
    const users = readJsonl(mainFile).filter((r) => r.type === 'user');
    const summaries = users.filter((u) =>
      JSON.stringify(u.message.content).includes('Another language model started'));
    expect(summaries.length).toBe(1);
    expect(summaries[0].x_lake.data.roundIndex).toBe(3);
    expect(summaries[0].x_lake.data.kind).toBe('user');
  });

  it('重建后静态注入/任务文本不重复（内容指纹 multiset 去重）', () => {
    const users = readJsonl(mainFile).filter((r) => r.type === 'user');
    const texts = users.map((u) =>
      typeof u.message?.content === 'string' ? u.message.content : JSON.stringify(u.message?.content));
    // P1 两次：首现 r0 + rec7 的 send_input 同文重发（verbatim 记录）；
    // 压缩重建（rec4/rec5/rec6 的 input 头部）不产生第三次
    expect(texts.filter((t) => t.includes(P1) && !t.includes('<environment_context>') && !t.includes('Another language')).length).toBe(2);
    expect(texts.filter((t) => t.includes('<environment_context>')).length).toBe(1);
  });

  it('压缩前后的工具结果各自恰好一次，轮次号跨压缩连续', () => {
    const users = readJsonl(mainFile).filter((r) => r.type === 'user');
    const toolResults = users.filter((u) =>
      Array.isArray(u.message.content) && u.message.content[0]?.type === 'tool_result');
    const byCall: Record<string, string[]> = {};
    for (const tr of toolResults) {
      const id = tr.message.content[0].tool_use_id;
      (byCall[id] ??= []).push(tr.message.content[0].content);
    }
    expect(byCall['call-c-1']).toEqual(['file1.ts file2.ts']);
    expect(byCall['call-c-2']).toEqual(['arch: a->b->c']);
    // call-c-3 被同长重写：原稿 + 润色稿都被如实记录（capture ≠ interpret）
    expect(byCall['call-c-3']).toEqual(['report draft written', 'report draft written, polished']);
    expect(toolResults[0].x_lake.data.roundIndex).toBe(1);

    const assistants = readJsonl(mainFile).filter((r) => r.type === 'assistant');
    expect(assistants.map((a) => a.x_lake.data.roundIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('同长重写（锚点失配）不丢新内容：润色稿已捕获', () => {
    const users = readJsonl(mainFile).filter((r) => r.type === 'user');
    const polished = users.filter((u) =>
      JSON.stringify(u.message.content).includes('polished'));
    expect(polished.length).toBe(1);
    expect(polished[0].x_lake.data.roundIndex).toBe(5);
  });

  it('send_input 同文重发 verbatim 记录（append 路径不做内容去重）', () => {
    const users = readJsonl(mainFile).filter((r) => r.type === 'user');
    const resends = users.filter((u) =>
      Array.isArray(u.message.content)
      && u.message.content[0]?.type === 'text'
      && u.message.content[0]?.text === P1);
    expect(resends.length).toBe(2);
    expect(resends[0].x_lake.data.roundIndex).toBe(0);
    expect(resends[1].x_lake.data.roundIndex).toBe(6);
  });
});
