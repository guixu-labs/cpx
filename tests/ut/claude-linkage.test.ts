// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// claude-linkage IT：派发关联的跨进程自愈。
//
// 根治现场（solo:8ae4a944）：关联状态曾全在进程内存，会话跨多代理进程时
// 内存回填态失守 → 子代理 meta 三字段全空 → insight 建桥三路全断。
// 本文件验证新架构的三条自愈路径：
//   ① 盘上重放种子：新进程首见会话即从捕获文件重建派发登记
//   ② 挂起 meta 补链：盘上 meta 即挂起状态，新派发到场/重启扫描即补
//   ③ 成员头跨进程稳定：x-claude-code-agent-id 经 meta 落盘，续会路由不散

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emit } from '../../src/claude-emitter.ts';
import { compressCaptureFile, sessionFilePath } from '../../src/writer.ts';
import { resetLinkageForTests } from '../../src/claude-linkage.ts';

const SID = 'cpx-linkage-heal';
let tmpDir: string;
let subagentsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-linkage-'));
  process.env.CONTEXT_PROXY_DIR = tmpDir;
  subagentsDir = path.join(tmpDir, SID, 'subagents');
  resetLinkageForTests(); // 每用例 = 新代理进程
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetLinkageForTests();
});

const TASK = '统计目录布局并给出迁移建议';
const AGENT_ID = 'a1b2c3d4e5f60789';

interface RecOpts {
  agentId?: string | null;
  task?: string | null;
}
// 子代理记录：msgs[0] 即任务文本（task=null 模拟 compact 改写后的续会）
function subRec({ agentId = AGENT_ID, task = TASK }: RecOpts = {}) {
  return {
    sid: SID,
    receivedAt: Date.now(),
    completedAt: Date.now(),
    request: {
      claudeAgentId: agentId,
      body: {
        system: [{ type: 'text', text: 'main system cc_is_subagent=true' }],
        tools: [{ name: 'Read' }],
        messages: task ? [{ role: 'user', content: [{ type: 'text', text: task + '\n' }] }] : [],
      },
    },
    response: { status: 200, model: 'glm-5.2', stop_reason: 'end_turn', content: [], usage: { input_tokens: 1, output_tokens: 1 } },
  };
}
// 父响应：Agent tool_use（携带派发三要素）
function dispatchRec(prompt = TASK, toolUseId = 'toolu_heal_1') {
  return {
    sid: SID,
    receivedAt: Date.now(),
    completedAt: Date.now(),
    request: {
      body: {
        system: [{ type: 'text', text: 'main system' }],
        tools: [{ name: 'Agent' }],
        messages: [{ role: 'user', content: 'go' }],
      },
    },
    response: {
      status: 200, model: 'glm-5.2', stop_reason: null,
      content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description: '统计目录布局', subagent_type: 'Explore', prompt } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}
function metaOf(subId: string): any | null {
  const p = path.join(subagentsDir, `${subId}.meta.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
}
function subFiles(): string[] {
  return fs.existsSync(subagentsDir) ? fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl')) : [];
}
// 复刻 cpx 的 subId 派生（sub-<md5(task) 前 12 位>）
function subIdOf(task: string): string {
  return 'sub-' + crypto.createHash('md5').update(task).digest('hex').slice(0, 12);
}

describe('claude-linkage：跨进程自愈', () => {
  it('盘上重放种子：P1 只写了派发行就重启，P2 首条子记录直接带全 meta', () => {
    // P1：父响应先落盘（派发行在主捕获里），子代理尚未发出请求
    emit(dispatchRec(TASK));
    resetLinkageForTests(); // P1 崩溃，P2 接管

    // P2：子记录首至——登记来自盘上重放，首写 meta 即完整
    emit(subRec());
    const subId = subIdOf(TASK);
    const meta = metaOf(subId);
    expect(meta).not.toBeNull();
    expect(meta.toolUseId).toBe('toolu_heal_1');
    expect(meta.name).toBe('统计目录布局');
    expect(meta.agentType).toBe('Explore');
    expect(meta.task).toBe(TASK);
    expect(meta.claudeAgentId).toBe(AGENT_ID);
    expect(meta.idSource).toBe('fileStem');
    expect(meta.x_lake.schema).toBe('cc-subagent-meta');
    expect(meta.x_lake.data.toolUseId).toBe('toolu_heal_1');
    expect(meta.x_lake.data.idSource).toBe('fileStem');
  });

  it('挂起 meta 补链：P1 写下 null meta 后崩溃，P2 的父响应到场即补链', () => {
    // P1：异步派发——子记录先至，meta 挂起（null），父响应永远没到 P1
    emit(subRec());
    const subId = subIdOf(TASK);
    expect(metaOf(subId).toolUseId).toBeNull();
    resetLinkageForTests(); // P1 崩溃（pendingSubMeta 失守——旧架构在此处永久失联）

    // P2：父响应到场。bootstrap 从盘上 meta 找到挂起态，派发登记后立即补链
    emit(dispatchRec(TASK));
    const meta = metaOf(subId);
    expect(meta.toolUseId).toBe('toolu_heal_1');
    expect(meta.name).toBe('统计目录布局');
    expect(meta.agentType).toBe('Explore');
    expect(meta.task).toBe(TASK);
  });

  it('老版本遗留 meta（无 task 字段）：重启后从捕获文件回读任务键补链', () => {
    // P1 写派发行 + 旧格式 meta（三字段 null、无 task/claudeAgentId/idSource）
    emit(dispatchRec(TASK));
    const subId = subIdOf(TASK);
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(subagentsDir, `${subId}.jsonl`), JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: TASK }] },
      timestamp: new Date().toISOString(),
    }) + '\n');
    fs.writeFileSync(path.join(subagentsDir, `${subId}.meta.json`), JSON.stringify({
      toolUseId: null, name: null, agentType: null,
      x_lake: { schema: 'cc-subagent-meta', version: 1, data: { toolUseId: null, name: null, agentType: null, subagentSessionId: subId } },
    }));
    resetLinkageForTests();

    // P2：任意一条会话记录触发 bootstrap → 扫描补链（无需等子记录）
    emit(dispatchRec(TASK, 'toolu_replay_probe'));
    const meta = metaOf(subId);
    expect(meta.toolUseId).toBe('toolu_heal_1'); // 首见优先：重试派发不夺锚
    expect(meta.name).toBe('统计目录布局');
    expect(meta.agentType).toBe('Explore');
    expect(meta.task).toBe(TASK);
    expect(meta.idSource).toBe('fileStem');
  });

  it('成员头跨进程稳定：续会（compact 后 msgs[0] 变形）按 meta.claudeAgentId 路由回原文件', () => {
    emit(subRec()); // P1：首记录（task 全文），meta 落盘
    const subId = subIdOf(TASK);
    const fileBefore = path.join(subagentsDir, `${subId}.jsonl`);
    const linesBefore = fs.readFileSync(fileBefore, 'utf-8').split('\n').filter(Boolean).length;
    resetLinkageForTests();

    // P2：续会请求 msgs[0] 已被 compact 改写（无任务文本）——头索引从盘上
    // meta 种子，路由回原成员文件（旧行为：sub-unknown 新文件）
    emit(subRec({ task: null }));
    const files = subFiles();
    expect(files).toContain(`${subId}.jsonl`);
    expect(files.every(f => f === `${subId}.jsonl`)).toBe(true); // 无 sub-unknown 散落
    const linesAfter = fs.readFileSync(fileBefore, 'utf-8').split('\n').filter(Boolean).length;
    expect(linesAfter).toBeGreaterThan(linesBefore); // 续会记录追加进了原文件
    // meta 不被续会污染（首任务定格）
    expect(metaOf(subId).task).toBe(TASK);
  });

  it('meta 升级不覆写：claudeAgentId 后到只补空位，已有字段不动', () => {
    // P1：无头的子记录（旧客户端形态）
    emit(subRec({ agentId: null }));
    const subId = subIdOf(TASK);
    expect(metaOf(subId).claudeAgentId).toBeNull();
    // 同一子代理带了头的续会 → 补 claudeAgentId，其余字段保持
    emit(subRec());
    const meta = metaOf(subId);
    expect(meta.claudeAgentId).toBe(AGENT_ID);
    expect(meta.task).toBe(TASK);
    expect(meta.toolUseId).toBeNull(); // 派发仍未到场，不虚构
  });

  it('主捕获 .7z 压缩态（resume 生命周期）：重放透明解压', () => {
    emit(dispatchRec(TASK));
    compressCaptureFile(sessionFilePath(SID)); // 会话关闭压缩
    resetLinkageForTests();

    emit(subRec()); // resume：重放从 .7z 读派发行
    expect(metaOf(subIdOf(TASK)).toolUseId).toBe('toolu_heal_1');
  });
});
