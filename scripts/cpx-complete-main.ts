#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// 补全热路径 bundle 入口（esbuild 打包目标）：只 import cpx-complete（纯
// node 内置依赖），保持 bundle 微型——补全延迟 = node 冷启（<100ms），不经
// tsx 运行时转换整个 CLI 导入图（~0.5s）。cpx-cli 的 completion/__complete
// 分发与本文件共用同一 runCompleteMain。

import { runCompleteMain } from '../src/cli/cpx-complete';

process.exitCode = runCompleteMain(process.argv.slice(2));
