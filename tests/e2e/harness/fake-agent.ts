// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 假 agent 工厂（insight「真浏览器」的 cpx 等价物）：真 spawn 真 HTTP 真流式
// drain 的协议客户端脚本——不是 mock，是「最小但真实」的 agent 进程。三协议
// 各一个标准件，注入契约（--settings / -c / OPENAI_BASE_URL）在 agent 侧反
// 向解析——旅程顺带锁定 cpx 的注入形态（agent 怎么拿到代理地址是协议面）。
//
// 通用纪律（与既有 ad-hoc e2e 的假 agent 一致）：
//   · CPX_SESSION_ID 落盘（spec 定位捕获文件的工牌）
//   · 收到的响应全文落盘（透传保真断言：agent 收到 == 桩发出）
//   · 瞬态抖动重试兜底；GIVEUP 也 exit 0（捕获优先，断言自会红）
//   · 绝不因网络失败非零退出——agent 的退出码不是被测物，捕获才是

import fs from 'node:fs';
import path from 'node:path';
import type { Sandbox } from './sandbox';

export interface FakeAgent {
  /** 可执行脚本绝对路径（spawn 用）。 */
  path: string;
  /** agent 自报 sid（claude/opencode 头路由形态；responses 协议无头恒 null）。 */
  sid: string | null;
}

interface AgentOpts {
  /** 请求体（JSON 对象——协议形状由各 agent 标准件负责）。 */
  body: Record<string, unknown>;
  /** 附加请求头（密钥零泄漏用例：Authorization / x-api-key 注入面）。 */
  headers?: Record<string, string>;
  /** 自报会话头值（claude/opencode 形态；不传则不带 sid 头 → 落 pinned 文件）。 */
  sid?: string;
}

/** 通用脚手架：sid 工牌落盘 + 响应落盘 + 重试 + 工具函数。main 须自行 exit。 */
function scaffold(sandbox: Sandbox, name: string): { file: string; prologue: string } {
  const file = path.join(sandbox.bin, name);
  const prologue = `
const fs = require('node:fs');
const SID_DUMP = ${JSON.stringify(path.join(sandbox.root, `${name}.sid`))};
const RESP_DUMP = ${JSON.stringify(path.join(sandbox.root, `${name}.resp`))};
fs.writeFileSync(SID_DUMP, process.env.CPX_SESSION_ID || 'MISSING');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drain = async (url, headers, body, n) => {
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await r.text();
    fs.writeFileSync(RESP_DUMP, 'HTTP ' + r.status + '\\n' + text);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' body=' + text.slice(0, 160));
    await sleep(200); // 留 cpx 流尾 flush 余量
    process.exit(0);
  } catch (e) {
    if (n > 0) { await sleep(300); return drain(url, headers, body, n - 1); }
    process.exit(0); // GIVEUP exit 0：捕获优先，断言自会红
  }
};
`;
  return { file, prologue };
}

function finalize(sandbox: Sandbox, file: string, script: string, sid: string | null): FakeAgent {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${script}`);
  fs.chmodSync(file, 0o755);
  return { path: file, sid };
}

/** claude 形态：base URL 从 argv 的 --settings 注入反解（cpx 用 --settings 而非
 *  env——agent 侧解析即锁定该注入契约）；sid 走 x-claude-code-session-id 头。 */
export function claudeAgent(sandbox: Sandbox, opts: AgentOpts): FakeAgent {
  const name = 'fake-claude';
  const { file, prologue } = scaffold(sandbox, name);
  const main = `
// 注入契约反向解析：--settings '<json>' 里 env.ANTHROPIC_BASE_URL
let base = null;
for (let i = 0; i < process.argv.length - 1; i++) {
  if (process.argv[i] === '--settings') {
    try { base = JSON.parse(process.argv[i + 1]).env.ANTHROPIC_BASE_URL; } catch {}
  }
}
if (!base) { fs.writeFileSync(RESP_DUMP, 'NO_SETTINGS_INJECTION'); process.exit(0); }
const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
if (${JSON.stringify(opts.sid ?? null)}) headers[${JSON.stringify('x-claude-code-session-id')}] = ${JSON.stringify(opts.sid)};
for (const [k, v] of Object.entries(${JSON.stringify(opts.headers ?? {})})) headers[k] = v;
drain(base + ${JSON.stringify('/v1/messages')}, headers, ${JSON.stringify(opts.body)}, 5);
`;
  return finalize(sandbox, file, prologue + main, opts.sid ?? null);
}

/** codex 形态：base URL 从 argv 的 -c openai_base_url="…" 反解（ChatGPT 登录
 *  分支的注入面）；responses 协议无 sid 头 → 捕获落 cpx 钉定文件。 */
export function codexAgent(sandbox: Sandbox, opts: AgentOpts): FakeAgent {
  const name = 'fake-codex';
  const { file, prologue } = scaffold(sandbox, name);
  const main = `
// 注入契约反向解析：-c 'openai_base_url="<url>"'
let base = null;
for (let i = 0; i < process.argv.length; i++) {
  const m = /^openai_base_url="(.+)"$/.exec(process.argv[i]);
  if (m) base = m[1];
}
if (!base) { fs.writeFileSync(RESP_DUMP, 'NO_OPENAI_BASE_URL_INJECTION'); process.exit(0); }
const headers = { 'content-type': 'application/json' };
for (const [k, v] of Object.entries(${JSON.stringify(opts.headers ?? {})})) headers[k] = v;
drain(base + ${JSON.stringify('/responses')}, headers, ${JSON.stringify(opts.body)}, 5);
`;
  return finalize(sandbox, file, prologue + main, null);
}

/** opencode/openai 形态：OPENAI_BASE_URL 环境变量直读；sid 走 x-session-id 头。 */
export function openaiAgent(sandbox: Sandbox, opts: AgentOpts): FakeAgent {
  const name = 'fake-openai';
  const { file, prologue } = scaffold(sandbox, name);
  const main = `
const base = process.env.OPENAI_BASE_URL;
if (!base) { fs.writeFileSync(RESP_DUMP, 'NO_OPENAI_BASE_URL_ENV'); process.exit(0); }
const headers = { 'content-type': 'application/json' };
if (${JSON.stringify(opts.sid ?? null)}) headers[${JSON.stringify('x-session-id')}] = ${JSON.stringify(opts.sid)};
for (const [k, v] of Object.entries(${JSON.stringify(opts.headers ?? {})})) headers[k] = v;
drain(base + ${JSON.stringify('/v1/chat/completions')}, headers, ${JSON.stringify(opts.body)}, 5);
`;
  return finalize(sandbox, file, prologue + main, opts.sid ?? null);
}

/** 裸脚本 agent（specialized 用例：help fixture 探测 / argv 断言形态）。 */
export function rawAgent(sandbox: Sandbox, name: string, main: string): FakeAgent {
  const { file, prologue } = scaffold(sandbox, name);
  return finalize(sandbox, file, prologue + main, null);
}
