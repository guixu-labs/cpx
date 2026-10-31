// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// claude-emitter: convert a captured wire-record (ProxyRecord) into claude's
// session-jsonl line format, so context-insight's existing claude-jsonl adapter
// + its native subagent pipeline (subagents/ + meta.json) can ingest the proxy's
// output with zero context-insight changes.
//
// Each ProxyRecord → delta-emit new user messages (incl. tool_result) as
// {type:"user"} lines + the response as one {type:"assistant"} line. The
// assistant line carries extension fields `system` + `tools` (verbatim
// request.body.system / request.body.tools) for the Full Context reader; the
// claude-jsonl adapter ignores these extra fields.
//
// Subagent records (cc_is_subagent=true) are routed to
// <PROXY_DIR>/<sid>/subagents/<subId>.jsonl + a one-time <subId>.meta.json
// carrying the spawning Agent tool_use's id (toolUseId) + name + agentType.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProxyRecord, Protocol, AnthropicContentBlock, AnthropicUsage, OpenAIUsage } from './types';
import { sessionFilePath, sessionMetaPath, subagentFilePath, subagentMetaPath, appendClaudeLine, writeMeta, PROXY_DIR } from './writer';
import { isSafeSid } from './session-resolver';

// x_lake 命名空间（docs/lake-schema-spec.md）：claude 原生字段是冻结
// 信封，扩展数据进带 (schema,version) 声明的口袋。legacy 顶层字段
// （source/duration_ms/system/tools/ttftMs/stopReason/version/deduped/
// originalChars）并存写 —— 读方一律 x_lake 优先。
function xLake(schema: string, data: Record<string, unknown>) {
  return { schema, version: 1, data };
}

// Hot switch: `cpx config dedup on|off` takes effect on a LIVE session. The
// config file is re-read on every emit (emit runs once per wire record —
// seconds apart — so the tiny read is free). The env var is an explicit
// override used by tests: '1'=on, '0'=off, unset=hot-read the file.
function dedupEnabled(): boolean {
  const env = process.env.CONTEXT_PROXY_DEDUP_INJECTION;
  if (env === '1') return true;
  if (env === '0') return false;
  try {
    const dir = process.env.CONTEXT_PROXY_DIR ?? PROXY_DIR;
    return JSON.parse(fs.readFileSync(path.join(path.dirname(dir), 'cpx-config.json'), 'utf-8')).dedupInjection === true;
  } catch {
    return false;
  }
}

// Provenance marker written on EVERY emitted line: the capture file stays a
// valid claude session jsonl (extra fields are ignored by consumers), but the
// file itself declares where it came from — so provenance survives any
// rename/move, independent of directory conventions. The marker KEEPS the
// original agent name (claude-proxy / opencode-proxy, by wire protocol).
// context-insight reads this at import time to label the session.
// claude-code 把版本号放在 system 的计费头里（x-anthropic-billing-header:
// cc_version=2.1.234.467; cc_entrypoint=cli;）—— 逐字捕获时顺手留存。
export function ccVersionFromSystem(system: string | AnthropicContentBlock[] | undefined): string | null {
  // 版本 token 形如 2.1.234.467 或 2.1.234.c19（数字+build hash），吃到 ; 为止
  const m = (extractSystemText(system) ?? '').match(/cc_version=([^;\s"']+)/);
  return m ? m[1].replace(/\.+$/, '') : null;
}

// 框架标签（cc-session-meta.framework / 行级 source 的归属维度）。
//
// 判定优先级：
//   1) **wire 自描述** —— 有 agent 会把自己的会话头随请求发出（dsh 就是：
//      body.dsh_session_log.session）。这是最可靠的：不依赖启动参数，
//      换设备 / 换启动方式都成立，也不需要 cpx-cli 知道具体 agent。
//   2) **环境变量覆盖** —— CONTEXT_PROXY_AGENT_FRAMEWORK。给"不自报名"的
//      agent 留的显式口子。
//   3) 默认 —— anthropic 协议默认族是 claude-code。
export function agentFrameworkLabel(body?: unknown): string {
  if (body !== undefined && readDshSessionHeader(body)) return 'dsh';
  const fw = process.env.CONTEXT_PROXY_AGENT_FRAMEWORK?.trim();
  return fw ? fw : 'claude-code';
}

export function proxySourceMarker(protocol: Protocol, body?: unknown): string {
  if (protocol === 'openai') return 'opencode-proxy';
  if (protocol === 'responses') return 'codex-proxy';
  const fw = agentFrameworkLabel(body);
  return fw === 'claude-code' ? 'claude-proxy' : `${fw}-proxy`;
}

interface RequestBody {
  messages?: { role: string; content?: string | AnthropicContentBlock[] }[];
  system?: string | AnthropicContentBlock[];
  tools?: unknown;
  temperature?: number;
  max_tokens?: number;
}

function extractSystemText(system: string | AnthropicContentBlock[] | undefined): string | null {
  if (!system) return null;
  if (typeof system === 'string') return system || null;
  const parts: string[] = [];
  for (const b of system) {
    if (b.type === 'text' && b.text) parts.push(b.text);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

// The reassembler (AnthropicReassembler / OpenAIReassembler) already normalizes
// wire usage to Anthropic shape ({input_tokens, output_tokens,
// cache_read_input_tokens, cache_creation_input_tokens}). Pass it through
// verbatim — re-mapping here would double-convert and zero OpenAI-protocol
// usage (see opencode-emitter). For claude (anthropic) this is a no-op.
function mapUsage(usage: AnthropicUsage | OpenAIUsage | null): AnthropicUsage | undefined {
  if (!usage) return undefined;
  return usage as AnthropicUsage;
}

function isTitleGenRecord(rec: ProxyRecord): boolean {
  const body = rec.request.body as RequestBody | null;
  const sysText = extractSystemText(body?.system);
  return !!sysText && sysText.includes('sentence-case title');
}

// ═══════════════════════════════════════════════════════════════════════════
// dsh(DeepSeek Harness)扩展区块
//
// 为什么在这里:dsh 与 claude-code 共用 Anthropic Messages 协议,而路由
// (server.ts dispatchEmit)是**按协议**选 emitter —— 所以 dsh 的捕获也进这里。
// 这是本仓既有的模式:cannbot 同样共用 opencode-emitter(靠 userAgent 区分)。
//
// 本区块只做两件事,**不碰 claude 的既有路径**(native 路径必须逐字节不变):
//   ① 从 body.dsh_session_log 判出"这是 dsh"并取血缘
//      —— 用于框架标签(dsh / dsh-proxy)与子代理归属
//   ② 把 dsh 子代理落到 <父sid>/subagents/<子sid>.jsonl(与 claude 同布局)
//
// ⚠️ 拆分触发点 —— 满足任一条,就把本区块整体抽到 framework/dsh.ts:
//   · 有【第 3 个】框架要进 claude-emitter(或 opencode-emitter)
//     —— 两个是特例,三个才是模式
//   · 本区块超过 ~200 行 —— 占比过大,emitter 不再"主要是协议转换"
//   · 出现"改 claude 分支误伤 dsh"的 bug —— 隔离失效的实证
//
// 目标形态:抽 framework/ 适配层(claude.ts / dsh.ts / index.ts),emitter 只留
// "协议 → claude 格式"的转换,由 adapter 提供 { isSubagent, parentSid,
// subagentId, subagentName, toolAlias }。详见 README「框架扩展」。
// ═══════════════════════════════════════════════════════════════════════════
//
// dsh 把【会话头】作为私有扩展字段随每个请求发出去:
//   body.dsh_session_log.session = { id, parentSession, origin, delegationDepth, ... }
// 这是 dsh 官方代码(dsh-session-log-deepseek 的 wireHeader())序列化的
// session.header —— 和它写进原生日志的是同一个对象,因此是【权威】血缘来源。
//
// 注意:它不是 HTTP header,而是 HTTP body 里的一个 JSON 字段;
// dsh 的 HTTP header 里没有任何 parent 标识(实测)。
//
// 子会话的 sid 是它【自己】的(x-deepseek-harness-session-id),
// 而我们要把它的记录写进 <父sid>/subagents/<子sid>.jsonl —— 这正是
// insight 的 listSubagentSessions() 期待的布局。

/** 工具名归一:insight 的 bridge-builder 只认 task/Agent;
 *  dsh 的派发工具叫 subagent —— 在落盘时翻译,不改 insight。 */
const DISPATCH_TOOL_ALIAS: Record<string, string> = { subagent: 'Agent' };

interface DshSessionHeader {
  id?: string;
  parentSession?: string;
  origin?: string;
  delegationDepth?: number;
  agentPreset?: string;
}

interface DshSubagentDescriptor {
  label?: string;
  mode?: string;
  provider?: string;
  agentModel?: string;
}

/** 从请求体读 dsh 的会话头(血缘权威来源);非 dsh 请求返回 null。 */
function readDshSessionHeader(body: unknown): DshSessionHeader | null {
  const session = (body as { dsh_session_log?: { session?: unknown } } | null)?.dsh_session_log?.session;
  if (!session || typeof session !== 'object') return null;
  return session as DshSessionHeader;
}

/** 从 dsh 会话日志的增量事件里取 subagent/descriptor(带 label = 子代理名)。 */
function readDshSubagentDescriptor(body: unknown): DshSubagentDescriptor | null {
  const events = (body as { dsh_session_log?: { events?: unknown } } | null)?.dsh_session_log?.events;
  if (!Array.isArray(events)) return null;
  for (const e of events) {
    const ev = e as { type?: string; data?: unknown };
    if (ev?.type === 'subagent/descriptor' && ev.data && typeof ev.data === 'object') {
      return ev.data as DshSubagentDescriptor;
    }
  }
  return null;
}

function isSubagentRecord(rec: ProxyRecord): boolean {
  const body = rec.request.body as RequestBody | null;
  const sysText = extractSystemText(body?.system);
  return !!sysText && sysText.includes('cc_is_subagent=true');
}

// The subagent's task prompt = first non-system-reminder text block of its
// first user message. Identical to the spawning Agent tool_use input.prompt,
// so it groups a subagent's records + correlates to the dispatch meta.
function subagentTask(rec: ProxyRecord): string | null {
  const body = rec.request.body as RequestBody | null;
  const msgs = body?.messages;
  if (!msgs || !msgs.length) return null;
  const m0 = msgs[0];
  if (m0.role !== 'user') return null;
  // trim 归一：真机子代理任务块带尾随换行，而父侧 Agent tool_use 的
  // prompt 无——原始字符串建键必然失配（派发收集/回填/subId 分桶同键）
  if (typeof m0.content === 'string') {
    const t = m0.content.trim();
    return (t && !t.startsWith('<system-reminder>') && !t.startsWith('The user stepped away')) ? t : null;
  }
  if (Array.isArray(m0.content)) {
    for (const b of m0.content) {
      if (b.type !== 'text' || !b.text) continue;
      const tr = b.text.trim();
      if (!tr || tr.startsWith('<system-reminder>') || tr.startsWith('The user stepped away')) continue;
      return tr;
    }
  }
  return null;
}

// --- per-proxy-process state (one cpx run = one proxy process) ---
// Delta-emit by OCCURRENCE COUNT, not by array length: claude-code rewrites
// the messages array on stepped-away recaps / edits / compaction, so a
// message-count cursor silently skips new messages that land inside the
// already-consumed range. A multiset (hash → emitted count) detects new
// messages regardless of rewrite, shrink, or same-length reordering.
const emittedCounts = new Map<string, Map<string, number>>(); // contextKey → hash → emitted count
// contextKey → md5 fingerprints of injection system messages emitted IN FULL
const emittedInjections = new Map<string, Set<string>>();
const agentDispatch = new Map<string, { toolUseId: string | null; name: string | null; type: string | null }>();
const subIdForTask = new Map<string, string>();
// agent-id 头 → subId（首见时登记；续会请求带头再来 → 命中同 subId → 同文件
// 追加 + 继承 meta 归属）。头是 claude 逻辑成员级身份，跨重启稳定（实验验证
// x-claude-code-agent-id 仅子代理请求携带）；缺失时回落 prompt 分桶不劣化。
const subIdForAgentId = new Map<string, string>();
const metaWritten = new Set<string>();
// 异步派发（后台 Agent，requestShape:background）：子代理首轮请求先于父响应
// 落盘（父 turn 仍在流式输出）→ 首写 meta 时 agentDispatch 尚无该派发，
// toolUseId/name/type 全 null。原生 harness 自己持有派发 id（原生 meta 后台
// 型也带 toolUseId），对齐之：未解析的 meta 挂起，派发在后续 emit 到达时
// 回填重写。write-once 只约束「创建」；挂起集以 subId 记父 sid + task。
const pendingSubMeta = new Map<string, { sid: string; task: string }>();
// contextKey → 已发出的 assistant 行数（= 该上下文的 wire 轮次号，cc-wire-round.roundIndex）
const roundCount = new Map<string, number>();
const sessionMetaWritten = new Set<string>();

function subIdFor(task: string): string {
  let id = subIdForTask.get(task);
  if (!id) {
    id = 'sub-' + crypto.createHash('md5').update(task).digest('hex').slice(0, 12);
    subIdForTask.set(task, id);
  }
  return id;
}

// 子代理 meta（cc-subagent-meta 双信封）单点写：创建与回填共用同一形态。
// meta 未解析（agentDispatch 缺项）时三字段 null，由调用方挂起待回填。
function writeSubagentMeta(
  sid: string,
  subId: string,
  meta: { toolUseId: string | null; name: string | null; type: string | null } | undefined,
): void {
  const toolUseId = meta?.toolUseId ?? null;
  const name = meta?.name ?? null;
  const agentType = meta?.type ?? null;
  const inner = { toolUseId, name, agentType, subagentSessionId: subId };
  writeMeta(subagentMetaPath(sid, subId), {
    toolUseId, name, agentType,
    x_lake: xLake('cc-subagent-meta', inner),
  });
}

function toISO(ts: number): string {
  return new Date(ts).toISOString();
}

// Joined text of a message content (string or text blocks).
function textOf(content: string | AnthropicContentBlock[] | undefined): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === 'text' && b.text) parts.push(b.text);
  }
  return parts.join('\n');
}

// An "injection" is the agent-registry / skills-list system message claude-code
// re-appends on later rounds. Identified by its opening line so ordinary
// system messages are never deduped.
function isInjectionText(text: string): boolean {
  return text.startsWith('Available agent types for the Agent tool')
    || text.startsWith('The following skills are available');
}

export function emit(rec: ProxyRecord): void {
  if (isTitleGenRecord(rec)) return;
  const body = rec.request.body as RequestBody | null;
  if (!body) return;
  const sid = rec.sid;
  const isSub = isSubagentRecord(rec);

  // Collect Agent-tool dispatch meta (prompt → {toolUseId, name, type}) from
  // ALL records (main + subagent) — a subagent that spawns its OWN subagent
  // emits that Agent tool_use inside an isSub record; gating on !isSub would
  // miss nested dispatches, leaving meta.json with null toolUseId/name/type.
  // Keyed by prompt (unique enough across contexts — each Agent tool_use has
  // a distinct task prompt).
  {
    const blocks = Array.isArray(rec.response.content) ? rec.response.content as AnthropicContentBlock[] : [];
    for (const b of blocks) {
      if (b.type !== 'tool_use' || b.name !== 'Agent' || !b.input) continue;
      const inp = b.input as { description?: string; subagent_type?: string; prompt?: string };
      const dispatchKey = inp.prompt?.trim();
      if (dispatchKey && !agentDispatch.has(dispatchKey)) {
        agentDispatch.set(dispatchKey, {
          toolUseId: b.id ?? null,
          name: inp.description ?? null,
          type: inp.subagent_type ?? null,
        });
      }
    }
  }

  // 异步派发回填：本轮收集到的新派发，补写此前挂起的子代理 meta
  for (const [subId, p] of pendingSubMeta) {
    const meta = agentDispatch.get(p.task);
    if (!meta) continue;
    pendingSubMeta.delete(subId);
    writeSubagentMeta(p.sid, subId, meta);
  }

  // Resolve context + target file.
  let contextKey: string;
  let targetFile: string;
  // dsh:血缘来自 body.dsh_session_log.session(权威),与 claude 的
  // cc_is_subagent 是两个互不影响的分支。
  const dshHeader = readDshSessionHeader(body);
  const rawDshParentSid = dshHeader?.parentSession ?? null;
  // parentSession 来自请求 body（不可信 wire 数据）,而它会进文件路径
  // （<父sid>/subagents/…）—— 必须先过 isSafeSid,与 header sid / claude 的
  // subId / dsh 的 childId 同一条纪律。非法时回落主会话分支并告警。
  const dshParentSid = isSafeSid(rawDshParentSid) ? rawDshParentSid : null;
  if (rawDshParentSid && !dshParentSid) {
    console.error(`[cpx] dsh parentSession 非法,已忽略并回落主会话分支: ${JSON.stringify(rawDshParentSid).slice(0, 80)}`);
  }
  const isDshSub = !!dshParentSid
    && (dshHeader?.origin === 'subagent' || (dshHeader?.delegationDepth ?? 0) > 0);

  if (isDshSub) {
    // dsh 子代理:子用自己的 sid,记录要落到【父】的 subagents 目录下,
    // 布局与 claude 完全一致 → insight 侧零改动即可发现。
    const childId = sid;
    contextKey = childId;
    targetFile = subagentFilePath(dshParentSid, childId);
    if (!metaWritten.has(childId)) {
      metaWritten.add(childId);
      const desc = readDshSubagentDescriptor(body);
      const name = desc?.label ?? null;
      const agentType = desc?.mode ?? desc?.provider ?? null;
      writeMeta(subagentMetaPath(dshParentSid, childId), {
        // 注:toolUseId 需要从【父侧】的 tool_result 推导,涉及跨请求状态与
        // 竞态回填;当前不做 —— 它只影响 dispatch 箭头的 tooltip 状态,
        // 目录发现与泳道图不依赖它。
        toolUseId: null,
        name,
        agentType,
        x_lake: xLake('cc-subagent-meta', {
          toolUseId: null,
          name, agentType, subagentSessionId: childId,
        }),
      });
    }
  } else if (!isSub) {
    contextKey = 'main';
    targetFile = sessionFilePath(sid);
    if (!sessionMetaWritten.has(sid)) {
      sessionMetaWritten.add(sid);
      writeMeta(sessionMetaPath(sid), {
        x_lake: xLake('cc-session-meta', {
          producer: 'cpx',
          framework: rec.protocol === 'openai' ? 'opencode' : agentFrameworkLabel(body),
          protocol: rec.protocol,
          ccVersion: ccVersionFromSystem(body.system),
          sid,
        }),
      });
    }
  } else {
    const task = subagentTask(rec);
    // 归属优先级：x-claude-code-agent-id 头（逻辑成员身份，续会继承）> 任务
    // prompt md5（现状分桶）。按头分桶时续会流直接落入原成员文件——原生
    // harness 把续会记回同一 agent 文件，此处分桶与之对齐
    // （claudeAgentId 类型即 string | null，入口 server.ts 已把 undefined 归一，
    //   消费侧不再需要 ?? null——运行时 undefined 与 null 同走 falsy 分支）
    const agentId = rec.request.claudeAgentId;
    let subId: string | null = agentId ? subIdForAgentId.get(agentId) ?? null : null;
    if (!subId) {
      subId = task ? subIdFor(task) : 'sub-unknown';
      if (agentId) subIdForAgentId.set(agentId, subId);
    }
    contextKey = subId;
    targetFile = subagentFilePath(sid, subId);
    if (task && !metaWritten.has(subId)) {
      metaWritten.add(subId);
      const meta = agentDispatch.get(task);
      writeSubagentMeta(sid, subId, meta);
      // 派发未到（异步先于父响应落盘）→ 挂起待回填
      if (!meta) pendingSubMeta.set(subId, { sid, task });
    }
  }

  // Delta-emit new non-assistant messages (user incl. tool_result, system).
  // Skip role:"assistant" — those are PRIOR responses already emitted as their
  // own rec's assistant line; re-emitting would duplicate. collectAllToolResults
  // reads tool_result from these user lines.
  //
  // Injection dedup (cpx config dedup, DEFAULT OFF, HOT — reads the config
  // file on every emit so toggling affects a live session): claude-code
  // re-appends an IDENTICAL agent-registry / skills-list system message on
  // later rounds. The FIRST copy is emitted in full; each later byte-identical
  // occurrence is replaced by a compact `[已压缩]` marker line carrying
  // originalChars, so the capture stays small while still recording that an
  // injection happened. Changed content is NOT deduped — it emits in full and
  // updates fingerprints. Fingerprints are tracked PER CONTEXT (main / each
  // subagent), so identical injections in different contexts are each kept in
  // full.
  const dedup = dedupEnabled();
  const msgs = body.messages ?? [];
  const counts = emittedCounts.get(contextKey) ?? new Map<string, number>();
  const seen = new Map<string, number>();
  const injections = dedup ? (emittedInjections.get(contextKey) ?? new Set<string>()) : new Set<string>();
  const markedInRound = new Set<string>(); // 每轮每个 fingerprint 只发一个 [已压缩] 标记
  for (const m of msgs) {
    if (m.role === 'assistant') continue;
    const hash = m.role + ':' + JSON.stringify(m.content ?? '');
    const occ = seen.get(hash) ?? 0;
    seen.set(hash, occ + 1);
    // Injection dedup: check fingerprint BEFORE the multiset skip. Otherwise
    // the multiset silently drops byte-identical injection re-sends (occ < counts)
    // before the fingerprint block runs → [已压缩] marker never emits, dedup
    // stats stay 0. Fingerprints only apply to role:'system' injection messages
    // (registry/skills); non-injection messages still use the multiset below.
    const injectionText = dedup && m.role === 'system' ? textOf(m.content) : null;
    const fingerprint = injectionText && isInjectionText(injectionText)
      ? crypto.createHash('md5').update(injectionText).digest('hex')
      : null;
    if (fingerprint && injections.has(fingerprint)) {
      if (markedInRound.has(fingerprint)) {
        // 同轮已发过 [已压缩] 标记，后续副本静默丢弃（不计入 counts，
        // 避免下一轮误判为「已发」而漏标）
        continue;
      }
      markedInRound.add(fingerprint);
      appendClaudeLine(targetFile, {
        type: 'system',
        message: { role: 'system', content: [{ type: 'text', text: `[已压缩] 注入上下文与之前一份完全相同（${injectionText!.length} chars），原文未重复记录` }] },
        timestamp: toISO(rec.receivedAt),
        deduped: true,
        originalChars: injectionText!.length,
        source: proxySourceMarker(rec.protocol, body),
        x_lake: xLake('cc-wire-input', {
          roundIndex: roundCount.get(contextKey) ?? 0,
          kind: 'dedup-placeholder',
          dedup: { originalChars: injectionText!.length, fingerprint },
        }),
      });
      counts.set(hash, occ + 1);
      continue;
    }
    // Multiset skip: non-injection duplicates already emitted (silent drop)
    if (occ < (counts.get(hash) ?? 0)) continue;
    appendClaudeLine(targetFile, {
      type: m.role === 'system' ? 'system' : 'user',
      message: { role: m.role, content: m.content ?? '' },
      timestamp: toISO(rec.receivedAt),
      source: proxySourceMarker(rec.protocol, body),
      x_lake: xLake('cc-wire-input', {
        roundIndex: roundCount.get(contextKey) ?? 0,
        kind: wireInputKind(m),
      }),
    });
    counts.set(hash, occ + 1);
    if (fingerprint) injections.add(fingerprint);
  }
  emittedCounts.set(contextKey, counts);
  if (dedup) emittedInjections.set(contextKey, injections);

  // Emit the response as one assistant line. Extension fields `system` + `tools`
  // (verbatim request body) ride on this line; the claude-jsonl adapter ignores
  // them, the Full Context reader consumes them.
  // Wire timing: `duration_ms` (native claude field, adapter reads it →
  // interaction.latency → turn-split → Turn.latencyMs, so perf tab sees it
  // WITHOUT an OCP-bending post-write) + `stopReason` (adapter reads →
  // finish_reason → Turn.finishReason). `ttftMs` has no pipeline field, so it
  // stays a pure extension field (declared in x_lake cc-wire-round; today
  // it only round-trips via lake cc-db-turn export/patch).
  // x_lake（cc-wire-round）是以上全部信息的声明式权威源，
  // 并新增 legacy 通道没有的：roundIndex / requestParams / status。
  const contentBlocks = (Array.isArray(rec.response.content) ? rec.response.content as AnthropicContentBlock[] : [])
    .map((b) => {
      // 工具名归一只对 dsh 生效:claude 路径必须逐字节不变 —— 若某个 claude
      // 会话里有同名(subagent)的自定义/MCP 工具,无条件改名会破坏 wire 存档。
      if (!dshHeader) return b;
      const alias = b.type === 'tool_use' && b.name ? DISPATCH_TOOL_ALIAS[b.name] : undefined;
      return alias ? { ...b, name: alias } : b;
    });
  const roundIndex = roundCount.get(contextKey) ?? 0;
  roundCount.set(contextKey, roundIndex + 1);
  appendClaudeLine(targetFile, {
    type: 'assistant',
    message: {
      role: 'assistant',
      id: crypto.randomUUID(),
      content: contentBlocks,
      model: rec.response.model,
      usage: mapUsage(rec.response.usage),
    },
    timestamp: toISO(rec.completedAt),
    system: body.system ?? undefined,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    version: ccVersionFromSystem(body.system) ?? undefined,
    duration_ms: rec.latencyMs,
    stopReason: rec.response.stop_reason ?? undefined,
    ttftMs: rec.ttftMs ?? undefined,
    source: proxySourceMarker(rec.protocol, body),
    x_lake: xLake('cc-wire-round', {
      roundIndex,
      protocol: rec.protocol,
      system: body.system ?? undefined,
      tools: Array.isArray(body.tools) ? body.tools : undefined,
      requestParams: {
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        model: rec.request.model,
      },
      latencyMs: rec.latencyMs,
      ttftMs: rec.ttftMs ?? undefined,
      stopReason: rec.response.stop_reason ?? undefined,
      status: rec.response.status,
      ccVersion: ccVersionFromSystem(body.system) ?? undefined,
    }),
  });
}

// cc-wire-input.kind：结构化分类替代读方的内容文本嗅探。
function wireInputKind(m: { role: string; content?: string | AnthropicContentBlock[] }): string {
  if (m.role === 'system') {
    return isInjectionText(textOf(m.content) ?? '') ? 'injection' : 'system';
  }
  if (Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result')) return 'tool-result';
  const text = (typeof m.content === 'string' ? m.content : textOf(m.content) ?? '').trimStart();
  if (text.startsWith('<command-name>') || text.startsWith('<command-message>') || text.startsWith('<local-command')) return 'command-message';
  return 'user';
}
