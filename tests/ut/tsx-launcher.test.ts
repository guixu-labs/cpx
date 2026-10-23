// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// resolveTsxLoader 单测：createRequire 从文件位置标准解析的三种布局语义——
// ① npm i -g 嵌套（tsx 在包自己的 node_modules）
// ② 用户项目安装 hoist（tsx 提升到顶层 node_modules，包内没有）
// ③ 到处没有 tsx → null（调用方回落 npx）
// 修复背景：bin/cpx.mjs 与 cpx-cli 会话代理此前各自硬编码
// <pkg>/node_modules(/.bin)/tsx，hoist 布局下 miss——代理启动回落 npx 从
// registry 现场下载 tsx（网络依赖）；bin 则直接 ERR_MODULE_NOT_FOUND。
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveTsxLoader } from '../../src/cli/tsx-launcher';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-launcher-test-'));

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// 极小 tsx 包桩：require.resolve 只看 package.json exports，不看内容
function fakeTsxAt(dir: string): string {
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'tsx',
    exports: { '.': './dist/loader.mjs' },
  }));
  fs.writeFileSync(path.join(dir, 'dist', 'loader.mjs'), 'export {}\n');
  return pathToFileURL(path.join(dir, 'dist', 'loader.mjs')).href;
}

describe('resolveTsxLoader（从文件位置标准解析）', () => {
  it('嵌套布局（npm i -g）：包内 node_modules 的 tsx 命中', () => {
    const nested = path.join(TMP, 'nested');
    const pkgFile = path.join(nested, 'node_modules', 'context-cpx', 'src', 'cli', 'cpx-cli.ts');
    const expected = fakeTsxAt(path.join(nested, 'node_modules', 'context-cpx', 'node_modules', 'tsx'));
    expect(resolveTsxLoader(pkgFile)).toBe(expected);
  });

  it('hoist 布局（用户项目安装）：提升到顶层 node_modules 的 tsx 命中，包内无 tsx', () => {
    const hoist = path.join(TMP, 'hoist');
    const pkgFile = path.join(hoist, 'node_modules', 'context-cpx', 'src', 'cli', 'cpx-cli.ts');
    const expected = fakeTsxAt(path.join(hoist, 'node_modules', 'tsx'));
    expect(resolveTsxLoader(pkgFile)).toBe(expected);
    // 旧硬编码路径在该布局下不存在（修复动机）
    expect(fs.existsSync(path.join(path.dirname(pkgFile), '..', '..', 'node_modules', '.bin', 'tsx'))).toBe(false);
  });

  it('无 tsx 布局：返回 null（调用方回落 npx）', () => {
    const bare = path.join(TMP, 'bare');
    fs.mkdirSync(bare, { recursive: true });
    expect(resolveTsxLoader(path.join(bare, 'src', 'cli', 'cpx-cli.ts'))).toBeNull();
  });
});
