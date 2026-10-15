// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveSession, protocolFromPath } from './session-resolver';
import { requestBodyForCapture } from './request-body-decoder';
import { createReassembler, reassembleAnthropicJson, reassembleOpenAIJson, reassembleResponsesJson, type ReassembledResponse } from './stream-reassembler';
import { OrderedDispatcher } from './ordered-dispatch';
import { ensureProxyDir, sessionFilePath, appendSid } from './writer';
import { emit as claudeEmit } from './claude-emitter';
import { emit as opencodeEmit } from './opencode-emitter';
import { emit as codexEmit } from './codex-emitter';
import { redactRecord } from './redactor';
import type { Protocol, ProxyRecord } from './types';

// Route a captured record to the right emitter. The two emitters are
// independent (no shared conversion logic) per the "two independent frameworks"
// rule; both produce the same extended claude-format so the single claude-jsonl
// adapter consumes either. First emit per sid lands in the <pinned>.sids
// manifest so cpx knows at exit which capture files this run produced.
const emittedSids = new Set<string>();
function dispatchEmit(rec: ProxyRecord): void {
  // 落盘前清洗（唯一咽喉：所有 emitter 的数据都经这里进 jsonl）
  redactRecord(rec);
  // Child sessions file under their PARENT's tree (x-parent-session-id), so
  // only parent/main sids belong in the manifest cpx imports from.
  if (SESSION_ID && !rec.parentSessionId && !emittedSids.has(rec.sid)) {
    emittedSids.add(rec.sid);
    try { appendSid(SESSION_ID, rec.sid); } catch { /* best-effort */ }
  }
  if (rec.protocol === 'anthropic') claudeEmit(rec);
  else if (rec.protocol === 'responses') codexEmit(rec);
  else opencodeEmit(rec);
}

// 捕获记录按「请求到达序」落盘而非响应完成序（竞态与因果论证见
// ordered-dispatch.ts 头注：子代理首轮可能先于派发轮完成）。
const orderedDispatch = new OrderedDispatcher(dispatchEmit);
let arrivalCounter = 0;

const PORT = parseInt(process.env.CANNBOT_PROXY_PORT ?? '0', 10) || 0;
const SESSION_ID = process.env.CANNBOT_PROXY_SESSION_ID ?? '';
const ANTHROPIC_UPSTREAM = process.env.CANNBOT_PROXY_ANTHROPIC_UPSTREAM ?? 'https://api.anthropic.com';
const OPENAI_UPSTREAM = process.env.CANNBOT_PROXY_OPENAI_UPSTREAM ?? 'https://api.openai.com';
const RESPONSES_UPSTREAM = process.env.CANNBOT_PROXY_RESPONSES_UPSTREAM ?? 'https://api.openai.com';
// opencode per-provider upstream map (JSON {providerId: baseURL}), discovered
// from the opencode binary by cpx-cli. Lets the proxy forward /<providerId>/…
// to each provider's REAL upstream (dashscope, bigmodel, …) — fully
// transparent multi-provider routing, no single-upstream limitation.
const PROVIDER_UPSTREAMS: Record<string, string> = (() => {
  try { return JSON.parse(process.env.CANNBOT_PROXY_PROVIDER_UPSTREAMS ?? '{}') as Record<string, string>; }
  catch { return {}; }
})();

const STRIP_REQ_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding',
]);

ensureProxyDir();

// 出口网络策略（proxy → 真实 upstream）：按请求遵循环境代理变量
// （HTTP_PROXY/HTTPS_PROXY/NO_PROXY，ALL_PROXY 作 curl 风格兜底），无配置则
// 直连。EnvHttpProxyAgent 一个机制覆盖全部网络场景：shell 导出的全局梯子、
// 脚本起终端的窗口/项目级梯子（env 继承）、TUN 模式（无 env，OS 透明路由）、
// 以及无代理直连 provider。agent→proxy 的本地跳不在此层——那是 cpx-cli
// 注入子进程的 NO_PROXY 的职责，两跳彻底解耦。
// undici 是 package.json 的显式 npm 依赖（^6.28.1——EnvHttpProxyAgent 需
// undici ≥6），此处经 createRequire 按需加载使用。
const envHttpProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY
  || process.env.https_proxy || process.env.http_proxy || process.env.all_proxy
  || process.env.NO_PROXY || process.env.no_proxy;
if (envHttpProxy) {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = createRequire(import.meta.url)('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent({
    httpProxy: process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || undefined,
    httpsProxy: process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || undefined,
    noProxy: process.env.NO_PROXY || process.env.no_proxy || undefined,
  }));
}

// 原始 wire 落盘（协议观测/排障专用，CANNBOT_PROXY_DUMP_DIR=/path 开启）：
// 每个被代理的调用写一对 <seq>-request.json + <seq>-response.txt。请求头里
// 的敏感项（authorization/cookie/api-key/token）打码，body 逐字保留（解码后
// 的可读形态）。与捕获管线（PROXY_DIR）完全分离——这是回答 wire 格式问题的
// 调试工具（如 codex 子代理路由信号验证），不参与任何 emitter 消费。
const DUMP_DIR = process.env.CANNBOT_PROXY_DUMP_DIR ?? '';
let dumpSeq = 0;
// 请求体与 SSE 响应都可能很大（真机单会话 386 请求 / 18M tokens）：观测
// 目标是事件形状而非全量内容，超限截断保内存（按字符计，中文内容字节数
// 约为字符数 3 倍，量级足够）。
const DUMP_BODY_CAP = 8 * 1024 * 1024;

function capDumpText(text: string): string {
  return text.length > DUMP_BODY_CAP
    ? `${text.slice(0, DUMP_BODY_CAP)}\n…[dump truncated at ${DUMP_BODY_CAP} chars]`
    : text;
}

function dumpWireRequest(req: http.IncomingMessage, decodedBody: string): string | null {
  if (!DUMP_DIR) return null;
  const seq = String(++dumpSeq).padStart(4, '0');
  try {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    const headers: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = /authorization|cookie|api-key|token|session|key/i.test(k) ? '***' : v;
    }
    fs.writeFileSync(path.join(DUMP_DIR, `${seq}-request.json`), JSON.stringify({
      seq, method: req.method, url: req.url, headers, body: capDumpText(decodedBody),
    }, null, 2));
  } catch { /* best-effort：dump 失败绝不影响代理 */ }
  return seq;
}

function dumpWireResponse(seq: string | null, status: number, contentType: string, text: string): void {
  if (!seq || !DUMP_DIR) return;
  try {
    fs.writeFileSync(path.join(DUMP_DIR, `${seq}-response.txt`), `HTTP ${status}  content-type: ${contentType}\n\n${capDumpText(text)}`);
  } catch { /* best-effort */ }
}

function upstreamBase(protocol: Protocol): string {
  if (protocol === 'anthropic') return ANTHROPIC_UPSTREAM;
  if (protocol === 'responses') return RESPONSES_UPSTREAM;
  return OPENAI_UPSTREAM;
}

// Resolve the real upstream URL for a request. opencode requests carry a
// path prefix injected by cpx (/<providerId>/chat/completions); route those to
// the provider's real upstream (from PROVIDER_UPSTREAMS) with the prefix
// stripped. Everything else (claude, openai/generic profiles, or opencode
// providers not in the map) falls back to the single upstream + sid strip.
function resolveUpstreamUrl(protocol: Protocol, urlPath: string): string {
  if (Object.keys(PROVIDER_UPSTREAMS).length > 0) {
    const m = urlPath.match(/^\/([^/]+)(\/.*)$/);
    if (m && PROVIDER_UPSTREAMS[m[1]]) {
      return PROVIDER_UPSTREAMS[m[1]].replace(/\/$/, '') + m[2];
    }
  }
  // responses 协议：codex 向 base_url 追加 /responses；cpx 注入的 base_url
  // 恒带 /v1 后缀，故请求路径恒为 /v1/responses。转发时剥路径前缀 /v1 →
  // 还原 codex 直连上游时 base + /responses 的字节形态——chatgpt 后端、
  // 官方 OpenAI、自建网关（base 不以 /v1 结尾）三种 base 形态都成立。
  if (protocol === 'responses') {
    const path = stripSessionPrefix(urlPath).replace(/^\/v1\//, '/');
    return RESPONSES_UPSTREAM.replace(/\/$/, '') + path;
  }
  return upstreamBase(protocol) + stripSessionPrefix(urlPath);
}

function buildForwardHeaders(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (STRIP_REQ_HEADERS.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleProxy(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): Promise<void> {
  const protocolHint = protocolFromPath(req.url ?? '/');
  const bodyForParsing = requestBodyForCapture(body, protocolHint, req.headers['content-encoding']);
  let parsedBody: unknown = null;
  try {
    parsedBody = bodyForParsing.length > 0 ? JSON.parse(bodyForParsing.toString('utf-8')) : null;
  } catch {
    parsedBody = null;
  }

  const { sid, protocol } = resolveSession(req.url ?? '/', (name) => {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] ?? null : v ?? null;
  }, parsedBody, SESSION_ID || undefined);
  if (!protocol) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown protocol path' }));
    return;
  }

  const upstreamUrl = resolveUpstreamUrl(protocol, req.url ?? '');
  const forwardHeaders = buildForwardHeaders(req);
  forwardHeaders['content-type'] = req.headers['content-type'] ?? 'application/json';

  const receivedAt = Date.now();
  // 到达序：emit 顺序的因果基准（在 fetch 之前分配，502/异常路径也能墓碑推进）
  const arrivalSeq = ++arrivalCounter;
  const isSseRequested = parsedBody != null &&
    (parsedBody as { stream?: unknown }).stream === true;
  const dumpId = dumpWireRequest(req, bodyForParsing.toString('utf-8'));

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: req.method ?? 'POST',
      headers: forwardHeaders,
      body: body.length > 0 ? new Uint8Array(body) : undefined,
    });
  } catch (err) {
    orderedDispatch.submit(arrivalSeq, null);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream unreachable', detail: String(err) }));
    return;
  }

  const respContentType = upstreamRes.headers.get('content-type') ?? '';
  const isSseResponse = respContentType.includes('text/event-stream');

  for (const [k, v] of upstreamRes.headers) {
    if (k.toLowerCase() === 'content-encoding' || k.toLowerCase() === 'content-length') continue;
    res.setHeader(k, v);
  }

  if (isSseResponse || isSseRequested) {
    await handleStream(req, res, upstreamRes, sid, protocol, parsedBody, receivedAt, arrivalSeq, dumpId, respContentType);
  } else {
    await handleNonStream(res, upstreamRes, sid, protocol, parsedBody, receivedAt, arrivalSeq, dumpId, respContentType);
  }
}

function stripSessionPrefix(url: string): string {
  const match = url.match(/^\/s\/[^/]+(\/v1\/.*)$/);
  if (match) return match[1];
  if (url.startsWith('/v1/')) return url;
  return url;
}

async function handleStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamRes: Response,
  sid: string,
  protocol: Protocol,
  requestBody: unknown,
  receivedAt: number,
  arrivalSeq: number,
  dumpId: string | null,
  respContentType: string
): Promise<void> {
  res.writeHead(upstreamRes.status, { 'content-type': res.getHeader('content-type') ?? 'text/event-stream' });

  const reassembler = createReassembler(protocol);
  const reader = upstreamRes.body?.getReader();
  if (!reader) {
    orderedDispatch.submit(arrivalSeq, null);
    res.end();
    return;
  }

  let dumpedText = '';
  try {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        reassembler.feed(chunk);
        res.write(value);
        if (dumpId && dumpedText.length < DUMP_BODY_CAP) dumpedText += chunk;
      }
    }
    // flush trailing multibyte bytes
    reassembler.feed(decoder.decode());
  } catch {
    // client disconnect — still record what we captured
  }
  dumpWireResponse(dumpId, upstreamRes.status, respContentType, dumpedText);

  // Persist the record BEFORE res.end() so the client receiving the response
  // (and possibly exiting immediately, causing cpx-cli to SIGTERM this proxy)
  // cannot race the disk write. Order: reassemble → append → then close.
  // emit() 调 appendFileSync 可能抛（ENOSPC/EIO）—— 不能让它阻断 res.end，
  // 否则客户端连接悬挂；也不能让异常冒泡到外层 catch（headers 已发 →
  // writeHead(500) 二次抛 ERR_HTTP_HEADERS_SENT → 进程崩）
  const completedAt = Date.now();
  const reassembled = reassembler.result();
  const ttftMs = reassembled.firstTokenAt != null ? reassembled.firstTokenAt - receivedAt : null;
  // submit 在 res.end() 前：到达序缓冲保证后继记录先于此响应结束前不会
  // 落盘（见 ordered-dispatch.ts）。buildRecord 抛错时提交 null 推进序列，
  // 绝不让后续记录滞留内存。emit 自身的落盘错误在 flush 内部兜底。
  try {
    orderedDispatch.submit(arrivalSeq, buildRecord(sid, protocol, requestBody, upstreamRes.status, reassembled, receivedAt, completedAt, req, ttftMs));
  } catch (e) {
    orderedDispatch.submit(arrivalSeq, null);
    console.error('[proxy] emit failed (capture may be incomplete):', e instanceof Error ? e.message : e);
  }
  res.end();
}

async function handleNonStream(
  res: http.ServerResponse,
  upstreamRes: Response,
  sid: string,
  protocol: Protocol,
  requestBody: unknown,
  receivedAt: number,
  arrivalSeq: number,
  dumpId: string | null,
  respContentType: string
): Promise<void> {
  // Body read failed mid-stream（上游连接中断 / body 超时 / 解码错误）：
  // 墓碑推进到达序后照常回错——绝不让单个失败把 dispatcher 卡死在这个
  // seq 上（所有协议共用一个 dispatcher，卡死 = 之后全部记录只进内存缓
  // 冲、永不落盘，捕获侧静默全丢）。master 上此路径是直调 dispatchEmit
  // 只丢自己一条；接线 ordered-dispatch 后必须有这条兜底。
  let text: string;
  try {
    text = await upstreamRes.text();
  } catch (e) {
    dumpWireResponse(dumpId, upstreamRes.status, respContentType, '');
    orderedDispatch.submit(arrivalSeq, null);
    console.error('[proxy] nonstream body read failed (record dropped):', e instanceof Error ? e.message : e);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream body read failed' }));
    } else {
      res.end();
    }
    return;
  }
  dumpWireResponse(dumpId, upstreamRes.status, respContentType, text);

  let reassembled: ReassembledResponse;
  try {
    const json = JSON.parse(text);
    reassembled = protocol === 'anthropic'
      ? reassembleAnthropicJson(json)
      : protocol === 'responses'
        ? reassembleResponsesJson(json)
        : reassembleOpenAIJson(json);
  } catch {
    reassembled = { model: null, stop_reason: null, content: [], usage: null };
  }

  // Persist before sending the response to the client (same race fix as handleStream).
  const completedAt = Date.now();
  let rec: ProxyRecord | null = null;
  try {
    rec = buildRecord(sid, protocol, requestBody, upstreamRes.status, reassembled, receivedAt, completedAt, null, null);
  } catch { /* abandoned — submit(null) still advances the sequence */ }
  orderedDispatch.submit(arrivalSeq, rec);

  res.writeHead(upstreamRes.status, { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' });
  res.end(text);
}

function buildRecord(
  sid: string,
  protocol: Protocol,
  requestBody: unknown,
  status: number,
  reassembled: ReassembledResponse,
  receivedAt: number,
  completedAt: number,
  req: http.IncomingMessage | null,
  ttftMs: number | null
): ProxyRecord {
  const model = (requestBody && typeof requestBody === 'object' && 'model' in requestBody)
    ? String((requestBody as { model: unknown }).model) : null;
  // opencode sends x-session-id (ses_xxx); child sessions (subagents) carry a
  // different value plus x-parent-session-id pointing at the main session —
  // the opencode-emitter uses both for routing.
  const xSessionId = req ? (req.headers['x-session-id'] as string | undefined) ?? null : null;
  const userAgent = req ? (req.headers['user-agent'] as string | undefined) ?? null : null;
  const parentSessionId = req ? (req.headers['x-parent-session-id'] as string | undefined) ?? null : null;
  return {
    sid,
    protocol,
    receivedAt,
    completedAt,
    latencyMs: completedAt - receivedAt,
    ttftMs,
    request: {
      path: req?.url ?? '',
      model,
      body: requestBody ?? {},
    },
    response: {
      status,
      model: reassembled.model,
      stop_reason: reassembled.stop_reason,
      content: reassembled.content,
      usage: reassembled.usage,
    },
    xSessionId,
    parentSessionId,
    userAgent,
  };
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';
  if (req.method === 'GET' && (url === '/healthz' || url === '/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: server.address() }));
    return;
  }
  // 路由门含 /responses 后缀：provider 隧道是路径保真的，根路径 base_url
  // （无 /v1 前缀）的 responses provider 请求形如 /<providerId>/responses，
  // includes('/v1/') 覆盖不到就会 404——注入隧道反而打断用户请求，违背
  // 「降级直连而非坏路由」的自身契约（session-resolver.protocolFromPath
  // 同步识别该形态）。
  if (req.method === 'POST' && (url.includes('/v1/') || url.includes('/chat/completions') || url.includes('/messages') || /\/responses\/?$/.test(url))) {
    try {
      const body = await readBody(req);
      await handleProxy(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'proxy error', detail: String(err) }));
      } else {
        // headers already sent (streaming started) — can't send 500, just end
        res.end();
      }
    }
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  // Create the capture file eagerly: cpx prints its path (and a `tail -f`
  // hint) at startup, and the first wire record may only arrive minutes
  // later — before that the path would not exist, breaking tail -f and
  // confusing manual imports. The emitter's append keeps writing to it.
  if (SESSION_ID) {
    try { fs.closeSync(fs.openSync(sessionFilePath(SESSION_ID), 'a')); } catch { /* best-effort */ }
  }
  console.log(`[cannbot-proxy] listening on http://127.0.0.1:${port}`);
  if (process.send) process.send({ type: 'listening', port });
});
