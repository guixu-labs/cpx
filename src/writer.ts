// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  compressCaptureFile as compressTo7z,
  decompressToPlain,
  readCaptureText as readArchivedText,
} from './compression';

export const PROXY_DIR = process.env.CANNBOT_PROXY_DIR
  ?? path.join(os.homedir(), '.cannbot-insight', 'proxy');

// Lazy read of the proxy dir so tests can redirect via CANNBOT_PROXY_DIR after
// module load (the const above is captured at server-startup time only).
function dir(): string {
  return process.env.CANNBOT_PROXY_DIR ?? PROXY_DIR;
}

// Top-level capture files carry a cpx- prefix: the stem is claude's REAL
// session id (identical to claude's native jsonl filename), so the prefix
// keeps proxy captures collision-free if the capture and native projects
// directories are ever archived together. Insight never parses the prefix —
// session identity there is the unprefixed sid (import param / Session.taskId);
// only proxy-side code goes through this helper.
export function captureStem(sid: string): string {
  return `cpx-${sid}`;
}

export function sessionFilePath(sid: string): string {
  return path.join(dir(), `${captureStem(sid)}.jsonl`);
}

// Main-session meta（cc-session-meta，schema 见 docs/lake-schema-spec.md）：
// producer/framework/protocol/ccVersion 等文件级声明，紧邻主捕获文件。
export function sessionMetaPath(sid: string): string {
  return path.join(dir(), `${captureStem(sid)}.meta.json`);
}

// Per-run manifest: the proxy appends every sid it emitted a record for.
// With header-based routing the capture sid is claude's REAL session id
// (differs from cpx's pinned sid; /resume can add more mid-run), so cpx reads
// this manifest at exit to know exactly which capture files this run produced.
export function sidsFilePath(pinnedSid: string): string {
  return path.join(dir(), `${captureStem(pinnedSid)}.sids`);
}

export function appendSid(pinnedSid: string, sid: string): void {
  fs.appendFileSync(sidsFilePath(pinnedSid), sid + '\n');
}

// Subagent capture files live under <PROXY_DIR>/<sid>/subagents/<subId>.jsonl
// (claude's convention, read by cannbot-insight's listSubagentSessions).
export function subagentFilePath(sid: string, subId: string): string {
  return path.join(dir(), sid, 'subagents', `${subId}.jsonl`);
}

export function subagentMetaPath(sid: string, subId: string): string {
  return subagentFilePath(sid, subId).replace(/\.jsonl$/, '.meta.json');
}

export function ensureProxyDir(): void {
  fs.mkdirSync(PROXY_DIR, { recursive: true });
}

// Append one claude-format JSON line to a capture file (creating parent dirs).
// 7z 生命周期钩子：该文件若已是压缩态（上次会话关闭时压缩、本次 resume 复用
// sid），append 前解压回明文 scratch —— 之后本运行全程明文追加，退出路径
// 重新压缩。每次 append 都 resolve（不缓存）：同进程内"压缩→再追加"（测试/
// 长生命周期代理）也能正确展开。见 docs/COMPRESSION-DESIGN.md。
export function appendClaudeLine(file: string, line: object): void {
  const writable = ensureWritableCapture(file);
  fs.mkdirSync(path.dirname(writable), { recursive: true });
  fs.appendFileSync(writable, JSON.stringify(line) + '\n');
}

// Write the subagent meta.json (toolUseId + name + agentType) once per subagent.
export function writeMeta(metaPath: string, meta: object): void {
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

// ── 7z at rest（docs/COMPRESSION-DESIGN.md）───────────────────────────
// 生命周期：live 明文追加（tail -F / 增量依赖 append）→ 会话关闭压缩为
// .jsonl.7z（cpx-cli 退出路径：压缩 → 导入）→ resume 复用 sid 时解压回
// 明文 scratch 再追加。存量 .jsonl.gz 永续可读（上传时 ensure7z 迁移）。
// meta.json 永远明文（分类契约）。

/** 解析捕获文件真实路径。优先级：明文（live/resume scratch 权威）> .7z（新）> .gz（存量）。 */
export function resolveCapturePath(p: string): string {
  // 压缩态请求路径先查明文：共存 = resume scratch 态，明文是本次运行的追加目标
  if (p.endsWith('.jsonl.gz') || p.endsWith('.jsonl.7z')) {
    const plain = p.replace(/\.(gz|7z)$/, '');
    if (fs.existsSync(plain)) return plain;
  }
  if (fs.existsSync(p)) return p;
  if (p.endsWith('.jsonl')) {
    if (fs.existsSync(`${p}.7z`)) return `${p}.7z`;
    if (fs.existsSync(`${p}.gz`)) return `${p}.gz`;
  }
  return p; // 不存在（新建捕获）：调用方按返回值创建
}

/** 读捕获文件文本（三形态透明解压：.7z / .gz / 明文直读）。 */
export function readCaptureText(p: string): string {
  return readArchivedText(resolveCapturePath(p));
}

/** 压缩捕获文件（明文 .jsonl → .jsonl.7z，删明文与存量 .gz）。幂等：已压缩态跳过。 */
export function compressCaptureFile(p: string): string {
  const resolved = resolveCapturePath(p);
  if (resolved.endsWith('.7z') || resolved.endsWith('.gz')) return resolved;
  if (!fs.existsSync(resolved)) return resolved; // 空占位（cpx 预创建 0KB）留给调用方清理
  return compressTo7z(resolved);
}

/** resume 准备：压缩态（.7z/.gz）→ 解压回明文 scratch（删压缩态，防双份数据分叉）。幂等。 */
export function ensureWritableCapture(p: string): string {
  return decompressToPlain(resolveCapturePath(p));
}
