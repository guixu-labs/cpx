// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// Tab 补全 IT：候选逻辑各上下文（首词子命令/agent 命令、--agent profiles、
// upload/normalize 动态 sid、config dedup on/off、status flags、值参数场景、
// agent 域不越界）+ 脚本产物（bash/zsh 转发 __complete）+ 真 wrapper 的
// __complete 冒烟。

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { completeCandidates, listCaptureSids, bashScript, zshScript, runCompletion } from '../src/cli/cpx-complete';

const WRAPPER = path.join(path.resolve(__dirname, '..'), 'cpx-cli');
let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-complete-it-'));
  process.env.CANNBOT_PROXY_DIR = dir;
});

function writeCapture(sid: string, mtimeMs: number, plain = false): void {
  const file = path.join(dir, `cpx-${sid}.jsonl${plain ? '' : '.gz'}`);
  fs.writeFileSync(file, plain ? '{}\n' : zlib.gzipSync('{}\n'));
  fs.utimesSync(file, mtimeMs, mtimeMs);
}

describe('completeCandidates 上下文', () => {
  it('首词：子命令 + agent 命令 + 顶层 flag；前缀过滤', () => {
    const all = completeCandidates(['cpx', '']);
    for (const w of ['upload', 'list', 'status', 'config', 'completion', 'claude', 'opencode', '--agent', '--autoupload']) {
      expect(all).toContain(w);
    }
    expect(completeCandidates(['cpx', 'up'])).toEqual(['upload']);
    expect(completeCandidates(['cpx', 'cl'])).toEqual(['claude']);
  });

  it('--agent / --opgen 值参数场景；其余值参数无候选', () => {
    expect(completeCandidates(['cpx', '--agent', ''])).toEqual(
      ['claude', 'opencode', 'cannbot', 'codex', 'openai', 'generic'],
    );
    expect(completeCandidates(['cpx', '--agent', 'c'])).toEqual(['claude', 'cannbot', 'codex']);
    expect(completeCandidates(['cpx', 'upload', '--opgen', 's'])).toEqual(['success']);
    expect(completeCandidates(['cpx', 'upload', '--submitter', '张'])).toEqual([]);
  });

  it('upload：动态 sid（新 → 旧、cpx- 前缀剥离、明文/压缩去重、空文件排除）；flag 场景', () => {
    writeCapture('old-sid', Date.now() - 7200_000);
    writeCapture('new-sid', Date.now() - 60_000);
    writeCapture('mid-sid', Date.now() - 600_000, true);
    writeCapture('empty-sid', Date.now() - 30_000);
    fs.truncateSync(path.join(dir, 'cpx-empty-sid.jsonl.gz'));
    expect(listCaptureSids()).toEqual(['new-sid', 'mid-sid', 'old-sid']);
    expect(completeCandidates(['cpx', 'upload', ''])).toEqual(['new-sid', 'mid-sid', 'old-sid']);
    expect(completeCandidates(['cpx', 'upload', 'n'])).toEqual(['new-sid']);
    expect(completeCandidates(['cpx', 'upload', '--'])).toEqual(
      ['--submitter', '--category', '--desc', '--opgen', '--baseline'],
    );
  });

  it('normalize：sid 候选；config：dedup → on/off；status：--kill/--all', () => {
    expect(completeCandidates(['cpx', 'config', ''])).toEqual(['dedup']);
    expect(completeCandidates(['cpx', 'config', 'dedup', ''])).toEqual(['on', 'off']);
    expect(completeCandidates(['cpx', 'status', '-'])).toEqual(['--kill', '--all']);
  });

  it('agent 命令域不越界：透传参数无候选（flag 词仅 agent 紧随其后的首段给保留 flag）', () => {
    expect(completeCandidates(['cpx', 'claude', ''])).toEqual([]);
    expect(completeCandidates(['cpx', 'opencode', '--mo'])).toEqual([]);
    expect(completeCandidates(['cpx', 'claude', 'src/', ''])).toEqual([]);
    expect(completeCandidates(['cpx', '-'])).toEqual(['--agent', '--autoupload', '--help', '--version', '-h', '-v']);
    expect(completeCandidates(['cpx', 'ls', 'x'])).toEqual([]);
  });
});

describe('completion 脚本与安装', () => {
  it('bash/zsh 脚本均转发 __complete；agent 域静默（无 -o default 文件兜底）；bundle 存在时嵌快路径', () => {
    expect(bashScript()).toContain('__complete');
    expect(bashScript()).toContain('complete -F _cpx cpx');
    expect(bashScript()).not.toContain('-o default');
    expect(bashScript()).toContain('words="list ls status upload'); // 静态表生成时内嵌（零进程路由）
    expect(zshScript()).toContain('bashcompinit');
    expect(zshScript()).toContain('__complete');
    const bundle = path.join(path.resolve(__dirname, '..'), 'dist', 'cpx-complete.mjs');
    if (fs.existsSync(bundle)) {
      expect(bashScript()).toContain('cpx-complete.mjs');
      expect(bashScript()).toContain(`node "${bundle}"`);
    }
  });
  it('runCompletion：非法 shell → 2；--install 落盘到用户补全目录', () => {
    const outs: string[] = []; const errs: string[] = [];
    expect(runCompletion(['fish'], m => outs.push(m), m => errs.push(m)).code).toBe(2);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-complete-home-'));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(runCompletion(['bash', '--install'], m => outs.push(m), m => errs.push(m)).code).toBe(0);
      const installed = path.join(home, '.local', 'share', 'bash-completion', 'completions', 'cpx');
      expect(fs.existsSync(installed)).toBe(true);
      expect(fs.readFileSync(installed, 'utf8')).toContain('__complete');
    } finally { process.env.HOME = prevHome; }
  });
  it('zsh --install：_cpx 落盘 + .zshrc fpath/compinit 幂等追加', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-complete-zsh-'));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const outs: string[] = []; const errs: string[] = [];
    try {
      runCompletion(['zsh', '--install'], m => outs.push(m), m => errs.push(m));
      runCompletion(['zsh', '--install'], m => outs.push(m), m => errs.push(m));
      expect(fs.readFileSync(path.join(home, '.zfunc', '_cpx'), 'utf8')).toContain('__complete');
      const rc = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
      expect(rc.match(/fpath=\(~\/\.zfunc/g)?.length).toBe(1);
      expect(rc.match(/compinit/g)?.length).toBe(2); // 一行内 autoload…compinit && compinit 两次出现
    } finally { process.env.HOME = prevHome; }
  });
  it('postinstall 冒烟：bash 用户装配用户级补全目录 + 热路径 bundle，退出码恒 0', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-postinst-'));
    const r = spawnSync('node', [path.join(path.resolve(__dirname, '..'), 'scripts', 'postinstall.mjs')], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HOME: home, SHELL: '/bin/bash' },
    });
    expect(r.status).toBe(0);
    const installed = path.join(home, '.local', 'share', 'bash-completion', 'completions', 'cpx');
    expect(fs.existsSync(installed)).toBe(true);
    const bundle = path.join(path.resolve(__dirname, '..'), 'dist', 'cpx-complete.mjs');
    if (fs.existsSync(bundle)) {
      const fast = spawnSync('node', [bundle, '__complete', 'cpx', 'up'], { encoding: 'utf8', timeout: 30_000 });
      expect(fast.stdout.trim()).toBe('upload');
    }
  });
});

describe('__complete 真 wrapper 冒烟', () => {
  it('cpx __complete 整行词表 → 候选行输出', () => {
    const r = spawnSync('bash', [WRAPPER, '__complete', 'cpx', 'up'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('upload');
  });
  it('静态上下文零进程：node/cpx 全灭仍可补全（只有 sid 动态场景依赖 node）', () => {
    const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-node-stub-'));
    fs.writeFileSync(path.join(stub, 'node'), '#!/bin/sh\nexit 9\n');
    fs.chmodSync(path.join(stub, 'node'), 0o755);
    fs.writeFileSync(path.join(stub, 'cpx'), '#!/bin/sh\nexit 9\n');
    fs.chmodSync(path.join(stub, 'cpx'), 0o755);
    const scriptFile = path.join(stub, 'completion.sh');
    fs.writeFileSync(scriptFile, bashScript());
    const run = (line: string) => spawnSync('bash', ['-c', `source ${JSON.stringify(scriptFile)}; ${line}`], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
    });
    const a = run('COMP_WORDS=(cpx up); COMP_CWORD=1; _cpx; echo "${COMPREPLY[@]}"');
    expect(a.stdout.trim()).toBe('upload');
    const b = run('COMP_WORDS=(cpx upload ""); COMP_CWORD=2; _cpx; echo "[${COMPREPLY[@]}]"');
    expect(b.stdout.trim()).toBe('[]'); // 动态分支 node 失败 → 空（静态不受影响）
    fs.rmSync(stub, { recursive: true, force: true });
  });
});
