// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// gzip at rest 生命周期（docs/COMPRESSION-DESIGN.md）：压缩/解压往返 bit 级
// 一致、resume 生命周期（压缩→追加→再压缩）、resolveCapturePath 三分支。
import { describe, it, expect, beforeEach } from 'vitest';
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
} from '../src/writer.ts';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-gz-'));
process.env.CANNBOT_PROXY_DIR = tmpRoot;

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

describe('writer gzip at rest', () => {
  it('compressCaptureFile：明文 → .jsonl.gz，删明文；幂等跳过', () => {
    const f = path.join(tmpRoot, 'cpx-s1.jsonl');
    fs.writeFileSync(f, 'line1\nline2\n');
    const gz = compressCaptureFile(f);
    expect(gz).toBe(`${f}.gz`);
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(gz)).toBe(true);
    expect(zlib.gunzipSync(fs.readFileSync(gz)).toString()).toBe('line1\nline2\n');
    // 幂等
    expect(compressCaptureFile(f)).toBe(gz);
  });

  it('readCaptureText / resolveCapturePath：.gz 透明读 + 三分支互找', () => {
    const f = path.join(tmpRoot, 'cpx-s2.jsonl');
    fs.writeFileSync(`${f}.gz`, zlib.gzipSync(Buffer.from('a\nb\n')));
    // 分支②：明文不存在、.gz 存在
    expect(resolveCapturePath(f)).toBe(`${f}.gz`);
    expect(readCaptureText(f)).toBe('a\nb\n');
    // 分支③：resume scratch 态（.gz 与明文共存 → 明文优先，scratch 权威）
    fs.writeFileSync(f, 'plain\n');
    expect(resolveCapturePath(`${f}.gz`)).toBe(f);
    expect(readCaptureText(`${f}.gz`)).toBe('plain\n'); // 共存时读明文
    fs.rmSync(`${f}.gz`);
    // 分支①：直接存在
    expect(resolveCapturePath(f)).toBe(f);
  });

  it('resume 生命周期：压缩态 append 前自动解压回明文 scratch，追加后可再压缩', () => {
    const f = path.join(tmpRoot, 'cpx-s3.jsonl');
    appendClaudeLine(f, { type: 'user', v: 1 });
    compressCaptureFile(f);
    expect(fs.existsSync(`${f}.gz`)).toBe(true);
    // 模拟下一次会话 resume：appendClaudeLine 触发 ensureWritableCapture
    appendClaudeLine(f, { type: 'assistant', v: 2 });
    expect(fs.existsSync(f)).toBe(true);      // 解压回明文 scratch
    expect(fs.existsSync(`${f}.gz`)).toBe(false); // .gz 删除（防双份分叉）
    const text = readCaptureText(f);
    expect(text).toContain('"v":1');
    expect(text).toContain('"v":2');
    // 再压缩：内容往返完整
    compressCaptureFile(f);
    expect(readCaptureText(f)).toBe(text);
  });

  it('ensureWritableCapture：明文态幂等直通', () => {
    const f = path.join(tmpRoot, 'cpx-s4.jsonl');
    fs.writeFileSync(f, 'x\n');
    expect(ensureWritableCapture(f)).toBe(f);
    expect(ensureWritableCapture(f)).toBe(f);
    expect(fs.readFileSync(f, 'utf8')).toBe('x\n');
  });
});
