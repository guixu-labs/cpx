// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// `cpx --version` IT：经仓内 wrapper 起 cpx-cli，验证：
//   ① --version / -v 均输出 cpx v<版本>，版本号与 src/version.ts 单一源一致
//   ② 输出带生效代码路径（多仓共存时确认当前副本，对应 symlink 映射）
//   ③ --help 标题含同一版本号（版本源唯一，不会两处漂移）

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.join(path.resolve(__dirname, '..'), 'cpx-cli');
const PKG = path.resolve(__dirname, '..');

function runCpx(flag: string) {
  return spawnSync('bash', [WRAPPER, flag], { encoding: 'utf-8', timeout: 60_000 });
}

describe('cpx --version', () => {
  it('prints the version from src/version.ts (single source)', () => {
    for (const flag of ['--version', '-v']) {
      const r = runCpx(flag);
      expect(r.status, `${flag}: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain(`cpx v${VERSION}`);
    }
  });

  it('prints the live code path (multi-checkout disambiguation)', () => {
    const r = runCpx('--version');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(PKG);
  });

  it('--help title carries the same version (no drift between sources)', () => {
    const r = runCpx('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`cpx v${VERSION} —`);
  });
});
