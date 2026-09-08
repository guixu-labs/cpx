// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cannbot-emitter 适配测试（docs/CANNBOT-DESIGN.md §5.3）：cannbot 是 opencode 系
// fork，wire 层与 opencode 同形（openai 协议 + X-Session-Id 头），UA 是唯一
// 区分信号。验证：UA cannbot/* → meta framework='cannbot' + ccVersion +
// 行级 source='cannbot-proxy' + 顶层 version；UA opencode/* 路径逐字节不变
//（回归锁）；UA 缺失 = opencode 既有行为。

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emit } from '../src/opencode-emitter.ts';
import { sessionFilePath, sessionMetaPath } from '../src/writer.ts';

const CB_SID = 'ses_cannbot_it_main';
const OC_SID = 'ses_opencode_regression';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-cannbot-'));
process.env.CANNBOT_PROXY_DIR = tmpDir; // BEFORE sessionFilePath is evaluated at module scope

function record(sid: string, userAgent: string | null): object {
  return {
    sid,
    protocol: 'openai',
    receivedAt: 1700000000000,
    completedAt: 1700000001000,
    latencyMs: 1000,
    userAgent,
    request: {
      path: '/cannbot/chat/completions',
      model: 'glm-5.2',
      body: {
        model: 'glm-5.2',
        messages: [
          { role: 'system', content: 'You are cannbot, the CANN coding agent.\n\nInstructions from: /home/user/AGENTS.md' },
          { role: 'user', content: '帮我看一下这个算子' },
        ],
        tools: [{ type: 'function', function: { name: 'bash', description: 'Run a command.' } }],
      },
    },
    response: {
      status: 200,
      model: 'glm-5.2',
      content: [{ type: 'text', text: '收到，开始分析。' }],
      usage: { input_tokens: 100, output_tokens: 20 },
      stop_reason: 'stop',
    },
  };
}

beforeAll(() => {
  emit(record(CB_SID, 'cannbot/1.1.2') as never);
  emit(record(OC_SID, 'opencode/1.18.4') as never);
});

interface EmittedRow {
  type: string;
  source?: string;
  version?: string;
  system?: string;
  tools?: Array<{ name: string; description?: string }>;
  x_cannbay?: { schema: string; data: Record<string, unknown> };
  [k: string]: unknown;
}

function readJsonl(file: string): EmittedRow[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as EmittedRow);
}

describe('opencode-emitter × cannbot（UA 驱动框架标识分流）', () => {
  it('meta：UA cannbot/* → cc-session-meta.framework=cannbot + ccVersion，protocol 仍为 openai', () => {
    const metaPath = sessionMetaPath(CB_SID);
    expect(fs.existsSync(metaPath)).toBe(true);
    const xb = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).x_cannbay;
    expect(xb.schema).toBe('cc-session-meta');
    expect(xb.data.producer).toBe('cpx');
    expect(xb.data.framework).toBe('cannbot');
    expect(xb.data.ccVersion).toBe('1.1.2');
    expect(xb.data.protocol).toBe('openai'); // 协议≠框架（spec §4.1 语义是线路协议）
  });

  it('行级：source=cannbot-proxy（legacy 双轨）+ x_cannbay 声明齐全 + 顶层 version=cannbot 版本', () => {
    const rows = readJsonl(sessionFilePath(CB_SID));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.source === 'cannbot-proxy')).toBe(true);
    const asst = rows.find(r => r.type === 'assistant');
    expect(asst.version).toBe('1.1.2');
    expect(asst.x_cannbay.schema).toBe('cc-wire-round');
    expect(asst.x_cannbay.data.protocol).toBe('openai');
    expect(asst.x_cannbay.data.requestParams.model).toBe('glm-5.2');
  });

  it('回归锁：UA opencode/* 路径逐字节不变（framework=opencode、source=opencode-proxy、无 ccVersion）', () => {
    const metaPath = sessionMetaPath(OC_SID);
    expect(fs.existsSync(metaPath)).toBe(true);
    const xb = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).x_cannbay;
    expect(xb.data.framework).toBe('opencode');
    expect(xb.data.ccVersion).toBeUndefined();
    const rows = readJsonl(sessionFilePath(OC_SID));
    expect(rows.every(r => r.source === 'opencode-proxy')).toBe(true);
    const asst = rows.find(r => r.type === 'assistant');
    expect(asst.version).toBe('1.18.4');
  });
});
