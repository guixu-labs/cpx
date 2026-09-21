// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 压缩唯一咽喉（docs/COMPRESSION-DESIGN.md）：7z at rest。
// 写侧只出 .jsonl.7z（LZMA2，确定性开关保证同内容同字节→重传幂等）；
// 读侧三形态永续可读：.jsonl / .jsonl.gz（存量）/ .jsonl.7z。
// 与 insight src/lib/compression.ts 同构（受控双实现，命令常量保持一致）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sevenzipBin from '7zip-bin';

export const SEVENZ_EXT = '.jsonl.7z';
export const GZ_EXT = '.jsonl.gz';

// 同内容同字节：关全部时间戳（否则档案内嵌 mtime，重传必产新 blob）
const SEVENZ_DETERMINISTIC = ['-mtm=off', '-mta=off', '-mtc=off'];

function sevenza(): string {
  const bin = sevenzipBin.path7za;
  // 部分镜像安装剥执行位（实测 npmmirror）——落 chmod 兜底，失败交给 spawn 报错
  try { fs.chmodSync(bin, 0o755); } catch { /* best-effort */ }
  return bin;
}

export function is7z(p: string): boolean { return p.endsWith('.7z'); }
export function isGz(p: string): boolean { return p.endsWith('.gz'); }

function run7za(args: string[], maxBuffer = 1 << 28): Buffer {
  const r = spawnSync(sevenza(), args, { maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    throw new Error(`7za ${args[0]} failed (exit ${r.status}): ${r.stderr?.toString().slice(0, 500)}`);
  }
  return r.stdout as Buffer;
}

/** 压缩级别：默认 9（最高比率）；CANNBOT_7Z_LEVEL 覆盖（退出压缩慢时可降 7 提速） */
function compressionLevel(): number {
  const raw = Number(process.env.CANNBOT_7Z_LEVEL);
  return Number.isInteger(raw) && raw >= 1 && raw <= 9 ? raw : 9;
}

/** 明文 .jsonl → 同 stem .jsonl.7z（删明文；顺手清掉同 stem 存量 .gz 防双压缩态分叉）。幂等：已 .7z 跳过。 */
export function compressCaptureFile(plainPath: string): string {
  if (is7z(plainPath)) return plainPath;
  const out = `${plainPath}.7z`;
  fs.rmSync(out, { force: true });
  run7za(['a', `-mx=${compressionLevel()}`, ...SEVENZ_DETERMINISTIC, out, plainPath]);
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error(`7z compress produced no output: ${out}`);
  fs.rmSync(plainPath, { force: true });
  const legacyGz = `${plainPath}.gz`;
  if (fs.existsSync(legacyGz)) fs.rmSync(legacyGz, { force: true });
  return out;
}

/** 解压回明文 scratch（.7z 或存量 .gz；删压缩态，防双份数据分叉）。幂等：明文跳过。
 *  .7z 解压 maxBuffer 1GiB 与 readCaptureBuffer 对齐——解压后明文 >256MB 的
 *  捕获（631MB wire 实例在案，压缩态仅 ~30-60MB）在默认上限必炸，resume
 *  回归（ensureWritableCapture）与治理慢路径都走这里。 */
export function decompressToPlain(archivePath: string): string {
  if (!is7z(archivePath) && !isGz(archivePath)) return archivePath;
  const plain = archivePath.replace(/\.(7z|gz)$/, '');
  if (is7z(archivePath)) {
    const buf = run7za(['e', '-so', archivePath], 1 << 30);
    if (buf.length === 0) throw new Error(`7z extract empty: ${archivePath}`);
    fs.writeFileSync(plain, buf);
  } else {
    fs.writeFileSync(plain, zlib.gunzipSync(fs.readFileSync(archivePath)));
  }
  fs.rmSync(archivePath, { force: true });
  return plain;
}

/** 读捕获字节（三形态透明解压：.7z / .gz / 明文直读）——Buffer 直出，不过
 *  V8 单字符串上限（与 insight readCaptureBuffer 同构，.7z maxBuffer 1GiB）。 */
export function readCaptureBuffer(filePath: string): Buffer {
  if (is7z(filePath)) return run7za(['e', '-so', filePath], 1 << 30);
  const buf = fs.readFileSync(filePath);
  return isGz(filePath) ? zlib.gunzipSync(buf) : buf;
}

/** 读捕获文本（三形态透明解压：.7z / .gz / 明文直读）。 */
export function readCaptureText(filePath: string): string {
  return readCaptureBuffer(filePath).toString('utf8');
}

/** staging 转换：任意形态（明文/.gz）→ .7z。旧 gz 数据上传时迁移到新格式；已 .7z 原样返回。
 * 全程 Buffer/子进程、零字符串中转（明文/解压后 >512MB 过 V8 单字符串上限必炸——
 * 631MB wire 捕获量级在案，旧 gzip 路径全程 Buffer 能处理，字符串中转是回归）：
 * 明文直接 7za 子进程压缩（零内存占用）；.gz 先 decompressToPlain（Buffer 落盘）再压缩。 */
export function ensure7z(filePath: string): string {
  if (is7z(filePath)) return filePath;
  if (isGz(filePath)) return compressCaptureFile(decompressToPlain(filePath));
  return compressCaptureFile(filePath);
}

/** 三形态 stem 提取：cpx-<sid>.jsonl[.gz|.7z] / <sid>.jsonl[.gz|.7z] → sid。 */
export function captureFileStem(filePath: string): string {
  return path.basename(filePath).replace(/\.jsonl(\.gz|\.7z)?$/, '').replace(/^cpx-/, '');
}
