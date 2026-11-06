// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROXY_ROOT = path.resolve(__dirname, '../../');
const WRAPPER = path.join(PROXY_ROOT, 'cpx-cli');

let TMP: string;
let CAPTURES: string;

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-child-exit-code-e2e-'));
  CAPTURES = path.join(TMP, 'captures');
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function runAgent(exitCode: number) {
  return spawnSync('bash', [WRAPPER, '--agent', 'generic', '--', '/bin/sh', '-c', `exit ${exitCode}`], {
    encoding: 'utf-8',
    timeout: 120_000,
    env: {
      ...process.env,
      CANNBOT_PROXY_DIR: CAPTURES,
      CANNBOT_CPX_INSIGHT_BASE: 'not-a-url',
      CANNBOT_NO_BROWSER: '1',
    },
  });
}

describe('cpx child process exit status', () => {
  it('preserves success from an agent that exits 0', () => {
    const result = runAgent(0);
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 120_000);

  it('preserves a nonzero agent status when no capture was produced', () => {
    const result = runAgent(37);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('no capture file produced');
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(37);
  }, 120_000);

  it('maps signal termination to the shell-style status', () => {
    const result = spawnSync('bash', [WRAPPER, '--agent', 'generic', '--', '/bin/sh', '-c', 'kill -TERM $$'], {
      encoding: 'utf-8',
      timeout: 120_000,
      env: {
        ...process.env,
        CANNBOT_PROXY_DIR: CAPTURES,
        CANNBOT_CPX_INSIGHT_BASE: 'not-a-url',
        CANNBOT_NO_BROWSER: '1',
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(128 + 15);
  }, 120_000);
});
