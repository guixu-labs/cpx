// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// claude-emit-state IT：增量落盘状态的跨进程自愈。
//
// 根治现场（solo:8ae4a944）：multiset 计数/注入指纹/轮次号曾全在进程内存，
// 代理进程重启即清零 → 新进程把重放的消息历史整批再落盘（四次重启各倾泻
// 338/341/354/610 行，后台代理完成通知被放大成 214 条背景事件）。
// 本文件验证新架构：进程首见捕获文件 → 盘上重放重建 → 重放历史不重发。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emit } from '../../src/claude-emitter.ts';
import { compressCaptureFile, sessionFilePath, readCaptureText } from '../../src/writer.ts';
import { resetLinkageForTests } from '../../src/claude-linkage.ts';
import { resetEmitStateForTests } from '../../src/claude-emit-state.ts';

const SID = 'cpx-emitstate-heal';
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-emitstate-'));
  process.env.CONTEXT_PROXY_DIR = tmpDir;
  resetLinkageForTests();
  resetEmitStateForTests(); // 每用例基线 = 新代理进程
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetLinkageForTests();
  resetEmitStateForTests();
  delete process.env.CONTEXT_PROXY_DEDUP_INJECTION;
});

// 主会话记录（system 无 cc_is_subagent 标记 → 走 main 分支）
function mainRec(messages: Array<{ role: string; content?: unknown }>) {
  return {
    sid: SID,
    receivedAt: Date.now(),
    completedAt: Date.now(),
    request: {
      body: {
        system: [{ type: 'text', text: 'main system' }],
        tools: [{ name: 'Read' }],
        messages,
      },
    },
    response: { status: 200, model: 'glm-5.2', stop_reason: 'end_turn', content: [], usage: { input_tokens: 1, output_tokens: 1 } },
  };
}

// 三形态透明读（明文 / .7z / .gz）
function fileLines(): Array<Record<string, any>> {
  const text = readCaptureText(sessionFilePath(SID));
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function userTexts(lines: Array<Record<string, any>>): string[] {
  return lines
    .filter(l => l.type === 'user')
    .map(l => (typeof l.message.content === 'string' ? l.message.content : l.message.content.map((b: any) => b.text).join('')));
}

describe('claude-emit-state：跨进程自愈', () => {
  it('重启后重放历史不重发：P1 落盘 [u1, sys 注入]，P2 带 [u1, sys, u2] 只新增 u2', () => {
    emit(mainRec([
      { role: 'user', content: 'u1' },
      { role: 'system', content: 'Available agent types for the Agent tool:\n- Explore' },
    ]));
    resetEmitStateForTests(); // P1 退出，P2 接管（旧架构在此处计数清零）

    emit(mainRec([
      { role: 'user', content: 'u1' },                        // 重放历史
      { role: 'system', content: 'Available agent types for the Agent tool:\n- Explore' },
      { role: 'user', content: 'u2' },                         // 新消息
    ]));
    const lines = fileLines();
    expect(userTexts(lines)).toEqual(['u1', 'u2']); // u1 无重发副本
    expect(lines.filter(l => l.type === 'system').length).toBe(1); // 注入 system 行无重发
    expect(lines.filter(l => l.type === 'assistant').length).toBe(2);
  });

  it('multiset 语义跨进程保持：同请求双副本全落盘，重启后第 3 副本才新增', () => {
    emit(mainRec([{ role: 'user', content: 'dup' }, { role: 'user', content: 'dup' }]));
    expect(userTexts(fileLines())).toEqual(['dup', 'dup']); // wire 上真有 2 副本 → 全捕获
    resetEmitStateForTests();

    emit(mainRec([{ role: 'user', content: 'dup' }, { role: 'user', content: 'dup' }, { role: 'user', content: 'dup' }]));
    // 已捕获 2 副本：本请求前 2 副本是重放（跳过），第 3 副本是 wire 新增量 → 落盘
    expect(userTexts(fileLines())).toEqual(['dup', 'dup', 'dup']);
  });

  it('roundIndex 跨进程连续：重启后新轮次接着旧值编号（不再从 0 重复）', () => {
    for (let i = 0; i < 3; i++) emit(mainRec([{ role: 'user', content: 'r' + i }]));
    expect(fileLines().filter(l => l.type === 'assistant').map(l => l.x_lake.data.roundIndex)).toEqual([0, 1, 2]);
    resetEmitStateForTests();

    emit(mainRec([{ role: 'user', content: 'r3' }]));
    const rounds = fileLines().filter(l => l.type === 'assistant').map(l => l.x_lake.data.roundIndex);
    expect(rounds).toEqual([0, 1, 2, 3]); // 旧架构此处会产出重复的 0
    // 输入行的 roundIndex 同样连续（每请求一条新输入，各属一轮）
    const inputRounds = fileLines().filter(l => l.x_lake?.schema === 'cc-wire-input').map(l => l.x_lake.data.roundIndex);
    expect(inputRounds).toEqual([0, 1, 2, 3]);
  });

  it('dedup 模式：重启后注入重发仍走 [已压缩] 标记（指纹盘上重建，不回退全量）', () => {
    process.env.CONTEXT_PROXY_DEDUP_INJECTION = '1';
    const injection = { role: 'system', content: 'The following skills are available for use with the Skill tool:\n- demo' };
    emit(mainRec([injection]));
    resetEmitStateForTests();

    emit(mainRec([injection])); // 重放同一注入
    const lines = fileLines();
    const full = lines.filter(l => l.type === 'system' && !l.deduped);
    const markers = lines.filter(l => l.deduped === true);
    expect(full.length).toBe(1); // 全量行只此一份
    expect(markers.length).toBe(1); // 重发走 [已压缩] 标记——指纹从盘上重建
    expect(markers[0].message.content[0].text).toContain('已压缩');
  });

  it('主捕获 .7z 压缩态（resume 生命周期）：bootstrap 透明解压重建', () => {
    emit(mainRec([{ role: 'user', content: 'u1' }]));
    compressCaptureFile(sessionFilePath(SID)); // 会话关闭压缩
    resetEmitStateForTests();

    // resume：请求重放 u1 并带新消息 u2 —— bootstrap 从 .7z 读回已捕获集
    emit(mainRec([{ role: 'user', content: 'u1' }, { role: 'user', content: 'u2' }]));
    const lines = fileLines();
    expect(userTexts(lines)).toEqual(['u1', 'u2']); // 重放不重发
    expect(lines.filter(l => l.type === 'assistant').map(l => l.x_lake.data.roundIndex)).toEqual([0, 1]);
  });
});
