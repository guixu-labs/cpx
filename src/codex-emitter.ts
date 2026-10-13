// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex-emitter: convert a captured codex wire-record (ProxyRecord,
// protocol='responses') into extended claude-format jsonl lines, so
// cannbot-insight's existing claude-jsonl adapter can ingest it with zero
// insight changes.
//
// Independent from claude-emitter / opencode-emitter — the three share NO
// conversion logic because the Responses API wire format differs from both
// Anthropic Messages and OpenAI Chat Completions in every relevant dimension:
//   - request body: {input: [...items]} (not messages[], not content blocks)
//   - items: message / function_call / function_call_output (independent items,
//     not blocks inside a message)
//   - system prompt: `instructions` field where present (older codex / some
//     gateways), else the leading developer-role input message (codex 0.161
//     real wire: 23KB base prompt re-sent verbatim in every request, main and
//     subagent threads alike) — both surfaces are captured into the claude
//     layout's `system` extension field for the Full Context reader; developer
//     messages never become timeline lines (static context, not events — same
//     D1 semantics as the codex native adapter)
//
// Output format is the SAME extended claude-format + x_cannbay as the other
// two emitters, so the single claude-jsonl adapter consumes all three.
//
// ── Thread model ──────────────────────────────────────────────────────────
// codex runs the MAIN conversation and each SUBAGENT as independent
// Responses-API threads through the same proxy port, all under one sid (no
// header signal). Every request re-sends the full thread input, so
// per-THREAD cursors are mandatory — a shared cursor (the old
// `contextKey='main'` hardcode) let the main thread's cursor swallow
// subagent input and scramble roundIndex.
//
// Compaction (wire-verified, codex 0.161 + remote_compaction_v2, 20-min
// real session): when a long thread fills its context window, the input is
// REBUILT into a handful of items — [static injections, task, (follow-up
// instruction), compaction summary] — so it SHRINKS (106→5 observed) and
// the item order is not preserved. A positional cursor alone then skips the
// rebuilt head, silently losing the summary and any new instruction. The
// cursor is therefore anchor-verified (chain hash of the emitted PREFIX — not
// just the last item, so a mid-prefix rewrite with an unchanged tail still
// trips resync) and resyncs by content-hash multiset on mismatch: only
// never-seen content is emitted, so re-injected static/task items are not
// duplicated.
//
// Routing signals (verified on real codex 0.161 + 0.162 wire, native rollouts +
// proxy observation):
//   1. a main-thread response containing a spawn_agent tool_use whose task
//      text is the spawn message — 0.161 passes it as `input.message`;
//      0.162 (post tool-error learning) passes `fork_context`+`items` with
//      the task inside a user message item (spawnTaskOf normalizes both)
//   2. a subagent thread's request input starts with static framework
//      injections (<environment_context>, …) followed by the task text
//      BYTE-IDENTICAL to the spawn task — the first non-injection user
//      item is the thread's identity
//   3. the main thread's NEXT request carries the spawn's
//      function_call_output {"agent_id","nickname"} → enriches the subagent
//      meta after the fact (codex auto-assigns nicknames, ignoring any the
//      prompt requested). Every spawn call_id maps to its task text —
//      0.162's retry chain registers the task via a failed message-form
//      call while the SUCCESSFUL items-form call carries the output.
//
// Subagent files land at <PROXY_DIR>/<sid>/subagents/<subId>.jsonl + .meta.json
// (the claude-convention layout insight's listSubagentSessions consumes
// as-is). Order is guaranteed: a subagent's first request can only happen
// AFTER the spawn response completed, so the dispatch registry is always
// populated before it's needed.

import crypto from 'node:crypto';
import type { ProxyRecord, AnthropicContentBlock, AnthropicUsage, OpenAIUsage } from './types';
import { sessionFilePath, subagentFilePath, subagentMetaPath, appendClaudeLine, writeMeta, sessionMetaPath } from './writer';
import { proxySourceMarker } from './claude-emitter';

interface ResponseInputItem {
  type: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: string;
}
interface ResponseRequestBody {
  input?: ResponseInputItem[];
  tools?: unknown[];
  model?: string;
  instructions?: string;
  stream?: boolean;
}

function xLake<T extends Record<string, unknown>>(schema: string, data: T) {
  return { schema, version: 1, data };
}

// ── Thread model state ────────────────────────────────────────────────────
// All maps are per-proxy-process; sid keys the outer file layout, contextKey
// keys the thread state. A cpx proxy process serves exactly one session.
interface ThreadContext {
  /** input items already emitted for this thread (positional cursor) */
  inputCursor: number;
  /** wire round number for this thread (cc-wire-round.roundIndex) */
  roundIndex: number;
  /** chain hash of items[0..inputCursor-1] — append-only verification anchor */
  anchorHash: string | null;
  /** content-hash multiset of the current input state (resync baseline) */
  seen: Map<string, number>;
}
const contexts = new Map<string, ThreadContext>();
interface SubagentDispatch {
  subId: string;
  /** spawn_agent tool_use id (= the call_id its function_call_output echoes) */
  callId: string | null;
  agentId: string | null;
  nickname: string | null;
}
const dispatchByTask = new Map<string, SubagentDispatch>();
const taskByCallId = new Map<string, string>();
const subMetaWritten = new Set<string>();
const sessionMetaWritten = new Set<string>();

function subIdFor(task: string): string {
  return 'sub-' + crypto.createHash('md5').update(task).digest('hex').slice(0, 12);
}

// Content fingerprint for the compaction resync: canonical projection over
// the fields that define the captured line — deliberately NOT the raw item
// JSON, whose `id` field changes when codex rebuilds the input (content-
// identical items must still match across a compaction rebuild).
function itemHash(it: ResponseInputItem): string {
  const parts = [
    it.type ?? '',
    it.role ?? '',
    it.name ?? '',
    it.call_id ?? '',
    it.arguments ?? '',
    (it.content ?? []).map((c) => `${c.type ?? ''}:${c.text ?? ''}`).join('\u0000'),
    it.output ?? '',
  ];
  return crypto.createHash('md5').update(JSON.stringify(parts)).digest('hex');
}

// Chain hash over the emitted prefix (items[0..count-1]): the append-only
// verification anchor. Single last-item hashing only proves the tail survived;
// a mid-prefix rewrite that keeps the tail byte-identical (and length ≥
// cursor) would pass it and drop the rewritten middle on the fast path. The
// chain covers ANY prefix edit — every round is O(n) item hashes, negligible
// for the hundreds-of-items input sizes observed on real codex sessions.
function prefixAnchor(items: ResponseInputItem[], count: number): string {
  const h = crypto.createHash('md5');
  for (let i = 0; i < count; i++) {
    h.update(itemHash(items[i]));
    h.update('\u0000');
  }
  return h.digest('hex');
}

function toISO(ts: number): string {
  return new Date(ts).toISOString();
}

function mapUsage(usage: AnthropicUsage | OpenAIUsage | null): AnthropicUsage | undefined {
  if (!usage) return undefined;
  return usage as AnthropicUsage;
}

// Static framework injections (same classification insight's codex adapter
// applies): they precede the thread identity in the input but are NOT it.
// <subagent_notification> is deliberately absent — it's an event injection
// that only appears in main AFTER the user prompt, never before the identity.
const CODEX_INJECTION_PREFIXES = ['<environment_context>', '<user_instructions>', '<codex_internal_context'];
function isStaticInjection(text: string): boolean {
  return CODEX_INJECTION_PREFIXES.some((p) => text.startsWith(p)) || text.startsWith('# AGENTS.md');
}

// The thread's identity: text of the first user-role item that is not a
// static injection. Main → the original user prompt; subagent → the spawn
// task text (byte-identical to spawn_agent's input.message — the routing key).
function threadIdentity(items: ResponseInputItem[]): string | null {
  for (const item of items) {
    if (item.type !== 'message' || (item.role ?? 'user') !== 'user') continue;
    const text = (item.content ?? []).map((c) => c.text ?? '').join('');
    if (!text) continue;
    if (isStaticInjection(text)) continue;
    return text;
  }
  return null;
}

// spawn_agent 任务文本的 wire 双形态（0.161/0.162 真机核实）：
//   0.161  {message: "<任务文本>"}（模型直传）
//   0.162  {fork_context, items: [{type:"text", text:"<任务文本>"}]}
//          （模型从工具错误中学习的形态：先试 message+items 双参被拒
//           （"Provide either message or items"）、再试 reasoning_effort 被
//           网关拒，最终只传 fork_context+items——一次成功，从无 message
//           形态。真机核实：四个子代理的 items[0].text 与线程身份逐字节
//           一致，路由等价性成立）
// items 内部双形状都认：纯文本项 {type:'text', text}（spawn args 实测）与
// message 项 {type:'message', content:[...]}（防御性——与线程 input 同构）。
// 真机缺陷背景（0.162 首测）：只认 message 时，items 形态 spawn 不注册
// 派发登记 → 子代理线程身份匹配不上 → 误路由进主线程文件，双流共享
// 一个游标 → 锚点失配 → resync 重复发射主线程条目（实测 39 请求的子
// 代理污染主文件至 6102 行）。
function spawnTaskOf(input: unknown): string | null {
  const inp = input as { message?: unknown; items?: unknown };
  if (typeof inp.message === 'string' && inp.message) return inp.message;
  if (Array.isArray(inp.items)) {
    for (const item of inp.items as Array<Record<string, unknown>>) {
      let text = '';
      if (typeof item.text === 'string') {
        text = item.text;
      } else if (Array.isArray(item.content)) {
        text = (item.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
      }
      if (!text || isStaticInjection(text)) continue;
      return text;
    }
  }
  return null;
}

// codex 系统提示词的 wire 双形态（见文件头）：instructions 字段优先，缺省
// 时取 input 里的 developer 消息全文（0.161 真机唯一形态——每请求全量重发，
// 主/子线程同基座）。只做 verbatim 归一，不做解释；产出进 claude 布局的
// system 扩展字段（claude-emitter 的 request.body.system 同款位置），insight
// 的 readFullContext 零改动消费。
function systemPromptOf(body: ResponseRequestBody): string | undefined {
  if (typeof body.instructions === 'string' && body.instructions) return body.instructions;
  const parts: string[] = [];
  for (const item of body.input ?? []) {
    if (item.type !== 'message' || (item.role ?? 'user') !== 'developer') continue;
    const text = (item.content ?? []).map(c => c.text ?? '').join('');
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function convertInputItem(item: ResponseInputItem): { type: string; message: { role: string; content: string | AnthropicContentBlock[] }; source: string; x_lake: { schema: string; version: number; data: { roundIndex: number; kind: string } }; x_cannbay: { schema: string; version: number; data: { roundIndex: number; kind: string } } } | null {
  if (item.type === 'message') {
    const role = item.role ?? 'user';
    if (role === 'assistant' || role === 'system' || role === 'developer') return null;
    const content = item.content && item.content.length > 0
      ? item.content.map(c => ({ type: 'text', text: c.text ?? '' })).filter(c => c.text)
      : '';
    return {
      type: 'user',
      message: { role: 'user', content: content || '' },
      source: 'codex-proxy',
      x_lake: xLake('cc-wire-input', { roundIndex: 0, kind: 'user' }), x_cannbay: xLake('cc-wire-input', { roundIndex: 0, kind: 'user' }),
    };
  }
  if (item.type === 'function_call_output') {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: item.call_id ?? '', content: item.output ?? '' }],
      },
      source: 'codex-proxy',
      x_lake: xLake('cc-wire-input', { roundIndex: 0, kind: 'tool-result' }), x_cannbay: xLake('cc-wire-input', { roundIndex: 0, kind: 'tool-result' }),
    };
  }
  return null;
}

// Subagent meta: same shape as claude-emitter's (toolUseId/name/agentType at
// top level + cc-subagent-meta in x_lake/x_cannbay) so insight's
// listSubagentSessions reads both frameworks uniformly. codex extras
// (agentId; nickname arrives late via the spawn output) are additive fields.
// Rewritten when enrichment arrives — the first write may precede the
// spawn's function_call_output (name falls back to a task preview then).
function writeSubMeta(sid: string, d: SubagentDispatch, task: string): void {
  // nickname 到货前的首写用任务首行做展示名；enrichment 到达后整文件重写
  const name = d.nickname ?? (task.trim().split('\n')[0].slice(0, 60) || null);
  const subMeta = {
    toolUseId: d.callId,
    name,
    agentType: null,
    agentId: d.agentId,
    nickname: d.nickname,
    x_lake: xLake('cc-subagent-meta', {
      toolUseId: d.callId,
      name,
      agentType: null,
      subagentSessionId: d.subId,
      agentId: d.agentId,
      nickname: d.nickname,
    }),
    x_cannbay: xLake('cc-subagent-meta', {
      toolUseId: d.callId,
      name,
      agentType: null,
      subagentSessionId: d.subId,
      agentId: d.agentId,
      nickname: d.nickname,
    }),
  };
  writeMeta(subagentMetaPath(sid, d.subId), subMeta);
}

export function emit(rec: ProxyRecord): void {
  const body = rec.request.body as ResponseRequestBody | null;
  if (!body?.input) return;

  const sid = rec.sid;
  const items = body.input;
  const contentBlocks = Array.isArray(rec.response.content) ? rec.response.content as AnthropicContentBlock[] : [];
  const systemPrompt = systemPromptOf(body);

  // 1) Dispatch registration: spawn_agent tool_use in THIS record's response
  // opens a subagent thread. Registered before any routing below — a later
  // record for that thread must find it here.
  // 任务文本双形态（spawnTaskOf）：0.161 message 直传 / 0.162 fork_context+
  // items。taskByCallId 的映射先于任务去重守卫——0.162 的失败重试链里，
  // 首个 message 形态失败调用注册任务文本，items 形态成功调用才带回
  // agent_id 输出；若成功 call 的 id 不映射，富化（信号 3）永远查不到，
  // meta 停在 agentId/nickname=null（真机 0.162 首测：4 个子代理全 null，
  // insight 的 agentId 连接键失效、泳道 0 turns）。
  for (const b of contentBlocks) {
    if (b.type !== 'tool_use' || b.name !== 'spawn_agent' || !b.input) continue;
    const task = spawnTaskOf(b.input);
    if (!task) continue;
    if (b.id) taskByCallId.set(b.id, task);
    if (!dispatchByTask.has(task)) {
      dispatchByTask.set(task, { subId: subIdFor(task), callId: b.id ?? null, agentId: null, nickname: null });
    }
  }

  // 2) Dispatch enrichment: the spawn's function_call_output rides THIS
  // request's input (the spawning thread's next round) and reveals the
  // auto-assigned agent_id + nickname. Rewrites the subagent meta if it was
  // already written with fallback values.
  for (const item of items) {
    if (item.type !== 'function_call_output' || !item.call_id) continue;
    const task = taskByCallId.get(item.call_id);
    if (!task) continue;
    const d = dispatchByTask.get(task);
    if (!d) continue;
    let out: { agent_id?: unknown; nickname?: unknown } | null = null;
    try { out = JSON.parse(item.output ?? '') as { agent_id?: unknown; nickname?: unknown }; } catch { out = null; }
    if (out && (typeof out.agent_id === 'string' || typeof out.nickname === 'string')) {
      // spawn 输出常驻后续每轮 input——只在值真正变化时重写 meta，避免
      // 每轮一次的冗余文件写
      const before = `${d.agentId}|${d.nickname}`;
      if (typeof out.agent_id === 'string') d.agentId = out.agent_id;
      if (typeof out.nickname === 'string') d.nickname = out.nickname;
      if (before !== `${d.agentId}|${d.nickname}` && subMetaWritten.has(d.subId)) {
        writeSubMeta(sid, d, task);
      }
    }
  }

  // 3) Thread routing: first non-injection user item vs the dispatch registry.
  const identity = threadIdentity(items);
  const dispatch = identity ? dispatchByTask.get(identity) : undefined;
  // 父线程甄别守卫：派发线程自己的记录携带父证据——本记录响应里的
  // spawn tool_use，或后续轮 input 里该 spawn 的 function_call_output
  //（任务文本经 taskByCallId 关联）；子代理新鲜线程只把任务文本作为首
  // 条 user 消息，两者都不存在。没有守卫时，主线程首条 user 消息恰好
  // 等于某 spawn 任务文本（机械式委派）会让主线程后续全部请求误入子
  // 代理文件——双流共享子代理游标，主文件断流。
  const isParentThread = dispatch !== undefined && identity !== null && (
    contentBlocks.some((b) => b.type === 'tool_use' && b.name === 'spawn_agent' && spawnTaskOf(b.input) === identity) ||
    items.some((it) => it.type === 'function_call_output' && taskByCallId.get(it.call_id ?? '') === identity)
  );
  const routedSub = dispatch && !isParentThread ? dispatch : undefined;
  const contextKey = routedSub ? routedSub.subId : 'main';
  const targetFile = routedSub ? subagentFilePath(sid, routedSub.subId) : sessionFilePath(sid);

  if (!routedSub) {
    if (!sessionMetaWritten.has(sid)) {
      sessionMetaWritten.add(sid);
      writeMeta(sessionMetaPath(sid), {
        x_lake: xLake('cc-session-meta', {
          producer: 'cpx',
          framework: 'codex',
          protocol: 'responses',
          sid,
        }), x_cannbay: xLake('cc-session-meta', {
          producer: 'cpx',
          framework: 'codex',
          protocol: 'responses',
          sid,
        }),
      });
    }
  } else if (!subMetaWritten.has(routedSub.subId)) {
    subMetaWritten.add(routedSub.subId);
    writeSubMeta(sid, routedSub, identity!);
  }

  // 4) Delta-emit THIS thread's new input items. Every request re-sends the
  // full thread history; the per-context cursor emits only the tail.
  // assistant echoes are skipped — each was already emitted as its own
  // round's assistant line.
  //
  // Append-only is VERIFIED, not assumed: the chain hash of the emitted
  // prefix must still match items[0..inputCursor-1]. On mismatch
  // (compaction rebuild — see header, or any mid-prefix rewrite) the thread
  // resyncs by content-hash multiset: emit only items never seen before, so
  // re-injected static/task content is not duplicated while the compaction
  // summary, any follow-up instruction, and any rewritten mid-prefix content
  // ARE captured. send_input same-text resends on the append-only path stay
  // verbatim (positional emit, no dedup).
  const ctx = contexts.get(contextKey) ?? { inputCursor: 0, roundIndex: 0, anchorHash: null, seen: new Map<string, number>() };
  const emitItem = (item: ResponseInputItem) => {
    const line = convertInputItem(item);
    if (!line) return;
    (line.x_lake as { data: { roundIndex: number } }).data.roundIndex = ctx.roundIndex;
    (line.x_cannbay as { data: { roundIndex: number } }).data.roundIndex = ctx.roundIndex;
    appendClaudeLine(targetFile, { ...line, timestamp: toISO(rec.receivedAt) });
  };
  const appendOnly = ctx.inputCursor === 0
    || (items.length >= ctx.inputCursor && prefixAnchor(items, ctx.inputCursor) === ctx.anchorHash);
  if (appendOnly) {
    for (let i = ctx.inputCursor; i < items.length; i++) {
      emitItem(items[i]);
      const h = itemHash(items[i]);
      ctx.seen.set(h, (ctx.seen.get(h) ?? 0) + 1);
    }
  } else {
    // multiset diff against the pre-rebuild state: the k-th occurrence of
    // content X in the new input is already captured iff k <= seen(X)
    const fresh = new Map<string, number>();
    for (const item of items) {
      const h = itemHash(item);
      const occurrence = (fresh.get(h) ?? 0) + 1;
      fresh.set(h, occurrence);
      if (occurrence <= (ctx.seen.get(h) ?? 0)) continue;
      emitItem(item);
    }
    ctx.seen = fresh;
  }
  ctx.inputCursor = items.length;
  ctx.anchorHash = items.length > 0 ? prefixAnchor(items, items.length) : null;

  // 5) Assistant line for this round, into the same thread file.
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
    system: systemPrompt,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    source: proxySourceMarker(rec.protocol, rec.request.body),
    x_lake: xLake('cc-wire-round', {
      roundIndex: ctx.roundIndex,
      protocol: 'responses',
      system: systemPrompt,
      tools: Array.isArray(body.tools) ? body.tools : undefined,
      requestParams: { model: body.model ?? rec.request.model },
      latencyMs: rec.latencyMs,
      ttftMs: rec.ttftMs ?? undefined,
      stopReason: rec.response.stop_reason ?? undefined,
      status: rec.response.status,
    }), x_cannbay: xLake('cc-wire-round', {
      roundIndex: ctx.roundIndex,
      protocol: 'responses',
      system: systemPrompt,
      tools: Array.isArray(body.tools) ? body.tools : undefined,
      requestParams: { model: body.model ?? rec.request.model },
      latencyMs: rec.latencyMs,
      ttftMs: rec.ttftMs ?? undefined,
      stopReason: rec.response.stop_reason ?? undefined,
      status: rec.response.status,
    }),
  });
  ctx.roundIndex += 1;
  contexts.set(contextKey, ctx);
}
