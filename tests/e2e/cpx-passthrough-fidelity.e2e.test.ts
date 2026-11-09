// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 透传保真 + 密钥零泄漏（cpx 的产品双承诺，旅程级成对兑现——insight
// browserConsole 验收门的 cpx 同位物：绿用例若违反产品承诺即判负）：
//   纯透传（请求侧）：上游台账收到 == agent 发出——body 逐字节、认证头
//   （Authorization / x-api-key）原样到达真实上游；
//   纯透传（响应侧）：agent 收到 == 桩发出——tee 流零干预零改写；
//   零泄漏：捕获内容（透明解压后的全文）+ meta 明文对机密串零命中。
// 「上游收到了、捕获里没有」必须成对出现——只证其一都不是完整证明
// （只证上游收到 = 没测 redactor；只证捕获没有 = 没测透传）。
// 语料带多字节/emoji/引号/尖括号/长尾串——字节级漂移（编码、截断、
// 转义重排）一概逃不掉 JSON.stringify 逐字节对账。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { startUpstreamStub, sseBody, type UpstreamStub } from './harness/upstream-stub';
import { claudeAgent } from './harness/fake-agent';
import { assertNoSecrets } from './harness/capture';
import { runCpx, readAgentResponse } from './harness/session';
import { ENV, ROUTES } from './harness/constants';

const SID = 'e2e-passthrough-01';
const SECRET_BEARER = 'sk-e2e-bearer-7f3a9c2e';
const SECRET_APIKEY = 'sk-ant-e2e-apikey-2b8d1f6a';

let sandbox: Sandbox;
let stub: UpstreamStub;

beforeAll(async () => {
  sandbox = createSandbox('cpx-passthrough-');
  stub = await startUpstreamStub();
});

afterAll(() => {
  sandbox.cleanup();
  return stub.close();
});

const BODY = {
  model: 'claude-opus-x',
  max_tokens: 32,
  stream: true,
  system: 'You are a passthrough fidelity probe. "quotes" & <angles>',
  messages: [{
    role: 'user',
    content: '多字节 🌏 内容 "quoted" <tag> plus a long tail: ' + 'x'.repeat(4096),
  }],
};

const SSE_TEXT = sseBody([
  { type: 'message_start', message: { model: 'claude-opus-x', usage: { input_tokens: 3 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'verbatim' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]);

describe('cpx 透传保真 + 密钥零泄漏（上游收到==agent 发出；捕获零机密）', () => {
  it('请求/响应双侧字节对账 + 捕获与 meta 机密零命中', async () => {
    stub.script(ROUTES.anthropic, { kind: 'sse', text: SSE_TEXT });
    const agent = claudeAgent(sandbox, {
      sid: SID,
      headers: { authorization: `Bearer ${SECRET_BEARER}`, 'x-api-key': SECRET_APIKEY },
      body: BODY,
    });

    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    // ── 请求侧：上游台账逐字节对账 ─────────────────────────────
    const upstreamCall = stub.requests.find((x) => x.path.includes(ROUTES.anthropic));
    expect(upstreamCall, 'upstream did not receive the request').toBeDefined();
    expect(upstreamCall!.method).toBe('POST');
    expect(upstreamCall!.body, 'body must be byte-identical passthrough').toBe(JSON.stringify(BODY));
    // 认证头原样到达真实上游（透传承诺：cpx 不吞不换认证）
    expect(upstreamCall!.headers.authorization).toBe(`Bearer ${SECRET_BEARER}`);
    expect(upstreamCall!.headers['x-api-key']).toBe(SECRET_APIKEY);

    // ── 响应侧：agent 收到 == 桩发出（tee 零干预）──────────────
    const resp = readAgentResponse(sandbox, 'fake-claude');
    expect(resp).toBe(`HTTP 200\n${SSE_TEXT}`);

    // ── 零泄漏：捕获全文（透明解压）+ meta 明文 ─────────────────
    assertNoSecrets(sandbox, SID, [SECRET_BEARER, SECRET_APIKEY]);
    for (const f of fs.readdirSync(sandbox.captures)) {
      if (!f.endsWith('.meta.json')) continue;
      const metaText = fs.readFileSync(path.join(sandbox.captures, f), 'utf8');
      expect(metaText.includes(SECRET_BEARER), `secret in ${f}`).toBe(false);
      expect(metaText.includes(SECRET_APIKEY), `secret in ${f}`).toBe(false);
    }
  }, 120_000);
});
