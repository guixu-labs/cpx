// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run-tests.sh 自愈安装目标的回归锁。历史 bug：resolve_vitest 探测已支持
// ../context-insight 第二候选（兄弟仓独立 checkout 名），但 vitest 缺失时的
// 自愈安装 fallback 仍硬编码 `(cd ../insight && npm install)`——当兄弟仓只有
// context-insight（无 insight）时 `cd ../insight` 目录不存在 → `|| exit 1` 直接
// 退出，自愈路径失效（正是本仓当前 worktree 布局：兄弟仓就是 context-insight）。
//
// 锁法：把真 run-tests.sh 拷进受控沙箱布局（兄弟仓只有 context-insight），用
// 假 npm/vitest 桩跑一遍真实自愈流程，断言 npm 被调用的目录是 context-insight
// 而非硬编码的 insight，且自愈闭环走通（exit 0）。旧实现（硬编码 ../insight）
// 在 `cd` 失败处即退出，npm 一次都不触发 → 断言必红。
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../../');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-bootstrap-'));
const cpxRoot = path.join(tmpRoot, 'cpx');
const insightRoot = path.join(tmpRoot, 'context-insight');
const binDir = path.join(tmpRoot, 'bin');
const npmLog = path.join(tmpRoot, 'npm.log');

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function writeExecutable(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

describe('run-tests.sh 自愈安装目标跟随兄弟仓探测', () => {
  it('兄弟仓只有 context-insight 时，vitest 缺失自愈应装进 context-insight（而非硬编码 ../insight）', () => {
    // cpx repo：pod 拷贝真 run-tests.sh + package.json，假 node_modules 令 cpx 自身
    // deps 检查通过（跳过 cpx 的 npm install），把唯一一次 npm install 留给兄弟仓自愈。
    fs.mkdirSync(path.join(cpxRoot, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts/run-tests.sh'), path.join(cpxRoot, 'scripts/run-tests.sh'));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(cpxRoot, 'package.json'));
    for (const d of Object.keys(pkg.dependencies ?? {})) {
      fs.mkdirSync(path.join(cpxRoot, 'node_modules', d), { recursive: true });
    }
    writeExecutable(path.join(cpxRoot, 'node_modules', '.bin', 'tsx'), '#!/usr/bin/env bash\nexit 0\n');

    // 兄弟仓：只有 context-insight（无 insight）——正是 reviewer 指出的场景。
    fs.mkdirSync(insightRoot, { recursive: true });
    fs.writeFileSync(path.join(insightRoot, 'package.json'), '{"name":"context-insight","private":true}\n');

    // 假 npm：记录被调用的 PWD，并模拟安装成功（在 CWD 落一个可执行 vitest，
    // 好让 resolve_vitest 二次探测命中、自愈闭环走通到 exit 0）。
    writeExecutable(path.join(binDir, 'npm'), `#!/usr/bin/env bash\n` +
      `echo "$PWD" >> '${npmLog}'\n` +
      `mkdir -p node_modules/.bin\n` +
      `printf '#!/usr/bin/env bash\\nexit 0\\n' > node_modules/.bin/vitest\n` +
      `chmod +x node_modules/.bin/vitest\n` +
      `exit 0\n`);

    const r = spawnSync('bash', [path.join(cpxRoot, 'scripts', 'run-tests.sh'), 'ut'], {
      cwd: cpxRoot,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CONTEXT_TEST_SKIP_SLOW: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });

    // 自愈闭环走通：没有在硬编码的 ../insight 上断掉
    expect(r.status, `run-tests.sh 失败：\n${r.stdout}\n${r.stderr}`).toBe(0);

    const calls = fs.existsSync(npmLog) ? fs.readFileSync(npmLog, 'utf8').trim().split('\n') : [];
    // npm 只该被调用一次（cpx 自身 deps 齐全被跳过），且落在 context-insight
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(insightRoot);
  });
});