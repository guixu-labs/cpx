// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex-emitter 线程模型单测：主线程与子代理线程共用一个 proxy 端口、一个 sid、
// 无 header 信号——路由完全靠「首条非注入 user 消息 ↔ spawn_agent 任务文本」
// 逐字节匹配（真机 codex 0.161 核实的信号链）。fixture 模拟：
//   rec1 main r0（用户 prompt）
//   rec2 main r1（响应含 spawn_agent tool_use → 登记派发）
//   rec3 sub  r0（input=[env_ctx 注入, 任务文本] → 路由进子代理文件）
//   rec4 sub  r1（子代理自己的 exec 工具轮）
//   rec5 main r2（input 含 spawn 的 function_call_output {agent_id,nickname}
//                → 子代理 meta 富化重写 + subagent_notification 事件）
// 关键回归：旧实现 contextKey='main' 硬编码——子代理 input 被主线程游标吞掉、
// roundIndex 串扰；本测试钉死两线程的文件隔离与各自独立的轮次号。

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { emit } from '../../src/codex-emitter.ts';
import { sessionFilePath, sessionMetaPath } from '../../src/writer.ts';

const SID = 'cpx-codex-thread';
const FIXTURE = path.resolve(__dirname, 'data/cpx-codex-thread.jsonl');
const TASK_TEXT = '你是资料整理助手 Cartographer。工作目录：/workspace/demo。请整理 docs 目录的资料并输出摘要。';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-codex-emit-'));
process.env.CONTEXT_PROXY_DIR = tmpDir; // BEFORE sessionFilePath 评估（模块级懒读）

const mainFile = sessionFilePath(SID);
const subagentsDir = path.join(tmpDir, SID, 'subagents');
const subId = 'sub-' + crypto.createHash('md5').update(TASK_TEXT).digest('hex').slice(0, 12);
const subFile = path.join(subagentsDir, `${subId}.jsonl`);
const subMetaFile = path.join(subagentsDir, `${subId}.meta.json`);

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

describe('codex-emitter: 线程路由（spawn 任务文本指纹）', () => {
  it('子代理文件落在 <sid>/subagents/<subId>.jsonl（claude 约定布局）', () => {
    expect(fs.existsSync(subFile)).toBe(true);
    expect(fs.existsSync(subagentsDir)).toBe(true);
  });

  it('主线程文件不含子代理的任务文本/工具轮（游标隔离）', () => {
    const rows = readJsonl(mainFile);
    const userTexts = rows.filter((r) => r.type === 'user').map((r) =>
      typeof r.message?.content === 'string' ? r.message.content : JSON.stringify(r.message?.content));
    for (const t of userTexts) {
      expect(t).not.toContain('Cartographer');
      expect(t).not.toContain('ls docs');
    }
  });

  it('子代理文件不含主线程的用户 prompt / 通知（反向隔离）', () => {
    const rows = readJsonl(subFile);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('请并行派发一个子代理整理资料');
    expect(text).not.toContain('<subagent_notification>');
    expect(text).not.toContain('call-spawn-1'); // spawn 输出属于主线程
  });
});

describe('codex-emitter: 每线程独立轮次号与 delta-emit', () => {
  it('主线程：注入 verbatim + user prompt r0、spawn tool_result r2、assistant r0/r1/r2', () => {
    const rows = readJsonl(mainFile);
    const users = rows.filter((r) => r.type === 'user');
    // rec1: env_ctx 注入 + user prompt（捕获 verbatim 原则——注入分类是
    // insight 适配器的职责，proxy 只记录）；rec5: spawn tool_result +
    // subagent_notification（r2）
    expect(users.length).toBe(4);
    expect(JSON.stringify(users[0].message.content)).toContain('<environment_context>');
    expect(users[1].message.content).toEqual([{ type: 'text', text: '请并行派发一个子代理整理资料' }]);
    expect(users[1].x_lake.data.roundIndex).toBe(0);
    expect(users[1].x_lake.data.kind).toBe('user');
    const toolResults = users.filter((u) => Array.isArray(u.message.content) && u.message.content[0]?.type === 'tool_result');
    expect(toolResults.length).toBe(1);
    expect(toolResults[0].message.content[0].tool_use_id).toBe('call-spawn-1');
    expect(toolResults[0].x_lake.data.roundIndex).toBe(2);
    expect(toolResults[0].x_lake.data.kind).toBe('tool-result');
    // subagent_notification 事件注入保留（system turn 语义在 insight 侧落）
    const notification = users.find((u) => JSON.stringify(u.message.content).includes('<subagent_notification>'));
    expect(notification).toBeTruthy();
    expect(notification!.x_lake.data.roundIndex).toBe(2);

    const assistants = rows.filter((r) => r.type === 'assistant');
    expect(assistants.map((a) => a.x_lake.data.roundIndex)).toEqual([0, 1, 2]);
  });

  it('子代理：注入 + 任务文本 r0、exec tool_result r1、assistant r0/r1', () => {
    const rows = readJsonl(subFile);
    const users = rows.filter((r) => r.type === 'user');
    expect(users.length).toBe(3);
    expect(JSON.stringify(users[0].message.content)).toContain('<environment_context>');
    expect(users[1].message.content).toEqual([{ type: 'text', text: TASK_TEXT }]);
    expect(users[1].x_lake.data.roundIndex).toBe(0);
    const toolResult = users.find((u) => Array.isArray(u.message.content) && u.message.content[0]?.type === 'tool_result');
    expect(toolResult!.message.content[0].tool_use_id).toBe('call-exec-1');
    expect(toolResult!.x_lake.data.roundIndex).toBe(1);

    const assistants = rows.filter((r) => r.type === 'assistant');
    expect(assistants.map((a) => a.x_lake.data.roundIndex)).toEqual([0, 1]);
    // spawn_agent tool_use 在主线程 r1 的 assistant 行里（泳道桥接信号）
    const mainRows = readJsonl(mainFile);
    const spawnAssistant = mainRows.filter((r) => r.type === 'assistant')[1];
    const toolUse = (spawnAssistant.message.content as any[]).find((b) => b.type === 'tool_use');
    expect(toolUse?.name).toBe('spawn_agent');
    expect(toolUse?.input?.message).toBe(TASK_TEXT);
  });

  it('thinking 块与 reasoning tokens 透传（reassembler 产物的捕获保真）', () => {
    const rows = readJsonl(mainFile);
    const a0 = rows.filter((r) => r.type === 'assistant')[0];
    expect((a0.message.content as any[])[0]?.type).toBe('thinking');
    expect(a0.message.usage?.reasoning_tokens).toBe(30);
  });
});

describe('codex-emitter: 子代理 meta 派发关联', () => {
  it('meta.json 携带 spawn 输出富化的 agent_id/nickname（晚到重写）', () => {
    expect(fs.existsSync(subMetaFile)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(subMetaFile, 'utf-8'));
    expect(meta.toolUseId).toBe('call-spawn-1');
    expect(meta.name).toBe('Volta');
    expect(meta.agentId).toBe('0199aa11-bb22-cc33-dd44-ee55ff660000');
    expect(meta.x_lake.schema).toBe('cc-subagent-meta');
    expect(meta.x_lake.data.subagentSessionId).toBe(subId);
    expect(meta.x_lake.data.nickname).toBe('Volta');
  });

  it('会话 meta 标记 framework=codex / protocol=responses', () => {
    const meta = JSON.parse(fs.readFileSync(sessionMetaPath(SID), 'utf-8'));
    expect(meta.x_lake.data.framework).toBe('codex');
    expect(meta.x_lake.data.protocol).toBe('responses');
  });
});
