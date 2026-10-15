// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 自定义派发工具（reuseDispatch 形态）的捕获侧回归锁：主会话 `subagent` 工具
// 派发（args {agent, description, prompt, sessionID}）不在旧白名单
// （task / name.includes('task')）内 → taskDispatch 收集不到 → 子会话 meta 的
// name/agentType 全空 → 下游 insight 名字链断（真机 ses_ecb797cb 全问号）。
// 白名单已扩 subagent 族（与 insight ingest/dispatch-tools.ts 注册表语义对齐）。

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emit } from '../../src/opencode-emitter.ts';
import { sessionFilePath } from '../../src/writer.ts';

const SID = 'sid-reuse';
const FIXTURE = path.resolve(__dirname, 'data/opencode-subagent-tool-records.jsonl');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-subagent-tool-'));
process.env.CANNBOT_PROXY_DIR = tmpDir; // BEFORE sessionFilePath is evaluated at module scope
const mainFile = sessionFilePath(SID);
const subagentsDir = path.join(tmpDir, SID, 'subagents');

function readJsonl(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

beforeAll(() => {
  const lines = fs.readFileSync(FIXTURE, 'utf-8').split('\n').filter(l => l.trim());
  for (const line of lines) {
    emit(JSON.parse(line));
  }
});

describe('opencode-emitter：自定义 subagent 派发工具的 meta 收集', () => {
  it('subagent 工具派发被收集：样板前缀失配时签名包含式回退命中，meta 带 name/agentType', () => {
    const metaFiles = fs.existsSync(subagentsDir)
      ? fs.readdirSync(subagentsDir).filter(f => f.endsWith('.meta.json'))
      : [];
    expect(metaFiles).toHaveLength(1);
    const meta = JSON.parse(fs.readFileSync(path.join(subagentsDir, metaFiles[0]), 'utf-8'));
    expect(meta.toolUseId).toBe('call_sub1');
    expect(meta.name).toBe('P1 需求分析');
    expect(meta.agentType).toBe('ascendc-ops-architect');
  });

  it('子会话 jsonl 正常落盘（首条 user 为样板前缀 + 派发 prompt——真机插件形态）', () => {
    const subFiles = fs.existsSync(subagentsDir)
      ? fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl'))
      : [];
    expect(subFiles).toHaveLength(1);
    const rows = readJsonl(path.join(subagentsDir, subFiles[0]));
    expect(rows.some(r => r.type === 'user' && String(r.message?.content).includes('请分析 P1 需求'))).toBe(true);
  });

  it('主会话派发行 verbatim 携带 subagent tool_use（args 含 sessionID 直连键）', () => {
    const dispatch = readJsonl(mainFile).find(r =>
      r.type === 'assistant' &&
      Array.isArray(r.message?.content) &&
      r.message.content.some((b: any) => b.type === 'tool_use' && b.name === 'subagent'),
    );
    expect(dispatch).toBeDefined();
    const block = dispatch.message.content.find((b: any) => b.type === 'tool_use' && b.name === 'subagent');
    expect(block.input).toMatchObject({
      agent: 'ascendc-ops-architect',
      description: 'P1 需求分析',
      prompt: '请分析 P1 需求文档，梳理算子 bn3d_training_update_grad 的语义与输入输出约束，并产出结构化分析报告',
      sessionID: 'ses_reuse_sub',
    });
  });
});
