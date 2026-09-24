// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// DeepSeek 思考流捕获 E2E IT（真行为锁）：现场 ses_f4da12dc —— cpx 件 vs
// opencode native 件按 tool_use id 对齐，109/182 轮 assistant 的 <thinking>
// 整块丢失（DeepSeek 系网关思考走 delta.reasoning_content 独立字段，旧
// OpenAIReassembler 只收 delta.content/tool_calls → 捕获件只剩工具调用，
// insight 查看大量 turn 没有 LLM Output）。单测锁重组器纯函数，本 IT 锁
// 全链路：真 cpx-cli → 真 proxy → mock 网关 SSE 思考流 → 重组 → emitter →
// 捕获 jsonl 落盘（防"单测过、链路丢"）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readCaptureText } from '../../src/compression.ts';

const WRAPPER = path.join(path.resolve(__dirname, '../../'), 'cpx-cli');

let TMP: string;
let CAPTURES: string;
let AGENT: string;
let AGENT_SID_DUMP: string;
let server: http.Server;
let upstream = '';

// mock 网关：/v1/chat/completions → DeepSeek 形态 SSE（思考 → 工具 → 计费
// usage 含 completion_tokens_details.reasoning_tokens —— 与现场网关同构）
const SSE_BODY = [
  { id: 'cmpl-e2e-rsn', model: 'deepseek-v4-pro', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '让我先想想' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { reasoning_content: '再确认一下' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_e2e_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 4 } } },
].map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';

beforeAll(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-reasoning-e2e-'));
  CAPTURES = path.join(TMP, 'captures');
  fs.mkdirSync(CAPTURES, { recursive: true });

  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(SSE_BODY);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unmocked' }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  upstream = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // 假 agent（autoupload e2e 同款纪律）：经注入的 OPENAI_BASE_URL 发一次真实
  // 流式请求（stream:true），drain 后退出；CPX_SESSION_ID 落盘供断言定位捕获
  // 文件。瞬态抖动重试兜底，GIVEUP 也 exit 0（捕获优先，断言自会红）。
  AGENT_SID_DUMP = path.join(TMP, 'agent.sid');
  AGENT = path.join(TMP, 'fake-agent');
  fs.writeFileSync(AGENT, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(AGENT_SID_DUMP)}, process.env.CPX_SESSION_ID || 'MISSING');
const base = process.env.OPENAI_BASE_URL;
const sleep = (ms) => new Promise(rs => setTimeout(rs, ms));
const attempt = async (n) => {
  try {
    const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-pro', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    const txt = await r.text();
    if (!r.ok || !txt.includes('[DONE]')) throw new Error('HTTP ' + r.status + ' body=' + txt.slice(0, 120));
    await sleep(300);
    process.exit(0);
  } catch (e) {
    if (n > 0) { await sleep(300); return attempt(n - 1); }
    process.exit(0);
  }
};
attempt(5);
`);
  fs.chmodSync(AGENT, 0o755);
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  if (!process.env.CPX_E2E_KEEP) fs.rmSync(TMP, { recursive: true, force: true });
});

function runCpx(): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    const p = spawn('bash', [WRAPPER, AGENT], {
      env: {
        ...process.env,
        CANNBOT_PROXY_DIR: CAPTURES,
        CANNBOT_PROXY_OPENAI_UPSTREAM: upstream,
        // 钉死不可达：不机会主义导入开发机在跑的真 insight、不开浏览器
        CANNBOT_CPX_INSIGHT_BASE: 'http://127.0.0.1:1',
        // belt+braces：openBrowser 熔断守卫（browser-guard.test.ts 源级锁消费本行）
        CANNBOT_NO_BROWSER: '1',
        HOME: TMP,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => resolve({ code: code ?? -1, output: out }));
  });
}

function readCapture(): any[] {
  const sid = fs.readFileSync(AGENT_SID_DUMP, 'utf-8').trim();
  expect(sid).not.toBe('MISSING');
  // 退出时 at-rest 压缩为 .jsonl.7z（在途为 .jsonl）—— readCaptureText 三形态
  // 透明解压（生产件复用）
  const stem = path.join(CAPTURES, `cpx-${sid}`);
  const f = [`${stem}.jsonl`, `${stem}.jsonl.7z`].find(p => fs.existsSync(p));
  expect(f, `capture file missing: ${stem}.jsonl(.7z)`).toBeDefined();
  return readCaptureText(f!).split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

describe('cpx DeepSeek 思考流捕获 E2E（reasoning_content → thinking 块全链路）', () => {
  it('捕获 jsonl：thinking 块置首 + tool_use + reasoning tokens 双通道', async () => {
    const r = await runCpx();
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    const lines = readCapture();
    // user 轮落盘（wire 输入 delta 发射）
    expect(lines.some(l => l.type === 'user' && JSON.stringify(l.message?.content).includes('hi'))).toBe(true);

    const asst = lines.find(l => l.type === 'assistant');
    expect(asst, 'assistant line missing').toBeDefined();
    expect(asst.source).toBe('opencode-proxy');
    expect(asst.message.model).toBe('deepseek-v4-pro');
    // thinking 块置首 + 工具调用（修复前：content 只剩 tool_use，LLM Output 空）
    expect(asst.message.content[0]).toEqual({ type: 'thinking', thinking: '让我先想想再确认一下' });
    expect(asst.message.content[1]).toMatchObject({ type: 'tool_use', id: 'call_e2e_1', name: 'bash' });
    // usage：openai 网关计费字段全量映射（含思考 token）
    expect(asst.message.usage).toMatchObject({ input_tokens: 11, output_tokens: 6, cache_read_input_tokens: 2, reasoning_tokens: 4 });
    // 声明式通道：insight claude-jsonl 既有 reasoningTokens 读取
    expect(asst.x_cannbay.schema).toBe('cc-wire-round');
    expect(asst.x_cannbay.version).toBe(1);
    expect(asst.x_cannbay.data.reasoningTokens).toBe(4);
    // 思考首 token 即计时起点（ttftMs 存在而非 null）
    expect(typeof asst.ttftMs).toBe('number');
  }, 120_000);
});
