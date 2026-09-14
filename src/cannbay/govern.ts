// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// cpx 直传治理层（与 insight cannbay2/index.ts governStagedSession 同语义）：
//   ① 白名单（仅 .jsonl/.jsonl.gz/.json）+ 大小限（100MB 压缩态）
//   ② 快路径：伴生 meta 声明 producer=cpx + governed=true（cpx 退出压缩时打的
//      信任标记）且全部 .jsonl 为 .gz —— 字节流已经 cpx 落盘咽喉 redactor
//      全量清洗，免解压重洗重压直传（cpx 捕获的常态路径，零重复劳动）
//   ③ 慢路径兜底：明文源 / 无标记 / 非 cpx producer → 解压 → 清洗 + 复检
//      （用 cpx 自己的 redactor 单一真身，与 insight 治理 parity IT 锁定
//      同输入同输出）→ 压缩出仓；复检残留 → fail-closed 熔断拒传
// 两份治理实现（insight/cpx）由 tests/cannbay-parity.test.ts 锁行为一致。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { redactString, redactInPlace, matchStringRules, isSensitiveKeyName, looksMasked } from '../redactor';

export const MAX_SESSION_BYTES = 100 * 1024 * 1024;

export class GovernanceError extends Error {}

interface CcSessionMeta {
  producer?: unknown;
  governed?: unknown;
}

function readCcSessionMeta(file: string): CcSessionMeta | null {
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    const xb = meta?.x_cannbay;
    return xb?.schema === 'cc-session-meta' && xb.data && typeof xb.data === 'object' ? xb.data : null;
  } catch {
    return null;
  }
}

// 单条 jsonl 行：能 parse 则结构层+字符串层双重清洗后回序列化（保持一行），
// 不能 parse 的行整行过字符串层（不丢内容）——与 insight redactLine 同构
function redactLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return line;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    redactInPlace(parsed);
    return JSON.stringify(parsed);
  } catch {
    return redactString(line);
  }
}

// 独立复检：正则组逐条重测 + 结构层敏感键明文检查。清洗后掩码形态不会再
// 命中，任何命中都是清洗未能覆盖的形态 → 熔断
function scanResidue(text: string): string[] {
  const hits: string[] = [];
  for (const matches of matchStringRules(text)) {
    if (matches.length) hits.push(...matches.slice(0, 3).map(s => s.slice(0, 40)));
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      walk(parsed);
    } catch { /* 非 JSON 行已由正则组覆盖 */ }
  }
  return hits;

  function walk(v: unknown): void {
    if (Array.isArray(v)) { for (const e of v) walk(e); return; }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string' && isSensitiveKeyName(k) && val && !looksMasked(val)) {
          hits.push(`${k}=${val.slice(0, 40)}`);
        } else {
          walk(val);
        }
      }
    }
  }
}

export interface GovernTextResult {
  output: string;
  residue: string[];
}

/** 治理一份明文文本：清洗 → 复检（与 insight governText parity 锁定）。 */
export function governText(text: string): GovernTextResult {
  const output = text.split('\n').map(redactLine).join('\n');
  return { output, residue: scanResidue(output) };
}

/** 治理 staging 内 sessions/<sid>/ 全部文件（governStagedSession 同语义）。 */
export function governStagedSession(stagingDir: string, sid: string): void {
  const sessionDir = path.join(stagingDir, 'sessions', sid);
  const listFiles = (): string[] => {
    const all = fs.readdirSync(sessionDir, { recursive: true, withFileTypes: true });
    const out: string[] = [];
    for (const d of all) {
      if (!d.isDirectory()) out.push(path.relative(sessionDir, path.join(d.parentPath, d.name)));
    }
    return out;
  };
  const files = listFiles();
  const unexpected = files.filter(f => !f.endsWith('.jsonl.gz') && !f.endsWith('.jsonl') && !f.endsWith('.json'));
  if (unexpected.length > 0) {
    throw new GovernanceError(`上传熔断：staging 存在白名单外文件（仅允许 .jsonl/.jsonl.gz/.json）：${unexpected.join(', ')}`);
  }
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz'));
  const meta = readCcSessionMeta(path.join(sessionDir, `${sid}.jsonl.gz`));
  const fastPath = meta?.producer === 'cpx' && meta.governed === true
    && jsonlFiles.length > 0 && jsonlFiles.every(f => f.endsWith('.jsonl.gz'));
  if (fastPath) {
    let totalBytes = 0;
    for (const rel of jsonlFiles) totalBytes += fs.statSync(path.join(sessionDir, rel)).size;
    if (totalBytes > MAX_SESSION_BYTES) {
      throw new GovernanceError(`Session "${sid}" exceeds single-file size limit (${(totalBytes / 1024 / 1024).toFixed(1)}MB > 100MB)`);
    }
    return;
  }
  for (const rel of files.filter(f => f.endsWith('.jsonl.gz'))) {
    const file = path.join(sessionDir, rel);
    fs.writeFileSync(file.replace(/\.gz$/, ''), zlib.gunzipSync(fs.readFileSync(file)));
    fs.rmSync(file);
  }
  const residues: string[] = [];
  for (const rel of listFiles().filter(f => f.endsWith('.jsonl'))) {
    const file = path.join(sessionDir, rel);
    const { output, residue } = governText(fs.readFileSync(file, 'utf8'));
    if (residue.length > 0) residues.push(...residue.map(r => `${rel}: ${r}`));
    fs.writeFileSync(file, output);
  }
  if (residues.length > 0) {
    throw new GovernanceError(`上传熔断：清洗后仍检出疑似密钥残留，已拒绝上传。检出项（值已截断）：\n${residues.slice(0, 10).join('\n')}`);
  }
  let totalBytes = 0;
  for (const rel of listFiles().filter(f => f.endsWith('.jsonl'))) {
    const file = path.join(sessionDir, rel);
    const gzFile = `${file}.gz`;
    fs.writeFileSync(gzFile, zlib.gzipSync(fs.readFileSync(file)));
    fs.rmSync(file);
    totalBytes += fs.statSync(gzFile).size;
  }
  if (totalBytes > MAX_SESSION_BYTES) {
    throw new GovernanceError(`Session "${sid}" exceeds single-file size limit (${(totalBytes / 1024 / 1024).toFixed(1)}MB > 100MB，gzip 压缩后仍超限)`);
  }
}
