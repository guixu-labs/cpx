// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 7z at rest 生命周期（docs/COMPRESSION-DESIGN.md）：压缩/解压往返 bit 级
// 一致、确定性（同内容同字节→重传幂等）、resume 生命周期（压缩→追加→再
// 压缩）、resolveCapturePath 优先级（明文 > .7z > 存量 .gz）、存量 gz 迁移。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  resolveCapturePath,
  readCaptureText,
  compressCaptureFile,
  ensureWritableCapture,
  appendClaudeLine,
} from '../../src/writer.ts';
import { ensure7z, decompressToPlain } from '../../src/compression.ts';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-7z-'));
process.env.CONTEXT_PROXY_DIR = tmpRoot;

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

describe('writer 7z at rest', () => {
  it('compressCaptureFile：明文 → .jsonl.7z，删明文；幂等跳过；同内容同字节（确定性）', () => {
    const f = path.join(tmpRoot, 'cpx-s1.jsonl');
    fs.writeFileSync(f, 'line1\nline2\n');
    const z = compressCaptureFile(f);
    expect(z).toBe(`${f}.7z`);
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(z)).toBe(true);
    expect(readCaptureText(z)).toBe('line1\nline2\n');
    // 幂等
    expect(compressCaptureFile(f)).toBe(z);
    // 确定性：同内容同名条目重压字节一致（上传幂等前提：staging 内恒为
    // <sid>.jsonl 同名压缩；档案内嵌条目名，跨名不比对）
    const d1 = path.join(tmpRoot, 'det1'), d2 = path.join(tmpRoot, 'det2');
    fs.mkdirSync(d1, { recursive: true }); fs.mkdirSync(d2, { recursive: true });
    fs.writeFileSync(path.join(d1, 'same.jsonl'), 'line1\nline2\n');
    fs.writeFileSync(path.join(d2, 'same.jsonl'), 'line1\nline2\n');
    const z1 = compressCaptureFile(path.join(d1, 'same.jsonl'));
    const z2 = compressCaptureFile(path.join(d2, 'same.jsonl'));
    expect(fs.readFileSync(z1).equals(fs.readFileSync(z2))).toBe(true);
  });

  it('readCaptureText / resolveCapturePath：.7z 透明读 + 分支互找（明文 > .7z > .gz）', () => {
    const f = path.join(tmpRoot, 'cpx-s2.jsonl');
    fs.writeFileSync(f, 'a\nb\n');
    const z = compressCaptureFile(f);
    // 分支②：明文不存在、.7z 存在
    expect(resolveCapturePath(f)).toBe(z);
    expect(readCaptureText(f)).toBe('a\nb\n');
    // 分支③：resume scratch 态（.7z 与明文共存 → 明文优先，scratch 权威）
    fs.writeFileSync(f, 'plain\n');
    expect(resolveCapturePath(z)).toBe(f);
    expect(readCaptureText(z)).toBe('plain\n'); // 共存时读明文
    fs.rmSync(f);
    fs.rmSync(z);
    // 存量 .gz 兜底：无 .7z 时命中 .gz
    fs.writeFileSync(`${f}.gz`, zlib.gzipSync(Buffer.from('legacy\n')));
    expect(resolveCapturePath(f)).toBe(`${f}.gz`);
    expect(readCaptureText(f)).toBe('legacy\n');
    // 分支①：直接存在（明文优先级最高）
    fs.writeFileSync(f, 'now-plain\n');
    expect(resolveCapturePath(f)).toBe(f);
  });

  it('resume 生命周期：压缩态 append 前自动解压回明文 scratch，追加后可再压缩', () => {
    const f = path.join(tmpRoot, 'cpx-s3.jsonl');
    appendClaudeLine(f, { type: 'user', v: 1 });
    compressCaptureFile(f);
    expect(fs.existsSync(`${f}.7z`)).toBe(true);
    // 模拟下一次会话 resume：appendClaudeLine 触发 ensureWritableCapture
    appendClaudeLine(f, { type: 'assistant', v: 2 });
    expect(fs.existsSync(f)).toBe(true);       // 解压回明文 scratch
    expect(fs.existsSync(`${f}.7z`)).toBe(false); // .7z 删除（防双份分叉）
    const text = readCaptureText(f);
    expect(text).toContain('"v":1');
    expect(text).toContain('"v":2');
    // 再压缩：内容往返完整
    compressCaptureFile(f);
    expect(readCaptureText(f)).toBe(text);
  });

  it('存量 gz 迁移：resume 从 .gz 展开；退出压缩清掉旧 .gz（防双压缩态分叉）', () => {
    const f = path.join(tmpRoot, 'cpx-s5.jsonl');
    fs.writeFileSync(`${f}.gz`, zlib.gzipSync(Buffer.from('{"type":"user","v":0}\n')));
    // resume：从存量 gz 解压回明文追加
    appendClaudeLine(f, { type: 'assistant', v: 1 });
    expect(fs.existsSync(`${f}.gz`)).toBe(false);
    expect(readCaptureText(f)).toContain('"v":0');
    // 退出压缩：产 .7z，且同 stem 旧 .gz 若残留一并清除
    fs.writeFileSync(`${f}.gz`, zlib.gzipSync(Buffer.from('stale\n')));
    const z = compressCaptureFile(f);
    expect(z).toBe(`${f}.7z`);
    expect(fs.existsSync(`${f}.gz`)).toBe(false);
    expect(readCaptureText(z)).toContain('"v":1');
  });

  it('ensureWritableCapture：明文态幂等直通', () => {
    const f = path.join(tmpRoot, 'cpx-s4.jsonl');
    fs.writeFileSync(f, 'x\n');
    expect(ensureWritableCapture(f)).toBe(f);
    expect(ensureWritableCapture(f)).toBe(f);
    expect(fs.readFileSync(f, 'utf8')).toBe('x\n');
  });

  it('ensure7z：gz → 7z 转换（staging 迁移用），内容不变、幂等', () => {
    const f = path.join(tmpRoot, 'cpx-s6.jsonl');
    fs.writeFileSync(`${f}.gz`, zlib.gzipSync(Buffer.from('legacy body\n')));
    const z = ensure7z(`${f}.gz`);
    expect(z).toBe(`${f}.7z`);
    expect(fs.existsSync(`${f}.gz`)).toBe(false);
    expect(readCaptureText(z)).toBe('legacy body\n');
    expect(ensure7z(z)).toBe(z);
  });

  it('ensure7z 全程不过 V8 字符串（大文件必炸回归锁）', () => {
    // 旧实现 writeFileSync(plain, readCaptureText(filePath)) 把整文件走一遍
    // UTF-8 字符串：明文/解压后 >512MB（V8 单字符串上限 0x1FFFFFE8）直接
    // RangeError——claude-jsonl.ts 记录的 631MB wire 捕获（3.5 天会话）就是
    // 这个量级，旧 gzip 路径全程 Buffer 能处理，字符串中转是回归。锁法：
    // spy writeFileSync，三形态转换的落盘写只允许 Buffer（.gz 解压落盘），
    // 明文路径零写（7za 子进程直压）
    const gz = path.join(tmpRoot, 'cpx-e1.jsonl.gz');
    fs.writeFileSync(gz, zlib.gzipSync('a\nb\n'));
    const plain = path.join(tmpRoot, 'cpx-e2.jsonl');
    fs.writeFileSync(plain, 'c\nd\n');
    const spy = vi.spyOn(fs, 'writeFileSync');
    try {
      expect(ensure7z(gz)).toBe(path.join(tmpRoot, 'cpx-e1.jsonl.7z'));
      expect(ensure7z(plain)).toBe(path.join(tmpRoot, 'cpx-e2.jsonl.7z'));
      expect(ensure7z(path.join(tmpRoot, 'cpx-e2.jsonl.7z'))).toBe(path.join(tmpRoot, 'cpx-e2.jsonl.7z'));
      // 仅 .gz 路径 decompressToPlain 的 Buffer 落盘一次；任何字符串写回（旧实现）在此现形
      expect(spy.mock.calls).toHaveLength(1);
      for (const [, data] of spy.mock.calls) expect(typeof data).not.toBe('string');
    } finally {
      spy.mockRestore();
    }
    expect(readCaptureText(path.join(tmpRoot, 'cpx-e1.jsonl.7z'))).toBe('a\nb\n');
    expect(readCaptureText(path.join(tmpRoot, 'cpx-e2.jsonl.7z'))).toBe('c\nd\n');
  });

  it('decompressToPlain .7z 解压 >256MB 明文不炸（maxBuffer 1GiB 回归锁）', () => {
    // 631MB wire 捕获量级（压缩态 ~30-60MB）在默认 maxBuffer（1<<28=256MB）
    // 必炸：resume 回归（ensureWritableCapture → decompressToPlain）与治理慢
    // 路径都走这里——旧 gzip 路径（gunzipSync 无上限）能处理，属同族回归。
    // 270MB 高度可压缩夹具（档案仅数百 KB）：旧实现 7za stdout 超 256MB
    // 即 ENOBUFS，修复后 1GiB 上限内正常落盘
    const f = path.join(tmpRoot, 'cpx-d1.jsonl');
    const chunk = Buffer.alloc(1024 * 1024, 0x41);
    const fh = fs.openSync(f, 'w');
    for (let i = 0; i < 270; i++) fs.writeSync(fh, chunk);
    fs.closeSync(fh);
    const z = compressCaptureFile(f);
    expect(fs.statSync(z).size).toBeLessThan(10 * 1024 * 1024); // 前置：压缩态远小于 256MB 阈值
    const out = decompressToPlain(z);
    expect(out).toBe(f);
    expect(fs.statSync(f).size).toBe(270 * 1024 * 1024);
  });

  it('compression parity：双端 .7z 解压点 maxBuffer 对齐 1GiB（源级锁）', () => {
    // 本轮审查抓的正是「readCaptureBuffer 修了 1GiB、同文件 decompressToPlain
    // 漏改」——源级锁双端两个解压点的 maxBuffer 形态（读源码正则抽取），漂移/复发即红
    const insightSrc = fs.readFileSync(path.resolve(__dirname, '../../../insight/src/lib/compression.ts'), 'utf8');
    const dtStart = insightSrc.indexOf('export function decompressToPlain');
    const dtEnd = insightSrc.indexOf('export function readCaptureBuffer');
    expect(insightSrc.slice(dtStart, dtEnd)).toContain("run7za(['e', '-so', archivePath], 1 << 30)");
    const rbStart = insightSrc.indexOf('export function readCaptureBuffer');
    expect(insightSrc.slice(rbStart)).toContain("run7za(['e', '-so', filePath], 1 << 30)");
  });
});
