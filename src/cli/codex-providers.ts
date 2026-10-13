// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex provider tunnel discovery: read ~/.codex/config.toml's custom
// [model_providers.*] table so `cpx codex` can tunnel EVERY provider's
// base_url through the capture proxy. Without this, self-hosted / gateway
// scenarios (volcano, deepseek, …) send traffic DIRECT to the gateway —
// codex honors the provider's own base_url and cpx never sees a byte.
//
// Deliberately hand-rolled lightweight TOML extraction (no toml dependency —
// same discipline as the existing openai_base_url probe). We only need:
//   [model_providers.<id>] blocks → base_url = "https://…" (+ wire_api)
// Bare keys and quoted string values only; anything else degrades to "not
// present", after which capture falls back to the built-in openai paths
// (openai_base_url override / cpx_proxy provider) — never breaks a run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CodexProviderTable {
  /** provider id → real upstream base_url (verbatim from config.toml) */
  providers: Record<string, { baseUrl: string; wireApi: string | null }>;
}

// Bare-key ids only: a provider id becomes a URL path segment (`/<id>/…`),
// so quoted TOML keys with '/' or spaces can't be tunneled — they're left
// untouched (direct, uncaptured) rather than producing a broken route.
const BARE_ID = /^[A-Za-z0-9_-]+$/;

// Proxy 保留路径段：`v1`（内置 openai/anthropic/responses 兜底路径前缀，
// cpx 同时覆盖 openai_base_url=<proxy>/v1）与 `s`（/s/<sid>/… 会话前缀）。
// 用户 provider id 撞上它们会把内置流量路由到用户网关（[model_providers.v1]
// 抢走 /v1/responses、[model_providers.s] 抢走 /s/ 会话前缀）——与路径段
// 非法同理，退化直连不捕获，绝不放行进隧道。
const RESERVED_IDS = new Set(['v1', 's']);

export function readCodexProviderTable(
  configPath = path.join(os.homedir(), '.codex', 'config.toml')
): CodexProviderTable | null {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
  text = text.replace(/^\uFEFF/, ''); // BOM 容忍（部分 Windows 编辑器会写）

  const providers: Record<string, { baseUrl: string; wireApi: string | null }> = {};
  let section = ''; // '' = top-level

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // 任何以 '[' 开头的行都是节边界。未识别的节头形态（行尾注释、点号
    // 嵌套、未闭合括号）落哨兵节——绝不让键漏进上一个 section：那会把
    // provider 隧道到无关主机（错误转发），比「不捕获」严重一个量级。
    if (line.startsWith('[')) {
      const sec = line.match(/^\[([^\]]+)\]/);
      section = sec ? sec[1] : '\u0000unknown';
      continue;
    }
    // 值认双引号/单引号两种 TOML 字符串（basic/literal），行尾注释容忍；
    // 其余形态（多行数组、inline table）维持「视为不存在」的降级语义。
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/);
    if (!kv) continue;
    const [, key, dq, sq] = kv;
    const value = dq ?? sq ?? '';
    if (!section) continue; // top-level keys carry nothing we tunnel
    const mp = section.match(/^model_providers\.(.+)$/);
    if (!mp) continue;
    const id = mp[1];
    if (!BARE_ID.test(id) || RESERVED_IDS.has(id)) continue;
    providers[id] ??= { baseUrl: '', wireApi: null };
    if (key === 'base_url') providers[id].baseUrl = value;
    if (key === 'wire_api') providers[id].wireApi = value;
  }

  // Providers without a parsable base_url can't be tunneled — say so instead
  // of silently capturing nothing (the config clearly INTENDED to tunnel).
  // 「可路由性」收口：base_url 缺失 OR new URL 不可解析的 provider 一律剔出
  // 隧道表。providerUpstreamOrigins 只留可解析项，若 tunnelIds 仍含畸形项
  // 会坏路由（-c 注入隧道、proxy 却无对应 upstream → 落到默认 openai 上游），
  // 此处同步过滤，守住「每个被隧道 id 都有正向 origin」的不变量。
  for (const [id, p] of Object.entries(providers)) {
    let routable = false;
    if (p.baseUrl) {
      try { new URL(p.baseUrl); routable = true; } catch { routable = false; }
    }
    if (!routable) {
      delete providers[id];
      console.error(`[cpx] codex provider "${id}" has no parsable base_url — left direct (uncaptured, run unaffected)`);
    }
  }
  return { providers };
}

// Memoized accessor for runtime (cpx-cli consults the table twice: once for
// the proxy's PROVIDER_UPSTREAMS map, once for the -c injection list — one
// filesystem read total, including the null no-config case). Tests call
// readCodexProviderTable directly with injected paths and never touch the
// cache.
let cached: CodexProviderTable | null | undefined;
export function codexProviderTable(): CodexProviderTable | null {
  // null（无 config.toml）同样要缓存：??= 会把 null 视为未赋值导致每次重读。
  if (cached === undefined) cached = readCodexProviderTable();
  return cached;
}

// The tunnel itself is path-preserving (see tunnelBaseUrl): the injected
// base_url keeps the original base_url's path component, so codex's appended
// suffix ("/responses" for wire_api=responses, "/chat/completions" for
// wire_api=chat) lands on the SAME logical path after the proxy strips the
// /<providerId>/ prefix — the forwarded request is byte-identical to a
// direct one. Upstream identity rides CANNBOT_PROXY_PROVIDER_UPSTREAMS (the
// same map opencode uses), origin-only so the proxy re-appends the path.
// Path-preserving tunnel base: keep the original base_url's path component
// so the proxied URL is byte-compatible after prefix strip.
//   https://host/v1           → <proxyUrl>/<id>/v1
//   https://host/api/v3/      → <proxyUrl>/<id>/api/v3
export function tunnelBaseUrl(proxyUrl: string, providerId: string, realBaseUrl: string): string {
  let realPath = '';
  try {
    realPath = new URL(realBaseUrl).pathname.replace(/\/+$/, '');
  } catch {
    realPath = ''; // malformed base_url → tunnel at root; suffix still appended
  }
  return `${proxyUrl.replace(/\/+$/, '')}/${providerId}${realPath}`;
}

// Upstream map for the proxy: ORIGIN ONLY (scheme+host+port). The proxy
// re-appends the stripped /<id>/… path, so values must not carry a base path.
export function providerUpstreamOrigins(table: CodexProviderTable): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, p] of Object.entries(table.providers)) {
    try {
      out[id] = new URL(p.baseUrl).origin;
    } catch {
      /* malformed — leave to the single-upstream fallback */
    }
  }
  return out;
}
