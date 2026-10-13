// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 非流式响应体读取失败 E2E IT（到达序墓碑推进）：handleNonStream 的
// upstreamRes.text() 无兜底时，body 读取失败的异常冒泡到顶层 catch 只回
// 500，该请求的 arrivalSeq 永不 submit——所有协议共用一个
// OrderedDispatcher，卡死 = 之后全部记录只进内存缓冲、永不落盘（捕获侧
// 静默全丢，代理表面正常）。本 IT 锁全链路：真 server → mock 网关无效
// gzip 体 → 客户端 502 + 墓碑推进 → 后续请求照常捕获落盘。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { resolveTsxLoader } from '../../src/cli/tsx-launcher.ts';
import { readCaptureText } from '../../src/compression.ts';

const PROXY_ROOT = path.resolve(__dirname, '../../');
const TSX_LOADER = resolveTsxLoader(__filename);
const SID = 'cpx-e2e-nonstream';

let TMP: string;
let CAPTURES: string;
let upstreamServer: http.Server;
let upstream = '';
let proxy: ChildProcess | null = null;
let proxyPort = 0;

const NORMAL_BODY = JSON.stringify({
  id: 'cmpl-e2e-nonstream-ok',
  model: 'test-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});

beforeAll(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-nonstream-e2e-'));
  CAPTURES = path.join(TMP, 'captures');
  fs.mkdirSync(CAPTURES, { recursive: true });

  // mock 网关：broken 分支用「完整送达的头 + 无效 gzip 体」确定性触发
  // upstreamRes.text() reject——undici 的 fetch 读 body 时按 content-encoding
  // 解压，无效 gzip 必失败。不用 destroy() 抢断：那可能连响应头都没送达，
  // 落进本就有墓碑兜底的 fetch 失败路径，打不到被测的 text() 链。
  // normal 分支回完整 JSON
  upstreamServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      if (req.headers['x-test-case'] === 'broken') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(Buffer.from('definitely-not-gzip'));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(NORMAL_BODY);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unmocked' }));
  });
  await new Promise<void>(r => upstreamServer.listen(0, '127.0.0.1', r));
  upstream = `http://127.0.0.1:${(upstreamServer.address() as { port: number }).port}`;

  // 直起会话代理（startSessionProxy 同款纪律：node --import tsx loader）
  proxy = spawn(process.execPath, ['--import', TSX_LOADER!, path.join(PROXY_ROOT, 'src', 'server.ts')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: PROXY_ROOT,
    env: {
      ...process.env,
      CANNBOT_PROXY_PORT: '0',
      CANNBOT_PROXY_SESSION_ID: SID,
      CANNBOT_PROXY_OPENAI_UPSTREAM: upstream,
      CANNBOT_PROXY_DIR: CAPTURES,
    },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy did not report port within 30s')), 30000);
    const onData = (d: Buffer) => {
      const m = d.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m && !proxyPort) {
        proxyPort = parseInt(m[1]);
        clearTimeout(timer);
        resolve();
      }
    };
    proxy.stdout!.on('data', onData);
    proxy.stderr!.on('data', (d) => process.stderr.write(d));
    proxy.on('exit', () => { if (!proxyPort) { clearTimeout(timer); reject(new Error('proxy exited before reporting a port')); } });
  });
});

afterAll(async () => {
  try { proxy?.kill('SIGTERM'); } catch { /* best-effort */ }
  await new Promise<void>(r => upstreamServer.close(() => r()));
  if (!process.env.CPX_E2E_KEEP) fs.rmSync(TMP, { recursive: true, force: true });
});

function post(body: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

const REQ = JSON.stringify({ model: 'test-model', stream: false, messages: [{ role: 'user', content: 'hi' }] });

describe('cpx 非流式响应体读取失败 E2E（墓碑推进，dispatcher 不卡死）', () => {
  it('上游 body 读取失败 → 客户端 502；后续请求照常 200 且捕获落盘', async () => {
    // 第 1 个请求：无效 gzip 体让 text() reject。修复前：异常冒泡到顶层
    // catch 回 500、arrivalSeq 永不 submit，dispatcher 卡死；修复后：墓碑
    // submit + 502。
    const r1 = await post(REQ, { 'x-test-case': 'broken' });
    expect(r1.status).toBe(502);

    // 第 2 个请求：必须 200，且其记录必须落盘（修复前：滞留 pending 缓冲
    // 永不写盘——本断言红）
    const r2 = await post(REQ);
    expect(r2.status).toBe(200);
    expect(await r2.text()).toContain('ok');

    // 捕获文件最终有且仅有第 2 个请求的记录（第 1 个墓碑丢弃）
    const stem = path.join(CAPTURES, `cpx-${SID}`);
    let text = '';
    for (let i = 0; i < 100; i++) {
      const f = [`${stem}.jsonl`, `${stem}.jsonl.7z`].find(p => fs.existsSync(p));
      if (f) {
        text = readCaptureText(f);
        if (text.trim()) break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    expect(text.trim(), `capture never landed: ${stem}.jsonl(.7z)`).not.toBe('');
    const lines = text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    // 恰好第 2 个请求的一轮（user + assistant 两行；第 1 个请求墓碑丢弃，
    // 修复前两行都不会落盘）
    expect(lines).toHaveLength(2);
    expect(lines.filter((l) => l.type === 'user')).toHaveLength(1);
    const assistant = lines.filter((l) => l.type === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(JSON.stringify(assistant[0])).toContain('ok');
  }, 60000);
});
