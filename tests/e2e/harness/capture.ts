// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 捕获断言助手：三形态（明文/.7z/.gz）透明读取复用生产件 readCaptureText
// （insight「锚点用生产契约」的同款纪律——读法漂移由生产件自测兜住），叠加
// 两个验收哨兵（insight browserConsole 验收门的 cpx 等价物——绿用例若违反
// 即判负，躲不掉的产品承诺）：
//   1. claude-jsonl 消费契约哨兵：cpx 的全部价值出口是「insight 零改动消费」
//      ——每行可解析、user/assistant 行形状齐备、扩展数据走 x_lake 声明信封，
//      生产者侧把契约锁死（消费侧 insight 的 claude-jsonl 适配器另有其测）。
//   2. 密钥零泄漏哨兵：落盘全量文本对给定机密串逐个 grep——redactor 的
//      产品承诺以旅程级断言兑现（「上游收到了、捕获里没有」成对出现）。

import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { readCaptureText } from '../../../src/writer.ts';
import { CAPTURE_PREFIX } from './constants';
import type { Sandbox } from './sandbox';

/** 捕获文件路径（明文或压缩态先查存在者；不存在给明文路径让断言红得明白）。
 *  `rel` 指向会话目录内的相对路径（子代理形态：`<sid>/subagents/<subId>`）。 */
export function captureFile(sandbox: Sandbox, sid: string, rel?: string): string {
  const stem = rel ? path.join(sandbox.captures, rel) : path.join(sandbox.captures, `${CAPTURE_PREFIX}${sid}`);
  for (const p of [`${stem}.jsonl`, `${stem}.jsonl.7z`, `${stem}.jsonl.gz`]) {
    if (fs.existsSync(p)) return p;
  }
  return `${stem}.jsonl`;
}

/** 读取捕获全部行（JSON 解析后的对象数组；空/不存在断言红）。 */
export function readCaptureLines(sandbox: Sandbox, sid: string, rel?: string): Record<string, unknown>[] {
  const file = captureFile(sandbox, sid, rel);
  const text = readCaptureText(file);
  const lines = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  expect(lines.length, `capture ${file} is empty`).toBeGreaterThan(0);
  return lines;
}

/** claude-jsonl 消费契约哨兵：insight 零改动消费是产品承诺，生产者侧逐行锁。 */
export function assertClaudeJsonlContract(lines: Record<string, unknown>[]): void {
  const okTypes = new Set(['user', 'assistant', 'system', 'summary']);
  let userOrAssistant = 0;
  for (const [i, l] of lines.entries()) {
    expect(typeof l.type, `line ${i} .type`).toBe('string');
    expect(okTypes.has(l.type as string), `line ${i} type=${String(l.type)}`).toBe(true);
    if (l.type === 'user' || l.type === 'assistant') {
      userOrAssistant++;
      const msg = l.message as { role?: string; content?: unknown } | undefined;
      expect(msg, `line ${i} .message`).toBeDefined();
      expect(msg?.role, `line ${i} .message.role`).toBe(l.type);
      // source 是行级溯源标记（claude-proxy / opencode-proxy / codex-proxy …）
      expect(typeof l.source, `line ${i} .source`).toBe('string');
      expect((l.source as string).endsWith('-proxy'), `line ${i} source=${String(l.source)}`).toBe(true);
      // 扩展数据一律走带 (schema,version) 声明的 x_lake 信封（无扩展字段的
      // 裸 user 行可缺省——注入/轮次计数等丰富行必须有）
      const xl = l.x_lake as { schema?: string; version?: number } | undefined;
      if (xl) {
        expect(typeof xl.schema, `line ${i} x_lake.schema`).toBe('string');
        expect(xl.version, `line ${i} x_lake.version`).toBe(1);
      }
    }
  }
  expect(userOrAssistant, 'at least one user/assistant line').toBeGreaterThan(0);
}

/** 密钥零泄漏哨兵：捕获全量文本（含压缩态透明解压）对机密串逐个 grep。 */
export function assertNoSecrets(sandbox: Sandbox, sid: string, secrets: string[]): void {
  const text = readCaptureText(captureFile(sandbox, sid));
  for (const s of secrets) {
    expect(text.includes(s), `secret leaked into capture: ${s.slice(0, 12)}…`).toBe(false);
  }
}
