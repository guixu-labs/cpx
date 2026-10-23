// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cpx 独立安装（proxy/install.sh）IT：验证安装剥离后 ——
//   ① wrapper 落到 CPX_BINDIR 且指向仓内 proxy/cpx-cli（symlink，独立于 insight 安装）
//   ② 幂等可重跑；替换旧 start.sh 时代生成的 regular-file wrapper
//   ③ cpx CLI 在“无 insight”前提下可用（--help 冒烟 + status 不依赖 insight 运行）
//   ④ cpx 子命令注册正确（list 在册）
// CPX_BINDIR 覆盖安装目录（跳过 ~/.bashrc 修改），测试不触碰真实 PATH。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROXY_DIR = path.resolve(__dirname, '../../');
const INSTALL_SH = path.join(PROXY_DIR, 'install.sh');
const REPO_WRAPPER = path.join(PROXY_DIR, 'cpx-cli');

let bindir: string;

beforeAll(() => {
  bindir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-install-test-'));
});

afterAll(() => {
  try { fs.rmSync(bindir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function runInstall(extra: string[] = []) {
  return spawnSync('bash', [INSTALL_SH, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, CPX_BINDIR: bindir },
  });
}

describe('proxy/install.sh standalone installer', () => {
  it('installs the cpx wrapper as a symlink to the in-repo proxy/cpx-cli', () => {
    const r = runInstall();
    expect(r.status).toBe(0);
    const cpx = path.join(bindir, 'cpx');
    expect(fs.existsSync(cpx)).toBe(true);
    // symlink（非生成脚本）：独立于 insight 根 node_modules，跟随仓内 wrapper 的 tsx 回退链
    expect(fs.lstatSync(cpx).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(cpx)).toBe(fs.realpathSync(REPO_WRAPPER));
    // 可执行
    expect((fs.statSync(cpx).mode & 0o111) !== 0).toBe(true);
    // bash 语法检查（symlink 目标即仓内 wrapper）
    const syntax = spawnSync('bash', ['-n', REPO_WRAPPER], { encoding: 'utf-8' });
    expect(syntax.status).toBe(0);
  });

  it('is idempotent (re-run keeps a valid wrapper)', () => {
    const r = runInstall();
    expect(r.status).toBe(0);
    expect(fs.lstatSync(path.join(bindir, 'cpx')).isSymbolicLink()).toBe(true);
  });

  it('replaces a stale regular-file wrapper left by the old start.sh generation', () => {
    const cpx = path.join(bindir, 'cpx');
    fs.rmSync(cpx, { force: true });
    fs.writeFileSync(cpx, '#!/bin/bash\n# old start.sh artifact\necho stale\n', { mode: 0o755 });
    const r = runInstall();
    expect(r.status).toBe(0);
    expect(fs.lstatSync(cpx).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(cpx)).toBe(fs.realpathSync(REPO_WRAPPER));
  });

  it('cpx --help works without insight (CLI boots; list registered)', () => {
    const r = spawnSync(path.join(bindir, 'cpx'), ['--help'], { encoding: 'utf-8', timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('cpx list');
    expect(r.stdout).toContain('捕获无需 insight');
  }, 90_000);

  it('cpx status runs with insight not required (empty capture dir)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-status-test-'));
    try {
      const r = spawnSync(path.join(bindir, 'cpx'), ['status'], {
        encoding: 'utf-8',
        timeout: 60_000,
        env: { ...process.env, CONTEXT_PROXY_DIR: tmpDir },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('captures dir');
      // insight 状态行不再承诺“下次 cpx <agent> 自动拉起”
      expect(r.stdout).not.toContain('will auto-start');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 90_000);
});
