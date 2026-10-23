#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cpx npm bin 启动器（npm install -g context-cpx 后 `cpx` 命令的真身）。
// 仓内开发态走仓根 cpx-cli wrapper（bash，自行寻 tsx）；npm 包形态用本文件：
// tsx 是本包 dependency，但落位随安装形态而变（npm i -g 嵌套在包内、装进
// 用户项目 / npx context-cpx 时被提升到顶层 node_modules）——loader 经
// createRequire 从本文件做标准模块解析定位，两种布局都能命中。

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

// 从 bin 自身位置做标准模块解析定位 tsx loader（与 postinstall 解析 esbuild 同款）：
// npm i -g 时 tsx 嵌套在包内、装进用户项目/npx 时被提升到顶层 node_modules，
// 两种布局 require.resolve 都能命中；tsx 的 `.` export 即 ./dist/loader.mjs。
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

const child = spawn(
  process.execPath,
  ['--import', tsxLoader, path.join(PKG_DIR, 'src', 'cli', 'cpx-cli.ts'), ...args],
  {
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
