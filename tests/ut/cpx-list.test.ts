// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// `cpx list` IT：真实产物布局（顶层捕获 + cc-session-meta + subagents/）驱动，
// 经仓内 wrapper 起 cpx-cli，验证：
//   ① 按 mtime 降序
//   ② 同 stem 明文/压缩态合并为一条（明文优先，STATE=live）
//   ③ meta 声明的 framework/protocol 展示；缺失显示 -
//   ④ subagents 计数（.jsonl/.jsonl.gz 同 stem 去重）
//   ⑤ 空占位文件 / .pretty.json 调试产物不出现
//   ⑥ 空目录优雅提示

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const WRAPPER = path.join(path.resolve(__dirname, '../../'), 'cpx-cli');

let dir: string;
const T0 = Date.now() / 1000 - 3 * 3600;

function captureDir(): string { return dir; }

function writeLine(file: string, obj: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj) + '\n');
}

function sessionMeta(sid: string, framework: string, protocol: string): object {
  return { x_lake: { schema: 'cc-session-meta', version: 1, data: { producer: 'cpx', framework, protocol, sid } } };
}

function runList() {
  return spawnSync('bash', [WRAPPER, 'list'], {
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CONTEXT_PROXY_DIR: captureDir() },
  });
}

function lineOf(stdout: string, sid: string): string {
  const line = stdout.split('\n').find(l => l.includes(sid));
  expect(line, `line containing "${sid}" in:\n${stdout}`).toBeDefined();
  return line as string;
}

function orderOf(stdout: string, a: string, b: string): number {
  return stdout.indexOf(a) - stdout.indexOf(b);
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-list-test-'));
  const gz = (p: string) => fs.writeFileSync(p, zlib.gzipSync('{"type":"assistant"}\n'));

  // aaa：最旧，gzip at rest，无 meta（framework/protocol 显示 -）
  gz(path.join(dir, 'cpx-aaaaaaaa-0000-0000-0000-000000000000.jsonl.gz'));
  fs.utimesSync(path.join(dir, 'cpx-aaaaaaaa-0000-0000-0000-000000000000.jsonl.gz'), T0, T0);

  // bbb：次新，gzip at rest + meta（codex/responses）+ 2 个 subagent（sub2 双态去重）
  gz(path.join(dir, 'cpx-bbbbbbbb-0000-0000-0000-000000000000.jsonl.gz'));
  fs.utimesSync(path.join(dir, 'cpx-bbbbbbbb-0000-0000-0000-000000000000.jsonl.gz'), T0, T0 + 3600);
  fs.writeFileSync(
    path.join(dir, 'cpx-bbbbbbbb-0000-0000-0000-000000000000.meta.json'),
    JSON.stringify(sessionMeta('bbbbbbbb-0000-0000-0000-000000000000', 'codex', 'responses')),
  );
  const subDir = path.join(dir, 'bbbbbbbb-0000-0000-0000-000000000000', 'subagents');
  writeLine(path.join(subDir, 'ses_sub1.jsonl'), { type: 'assistant' });
  gz(path.join(subDir, 'ses_sub2.jsonl.gz'));
  writeLine(path.join(subDir, 'ses_sub2.jsonl'), { type: 'assistant' }); // resume scratch：同 stem 合并

  // ccc：最新，明文 live 态（裸 sid，无 cpx- 前缀）
  writeLine(path.join(dir, 'cccccccc-0000-0000-0000-000000000000.jsonl'), { type: 'user' });
  fs.utimesSync(path.join(dir, 'cccccccc-0000-0000-0000-000000000000.jsonl'), T0, T0 + 7200);

  // 噪声：空占位 + 调试产物
  fs.writeFileSync(path.join(dir, 'cpx-empty-placeholder.jsonl'), '');
  writeLine(path.join(dir, 'cpx-dddddddd-0000-0000-0000-000000000000.pretty.json'), { debug: true });
});

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('cpx list', () => {
  it('exits 0 and prints the capture dir header', () => {
    const r = runList();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('captures dir');
    expect(r.stdout).toContain(dir);
  });

  it('lists sessions in mtime descending order (ccc → bbb → aaa)', () => {
    const r = runList();
    expect(r.status).toBe(0);
    expect(orderOf(r.stdout, 'cccccccc', 'bbbbbbbb')).toBeLessThan(0);
    expect(orderOf(r.stdout, 'bbbbbbbb', 'aaaaaaaa')).toBeLessThan(0);
    expect(r.stdout).toContain('共 3 个会话');
  });

  it('merges plain/gz of the same stem into one live row and shows subagent count', () => {
    const r = runList();
    const bbb = lineOf(r.stdout, 'bbbbbbbb');
    expect(bbb).toContain('rest');
    expect(bbb).toContain('cpx-bbbbbbbb-0000-0000-0000-000000000000.jsonl.gz');
    // SUB 列 = 2（sub1 + sub2 双态去重）
    expect(bbb).toMatch(/codex\s+responses\s+2\s+rest/);
  });

  it('marks plain captures as live and shows meta-declared framework', () => {
    const r = runList();
    const ccc = lineOf(r.stdout, 'cccccccc');
    expect(ccc).toContain('live');
    // 无 meta：framework/protocol 显示 -
    const aaa = lineOf(r.stdout, 'aaaaaaaa');
    expect(aaa).toMatch(/\s-\s+-\s+0\s+rest/);
  });

  it('skips empty placeholders and .pretty.json debug artifacts', () => {
    const r = runList();
    expect(r.stdout).not.toContain('empty-placeholder');
    expect(r.stdout).not.toContain('pretty.json');
    expect(r.stdout).not.toContain('dddddddd');
  });

  it('points at insight import (UI dir scan; no cpx import subcommand)', () => {
    const r = runList();
    expect(r.stdout).toContain('Import Session');
    // 导入是 insight 的职责：cpx 不再提供 import 子命令
    expect(r.stdout).not.toContain('cpx import');
  });

  it('handles an empty capture dir gracefully', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-list-empty-'));
    try {
      const r = spawnSync('bash', [WRAPPER, 'list'], {
        encoding: 'utf-8',
        timeout: 60_000,
        env: { ...process.env, CONTEXT_PROXY_DIR: empty },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('no captures yet');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  }, 90_000);

  it('unknown subcommand falls through to agent spawn (no capture entries touched)', () => {
    const r = spawnSync('bash', [WRAPPER, 'definitely-not-a-command-xyz'], {
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, CONTEXT_PROXY_DIR: captureDir() },
    });
    // 非已知子命令 → 当作 agent 命令 spawn；本机无此命令 ENOENT，会话干净
    // 收尾（exit 0、零捕获），不影响已有捕获条目
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('ENOENT');
    expect(r.stderr).not.toContain('captures dir');
  }, 90_000);
});
