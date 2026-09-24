// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// openBrowser 测试环境熔断回归锁（历史事故：全量 e2e 真弹浏览器空页——旧
// PATH 桩对 WSL 的 cmd.exe 绝对路径分支结构性无效）。守卫必须存在且先于
// 任何 spawn 分支；e2e 同时显式设 CANNBOT_NO_BROWSER（belt+braces）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../');
const cliSrc = fs.readFileSync(path.join(ROOT, 'src/cli/cpx-cli.ts'), 'utf8');
// 消费方：走完整 cpx-cli 退出路径的 reasoning-capture e2e
const e2eSrc = fs.readFileSync(path.join(ROOT, 'tests/e2e/cpx-reasoning-capture.e2e.test.ts'), 'utf8');

describe('openBrowser 测试环境熔断（防弹窗回归锁）', () => {
  it('openBrowser 首行守卫：CANNBOT_NO_BROWSER / VITEST 任一即 return（先于 cmd.exe/xdg-open 分支）', () => {
    const fn = cliSrc.slice(cliSrc.indexOf('function openBrowser('), cliSrc.indexOf('function openBrowser(') + 800);
    expect(fn).toContain("if (process.env.CANNBOT_NO_BROWSER || process.env.VITEST) return;");
    // 守卫必须在任何 spawn 之前（cmd.exe 绝对路径分支是 PATH 桩拦不住的）
    expect(fn.indexOf('CANNBOT_NO_BROWSER')).toBeLessThan(fn.indexOf('spawnSync'));
  });

  it('reasoning-capture e2e 显式设 CANNBOT_NO_BROWSER（belt+braces）', () => {
    expect(e2eSrc).toContain("CANNBOT_NO_BROWSER: '1'");
  });
});
