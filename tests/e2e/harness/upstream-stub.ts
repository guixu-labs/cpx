// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 假上游模型 API（insight E2E「唯一 stub = 不真打 LLM 厂商」的同位物）：真
// agent 走真 cpx 代理，但上游是本桩——三协议（anthropic messages / openai
// chat / openai responses）可剧本化的 SSE/JSON/拖延应答 + 全量请求台账。
//
// 台账是「纯透传」断言的事实源：cpx 转发给上游的 body 逐字节记录，spec 与
// agent 原始发送对账；headers 同记（密钥零泄漏用例在此证明「上游收到了、
// 捕获里没有」）。

import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** 台账条目：cpx 转发到上游的原始请求（body 逐字节 utf8）。 */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export type UpstreamScript =
  /** SSE 流：text = 预序列化的事件流文本（sseBody 助手生成）。 */
  | { kind: 'sse'; text: string; delayMs?: number }
  /** 一次性 JSON 应答（非流协议路径 / 错误形态）。 */
  | { kind: 'json'; status?: number; body: unknown; delayMs?: number }
  /** 裸应答（全控制：状态行 + 头 + 原样体——无效 gzip 等畸形上游形态）。 */
  | { kind: 'raw'; status: number; headers: Record<string, string>; body: string | Buffer; delayMs?: number }
  /** 拖延（nonstream-stall 类用例）：挂住连接不回。 */
  | { kind: 'stall'; ms?: number };

export interface UpstreamStub {
  /** 桩根地址（CONTEXT_PROXY_*_UPSTREAM 指这里）。 */
  url: string;
  /** 全量请求台账（透传对账事实源）。 */
  requests: RecordedRequest[];
  /** 按 path 后缀配剧本（如 '/v1/messages'）；未配路由走 default 剧本。 */
  script(pathSuffix: string, script: UpstreamScript): void;
  /** 按 path 后缀配剧本队列：每次命中消费一个（FIFO），队空回落 fallback——
   *  同路由多请求差异化应答（到达序/并发用例）的事实源。 */
  scriptQueue(pathSuffix: string, scripts: UpstreamScript[]): void;
  /** 兜底剧本（默认 404 台账——未期路由到上游也算请求，对账时可见）。 */
  fallback(script: UpstreamScript): void;
  close(): Promise<void>;
}

/** SSE 事件流序列化（协议中立）：每事件一行 data: <json>，可选 OpenAI 式收尾。 */
export function sseBody(events: unknown[], opts: { openAIDone?: boolean } = {}): string {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return opts.openAIDone ? `${text}data: [DONE]\n\n` : text;
}

export async function startUpstreamStub(): Promise<UpstreamStub> {
  const requests: RecordedRequest[] = [];
  const scripts = new Map<string, UpstreamScript[]>();
  let fallbackScript: UpstreamScript | null = null;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '/';
      requests.push({
        method: req.method ?? 'GET',
        path: url,
        headers: { ...req.headers },
        body,
      });
      // 后缀匹配（带 query / provider 前缀的路由都能命中：/<pid>/chat/completions）
      // 命中即消费队首（FIFO）；队空或未配走 fallback
      let script: UpstreamScript | null = null;
      for (const [suffix, queue] of scripts) {
        if (url.includes(suffix)) {
          script = queue.length > 0 ? queue.shift()! : null;
          break;
        }
      }
      script ??= fallbackScript ?? { kind: 'json', status: 404, body: { error: 'unscripted route' } };
      const sc: UpstreamScript = script;
      // 应答延时：编排「后到先答」的到达序（异步回填类用例的事实源）
      const respond = () => {
        if (sc.kind === 'stall') {
          // 挂住不断（stall 用例的连接形态），到时销毁强制断开
          const t = setTimeout(() => { res.destroy(); }, sc.ms ?? 60_000);
          res.on('close', () => clearTimeout(t));
          return;
        }
        if (sc.kind === 'sse') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(sc.text);
          return;
        }
        if (sc.kind === 'raw') {
          res.writeHead(sc.status, sc.headers);
          res.end(sc.body);
          return;
        }
        res.writeHead(sc.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(sc.body));
      };
      if ('delayMs' in sc && sc.delayMs) {
        setTimeout(respond, sc.delayMs);
        return;
      }
      respond();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    script: (suffix, s) => { scripts.set(suffix, [s]); },
    scriptQueue: (suffix, list) => { scripts.set(suffix, [...list]); },
    fallback: (s) => { fallbackScript = s; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
