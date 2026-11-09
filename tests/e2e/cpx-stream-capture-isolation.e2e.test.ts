// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { resolveTsxLoader } from '../../src/cli/tsx-launcher.ts';
import { readCaptureText } from '../../src/compression.ts';

const root = path.resolve(__dirname, '../..');
const first = 'data: null\n\n';
const streams = [
  { route: '/v1/chat/completions', marker: 'later-openai', events: [
    { choices: [{ delta: { content: 'later-openai' } }] },
  ] },
  { route: '/v1/messages', marker: 'later-anthropic', events: [
    { type: 'message_start', message: { model: 'test', usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'later-anthropic' } },
    { type: 'message_stop' },
  ] },
  { route: '/v1/responses', marker: 'later-responses', events: [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant' } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'later-responses' },
  ] },
].map(item => ({ ...item, last: item.events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n' }));
let tmp: string;
let upstream: http.Server;
let proxy: ChildProcess;
let port: number;
let stderr = '';
const sid = 'stream-isolation';

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-stream-isolation-'));
  upstream = http.createServer((req, res) => {
    const stream = streams.find(item => item.route === req.url || item.route === '/v1' + req.url);
    if (!stream) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(first);
    setTimeout(() => res.end(stream.last), 30);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const loader = resolveTsxLoader(__filename);
  if (!loader) throw new Error('tsx loader unavailable');
  proxy = spawn(process.execPath, ['--import', loader, path.join(root, 'src', 'server.ts')], {
    cwd: root,
    env: { ...process.env, CONTEXT_PROXY_PORT: '0', CONTEXT_PROXY_DIR: tmp, CONTEXT_PROXY_SESSION_ID: sid,
      CONTEXT_PROXY_OPENAI_UPSTREAM: base, CONTEXT_PROXY_ANTHROPIC_UPSTREAM: base,
      CONTEXT_PROXY_RESPONSES_UPSTREAM: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxy.stderr!.on('data', data => { stderr += String(data); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy startup timed out')), 30000);
    proxy.once('exit', code => { clearTimeout(timer); reject(new Error(`proxy exited: ${code}`)); });
    proxy.stdout!.on('data', data => {
      const match = String(data).match(/127\.0\.0\.1:(\d+)/);
      if (match) { port = Number(match[1]); clearTimeout(timer); resolve(); }
    });
  });
});

afterAll(async () => {
  proxy?.kill();
  if (upstream) await new Promise<void>(resolve => upstream.close(() => resolve()));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('stream capture failures do not interrupt proxy responses', () => {
  for (const { route, marker, last } of streams) {
    it(`forwards the failing event and subsequent bytes for ${route}`, async () => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(route === '/v1/responses'
          ? { model: 'test', stream: true, input: [{ type: 'message', role: 'user',
            content: [{ type: 'input_text', text: 'hi' }] }] }
          : { model: 'test', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(first + last);
      const stem = path.join(tmp, `cpx-${sid}`);
      let captured = '';
      for (let i = 0; i < 100; i++) {
        const file = [`${stem}.jsonl`, `${stem}.jsonl.7z`].find(p => fs.existsSync(p));
        if (file) captured = readCaptureText(file);
        if (captured.includes(marker)) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const assistants = captured.split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(record => record.type === 'assistant');
      expect(JSON.stringify(assistants), stderr).toContain(marker);
      expect(stderr).not.toContain('[proxy] stream capture failed:');
    });
  }
});
