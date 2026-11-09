// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 非流式响应体读取失败 E2E IT（到达序墓碑推进）：handleNonStream 的
// upstreamRes.text() 无兜底时，body 读取失败的异常冒泡到顶层 catch 只回
// 500，该请求的 arrivalSeq 永不 submit——所有协议共用一个
// OrderedDispatcher，卡死 = 之后全部记录只进内存缓冲、永不落盘（捕获侧
// 静默全丢，代理表面正常）。本 IT 锁全链路：真 server → mock 网关无效
// gzip 体 → 客户端 502 + 墓碑推进 → 后续请求照常捕获落盘。
// （proxy 层 IT：spawnProxy 直起 server.ts，不经 cpx-cli——被测物是代理
//  本身的错误路径；stub 用 raw 剧本构造「完整送达的头 + 无效 gzip 体」。）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { startUpstreamStub, type UpstreamStub } from './harness/upstream-stub';
import { spawnProxy, type ProxyHandle } from './harness/session';
import { readCaptureText } from '../../src/compression.ts';
import { ROUTES } from './harness/constants';

const SID = 'cpx-e2e-nonstream';

let sandbox: Sandbox;
let stub: UpstreamStub;
let proxy: ProxyHandle;

// normal 分支：完整 JSON 应答
const NORMAL_BODY = JSON.stringify({
  id: 'cmpl-e2e-nonstream-ok',
  model: 'test-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});

beforeAll(async () => {
  sandbox = createSandbox('cpx-nonstream-e2e-');
  stub = await startUpstreamStub();

  // mock 网关：broken 分支用「完整送达的头 + 无效 gzip 体」确定性触发
  // upstreamRes.text() reject——undici 的 fetch 读 body 时按 content-encoding
  // 解压，无效 gzip 必失败。不用 destroy() 抢断：那可能连响应头都没送达，
  // 落进本就有墓碑兜底的 fetch 失败路径，打不到被测的 text() 链。
  stub.fallback({ kind: 'json', status: 404, body: { error: 'unmocked' } });
  stub.script(ROUTES.openai, { kind: 'json', status: 200, body: JSON.parse(NORMAL_BODY) });

  // 直起会话代理（startSessionProxy 同款纪律：node --import tsx loader）
  proxy = await spawnProxy(sandbox, { sid: SID, upstreams: { CONTEXT_PROXY_OPENAI_UPSTREAM: stub.url } });
});

afterAll(() => {
  proxy.kill();
  sandbox.cleanup();
  return stub.close();
});

function post(body: string, headers: Record<string, string> = {}) {
  return fetch(`${proxy.url}/v1/chat/completions`, {
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
    stub.script(ROUTES.openai, {
      kind: 'raw',
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: 'definitely-not-gzip',
    });
    const r1 = await post(REQ, { 'x-test-case': 'broken' });
    expect(r1.status).toBe(502);

    // 第 2 个请求：必须 200，且其记录必须落盘（修复前：滞留 pending 缓冲
    // 永不写盘——本断言红）
    stub.script(ROUTES.openai, { kind: 'json', status: 200, body: JSON.parse(NORMAL_BODY) });
    const r2 = await post(REQ);
    expect(r2.status).toBe(200);
    expect(await r2.text()).toContain('ok');

    // 捕获文件最终有且仅有第 2 个请求的记录（第 1 个墓碑丢弃）
    const stem = path.join(sandbox.captures, `cpx-${SID}`);
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
