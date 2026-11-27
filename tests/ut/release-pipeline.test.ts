// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../src/version.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, '../..');
const tool = (name: string) => path.join(PKG_DIR, 'scripts', 'release', name);

function tempPath(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeExecutable(file: string, source: string): void {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

const FAKE_PROMOTE_NPM = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'view') {
  const state = JSON.parse(fs.readFileSync(process.env.FAKE_NPM_STATE, 'utf8'));
  process.stdout.write(JSON.stringify(state[args[1]] ?? {}));
} else if (args[0] === 'dist-tag') {
  fs.appendFileSync(process.env.FAKE_NPM_LOG, args.join(' ') + '\\n');
} else {
  process.exit(2);
}
`;

function runPromote(distTags: Record<string, Record<string, string>>) {
  const tmp = tempPath('release-promote-cpx-');
  writeExecutable(path.join(tmp, 'npm'), FAKE_PROMOTE_NPM);
  const statePath = path.join(tmp, 'state.json');
  const logPath = path.join(tmp, 'npm.log');
  fs.writeFileSync(statePath, JSON.stringify(distTags));

  const result = spawnSync(
    process.execPath,
    [tool('promote.mjs'), '--version', '0.1.20', '--confirm', '0.1.20', '--prune-legacy', 'true'],
    {
      cwd: PKG_DIR,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}`,
        FAKE_NPM_STATE: statePath,
        FAKE_NPM_LOG: logPath,
      },
    },
  );

  const log = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  fs.rmSync(tmp, { recursive: true, force: true });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, log };
}

describe('release pipeline workflows', () => {
  const publishWorkflow = fs.readFileSync(path.join(PKG_DIR, '.github/workflows/release-publish.yml'), 'utf8');
  const promoteWorkflow = fs.readFileSync(path.join(PKG_DIR, '.github/workflows/release-promote.yml'), 'utf8');

  it('publish 先发布所选 tag 并完成 registry 验证，不直接移动 latest', () => {
    const publishStep = publishWorkflow.indexOf('name: Publish packages to selected dist-tag');
    const verifyStep = publishWorkflow.indexOf('name: Verify selected dist-tag');
    expect(publishStep).toBeGreaterThan(-1);
    expect(verifyStep).toBeGreaterThan(publishStep);
    expect(publishWorkflow).toContain('--wait-seconds 300 --poll-seconds 15');
    expect(publishWorkflow).not.toContain('dist-tag add');

    const publishJob = publishWorkflow.slice(publishWorkflow.indexOf('\n  publish:'));
    expect(publishJob).toContain("if: inputs.mode == 'publish'");
    expect(publishJob).toContain('name: Verify selected dist-tag');
  });

  it('promote 在移动 latest 后做有界轮询验证', () => {
    const promoteStep = promoteWorkflow.indexOf('name: Promote packages to latest');
    const verifyStep = promoteWorkflow.indexOf('name: Verify registry state');
    expect(promoteStep).toBeGreaterThan(-1);
    expect(verifyStep).toBeGreaterThan(promoteStep);
    expect(promoteWorkflow).toContain(
      '--tag latest --version "$VERSION" --wait-seconds 300 --poll-seconds 15',
    );
  });

  it('registry 验证脚本支持有界轮询', () => {
    const result = spawnSync(process.execPath, [tool('verify-registry.mjs'), '--help'], {
      cwd: PKG_DIR,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('--wait-seconds');
    expect(`${result.stdout}${result.stderr}`).toContain('--poll-seconds');
  });
});

describe('release promote atomicity', () => {
  it('任一包未发布时不产生任何 dist-tag 变更', () => {
    const { status, log } = runPromote({
      'context-cpx': { beta: '0.1.20' },
      'cannbot-proxy': { beta: '0.1.19' },
    });
    expect(status).not.toBe(0);
    expect(log).toEqual([]);
  });

  it('两包齐备时统一提升 latest 并清理 legacy tags', () => {
    const { status, log } = runPromote({
      'context-cpx': { beta: '0.1.20', next: '0.1.19', dev: '0.1.18' },
      'cannbot-proxy': { beta: '0.1.20', latest: '0.1.19' },
    });
    expect(status).toBe(0);
    expect(log).toHaveLength(4);
    expect(log).toContain('dist-tag add context-cpx@0.1.20 latest --registry https://registry.npmjs.org/');
    expect(log).toContain('dist-tag add cannbot-proxy@0.1.20 latest --registry https://registry.npmjs.org/');
    expect(log).toContain('dist-tag rm context-cpx next --registry https://registry.npmjs.org/');
    expect(log).toContain('dist-tag rm context-cpx dev --registry https://registry.npmjs.org/');
  });
});

describe('release preflight', () => {
  it('版本、tag、main 归属与 npm 冲突检查通过后可发布', () => {
    const tmp = tempPath('release-preflight-cpx-');
    const fakeNpm = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== 'view') process.exit(2);
if (args[1].includes('@')) process.exit(1);
process.stdout.write(JSON.stringify({ latest: '0.1.18', beta: '0.1.19' }));
`;
    const fakeGit = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'merge-base') process.exit(0);
if (args[0] === 'rev-parse') { process.stdout.write('abc123\\n'); process.exit(0); }
process.exit(2);
`;
    writeExecutable(path.join(tmp, 'npm'), fakeNpm);
    writeExecutable(path.join(tmp, 'git'), fakeGit);

    const result = spawnSync(
      process.execPath,
      [tool('preflight-publish.mjs'), '--tag', `v${VERSION}`, '--confirm', VERSION, '--mode', 'publish', '--dist-tag', 'beta'],
      {
        cwd: PKG_DIR,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}` },
      },
    );
    fs.rmSync(tmp, { recursive: true, force: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`[release-preflight] publish: v${VERSION} / ${VERSION} / beta OK`);
  });
});
