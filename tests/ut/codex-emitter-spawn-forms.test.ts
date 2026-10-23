// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex-emitter spawn 双形态 IT（0.162 真机 wire 演化，dumpC 全量核实）：
// 0.161 模型调 spawn_agent 传 input.message；0.162 模型从工具错误中学习，
// 失败链（message+items 双参被拒 → reasoning_effort 被拒）后只传
// fork_context+items——任务文本在 items 内的 user message 里。旧注册逻辑
// 只认 message，真机缺陷（39 请求的「复核员」子代理整线程误入主文件、
// 游标串扰重复发射、4 个 meta 富化全 null）。
// 本 IT 锁修复后的三条链：
//   A. 失败 message 形态注册任务 + 成功 items 形态 call_id 映射 → 富化打通
//   B. 纯 items 形态 spawn（从无 message 尝试，Aristotle 案例）→ 注册 +
//      路由 + 富化全链
//   C. 主线程文件隔离（两子代理的任务文本/轮次不进主文件）
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { emit } from '../../src/codex-emitter.ts';
import { sessionFilePath } from '../../src/writer.ts';

const SID = 'cpx-codex-spawn-forms';
const FIXTURE = path.resolve(__dirname, 'data/cpx-codex-spawn-forms.jsonl');
const TASK1 = '你是本仓库审计项目的「架构分析员」，负责阶段一架构分析。工作目录：/workspace/demo。';
const TASK2 = '你是本仓库审计项目的「复核员」，负责阶段五交叉复核。工作目录：/workspace/demo。';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-codex-spawn-'));
process.env.CONTEXT_PROXY_DIR = tmpDir; // BEFORE sessionFilePath 评估（模块级懒读）

const mainFile = sessionFilePath(SID);
const subagentsDir = path.join(tmpDir, SID, 'subagents');
const subId1 = 'sub-' + crypto.createHash('md5').update(TASK1).digest('hex').slice(0, 12);
const subId2 = 'sub-' + crypto.createHash('md5').update(TASK2).digest('hex').slice(0, 12);
const subFile1 = path.join(subagentsDir, `${subId1}.jsonl`);
const subFile2 = path.join(subagentsDir, `${subId2}.jsonl`);
const subMeta1 = path.join(subagentsDir, `${subId1}.meta.json`);
const subMeta2 = path.join(subagentsDir, `${subId2}.meta.json`);

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

describe('codex-emitter: spawn 任务文本双形态（0.161 message / 0.162 items）', () => {
  it('链 A：失败 message 形态注册任务 → 成功 items 形态同任务不重复注册（单 subId 单文件）', () => {
    expect(fs.existsSync(subFile1)).toBe(true);
    // 只有一个子代理文件对应任务 1（失败与成功两次 spawn 不产生两个登记）
    const files = fs.readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl'));
    expect(files).toHaveLength(2);
  });

  it('链 A 富化：成功 items 形态 call_id（非注册时的失败 call_id）的输出 → meta 拿到 agentId/nickname', () => {
    const meta = JSON.parse(fs.readFileSync(subMeta1, 'utf-8'));
    expect(meta.agentId).toBe('01aa-bb01-arch');
    expect(meta.nickname).toBe('Raman');
  });

  it('链 B：纯 items 形态 spawn（从无 message 尝试）→ 注册 + 路由进自己的文件', () => {
    // 旧实现：不注册 → 子代理线程身份匹配不上 → 误入主线程（真机 39 请求污染）
    expect(fs.existsSync(subFile2)).toBe(true);
    const rows2 = readJsonl(subFile2);
    // r0（任务 + 首响应）与 r1（第二轮）都在子代理文件里
    const texts = rows2.map((r) => JSON.stringify(r.message?.content ?? ''));
    expect(texts.some((t) => t.includes('开始交叉复核'))).toBe(true);
  });

  it('链 B 富化：纯 items 形态的 spawn 输出 → meta 拿到 agentId/nickname', () => {
    const meta = JSON.parse(fs.readFileSync(subMeta2, 'utf-8'));
    expect(meta.agentId).toBe('01aa-bb02-review');
    expect(meta.nickname).toBe('Aristotle');
  });

  it('链 C：主线程文件隔离——两子代理的任务文本不作为主线程 user 行出现', () => {
    const mainRows = readJsonl(mainFile);
    const userTexts = mainRows
      .filter((r) => r.type === 'user')
      .map((r) => (typeof r.message?.content === 'string' ? r.message.content : JSON.stringify(r.message?.content ?? '')));
    expect(userTexts.some((t) => t.includes('「架构分析员」'))).toBe(false);
    expect(userTexts.some((t) => t.includes('「复核员」'))).toBe(false);
  });

  it('链 C：子代理各自轮次连续（roundIndex 0,1 递增、跨线程不串扰）', () => {
    const rows1 = readJsonl(subFile1);
    const rounds1 = rows1
      .filter((r) => r.type === 'assistant')
      .map((r) => r.x_lake?.data?.roundIndex);
    expect(rounds1).toEqual([0, 1]);
    const rows2 = readJsonl(subFile2);
    const rounds2 = rows2.filter((r) => r.type === 'assistant').map((r) => r.x_lake?.data?.roundIndex);
    expect(rounds2).toEqual([0]);
  });

  it('失败 spawn 的错误输出仍是主线程 verbatim 事件（不吞、不误富化）', () => {
    const mainRows = readJsonl(mainFile);
    const failOut = mainRows.some((r) => JSON.stringify(r.message?.content ?? '').includes('Provide either message or items'));
    expect(failOut).toBe(true);
    // 错误输出不含 agent_id → 不触发富化（meta 的 agentId 只来自成功输出）
    const meta1 = JSON.parse(fs.readFileSync(subMeta1, 'utf-8'));
    expect(meta1.agentId).toBe('01aa-bb01-arch');
  });
});
