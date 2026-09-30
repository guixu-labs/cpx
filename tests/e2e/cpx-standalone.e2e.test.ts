// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// `cpx opencode` 2.x --standalone 隔离注入 IT（ses_f13dcb27 捕获失败根因回归）：
// opencode 2.x 客户端-服务端架构下，TUI 经 service.json 连接常驻共享后台服务，
// LLM 调用由服务进程发出——不在 cpx 子进程树内，读不到注入的
// OPENCODE_CONFIG_CONTENT → 流量直连上游、捕获 0 字节。修复：探测到
// --standalone（help 定义行）后注入，让客户端改用私有服务。
// 假 agent 模拟二进制能力面（不真跑 opencode，help fixture 复刻 2.0.18 真实
// 形态），端到端断言最终 spawn 的 argv 与注入内容：
//   ① 2.x TUI（无参）→ --standalone 前置；注入原语不变（回归）
//   ② 2.x 子命令 run → 紧跟子命令后（实测 2.0.18：前置于 run 报
//      Unrecognized flag，位置敏感是本修复的核心约束）
//   ③ 2.x serve 子命令：help 仅有 --print-logs 描述里的行中提及
//      "(server logs require --standalone)"——朴素包含匹配会误判为支持，
//      必须行首锚定定义行；此处断言不注入
//   ④ 2.x 根 flag（-s continue）→ 前置
//   ⑤ 2.x 目录位置参数 → 前置
//   ⑥ 1.x 形态（无该 flag）→ 不注入（未知 flag 令其打 help 退出零捕获）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROXY_ROOT = path.resolve(__dirname, '../../');
const WRAPPER = path.join(PROXY_ROOT, 'cpx-cli');

let TMP: string;
let CFG: string;
let DATA: string;
let CACHE: string;
let CAPTURES: string;
let HELP_V2: string; // 2.x 形态 help fixture 目录
let HELP_V1: string; // 1.x 形态 help fixture 目录
let AGENT_V2: string;
let AGENT_V1: string;

// 复刻 opencode 2.0.18 help：--standalone 为"定义行"（行首缩进起），
// --print-logs 描述中的 "(server logs require --standalone)" 为"行中提及"。
const ROOT_HELP = [
  'USAGE',
  '  opencode <subcommand> [flags] [<directory>]',
  '',
  'FLAGS',
  '  --standalone            Run with a private server instead of the background service',
  '  --print-logs            Print logs to stderr (server logs require --standalone)',
  '',
  'SUBCOMMANDS',
  '  run                Run OpenCode with a message',
  '  serve              Start the v2 API and web server',
  '',
].join('\n');
const RUN_HELP = [
  'USAGE',
  '  opencode run [flags] [<message...>]',
  '',
  'FLAGS',
  '  --standalone            Run with a private server instead of the background service',
  '  --print-logs            Print logs to stderr (server logs require --standalone)',
  '',
].join('\n');
// serve：无 --standalone 定义行，只有 --print-logs 描述的行中提及（陷阱）
const SERVE_HELP = [
  'USAGE',
  '  opencode serve [flags]',
  '',
  'FLAGS',
  '  --hostname       Hostname for the server',
  '  --port           Port for the server',
  '  --print-logs     Print logs to stderr (server logs require --standalone)',
  '',
].join('\n');
// 1.x：没有 --standalone，也没有 SUBCOMMANDS 段
const ROOT_HELP_V1 = [
  'USAGE',
  '  opencode [flags] [<directory>]',
  '',
  'FLAGS',
  '  --auto           Update to the newest version',
  '',
].join('\n');

// 假 agent：按 cpx 的探测协议应答（`--help` / `<sub> --help`），正式调用时
// 落盘注入 env 与完整 argv（断言对象）。FAKE_AGENT_DUMP 经 cpx env 透传。
function writeAgentScript(file: string, helpDir: string): void {
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `HELP_DIR='${helpDir}'`,
    'if [ "$1" = "--help" ]; then cat "$HELP_DIR/root.txt"; exit 0; fi',
    'if [ "$2" = "--help" ]; then cat "$HELP_DIR/$1.txt" 2>/dev/null; exit 0; fi',
    `printf '%s\\n' "$@" > "\${FAKE_AGENT_DUMP}.argv"`,
    'printenv OPENCODE_CONFIG_CONTENT > "${FAKE_AGENT_DUMP}.injected"',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
}

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-standalone-it-'));
  CFG = path.join(TMP, 'config');
  DATA = path.join(TMP, 'data');
  CACHE = path.join(TMP, 'cache');
  CAPTURES = path.join(TMP, 'captures');
  // 缓存目录钉死到空夹具：不读开发机真实的 ~/.cache/opencode（确定性，
  // 与另两个 opencode e2e 同款纪律）
  fs.mkdirSync(CACHE, { recursive: true });
  // 用户配置：自定义 gateway provider（自定义 provider 捕获 IT 同款形态）
  fs.mkdirSync(path.join(CFG, 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(CFG, 'opencode', 'opencode.jsonc'), [
    '{',
    '  // 私有 AI 网关（自定义 provider）',
    '  "provider": {',
    '    "gateway": {',
    '      "npm": "@ai-sdk/openai-compatible",',
    '      "options": {',
    '        "baseURL": "https://private-gw.example.com/v1",',
    '        "apiKey": "test-key-1234567890"',
    '      },',
    '      "models": { "model-a1": { "name": "Model A1" } }',
    '    }',
    '  }',
    '}',
  ].join('\n'));
  fs.mkdirSync(path.join(DATA, 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'opencode', 'auth.json'), JSON.stringify({ 'example-cn': { type: 'api', key: 'k' } }));
  HELP_V2 = path.join(TMP, 'help-v2');
  fs.mkdirSync(HELP_V2, { recursive: true });
  fs.writeFileSync(path.join(HELP_V2, 'root.txt'), ROOT_HELP);
  fs.writeFileSync(path.join(HELP_V2, 'run.txt'), RUN_HELP);
  fs.writeFileSync(path.join(HELP_V2, 'serve.txt'), SERVE_HELP);
  HELP_V1 = path.join(TMP, 'help-v1');
  fs.mkdirSync(HELP_V1, { recursive: true });
  fs.writeFileSync(path.join(HELP_V1, 'root.txt'), ROOT_HELP_V1);
  AGENT_V2 = path.join(TMP, 'fake-agent-v2');
  AGENT_V1 = path.join(TMP, 'fake-agent-v1');
  writeAgentScript(AGENT_V2, HELP_V2);
  writeAgentScript(AGENT_V1, HELP_V1);
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function runCpx(agent: string, agentArgs: string[], dump: string) {
  return spawnSync('bash', [WRAPPER, '--agent', 'opencode', '--', agent, ...agentArgs], {
    encoding: 'utf-8',
    timeout: 120_000,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: CFG,
      XDG_DATA_HOME: DATA,
      XDG_CACHE_HOME: CACHE,
      CANNBOT_PROXY_DIR: CAPTURES,
      // 钉死不可达：探测必败 → 不机会主义导入开发机在跑的真 insight、不开浏览器
      CANNBOT_CPX_INSIGHT_BASE: 'http://127.0.0.1:1',
      FAKE_AGENT_DUMP: dump,
    },
  });
}

function readArgv(dump: string): string[] {
  return fs.readFileSync(`${dump}.argv`, 'utf-8').split('\n').filter((l) => l !== '');
}

// 拦截原语回归：OPENCODE_CONFIG_CONTENT 注入结构不变（provider baseURL →
// 本机代理 /<providerId>/ 前缀路由）
function assertInjectionIntact(dump: string): void {
  const injected = JSON.parse(fs.readFileSync(`${dump}.injected`, 'utf-8'));
  expect(injected?.provider?.gateway?.options?.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/gateway\/$/);
  expect(injected?.provider?.['example-cn']?.options?.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/example-cn\/$/);
}

describe('cpx opencode --standalone 特性探测注入（2.x 捕获回归 IT）', () => {
  it('① 2.x TUI（无参）：--standalone 前置；注入原语不变', () => {
    const dump = `${TMP}/d1`;
    const r = runCpx(AGENT_V2, [], dump);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, `cpx output:\n${out}`).toBe(0);
    expect(readArgv(dump)).toEqual(['--standalone']);
    assertInjectionIntact(dump);
    expect(out).toContain('--standalone 已注入');
  }, 120_000);

  it('② 2.x 子命令 run：--standalone 紧跟子命令后（位置敏感约束）', () => {
    const dump = `${TMP}/d2`;
    const r = runCpx(AGENT_V2, ['run', 'hello world'], dump);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, `cpx output:\n${out}`).toBe(0);
    // 前置于 run（['--standalone', 'run', …]）实测报 Unrecognized flag——断言
    // 最终 argv 的插入位置正确
    expect(readArgv(dump)).toEqual(['run', '--standalone', 'hello world']);
    assertInjectionIntact(dump);
  }, 120_000);

  it('③ 2.x serve（仅行中提及、无定义行）：不注入——朴素包含匹配的陷阱', () => {
    const dump = `${TMP}/d3`;
    const r = runCpx(AGENT_V2, ['serve', '--port', '1234'], dump);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, `cpx output:\n${out}`).toBe(0);
    expect(readArgv(dump)).toEqual(['serve', '--port', '1234']);
    assertInjectionIntact(dump);
    expect(out).toContain('未注入');
  }, 120_000);

  it('④ 2.x 根 flag（-s continue）：前置', () => {
    const dump = `${TMP}/d4`;
    const r = runCpx(AGENT_V2, ['-s', 'ses_abc123'], dump);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, `cpx output:\n${out}`).toBe(0);
    expect(readArgv(dump)).toEqual(['--standalone', '-s', 'ses_abc123']);
    assertInjectionIntact(dump);
  }, 120_000);

  it('⑤ 2.x 目录位置参数（非子命令）：前置', () => {
    const dump = `${TMP}/d5`;
    const r = runCpx(AGENT_V2, ['/tmp/some-project'], dump);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, `cpx output:\n${out}`).toBe(0);
    expect(readArgv(dump)).toEqual(['--standalone', '/tmp/some-project']);
    assertInjectionIntact(dump);
  }, 120_000);

  it('⑥ 1.x 形态（无该 flag）：不注入（TUI 与子命令两形态）', () => {
    const dumpA = `${TMP}/d6a`;
    const ra = runCpx(AGENT_V1, [], dumpA);
    const outA = `${ra.stdout}\n${ra.stderr}`;
    expect(ra.status, `cpx output:\n${outA}`).toBe(0);
    expect(readArgv(dumpA)).toEqual([]);
    assertInjectionIntact(dumpA);
    expect(outA).toContain('未注入');

    const dumpB = `${TMP}/d6b`;
    const rb = runCpx(AGENT_V1, ['run', 'hello'], dumpB);
    const outB = `${rb.stdout}\n${rb.stderr}`;
    expect(rb.status, `cpx output:\n${outB}`).toBe(0);
    expect(readArgv(dumpB)).toEqual(['run', 'hello']);
    assertInjectionIntact(dumpB);
  }, 120_000);

  it('⑦ 用户已显式传入 --standalone：原样返回不重复注入', () => {
    const dumpA = `${TMP}/d7a`;
    const ra = runCpx(AGENT_V2, ['--standalone'], dumpA);
    const outA = `${ra.stdout}\n${ra.stderr}`;
    expect(ra.status, `cpx output:\n${outA}`).toBe(0);
    expect(readArgv(dumpA)).toEqual(['--standalone']);
    assertInjectionIntact(dumpA);

    const dumpB = `${TMP}/d7b`;
    const rb = runCpx(AGENT_V2, ['run', '--standalone', 'hello'], dumpB);
    const outB = `${rb.stdout}\n${rb.stderr}`;
    expect(rb.status, `cpx output:\n${outB}`).toBe(0);
    expect(readArgv(dumpB)).toEqual(['run', '--standalone', 'hello']);
    assertInjectionIntact(dumpB);
  }, 120_000);
});
