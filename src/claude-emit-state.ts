// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// claude-emit-state: wire-input 增量落盘状态（multiset 计数 / 注入指纹 /
// 轮次号）的进程级注册表 + 盘上重建。
//
// 为什么独立成模块（历史教训）：这三样曾活在 claude-emitter 的进程内存
//（emittedCounts / emittedInjections / roundCount），代理进程重启（resume /
// 换机器重开）即清零 → 新进程把重放的消息历史整批当新消息再落盘。现场
// solo:8ae4a944：四次重启各倾泻 338/341/354/610 行（主文件 25%+ 是重放
// 副本），31 个后台代理的真实完成通知被放大成 214 条「背景事件」。
//
// 架构原则（与 claude-linkage 同源）：**盘上捕获文件是唯一真源**。捕获行
// 就是已发出的增量——进程首见该捕获文件时重放既有行重建计数，此后的
// wire 增量与重放同构（同一 hash 键、同一指纹口径），只发新货。
// 三个量全部可从捕获行精确重建：
//   · multiset 计数 —— user/system 行按 message.{role,content} 重算 hash
//     计数。live 发射只在落盘时 +1（noteEmitted），已捕获副本数恰等于
//     文件里的行数，重建即精确；
//   · 注入指纹 —— 全量注入 system 行按文本重算 md5；[已压缩] 标记行读
//     落盘指纹（原文未存，不可重算——首份全量行已在文件里，重算命中）；
//   · 轮次号 —— assistant 行计数（文件里一行 = 一轮）。
//
// 由此进程重启天然自愈：新进程首见捕获文件 → 重放重建 → 重放历史里的
// 旧消息全部落在已捕获计数内 → 静默跳过，只有真新消息才落盘。

import crypto from 'node:crypto';
import { forEachCaptureLine } from './writer';

// ── live 发射与盘上重放共用的提取/指纹 ───────────────────────────────
// 同构是重建正确的前提（与 DISPATCH_TOOL_ALIAS 收编 claude-linkage 同一
// 理由）：live 用什么口径落盘，重放就必须用什么口径读回。

// Joined text of a message content (string or text blocks).
export function textOf(content: string | Array<{ type?: string; text?: string }> | undefined): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === 'text' && b.text) parts.push(b.text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

// An "injection" is the agent-registry / skills-list system message claude-code
// re-appends on later rounds. Identified by its opening line so ordinary
// system messages are never deduped.
export function isInjectionText(text: string): boolean {
  return text.startsWith('Available agent types for the Agent tool')
    || text.startsWith('The following skills are available');
}

// ── 每个捕获文件一份的增量落盘状态 ───────────────────────────────────
export class EmitState {
  private counts = new Map<string, number>();
  private injectionFps = new Set<string>();
  private rounds = 0;
  private bootstrapped = false;

  constructor(private readonly file: string) {}

  // 进程首见该捕获文件：重放既有行重建计数。幂等；文件 IO 全部容错——
  // 重放是尽力而为，绝不阻断捕获主路径。
  ensureBootstrapped(): void {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    try {
      forEachCaptureLine(this.file, (line) => this.replay(line));
    } catch (err) {
      console.error(`[cpx] emit-state bootstrap 失败（忽略，捕获不受影响）: ${String(err)}`);
    }
  }

  private replay(line: unknown): void {
    const l = line as {
      type?: string;
      message?: { role?: string; content?: unknown };
      x_lake?: { data?: { dedup?: { fingerprint?: unknown } } };
    };
    if (l.type === 'assistant') {
      this.rounds++;
      return;
    }
    if (l.type !== 'user' && l.type !== 'system') return;
    // hash 键与 live 发射同构：emitter 落盘 message = {role, content}（content
    // ?? ''），replay 按同一键序重算——JSON.parse/stringify 保序，键稳定。
    const role = typeof l.message?.role === 'string' ? l.message.role : l.type;
    const hash = role + ':' + JSON.stringify(l.message?.content ?? '');
    this.counts.set(hash, (this.counts.get(hash) ?? 0) + 1);
    // 注入指纹：全量行按文本重算；[已压缩] 标记行读落盘指纹（x_lake
    // cc-wire-input.dedup.fingerprint——原文未存盘，重算不了，读声明）。
    const text = textOf(l.message?.content as string | Array<{ type?: string; text?: string }> | undefined);
    if (text && isInjectionText(text)) {
      this.injectionFps.add(crypto.createHash('md5').update(text).digest('hex'));
    } else if (typeof l.x_lake?.data?.dedup?.fingerprint === 'string') {
      this.injectionFps.add(l.x_lake.data.dedup.fingerprint);
    }
  }

  // 已捕获副本数（multiset 比较的左值）。occ = 本请求内的副本序号（0 起）。
  emittedCount(hash: string): number {
    return this.counts.get(hash) ?? 0;
  }

  noteEmitted(hash: string, occ: number): void {
    this.counts.set(hash, occ + 1);
  }

  hasInjection(fingerprint: string): boolean {
    return this.injectionFps.has(fingerprint);
  }

  noteInjection(fingerprint: string): void {
    this.injectionFps.add(fingerprint);
  }

  // 本文件已发射的轮数 = 下一轮的 roundIndex（发射时先取值后 noteRound）。
  roundIndex(): number {
    return this.rounds;
  }

  noteRound(): void {
    this.rounds++;
  }
}

// ── 进程级注册表（按捕获文件路径惰性建实例）──────────────────────────
// 文件路径是持久身份：contextKey（subId）解析跨进程稳定，但重放状态跟着
// 文件走，不跟 contextKey 走。
const states = new Map<string, EmitState>();

export function emitStateFor(file: string): EmitState {
  let s = states.get(file);
  if (!s) {
    s = new EmitState(file);
    states.set(file, s);
  }
  return s;
}

/** 测试专用：清空进程级状态（模拟代理进程重启）。 */
export function resetEmitStateForTests(): void {
  states.clear();
}
