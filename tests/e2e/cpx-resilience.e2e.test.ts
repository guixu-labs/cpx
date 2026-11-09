// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 韧性与边界旅程（真实现场的五种异常形态 + 一种积压形态）：
//   ① 上游 5xx：错误原样透传给 agent（诊断信息零吞），轮次仍捕获
//   ② SIGINT 快速收尾：Ctrl-C → 退出码 130、占位/manifest 清净、代理
//      零泄漏（收尾不变量）；顺带锁 `cpx status` 的活会话观测面
//   ③ 大体量：1MB 级消息体双向保真（转发字节原样 + 捕获全文）
//   ④ gzip 请求体：转发侧字节不动（content-encoding 原样），捕获侧
//      透明解压（两半各证一半，合起来才是完整契约）
//   ⑤ 并发到达序：先到慢应答 + 后到快应答 → 落盘序 = 到达序而非完成序
//      （ordered-dispatch 的核心承诺）
//   ⑥ 陈旧占位清扫：上次 SIGKILL 残留的 0 字节占位，下次启动即扫除

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { startUpstreamStub, sseBody, type UpstreamStub, type UpstreamScript } from './harness/upstream-stub';
import { protocolAgent, rawAgent } from './harness/fake-agent';
import { readCaptureLines, assertClaudeJsonlContract } from './harness/capture';
import { runCpx, startCpx, runCommand, readAgentResponse } from './harness/session';
import { ENV, ROUTES } from './harness/constants';

let sandbox: Sandbox;
let stub: UpstreamStub;

beforeAll(async () => {
  sandbox = createSandbox('cpx-resilience-');
  stub = await startUpstreamStub();
});

afterAll(() => {
  sandbox.cleanup();
  return stub.close();
});

function textSse(text: string): UpstreamScript {
  return {
    kind: 'sse',
    text: sseBody([
      { type: 'message_start', message: { model: 'claude-opus-x', usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]),
  };
}

function waitFile(file: string, ms = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (fs.existsSync(file)) { clearInterval(iv); resolve(); return; }
      if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`timeout waiting ${file}`)); }
    }, 200);
  });
}

describe('cpx 韧性与边界（5xx / SIGINT / 大体量 / gzip / 到达序 / 占位清扫）', () => {
  it('① 上游 5xx：错误透传零吞 + 轮次仍捕获', async () => {
    const ERR_BODY = JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    stub.script(ROUTES.anthropic, { kind: 'raw', status: 503, headers: { 'content-type': 'application/json' }, body: ERR_BODY });
    const agent = protocolAgent(sandbox, {
      mode: 'claude',
      name: 'fake-res-5xx',
      requests: [{ sid: 'e2e-res-5xx', body: { model: 'claude-opus-x', max_tokens: 8, stream: false, messages: [{ role: 'user', content: '触发过载' }] } }],
    });

    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);
    // agent 侧：错误体逐字节到达（诊断信息零吞）
    expect(readAgentResponse(sandbox, 'fake-res-5xx')).toBe(`=== HTTP 503\n${ERR_BODY}\n`);
    // 捕获侧：轮次仍在（user 行 + 状态记录）
    const lines = readCaptureLines(sandbox, 'e2e-res-5xx');
    assertClaudeJsonlContract(lines);
    expect(JSON.stringify(lines)).toContain('触发过载');
    const round = lines.find((l) => l.type === 'assistant') as { x_lake: { data: { status: number } } } | undefined;
    expect(round?.x_lake.data.status).toBe(503);
  }, 120_000);

  it('② SIGINT 收尾：退出码 130 + 占位清净 + `cpx status` 活会话观测', async () => {
    stub.script(ROUTES.anthropic, textSse('（不应被消费——本用例 agent 只睡眠）'));
    // 睡眠 agent：真 spawn 真挂住（探测期无注入 env 即退——不阻塞 probeHelp）
    const agent = rawAgent(sandbox, 'fake-res-sleep', 'setTimeout(() => {}, 90_000);');

    const session = startCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    // 等 agent 真启动（sid 工牌落盘）
    const sidFile = `${sandbox.root}/fake-res-sleep.sid`;
    await waitFile(sidFile);
    const pinned = fs.readFileSync(sidFile, 'utf8').trim();
    expect(pinned, 'agent did not receive CPX_SESSION_ID').not.toBe('MISSING');

    // `cpx status`：活会话可见（并行 spec 各有代理，只断言本会话的 sid 行）
    const st = await runCommand(sandbox, 'bash', ['cpx-cli', 'status']);
    expect(st.code, `status output:\n${st.output}`).toBe(0);
    expect(st.output).toMatch(/proxy processes : \d+ running/);
    expect(st.output).toContain(`sid ${pinned}`);

    // SIGINT：wrapper 是 exec 单进程，信号直达 cpx-cli
    session.child.kill('SIGINT');
    const done = await session.done;
    expect(done.code, `cpx output on SIGINT:\n${done.output}`).toBe(130);

    // 本会话占位（0 字节）+ 运行清单被信号路径清理（dropSessionScratch）
    for (const ext of ['.jsonl', '.jsonl.7z', '.jsonl.gz', '.sids']) {
      const p = `${sandbox.captures}/cpx-${pinned}${ext}`;
      expect(fs.existsSync(p), `leftover ${p} after SIGINT`).toBe(false);
    }
    // 代理零存活（并行 spec 各有代理——只断言本会话的 sid 已从活清单消失）
    const st2 = await runCommand(sandbox, 'bash', ['cpx-cli', 'status']);
    expect(st2.output).not.toContain(`sid ${pinned}`);
  }, 120_000);

  it('③ 大体量：1MB 消息体双向保真', async () => {
    const MARKER = 'BIGPAYLOAD-START';
    const big = `${MARKER}${'A'.repeat(1_048_576)}END`;
    stub.script(ROUTES.anthropic, textSse('收到大块'));
    const agent = protocolAgent(sandbox, {
      mode: 'claude',
      name: 'fake-res-big',
      requests: [{ sid: 'e2e-res-big', body: { model: 'claude-opus-x', max_tokens: 8, stream: true, messages: [{ role: 'user', content: big }] } }],
    });

    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);
    // 上游侧：字节全量到达（≥1MB）
    expect(stub.requests[stub.requests.length - 1].body.length).toBeGreaterThan(1_048_576);
    expect(stub.requests[stub.requests.length - 1].body).toContain(MARKER);
    // 捕获侧：全文落盘（读回解压链）
    const lines = readCaptureLines(sandbox, 'e2e-res-big');
    assertClaudeJsonlContract(lines);
    const user = JSON.stringify(lines.find((l) => l.type === 'user'));
    expect(user).toContain(MARKER);
    expect(user).toContain('END');
  }, 120_000);

  it('④ gzip 请求体：转发字节不动，捕获透明解压', async () => {
    stub.script(ROUTES.anthropic, textSse('gzip 回答'));
    const agent = protocolAgent(sandbox, {
      mode: 'claude',
      name: 'fake-res-gzip',
      requests: [{
        sid: 'e2e-res-gzip',
        gzip: true,
        body: { model: 'claude-opus-x', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'gzip 明文载荷' }] },
      }],
    });

    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);
    // 上游侧：收到的是 gzip 字节（content-encoding 原样透传，明文不在体里）
    const hit = stub.requests[stub.requests.length - 1];
    expect(hit.headers['content-encoding']).toBe('gzip');
    expect(hit.body).not.toContain('gzip 明文载荷');
    // 捕获侧：透明解压（requestBodyForCapture 的 content-encoding 链）
    const lines = readCaptureLines(sandbox, 'e2e-res-gzip');
    assertClaudeJsonlContract(lines);
    expect(JSON.stringify(lines.find((l) => l.type === 'user'))).toContain('gzip 明文载荷');
  }, 120_000);

  it('⑤ 并发到达序：落盘序 = 到达序（非完成序）', async () => {
    // 先到的请求给慢应答（500ms），后到的给即时应答——完成序与到达序相反
    stub.scriptQueue(ROUTES.anthropic, [
      { ...textSse('先到慢答'), delayMs: 500 },
      textSse('后到快答'),
    ]);
    const agent = protocolAgent(sandbox, {
      mode: 'claude',
      name: 'fake-res-order',
      concurrent: true,
      requests: [
        { sid: 'e2e-res-order', delayMs: 0, body: { model: 'claude-opus-x', max_tokens: 8, stream: true, messages: [{ role: 'user', content: '先到请求' }] } },
        { sid: 'e2e-res-order', delayMs: 120, body: { model: 'claude-opus-x', max_tokens: 8, stream: true, messages: [{ role: 'user', content: '后到请求' }] } },
      ],
    });

    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    const lines = readCaptureLines(sandbox, 'e2e-res-order');
    assertClaudeJsonlContract(lines);
    const assistants = lines.filter((l) => l.type === 'assistant') as Array<{ x_lake: { data: { roundIndex: number } }; message: { content: Array<{ text?: string }> } }>;
    expect(assistants).toHaveLength(2);
    // 先到者（完成在后）拿 roundIndex 0——到达序派发，非完成序
    expect(assistants[0].message.content.some((b) => b.text === '先到慢答')).toBe(true);
    expect(assistants[0].x_lake.data.roundIndex).toBe(0);
    expect(assistants[1].message.content.some((b) => b.text === '后到快答')).toBe(true);
    expect(assistants[1].x_lake.data.roundIndex).toBe(1);
    // user 行落盘序同样 = 到达序
    const users = lines.filter((l) => l.type === 'user') as Array<{ message: { content: string } }>;
    expect(users.map((u) => u.message.content)).toEqual(['先到请求', '后到请求']);
  }, 120_000);

  it('⑥ 陈旧占位清扫：上次 SIGKILL 残留的 0 字节占位，启动即扫', async () => {
    // 预置历史积压：0 字节占位，无伴生 meta（SIGKILL 后无人清理的真形态。
    // 注意：带伴生 meta 的占位是真实会话产物——清扫刻意跳过，绝不误删）
    const stale = `${sandbox.captures}/cpx-e2e-res-stale.jsonl`;
    fs.writeFileSync(stale, '');

    stub.script(ROUTES.anthropic, textSse('清扫后正常回答'));
    const agent = protocolAgent(sandbox, {
      mode: 'claude',
      name: 'fake-res-sweep',
      requests: [{ sid: 'e2e-res-sweep', body: { model: 'claude-opus-x', max_tokens: 8, stream: true, messages: [{ role: 'user', content: '清扫验证' }] } }],
    });

    const r = await runCpx(sandbox, ['--agent', 'claude', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    // 陈旧占位被启动清扫带走，本会话捕获正常存在
    expect(fs.existsSync(stale)).toBe(false);
    const lines = readCaptureLines(sandbox, 'e2e-res-sweep');
    expect(JSON.stringify(lines)).toContain('清扫验证');
  }, 120_000);
});
