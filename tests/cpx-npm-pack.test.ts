// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// npm 发布就绪 IT（cannbot-proxy）：发布到公共 registry 前，从 npm 的真实视角验证——
//   ① `npm pack --dry-run`（零网络零落盘）：bin 启动器 / 源码 / LICENSE / docs 在包内，tests / 仓内 wrapper / lockfile 排除
//   ② package.json 发布就绪：无 private、包名 cannbot-proxy、版本与单一版本源 src/version.ts 同值、bin cpx → bin/cpx.mjs
//   ③ bin 启动器实跑冒烟：`node bin/cpx.mjs --version` 经 node --import tsx 起 cpx-cli，
//      输出 cpx v<版本> 与单一源一致（npm 全局装后用户敲 `cpx --version` 的等价路径）

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, '..');

const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
const lockJson = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package-lock.json'), 'utf8'));

interface PackFile { path: string; size: number }

// npm ≤11 输出数组 [{files}]；npm ≥12 改为按包名索引的对象。两种格式归一成数组。
function parsePackJson(stdout: string): Array<{ files: PackFile[] }> {
  const parsed: unknown = JSON.parse(stdout);
  const list = Array.isArray(parsed)
    ? (parsed as Array<{ files?: PackFile[] }>)
    : Object.values(parsed as Record<string, { files?: PackFile[] }>);
  return list.map((e) => ({ files: e.files ?? [] }));
}

function packDryRun(): PackFile[] {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PKG_DIR,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (r.status !== 0) {
    throw new Error(`npm pack --dry-run 失败:\n${r.stderr}\n${r.stdout}`);
  }
  const parsed = parsePackJson(r.stdout);
  expect(parsed.length).toBe(1);
  return parsed[0].files;
}

describe('npm publish readiness (cannbot-proxy)', () => {
  it('产物含运行必需文件：bin 启动器 / 源码 / LICENSE / docs / CHANGELOG', () => {
    const files = packDryRun().map((f) => f.path);
    for (const must of [
      'bin/cpx.mjs',
      'src/cli/cpx-cli.ts',
      'src/server.ts',
      'src/version.ts',
      'scripts/postinstall.mjs',
      'LICENSE',
      'docs/DESIGN.md',
      'CHANGELOG.md',
    ]) {
      expect(files, `缺少发布必需文件: ${must}`).toContain(must);
    }
  });

  it('裁剪生效：tests / 仓内 wrapper / install.sh / lockfile 不进包', () => {
    const files = packDryRun().map((f) => f.path);
    const forbidden = (p: string) =>
      p === 'tests' || p.startsWith('tests/') ||
      p === 'cpx-cli' ||
      p === 'install.sh' ||
      p === 'package-lock.json' ||
      p === 'node_modules' || p.startsWith('node_modules/');
    const leaked = files.filter(forbidden);
    expect(leaked, `以下文件不应进包: ${leaked.join(', ')}`).toEqual([]);
  });

  it('package.json 发布就绪：无 private、包名/bin/版本单轨/license 齐备', () => {
    expect(pkgJson.private, 'private:true 会阻断 npm publish').toBeUndefined();
    expect(pkgJson.name).toBe('cannbot-proxy');
    expect(pkgJson.version, 'package.json 版本须与单一版本源 src/version.ts 同值').toBe(VERSION);
    expect(pkgJson.bin).toEqual({ cpx: './bin/cpx.mjs' });
    expect(pkgJson.license).toBeTruthy();
    expect(pkgJson.engines?.node).toMatch(/>=20/);
    expect(pkgJson.files).toContain('bin');
  });

  it('bin 启动器实跑冒烟：node bin/cpx.mjs --version 输出与单一版本源一致', () => {
    const r = spawnSync(process.execPath, [path.join('bin', 'cpx.mjs'), '--version'], {
      cwd: PKG_DIR,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(r.status, `启动器退出码非 0:\nstdout=${r.stdout}\nstderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain(`cpx v${VERSION}`);
  });

  it('package-lock.json 顶部 name/version 与 package.json 同值（单轨不漂移）', () => {
    expect(lockJson.name).toBe(pkgJson.name);
    expect(lockJson.version).toBe(pkgJson.version);
    expect(lockJson.packages?.['']?.name).toBe(pkgJson.name);
    expect(lockJson.packages?.['']?.version).toBe(pkgJson.version);
  });
});
