// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// ensureLfsGitattributes IT（真实 git 仓 + 真实文件，无 git-lfs 依赖——函数
// 本体只做 fs 读写 + git add，runGit 默认中和 lfs filter）。回归锁：
// 补行判定的 glob 转义（*.7z/*.gz 的 `*` 与 `.` 都须转义）——未转义 `*`
// 的旧实现构造出 `^\.7z\s+filter=lfs`，永远匹配不到行首为 `*` 的真实
// .gitattributes 行 →「缺行补行」恒真 → 每次 LFS 上传重复追加声明行并
// 触发无意义的 .gitattributes 提交，文件随上传次数无限增长。
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureLfsGitattributes } from '../../src/cannbay/mirror';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay-lfs-ga-'));

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 }).toString();
}

function mkRepo(ga?: string): string {
  const repo = path.join(TMP, `repo-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(repo, { recursive: true });
  git('git init -b main .', repo);
  if (ga != null) fs.writeFileSync(path.join(repo, '.gitattributes'), ga);
  return repo;
}

function countLines(repo: string, re: RegExp): number {
  return (fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8').match(re) ?? []).length;
}

describe('ensureLfsGitattributes 补行/去重（无需 git-lfs 真机件）', () => {
  it('已有 *.7z + *.gz 声明（含无关行噪声）→ 字节零改动，不重复追加', () => {
    const ga = '*.png filter=lfs diff=lfs merge=lfs -text\n'
      + '*.7z filter=lfs diff=lfs merge=lfs -text\n'
      + '*.gz filter=lfs diff=lfs merge=lfs -text\n';
    const repo = mkRepo(ga);
    ensureLfsGitattributes(repo);
    expect(fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8')).toBe(ga);
  });

  it('只带存量 *.gz 声明 → 仅补 *.7z 一行，*.gz 不重复', () => {
    const repo = mkRepo('*.gz filter=lfs diff=lfs merge=lfs -text\n');
    ensureLfsGitattributes(repo);
    expect(countLines(repo, /^\*\.7z filter=lfs/gm)).toBe(1);
    expect(countLines(repo, /^\*\.gz filter=lfs/gm)).toBe(1);
  });

  it('无 .gitattributes → 补齐双行并 git add；重复调用幂等', () => {
    const repo = mkRepo();
    ensureLfsGitattributes(repo);
    expect(countLines(repo, /^\*\.7z filter=lfs/gm)).toBe(1);
    expect(countLines(repo, /^\*\.gz filter=lfs/gm)).toBe(1);
    expect(git('git status --porcelain', repo)).toContain('A  .gitattributes');
    const after = fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8');
    ensureLfsGitattributes(repo);
    expect(fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8')).toBe(after);
  });
});
