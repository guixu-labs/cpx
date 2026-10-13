// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex-emitter 前缀锚点 IT：append-only 判定从「末位 item 哈希」升级为
// 「已发射前缀链式哈希」。旧末位锚点只在末位 item 变化时失配——中段重写
// 但末位逐字节不变（且长度 ≥ cursor）会走 append-only 快路径，只发尾部
// 增量，中段新内容静默丢失。本 IT 构造该形态：第 2 轮重写中段 user 消息、
// 末位 user 消息逐字节不变，断言重写后的中段内容确实落盘（旧实现此断言
// 红——测试抓不住旧 bug = 白写）。
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emit } from '../../src/codex-emitter.ts';
import { sessionFilePath } from '../../src/writer.ts';

const SID = 'cpx-codex-anchor';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-codex-anchor-'));
process.env.CANNBOT_PROXY_DIR = tmpDir; // BEFORE sessionFilePath 评估（模块级懒读）

const mainFile = sessionFilePath(SID);

function readJsonl(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const userMsg = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

function rec(input: any[], content: any[], receivedAt: number) {
  return {
    sid: SID,
    protocol: 'responses' as const,
    receivedAt,
    completedAt: receivedAt + 100,
    latencyMs: 100,
    ttftMs: 50,
    request: {
      path: '/v1/responses',
      model: 'm',
      body: { model: 'm', stream: true, input },
    },
    response: {
      status: 200,
      model: 'm',
      stop_reason: 'completed',
      content,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

beforeAll(() => {
  // 轮 0：input = [原始问题, 第一步] → 全量发射，锚点 = prefix([原始, 第一步])
  emit(rec(
    [userMsg('原始问题'), userMsg('第一步')],
    [{ type: 'text', text: 'r0' }],
    1760000000000,
  ));
  // 轮 1：追加「第二步」→ append-only 快路径，只发尾部增量
  emit(rec(
    [userMsg('原始问题'), userMsg('第一步'), userMsg('第二步')],
    [{ type: 'text', text: 'r1' }],
    1760000001000,
  ));
  // 轮 2：中段重写（原始问题 → 修订后的问题），末位「第二步」逐字节不变、
  // 长度不变。旧末位锚点：itemHash(末位) 不变 → 快路径 → 零增量 → 修订丢失；
  // 新前缀锚点：prefixAnchor 变化 → resync → multiset diff 捕获修订。
  emit(rec(
    [userMsg('修订后的问题'), userMsg('第一步'), userMsg('第二步')],
    [{ type: 'text', text: 'r2' }],
    1760000002000,
  ));
});

describe('codex-emitter: 前缀锚点（中段重写不丢内容）', () => {
  it('中段重写（末位不变）的新内容被捕获', () => {
    const users = readJsonl(mainFile).filter((r) => r.type === 'user');
    const texts = users.map((u) =>
      (typeof u.message?.content === 'string' ? u.message.content : JSON.stringify(u.message?.content ?? '')));
    expect(texts.some((t) => t.includes('修订后的问题'))).toBe(true);
  });

  it('末位未变的条目不被重复发射（multiset diff 不重复）', () => {
    const users = readJsonl(mainFile).filter((r) => r.type === 'user');
    const texts = users.map((u) =>
      (typeof u.message?.content === 'string' ? u.message.content : JSON.stringify(u.message?.content ?? '')));
    expect(texts.filter((t) => t.includes('第一步'))).toHaveLength(1);
    expect(texts.filter((t) => t.includes('第二步'))).toHaveLength(1);
  });
});
