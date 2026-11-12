// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run-tests.sh vitest 自举的回归锁。历史：cpx 曾未声明 vitest 依赖，运行时借
// 兄弟仓 insight（../insight | ../context-insight 双名探测）的二进制，缺失时
// 替兄弟仓 npm install——两仓存在工具面耦合。0.1.15 起 vitest 收编为本包
// devDependency，仓间零依赖。
//
// 锁两件事：
//   1) 行为锁：全新 cpx checkout（vitest 缺失、且**没有任何兄弟仓**）跑
//      run-tests.sh，自愈 = 本包 npm install，闭环走通（exit 0）——兄弟仓
//      缺席不再是测试入口的运行前提
//   2) 静态锁：脚本文本不得再出现兄弟仓借用路径（../insight、
//      ../context-insight）——防「探测/安装回潮」的漂移哨兵
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../../');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-bootstrap-'));
const cpxRoot = path.join(tmpRoot, 'cpx');
const binDir = path.join(tmpRoot, 'bin');
const npmLog = path.join(tmpRoot, 'npm.log');

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function writeExecutable(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

describe('run-tests.sh vitest 自举（自有依赖，仓间零依赖）', () => {
  it('vitest 缺失且无兄弟仓：自愈 = 本包 npm install，闭环走通', () => {
    // cpx repo：拷贝真 run-tests.sh + package.json，假 node_modules 令 cpx 自身
    // dependencies 检查通过（跳过生产依赖安装），把唯一一次 npm install 留给
    // vitest 自愈——与 fresh clone 后首次跑测试的真实形态一致。
    fs.mkdirSync(path.join(cpxRoot, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts/run-tests.sh'), path.join(cpxRoot, 'scripts/run-tests.sh'));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(cpxRoot, 'package.json'));
    for (const d of Object.keys(pkg.dependencies ?? {})) {
      fs.mkdirSync(path.join(cpxRoot, 'node_modules', d), { recursive: true });
    }
    writeExecutable(path.join(cpxRoot, 'node_modules', '.bin', 'tsx'), '#!/usr/bin/env bash\nexit 0\n');

    // 关键布局：tmp 下只有 cpx，没有任何兄弟仓（insight/context-insight 都不在）
    // ——旧实现（借兄弟仓二进制）在此必挂：探测全 miss → 找不到兄弟仓退出。

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

    // 自愈闭环走通：没有兄弟仓也活着
    expect(r.status, `run-tests.sh 失败：\n${r.stdout}\n${r.stderr}`).toBe(0);

    // npm 只被调用一次（生产依赖齐全被跳过），且落在 cpx 自己的目录
    const calls = fs.existsSync(npmLog) ? fs.readFileSync(npmLog, 'utf8').trim().split('\n') : [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(cpxRoot);
  });

  it('静态哨兵：run-tests.sh 不得出现兄弟仓借用路径', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts/run-tests.sh'), 'utf8');
    expect(script, '兄弟仓借用回潮（vitest 应为本包 devDependency）').not.toContain('../insight');
    expect(script, '兄弟仓借用回潮（vitest 应为本包 devDependency）').not.toContain('../context-insight');
    // 收编的根：package.json 必须声明 vitest（否则自愈安装装不出来）
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.devDependencies?.vitest, 'package.json 必须声明 vitest devDependency').toBeTruthy();
  });
});
