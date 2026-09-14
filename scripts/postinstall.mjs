#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// cpx 安装钩子：Tab 补全开箱即用（用户不该手动跑 completion --install）。
// ① esbuild 预编译补全热路径 bundle（dist/cpx-complete.mjs，纯 node 直跑，
//    免 tsx 转换整个 CLI 的 ~0.5s 补全延迟；esbuild 经 tsx 依赖随包落地）
// ② bash 写用户级 bash-completion 自动加载目录；zsh 仅在实际是 zsh 用户时装配
//    （脚本指向 bundle 绝对路径，缺失回退 cpx __complete 慢路径）
// 全程 best-effort：补全装不上绝不阻断安装（npm i -g 永远成功）。

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(PKG_DIR, 'bin', 'cpx.mjs');

try {
  try {
    const require = createRequire(path.join(PKG_DIR, 'package.json'));
    const esbuild = require('esbuild');
    fs.mkdirSync(path.join(PKG_DIR, 'dist'), { recursive: true });
    esbuild.buildSync({
      entryPoints: [path.join(PKG_DIR, 'scripts', 'cpx-complete-main.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile: path.join(PKG_DIR, 'dist', 'cpx-complete.mjs'),
      logLevel: 'silent',
    });
  } catch { /* esbuild 缺失：跳过 bundle，补全回退慢路径 */ }

  spawnSync(process.execPath, [BIN, 'completion', 'bash', '--install'], { stdio: 'inherit' });
  const zshUser = /zsh$/.test(process.env.SHELL ?? '') || fs.existsSync(path.join(os.homedir(), '.zshrc'));
  if (zshUser) {
    spawnSync(process.execPath, [BIN, 'completion', 'zsh', '--install'], { stdio: 'inherit' });
  }
} catch {
  /* 补全失败不阻断安装 */
}
