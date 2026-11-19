// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex provider tunnel discovery: read the codex config.toml's custom
// [model_providers.*] table so `cpx codex` can tunnel EVERY provider's
// base_url through the capture proxy. Without this, self-hosted / gateway
// scenarios (volcano, deepseek, …) send traffic DIRECT to the gateway —
// codex honors the provider's own base_url and cpx never sees a byte.
//
// ── 作用域同构（config-scope parity，issue #156 根修）────────────────────
// codex 的配置宇宙由 CODEX_HOME 锚定（env，缺失 fallback ~/.codex），config.toml
// 与 auth.json 都在其中。cpx 与子进程 codex 必须看见同一个宇宙：
//   - cpx 读操作员 ~/.codex、而 harness 给子 codex 隔离 CODEX_HOME 时，cpx
//     会为子进程「看不见」的 provider 注入 base_url-only 覆盖 → codex 0.169
//     加载期就地新建无 name 残缺条目 → 校验崩溃（客户现场 #156，本地 0.169
//     实验 B1 逐字复现 / B2 加 name 即过）。
//   - 本模块是 codex 作用域的唯一单点：codexHome/codexConfigPath/codexAuthPath
//     全部从这里出发（agent-upstream.ts 的 chatgpt 检测同源引用）。
//
// Deliberately hand-rolled lightweight TOML extraction (no toml dependency —
// same discipline as the existing openai_base_url probe). We only need:
//   [model_providers.<id>] blocks → base_url / name / env_key / wire_api /
//     requires_openai_auth（注入自足所需的字段全集，见下）
//   top-level openai_base_url → built-in openai provider endpoint (镜像契约:
//   responses 协议真实上游的解析依据,见 agent-upstream.ts)
// Bare keys and quoted string values only; anything else degrades to "not
// present", after which capture falls back to the built-in openai paths
// (openai_base_url override / cpx_proxy provider) — never breaks a run.
//
// ── 注入自足（self-sufficient injection）──────────────────────────────
// cpx 经 -c 注入的每个 provider 条目必须独立通过 codex 的加载校验并保留鉴权
// 语义（name 缺失 → 0.169 加载崩溃；env_key 丢失 → 转发不带 Authorization →
// 网关 401），不依赖「子进程 config 里已有同名条目可按键合并」这一前提——
// 作用域判断再出错（或 codex 再改作用域机制）时，注入只产生完整可加载条目。
// 因此解析器收 name/env_key/requires_openai_auth（wire_api/base_url 原有）；
// query_params 等 inline table 维持降级不收（已知限制：作用域失配的防御
// 场景下会丢——正常同作用域场景由子进程条目自身保留）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** codex 单个 provider 的隧道所需字段（注入自足字段全集的解析子集） */
export interface CodexProviderEntry {
  /** provider id → real upstream base_url (verbatim from config.toml) */
  baseUrl: string;
  wireApi: string | null;
  /** codex 0.169+ 加载期校验 name 非空——注入必带（fallback id 见注入侧） */
  name: string | null;
  /** 鉴权 env 名（丢失 → 请求不带 Authorization → 网关 401） */
  envKey: string | null;
  /** chatgpt 登录形态标记（true 时 codex 用登录态鉴权） */
  requiresOpenaiAuth: boolean | null;
}

export interface CodexProviderTable {
  providers: Record<string, CodexProviderEntry>;
  /** config.toml 顶层 openai_base_url（codex 内置 openai 端点；null=未设） */
  openaiBaseUrl: string | null;
}

// ── codex 作用域单点 ──────────────────────────────────────────────────

/** codex 配置根：$CODEX_HOME（非空才生效）→ ~/.codex。与 codex 自身解析
 *  同构（实验 B1/B2：CODEX_HOME 隔离目录下 config.toml/auth.json 生效）。 */
export function codexHome(env: NodeJS.ProcessEnv, homeDir: string): string {
  const v = env.CODEX_HOME?.trim();
  return v ? v : path.join(homeDir, '.codex');
}

/** codex 主配置文件路径（作用域单点派生） */
export function codexConfigPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  return path.join(codexHome(env, homeDir), 'config.toml');
}

/** codex 登录凭据路径（agent-upstream chatgpt 检测的输入） */
export function codexAuthPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  return path.join(codexHome(env, homeDir), 'auth.json');
}

// Bare-key ids only: a provider id becomes a URL path segment (`/<id>/…`),
// so quoted TOML keys with '/' or spaces can't be tunneled — they're left
// untouched (direct, uncaptured) rather than producing a broken route.
// codex-overrides 的 argv 层同源引用（单一词表）。
export const BARE_ID = /^[A-Za-z0-9_-]+$/;

// Proxy 保留路径段：`v1`（内置 openai/anthropic/responses 兜底路径前缀，
// cpx 同时覆盖 openai_base_url=<proxy>/v1）与 `s`（/s/<sid>/… 会话前缀）。
// 用户 provider id 撞上它们会把内置流量路由到用户网关（[model_providers.v1]
// 抢走 /v1/responses、[model_providers.s] 抢走 /s/ 会话前缀）——与路径段
// 非法同理，退化直连不捕获，绝不放行进隧道。
// codex-overrides 的 argv 层同源引用（单一词表）。
export const RESERVED_IDS = new Set(['v1', 's']);

export function readCodexProviderTable(
  configPath: string,
): CodexProviderTable | null {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
  text = text.replace(/^\uFEFF/, ''); // BOM 容忍（部分 Windows 编辑器会写）

  const providers: Record<string, CodexProviderEntry> = {};
  let section = ''; // '' = top-level
  let openaiBaseUrl: string | null = null;

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
    // 值认双引号/单引号两种 TOML 字符串（basic/literal）与裸布尔，行尾
    // 注释容忍；其余形态（多行数组、inline table）维持「视为不存在」的
    // 降级语义。
    const kvStr = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/);
    const kvBool = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(true|false)\s*(?:#.*)?$/);
    if (!kvStr && !kvBool) continue;
    if (!section) {
      // 顶层键只收 openai_base_url（TOML 顶层键必须位于任何节头之前，
      // 节后的裸键不可能是顶层语义）；其余顶层键无隧道/端点价值。
      if (kvStr?.[1] === 'openai_base_url') openaiBaseUrl = kvStr[2] ?? kvStr[3] ?? '';
      continue;
    }
    const mp = section.match(/^model_providers\.(.+)$/);
    if (!mp) continue;
    const id = mp[1];
    if (!BARE_ID.test(id) || RESERVED_IDS.has(id)) continue;
    providers[id] ??= { baseUrl: '', wireApi: null, name: null, envKey: null, requiresOpenaiAuth: null };
    const p = providers[id];
    if (kvStr) {
      const [, key, dq, sq] = kvStr;
      const value = dq ?? sq ?? '';
      if (key === 'base_url') p.baseUrl = value;
      if (key === 'name') p.name = value;
      if (key === 'env_key') p.envKey = value;
      if (key === 'wire_api') p.wireApi = value;
    } else if (kvBool) {
      if (kvBool[1] === 'requires_openai_auth') p.requiresOpenaiAuth = kvBool[2] === 'true';
    }
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
  return { providers, openaiBaseUrl };
}

// Memoized accessor for runtime (cpx-cli consults the table twice: once for
// the proxy's PROVIDER_UPSTREAMS map, once for the -c injection list — one
// filesystem read total, including the null no-config case). Tests call
// readCodexProviderTable directly with injected paths and never touch the
// cache. 作用域：CODEX_HOME-aware（与子进程同宇宙，见头注）。
let cached: CodexProviderTable | null | undefined;
export function codexProviderTable(): CodexProviderTable | null {
  // null（无 config.toml）同样要缓存：??= 会把 null 视为未赋值导致每次重读。
  if (cached === undefined) cached = readCodexProviderTable(codexConfigPath(process.env, os.homedir()));
  return cached;
}

// The tunnel itself is path-preserving (see tunnelBaseUrl): the injected
// base_url keeps the original base_url's path component, so codex's appended
// suffix ("/responses" for wire_api=responses, "/chat/completions" for
// wire_api=chat) lands on the SAME logical path after the proxy strips the
// /<providerId>/ prefix — the forwarded request is byte-identical to a
// direct one. Upstream identity rides CONTEXT_PROXY_PROVIDER_UPSTREAMS (the
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
