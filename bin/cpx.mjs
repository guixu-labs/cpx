#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cpx npm bin 启动器（npm install -g cannbot-proxy 后 `cpx` 命令的真身）。
// 仓内开发态走仓根 cpx-cli wrapper（bash，自行寻 tsx）；npm 包形态用本文件：
// tsx 是本包 dependency，安装即落 <pkg>/node_modules，用 node --import tsx 起 TS 源码。

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

const child = spawn(
  process.execPath,
  ['--import', 'tsx', path.join('src', 'cli', 'cpx-cli.ts'), ...args],
  {
    cwd: PKG_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      PATH: [path.join(PKG_DIR, 'node_modules', '.bin'), process.env.PATH || ''].join(path.delimiter),
    },
  },
)
child.on('error', (e) => {
  console.error(`[cpx] 启动失败: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) process.exit(code ?? 1)
  process.exit(code ?? 0)
})
