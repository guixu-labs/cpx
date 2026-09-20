// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// tsx loader 定位（cpx-cli 会话代理起 TS 源码用；bin/cpx.mjs 因自举时序限制
// 内联同款逻辑）：从给定文件位置做标准模块解析——npm i -g 时 tsx 嵌套在包内
// node_modules、装进用户项目 / npx cannbot-proxy 时被 npm 提升到顶层
// node_modules，两种布局 require.resolve 都能命中（tsx 的 `.` export 即
// ./dist/loader.mjs）。找不到返回 null，调用方回落 npx（registry 网络依赖）。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export function resolveTsxLoader(fromFile: string): string | null {
  try {
    return pathToFileURL(createRequire(fromFile).resolve('tsx')).href;
  } catch {
    return null;
  }
}
