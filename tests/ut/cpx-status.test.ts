// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// `cpx status` recent captures IT：at-rest 三形态（明文 / 存量 .jsonl.gz /
// 新 .jsonl.7z）全部列出。回归锁：7z 升级后 status 的文件 filter 漏加
// .jsonl.7z → 会话退出压缩成 .7z 后 recent captures 漏列全部已压缩会话
// （scanCaptureEntries/cpx list 已支持 .7z，唯 status 遗漏）。真实产物布局
// 驱动，经仓内 wrapper 起 cpx-cli。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { compressCaptureFile } from '../../src/compression.ts';

const WRAPPER = path.join(path.resolve(__dirname, '../../'), 'cpx-cli');

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-status-test-'));
  fs.writeFileSync(path.join(dir, 'cpx-plain0000-0000-0000-0000-000000000000.jsonl'), '{"type":"user"}\n');
  fs.writeFileSync(path.join(dir, 'cpx-legacy0000-0000-0000-0000-000000000000.jsonl.gz'), zlib.gzipSync('{"type":"user"}\n'));
  const p = path.join(dir, 'cpx-sevenz0000-0000-0000-0000-000000000000.jsonl');
  fs.writeFileSync(p, '{"type":"user"}\n');
  compressCaptureFile(p);
});

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function runStatus() {
  return spawnSync('bash', [WRAPPER, 'status'], {
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CANNBOT_PROXY_DIR: dir },
  });
}

describe('cpx status recent captures', () => {
  it('lists all three at-rest forms: plain / .jsonl.gz / .jsonl.7z', () => {
    const r = runStatus();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('recent captures');
    expect(r.stdout).toContain('cpx-plain0000-0000-0000-0000-000000000000.jsonl');
    expect(r.stdout).toContain('cpx-legacy0000-0000-0000-0000-000000000000.jsonl.gz');
    expect(r.stdout).toContain('cpx-sevenz0000-0000-0000-0000-000000000000.jsonl.7z');
  });
});
