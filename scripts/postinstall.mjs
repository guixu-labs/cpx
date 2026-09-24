#!/usr/bin/env node
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// cpx install hook: wire up tab completion out of the box (users should not
// have to run `completion --install` manually). bash installs into the
// user-level bash-completion autoload dir; zsh only when the user actually
// runs zsh (the completion script is a pure static word list — no dynamic
// branches, no node dependency). Best-effort throughout: a failed completion
// install never blocks `npm i -g`.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(PKG_DIR, 'bin', 'cpx.mjs');

try {
  spawnSync(process.execPath, [BIN, 'completion', 'bash', '--install'], { stdio: 'inherit' });
  const zshUser = /zsh$/.test(process.env.SHELL ?? '') || fs.existsSync(path.join(os.homedir(), '.zshrc'));
  if (zshUser) {
    spawnSync(process.execPath, [BIN, 'completion', 'zsh', '--install'], { stdio: 'inherit' });
  }
} catch {
  /* 补全失败不阻断安装 */
}
