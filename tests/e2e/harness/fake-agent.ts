// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 假 agent 工厂（insight「真浏览器」的 cpx 等价物）：真 spawn 真 HTTP 真流式
// drain 的协议客户端脚本——不是 mock，是「最小但真实」的 agent 进程。注入
// 契约（--settings / -c / OPENAI_BASE_URL / OPENCODE_CONFIG_CONTENT /
// DEEPSEEK_BASE_URL）在 agent 侧反向解析——旅程顺带锁定 cpx 的注入形态。
//
// 通用纪律（与既有 ad-hoc e2e 的假 agent 一致）：
//   · CPX_SESSION_ID 落盘（spec 定位捕获文件的工牌）
//   · 收到的响应全文落盘（透传保真断言：agent 收到 == 桩发出）
//   · 瞬态抖动重试兜底；GIVEUP 也 exit 0（捕获优先，断言自会红）
//   · 绝不因网络失败非零退出——agent 的退出码不是被测物，捕获才是
//
// 两层 API：
//   · protocolAgent —— 全功能：五模式 × 请求序列（多轮/子代理/并发/gzip
//     大体量都在这层），新 spec 一律用它
//   · claudeAgent / codexAgent / openaiAgent —— 单请求便捷件（既有 spec
//     的稳定面），内部委托 protocolAgent

import fs from 'node:fs';
import path from 'node:path';
import type { Sandbox } from './sandbox';

export type AgentMode = 'claude' | 'codex' | 'openai' | 'opencode-config' | 'dsh';

export interface FakeAgent {
  /** 可执行脚本绝对路径（spawn 用）。 */
  path: string;
  /** agent 自报 sid（请求头形态的约定值；responses 协议无头恒 null）。 */
  sid: string | null;
}

/** 单个请求：body + 可选头/工牌/压缩/延时。 */
export interface AgentRequest {
  /** 请求体（JSON 对象——协议形状由各模式标准件负责）。 */
  body: Record<string, unknown>;
  /** 附加请求头（密钥零泄漏用例：Authorization / x-api-key 注入面）。 */
  headers?: Record<string, string>;
  /** 自报会话头值（按模式映射到对应 sid 头；缺省不带 → 落 pinned 文件）。 */
  sid?: string;
  /** x-parent-session-id（opencode 子会话声明形态）。 */
  parentSid?: string;
  /** gzip 请求体 + content-encoding: gzip（请求体解码链用例）。 */
  gzip?: boolean;
  /** 发送前延时（并发用例的到达序编排）。 */
  delayMs?: number;
}

export interface ProtocolAgentOpts {
  mode: AgentMode;
  requests: AgentRequest[];
  /** 并发发送（不逐一等响应；到达序由 delayMs 编排）——默认串行多轮。 */
  concurrent?: boolean;
  /** 脚本名（默认 fake-<mode>；同文件多 agent 场景自定义）。 */
  name?: string;
}

/** 各模式的注入反解 + 路由形态（cpx 注入契约的镜像表）。 */
const MODE_WIRE: Record<AgentMode, { sidHeader: string | null; path: string; baseFrom: string }> = {
  claude: { sidHeader: 'x-claude-code-session-id', path: '/v1/messages', baseFrom: 'argv --settings' },
  dsh: { sidHeader: 'x-deepseek-harness-session-id', path: '/v1/messages', baseFrom: 'env DEEPSEEK_BASE_URL' },
  codex: { sidHeader: null, path: '/responses', baseFrom: 'argv -c openai_base_url' },
  openai: { sidHeader: 'x-session-id', path: '/v1/chat/completions', baseFrom: 'env OPENAI_BASE_URL' },
  'opencode-config': { sidHeader: 'x-session-id', path: 'chat/completions', baseFrom: 'env OPENCODE_CONFIG_CONTENT' },
};

/** 全功能协议 agent：五模式 × 请求序列。 */
export function protocolAgent(sandbox: Sandbox, opts: ProtocolAgentOpts): FakeAgent {
  const name = opts.name ?? `fake-${opts.mode}`;
  const wire = MODE_WIRE[opts.mode];
  const file = path.join(sandbox.bin, name);

  // 注入反解（各模式的「agent 怎么拿到代理地址」——本身就是被锁契约）
  const baseResolution: Record<AgentMode, string> = {
    claude: `
let base = null;
for (let i = 0; i < process.argv.length - 1; i++) {
  if (process.argv[i] === '--settings') {
    try { base = JSON.parse(process.argv[i + 1]).env.ANTHROPIC_BASE_URL; } catch {}
  }
}
if (!base) { fs.writeFileSync(NOINJECT_DUMP, 'probe-run: no --settings injection'); process.exit(0); }`,
    dsh: `
const base = process.env.DEEPSEEK_BASE_URL;
if (!base) { fs.writeFileSync(NOINJECT_DUMP, 'probe-run: no DEEPSEEK_BASE_URL env'); process.exit(0); }`,
    codex: `
let base = null;
for (let i = 0; i < process.argv.length; i++) {
  const m = /^openai_base_url="(.+)"$/.exec(process.argv[i]);
  if (m) base = m[1];
}
if (!base) { fs.writeFileSync(NOINJECT_DUMP, 'probe-run: no openai_base_url injection'); process.exit(0); }`,
    openai: `
const base = process.env.OPENAI_BASE_URL;
if (!base) { fs.writeFileSync(NOINJECT_DUMP, 'probe-run: no OPENAI_BASE_URL env'); process.exit(0); }`,
    'opencode-config': `
let base = null;
try { base = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).provider.gateway.options.baseURL; } catch {}
if (!base) { fs.writeFileSync(NOINJECT_DUMP, 'probe-run: no OPENCODE_CONFIG_CONTENT (probeHelp noise, expected)'); process.exit(0); }
// 尾斜杠归一：注入形态恒带尾斜杠，后续相对拼接（chat/completions 无前导
// 斜杠——与 ai-sdk 的 SDK URL 拼接语义一致）依赖它
base = base.endsWith('/') ? base : base + '/';`,
  };

  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const zlib = require('node:zlib');
const SID_DUMP = ${JSON.stringify(path.join(sandbox.root, `${name}.sid`))};
const RESP_DUMP = ${JSON.stringify(path.join(sandbox.root, `${name}.resp`))};
const NOINJECT_DUMP = ${JSON.stringify(path.join(sandbox.root, `${name}.noinject`))};
fs.writeFileSync(SID_DUMP, process.env.CPX_SESSION_ID || 'MISSING');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
${baseResolution[opts.mode]}
const PATH_SUFFIX = ${JSON.stringify(wire.path)};
const SID_HEADER = ${JSON.stringify(wire.sidHeader)};
const REQUESTS = ${JSON.stringify(opts.requests)};
const doSend = async (req, n) => {
  const url = base + PATH_SUFFIX;
  const headers = { 'content-type': 'application/json' };
  if (SID_HEADER && req.sid) headers[SID_HEADER] = req.sid;
  if (req.parentSid) headers['x-parent-session-id'] = req.parentSid;
  for (const [k, v] of Object.entries(req.headers || {})) headers[k] = v;
  let body = JSON.stringify(req.body);
  if (req.gzip) {
    headers['content-encoding'] = 'gzip';
    body = zlib.gzipSync(Buffer.from(body, 'utf8'));
  }
  try {
    const r = await fetch(url, { method: 'POST', headers, body });
    const text = await r.text();
    fs.appendFileSync(RESP_DUMP, '=== HTTP ' + r.status + '\\n' + text + '\\n');
    // HTTP 错误不重试：错误旅程（5xx 透传等）要单发确定性；重试只覆盖
    // 网络层瞬态（proxy 未起等）
  } catch (e) {
    if (n > 0) { await sleep(300); return doSend(req, n - 1); }
    // GIVEUP：捕获优先，断言自会红
  }
};
(async () => {
  if (${JSON.stringify(opts.concurrent ?? false)}) {
    // 并发形态：全部发出（delayMs 编排到达序），全收齐后统一收尾
    const ps = REQUESTS.map(async (req) => {
      if (req.delayMs) await sleep(req.delayMs);
      await doSend(req, 5);
    });
    await Promise.all(ps);
  } else {
    // 串行多轮：逐轮等响应（真实对话的因果序）
    for (const req of REQUESTS) {
      if (req.delayMs) await sleep(req.delayMs);
      await doSend(req, 5);
      await sleep(150); // 留流尾 flush 余量
    }
  }
  await sleep(200);
  process.exit(0);
})();
`;
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
  return { path: file, sid: opts.requests.find((r) => r.sid)?.sid ?? null };
}

/** claude 形态单请求便捷件（--settings 反解 + x-claude-code-session-id 头）。 */
export function claudeAgent(sandbox: Sandbox, opts: {
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  sid?: string;
}): FakeAgent {
  return protocolAgent(sandbox, { mode: 'claude', requests: [opts] });
}

/** codex 形态单请求便捷件（-c openai_base_url 反解；responses 无 sid 头）。 */
export function codexAgent(sandbox: Sandbox, opts: {
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}): FakeAgent {
  return protocolAgent(sandbox, { mode: 'codex', requests: [opts] });
}

/** opencode/openai 形态单请求便捷件（OPENAI_BASE_URL + x-session-id 头）。 */
export function openaiAgent(sandbox: Sandbox, opts: {
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  sid?: string;
}): FakeAgent {
  return protocolAgent(sandbox, { mode: 'openai', requests: [opts] });
}

/** 裸脚本 agent（specialized 用例：help fixture 探测 / argv 断言形态）。 */
export function rawAgent(sandbox: Sandbox, name: string, main: string): FakeAgent {
  const file = path.join(sandbox.bin, name);
  const prologue = `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(path.join(sandbox.root, `${name}.sid`))}, process.env.CPX_SESSION_ID || 'MISSING');
`;
  fs.writeFileSync(file, `#!/usr/bin/env node\n${prologue}${main}`);
  fs.chmodSync(file, 0o755);
  return { path: file, sid: null };
}
