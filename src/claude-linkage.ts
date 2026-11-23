// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// claude-linkage: claude 捕获的「派发 ↔ 子代理」关联状态。
//
// 为什么独立成模块（历史教训）：关联状态曾全部活在 claude-emitter 的进程
// 内存（agentDispatch / pendingSubMeta / subIdForAgentId / metaWritten），
// 会话跨多代理进程（resume / 长会话重启）时内存回填态失守 → 子代理
// meta.json 三字段全空且永不升级 → insight 建桥三路全断，子代理成孤儿
//（现场 solo:8ae4a944：44 派发 2 孤儿，$244 成本 195 turns 无归属）。
//
// 本模块的架构原则：**盘上捕获文件是唯一真源**。
//   · 派发登记表（prompt → toolUseId/name/type）——进程启动时从主/子捕获
//     jsonl 重放种子，wire 到场只做增量；不另造登记文件，无双写一致性问题。
//   · 子代理 meta.json——幂等升级写（null → 有值，永不覆写非空字段），
//     盘上 meta 即挂起状态，重启后扫描补链。
//   · claude 逻辑成员身份（x-claude-code-agent-id 头）落盘 meta，续会
//     路由与 insight 建桥都以它为跨进程稳定键。
//
// 由此进程重启天然自愈：新进程首见会话 → 重放登记 → 扫描挂起 meta →
// 补链完成；此后的 wire 增量与重放同构（同一提取函数、同一键归一）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  sessionFilePath,
  subagentFilePath,
  subagentsDirPath,
  subagentMetaPath,
  forEachCaptureLine,
  writeMeta,
} from './writer';
import { readEnvelopeWithLegacy } from './envelope';

export interface DispatchInfo {
  toolUseId: string | null;
  name: string | null;
  type: string | null;
}

interface SubagentMetaSnapshot {
  toolUseId: string | null;
  name: string | null;
  agentType: string | null;
  /** x-claude-code-agent-id 头（claude 逻辑成员身份；关联别名，不顶替规范 subId）。 */
  claudeAgentId: string | null;
  /** 派发任务文本（trim 归一）——升级写的安全键：后续请求 msgs[0] 被
   * compact 改写时，不用新文本去查别的派发（防错链）。 */
  task: string | null;
  subagentSessionId: string | null;
}

// dsh 的派发工具名归一（'subagent' → 'Agent'）：只对 dsh 生效——claude 路径
// 精确匹配 'Agent'，同名(subagent)的自定义/MCP 工具不改名。emitter 落盘前已
// 按此改写 dsh 派发，重放读到即 'Agent'，无需再归一。
export const DISPATCH_TOOL_ALIAS: Record<string, string> = { subagent: 'Agent' };

// ── 任务文本提取（request body 与捕获文件双场景共用）──────────────────
// 首条用户消息里的真实任务文本：system-reminder / stepped-away 块跳过，
// 其余首块 trim 归一。派发收集（tool_use.prompt）、子代理路由（subId 分桶）、
// meta 升级写（task 安全键）三处同键——键归一必须单点实现。
export function subagentTaskTextOf(content: string | Array<{ type?: string; text?: string }> | undefined | null): string | null {
  if (typeof content === 'string') {
    const t = content.trim();
    return (t && !t.startsWith('<system-reminder>') && !t.startsWith('The user stepped away')) ? t : null;
  }
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (b?.type !== 'text' || !b.text) continue;
    const t = b.text.trim();
    if (!t || t.startsWith('<system-reminder>') || t.startsWith('The user stepped away')) continue;
    return t;
  }
  return null;
}

// subId = sub-<md5(task) 前 12 位>：纯派生（同任务必同 id，天然幂等）。
// 模块级缓存只省 md5，不承载任何需要自愈的状态。
const subIdForTask = new Map<string, string>();
export function subIdFor(task: string): string {
  let id = subIdForTask.get(task);
  if (!id) {
    id = 'sub-' + crypto.createHash('md5').update(task).digest('hex').slice(0, 12);
    subIdForTask.set(task, id);
  }
  return id;
}

// ── 捕获文件读取（重放/任务提取共用的最小解析）───────────────────────
// 原语在 writer.forEachCaptureLine（emit-state 的盘上重建同源共用）：
// 只解析目标类型行，坏行静默跳过：捕获重放宁缺毋滥，绝不阻断 emit。

// 从捕获文件重放 Agent 派发登记。落盘的 assistant 行携带 message.content
// tool_use 块（dsh 已别名成 Agent）；prompt.trim() 为键，首见优先（与 live
// 收集器的 first-wins 语义一致——同 prompt 重试不夺首发的 toolUseId）。
function collectDispatchesFromFile(file: string, into: Map<string, DispatchInfo>): void {
  forEachCaptureLine(file, (line) => {
    const l = line as { type?: string; message?: { content?: unknown } };
    if (l.type !== 'assistant' || !Array.isArray(l.message?.content)) return;
    for (const b of l.message!.content as Array<Record<string, unknown>>) {
      if (b?.type !== 'tool_use' || typeof b.input !== 'object' || b.input === null) continue;
      const name = typeof b.name === 'string' ? b.name : '';
      if (name !== 'Agent') continue;
      const inp = b.input as { description?: unknown; subagent_type?: unknown; prompt?: unknown };
      const key = typeof inp.prompt === 'string' ? inp.prompt.trim() : '';
      if (!key || into.has(key)) continue;
      into.set(key, {
        toolUseId: typeof b.id === 'string' ? b.id : null,
        name: typeof inp.description === 'string' ? inp.description : null,
        type: typeof inp.subagent_type === 'string' ? inp.subagent_type : null,
      });
    }
  });
}

// 子捕获文件的首个任务文本（挂起 meta 补链时的任务键来源——老版本 meta
// 不带 task 字段，真源回到捕获文件本身）。
function taskOfSubagentFile(file: string): string | null {
  let task: string | null = null;
  forEachCaptureLine(file, (line) => {
    const l = line as { type?: string; message?: { content?: unknown } };
    if (task || l.type !== 'user' || !l.message) return;
    task = subagentTaskTextOf(l.message.content as string | Array<{ type?: string; text?: string }> | undefined);
  });
  return task;
}

// ── meta.json 读写（幂等升级）────────────────────────────────────────
function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

// meta 双信封（x_lake 优先，legacy 键 fallback——读取器单点在 envelope.ts）。
// 字段缺失（老版本写的 meta）一律按 null 读入，升级写自然补齐。
function readMetaSnapshot(metaPath: string): SubagentMetaSnapshot | null {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const xb = readEnvelopeWithLegacy(meta);
  const data = xb?.schema === 'cc-subagent-meta' && typeof xb.version === 'number' ? xb.data : null;
  return {
    toolUseId: str(data?.toolUseId ?? meta.toolUseId),
    name: str(data?.name ?? meta.name),
    agentType: str(data?.agentType ?? meta.agentType),
    claudeAgentId: str(data?.claudeAgentId ?? meta.claudeAgentId),
    task: str(data?.task ?? meta.task),
    subagentSessionId: str(data?.subagentSessionId ?? meta.subagentSessionId),
  };
}

// 幂等升级写：patch 只补 null 位，绝不覆写非空字段。写全顶层旧字段 +
// x_lake 双信封（读方 x_lake 优先）。idSource:'fileStem' 是规范 id 语义
// 声明——claudeAgentId 只是关联别名，insight 侧据此不把文件名 id 顶替掉。
function writeMetaUpgraded(
  sid: string,
  subId: string,
  current: SubagentMetaSnapshot,
  patch: Partial<Pick<SubagentMetaSnapshot, 'toolUseId' | 'name' | 'agentType' | 'claudeAgentId' | 'task'>>,
): SubagentMetaSnapshot {
  const merged: SubagentMetaSnapshot = {
    toolUseId: current.toolUseId ?? patch.toolUseId ?? null,
    name: current.name ?? patch.name ?? null,
    agentType: current.agentType ?? patch.agentType ?? null,
    claudeAgentId: current.claudeAgentId ?? patch.claudeAgentId ?? null,
    task: current.task ?? patch.task ?? null,
    subagentSessionId: current.subagentSessionId ?? subId,
  };
  writeMeta(subagentMetaPath(sid, subId), {
    toolUseId: merged.toolUseId,
    name: merged.name,
    agentType: merged.agentType,
    claudeAgentId: merged.claudeAgentId,
    task: merged.task,
    idSource: 'fileStem',
    x_lake: {
      schema: 'cc-subagent-meta',
      version: 1,
      data: { ...merged, idSource: 'fileStem' },
    },
  });
  return merged;
}

// ── 会话级关联（每 sid 一个实例）──────────────────────────────────────
export class SessionLinkage {
  private dispatches = new Map<string, DispatchInfo>();
  private metaCache = new Map<string, SubagentMetaSnapshot>();
  private agentIdIndex = new Map<string, string>();
  private bootstrapped = false;

  constructor(private readonly sid: string) {}

  // 进程首见该会话：重放登记 → 种子成员索引 → 扫描补链。幂等。
  // 文件 IO 全部容错——关联自愈是尽力而为，绝不阻断捕获主路径。
  ensureBootstrapped(): void {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    try {
      collectDispatchesFromFile(sessionFilePath(this.sid), this.dispatches);
      const dir = subagentsDirPath(this.sid);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const m = entry.name.match(/^(.+)\.jsonl(\.7z|\.gz)?$/);
        if (!m) continue;
        const subId = m[1]!;
        // 子文件内的嵌套派发同样进登记（与旧内存收集器「全记录收集」语义一致）
        collectDispatchesFromFile(path.join(dir, entry.name), this.dispatches);
        const snap = this.metaEntry(subId);
        if (snap.claudeAgentId) this.agentIdIndex.set(snap.claudeAgentId, snap.subagentSessionId ?? subId);
        if (!snap.toolUseId) this.healMetaFromCapture(subId, snap);
      }
    } catch (err) {
      console.error(`[cpx] linkage bootstrap 失败（忽略，捕获不受影响）: ${String(err)}`);
    }
  }

  // wire 观察到 Agent tool_use（主/子记录皆可）：登记未见的派发并立即补链
  // 挂起 meta（异步派发：子代理首轮请求先于父响应落盘——父响应到场时补）。
  observeDispatch(promptKey: string, info: DispatchInfo): void {
    if (this.dispatches.has(promptKey)) return;
    this.dispatches.set(promptKey, info);
    // 新派发可能对应早前挂起的 meta：补链
    this.syncPendingFromCache(promptKey);
  }

  // 子代理记录路由：成员头索引（跨进程稳定）> 任务 md5 分桶 > sub-unknown。
  resolveSubId(task: string | null, agentId: string | null): string {
    if (agentId) {
      const known = this.agentIdIndex.get(agentId);
      if (known) return known;
      const subId = task ? subIdFor(task) : 'sub-unknown';
      this.agentIdIndex.set(agentId, subId);
      return subId;
    }
    return task ? subIdFor(task) : 'sub-unknown';
  }

  // 子代理记录 emit：确保 meta 存在且携带已知信息（幂等，首任务定格）。
  ensureMeta(subId: string, task: string | null, agentId: string | null): void {
    try {
      const snap = this.metaEntry(subId);
      const patch: Partial<SubagentMetaSnapshot> = {};
      const taskKey = snap.task ?? task;
      const d = taskKey ? this.dispatches.get(taskKey) : undefined;
      if (d) {
        if (!snap.toolUseId && d.toolUseId) patch.toolUseId = d.toolUseId;
        if (!snap.name && d.name) patch.name = d.name;
        if (!snap.agentType && d.type) patch.agentType = d.type;
      }
      if (!snap.task && task) patch.task = task;
      if (!snap.claudeAgentId && agentId) patch.claudeAgentId = agentId;
      if (Object.keys(patch).length > 0) {
        this.metaCache.set(subId, writeMetaUpgraded(this.sid, subId, snap, patch));
      }
    } catch (err) {
      console.error(`[cpx] 子代理 meta 写入失败（忽略，捕获不受影响）: ${String(err)}`);
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  // meta 快照：进程内缓存，首触从盘读（重启后的首条子代理记录即盘上真源）。
  private metaEntry(subId: string): SubagentMetaSnapshot {
    let snap = this.metaCache.get(subId);
    if (!snap) {
      snap = readMetaSnapshot(subagentMetaPath(this.sid, subId)) ?? {
        toolUseId: null, name: null, agentType: null, claudeAgentId: null, task: null, subagentSessionId: null,
      };
      this.metaCache.set(subId, snap);
    }
    return snap;
  }

  // 挂起 meta 补链：任务键（meta.task，老版本 meta 回捕获文件首条用户行）查登记。
  private healMetaFromCapture(subId: string, snap: SubagentMetaSnapshot): void {
    const task = snap.task ?? taskOfSubagentFile(subagentFilePath(this.sid, subId));
    if (!task) return;
    const d = this.dispatches.get(task);
    if (!d || !d.toolUseId) return;
    const patch: Partial<SubagentMetaSnapshot> = { toolUseId: d.toolUseId };
    if (!snap.task) patch.task = task;
    if (!snap.name && d.name) patch.name = d.name;
    if (!snap.agentType && d.type) patch.agentType = d.type;
    this.metaCache.set(subId, writeMetaUpgraded(this.sid, subId, snap, patch));
  }

  // 新派发登记后，检查缓存里挂起（toolUseId null）且任务键恰为本派发的 meta。
  private syncPendingFromCache(promptKey: string): void {
    for (const [subId, snap] of this.metaCache) {
      if (snap.toolUseId) continue;
      const task = snap.task;
      if (!task || task !== promptKey) continue;
      const d = this.dispatches.get(task)!;
      const patch: Partial<SubagentMetaSnapshot> = {};
      if (d.toolUseId) patch.toolUseId = d.toolUseId;
      if (!snap.name && d.name) patch.name = d.name;
      if (!snap.agentType && d.type) patch.agentType = d.type;
      if (Object.keys(patch).length > 0) {
        this.metaCache.set(subId, writeMetaUpgraded(this.sid, subId, snap, patch));
      }
    }
  }
}

// ── 进程级注册表（每 sid 惰性建实例）──────────────────────────────────
const linkages = new Map<string, SessionLinkage>();

export function linkageFor(sid: string): SessionLinkage {
  let l = linkages.get(sid);
  if (!l) {
    l = new SessionLinkage(sid);
    linkages.set(sid, l);
  }
  return l;
}

/** 测试专用：清空进程级关联态（模拟代理进程重启）。 */
export function resetLinkageForTests(): void {
  linkages.clear();
  subIdForTask.clear();
}
