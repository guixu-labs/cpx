// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex-emitter 系统提示词捕获单测：wire 双形态归一进 claude 布局的 system
// 扩展字段（insight readFullContext 的消费入口，与 claude-emitter 的
// request.body.system 同款位置）。真机核实（codex 0.161 → volcano 网关，
// 146 请求全量 dump）：instructions 字段不存在，系统提示词 = input 首位
// developer 消息（23KB，每请求逐字重发，主/子线程同基座）；旧实现按
// instructions 设计 → system 恒为空 → UI 只剩 System(hidden) 估算徽标。
// 三形态矩阵：
//   dev   — 无 instructions + developer 消息（0.161 真机唯一形态）
//   instr — instructions 字段存在（部分版本/网关）→ 优先于 developer
//   none  — 双缺省 → 不写 system 键
// 回归锁：developer 消息是静态上下文非事件——绝不成为时间线 user 行
// （D1 语义与 codex 原生 adapter 一致），只进 system 扩展字段。

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emit } from '../../src/codex-emitter.ts';
import { sessionFilePath } from '../../src/writer.ts';

const FIXTURE = path.resolve(__dirname, 'data/cpx-codex-system.jsonl');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-codex-sys-'));
process.env.CANNBOT_PROXY_DIR = tmpDir; // BEFORE sessionFilePath 评估（模块级懒读）

const DEV_TEXT = 'You are a coding agent running in the Codex CLI, a terminal-based coding assistant. [SYS-DEV-BASE]';
const INSTR_TEXT = '你是 instructions 形态的系统提示词 [SYS-INSTR]';

function assistantsOf(sid: string): any[] {
  const file = sessionFilePath(sid);
  const rows = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  return rows.filter((r) => r.type === 'assistant');
}

function allRows(sid: string): any[] {
  const file = sessionFilePath(sid);
  return fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

beforeAll(() => {
  const lines = fs.readFileSync(FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
  for (const line of lines) {
    emit(JSON.parse(line));
  }
});

describe('codex-emitter: 系统提示词 wire 双形态捕获', () => {
  it('developer 消息（0.161 真机形态）→ system 扩展字段，顶层与 x_cannbay 双轨一致', () => {
    const [a] = assistantsOf('cpx-codex-sys-dev');
    expect(a.system).toBe(DEV_TEXT);
    expect(a.x_cannbay.data.system).toBe(DEV_TEXT);
    // tools 同行落盘（readFullContext 的 foundExt 触发条件）
    expect(a.tools.map((t: any) => t.name)).toEqual(['exec_command']);
    expect(a.x_cannbay.data.tools.map((t: any) => t.name)).toEqual(['exec_command']);
  });

  it('developer 消息不进时间线（静态上下文非事件，D1 语义）', () => {
    const rows = allRows('cpx-codex-sys-dev');
    const users = rows.filter((r) => r.type === 'user');
    // input 三项：developer（丢）+ env_ctx 注入 + 用户 prompt → 时间线 2 行
    expect(users.length).toBe(2);
    expect(JSON.stringify(users.map((u) => u.message.content))).not.toContain('SYS-DEV-BASE');
    expect(JSON.stringify(users[1].message.content)).toContain('请分析当前仓库的架构');
  });

  it('instructions 字段存在时优先于 developer 派生', () => {
    const [a] = assistantsOf('cpx-codex-sys-instr');
    expect(a.system).toBe(INSTR_TEXT);
    expect(a.x_cannbay.data.system).toBe(INSTR_TEXT);
  });

  it('双缺省时不写 system 键（不产空串占位）', () => {
    const [a] = assistantsOf('cpx-codex-sys-none');
    expect('system' in a).toBe(false);
    expect(a.x_cannbay.data.system).toBeUndefined();
  });
});
