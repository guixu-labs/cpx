// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// `cpx codex` 配置作用域失配 IT（客户现场 issue #156 回归）：
// harness 给子 codex 隔离 CODEX_HOME、活跃 provider 靠 `-c` 注入（带
// name），操作员宿主 ~/.codex/config.toml 另有自建 provider（zhipu/blue）。
// 修复前 cpx 硬编码读操作员 ~/.codex → 给子进程「看不见」的 provider 注入
// base_url-only 覆盖 → codex 0.169 加载期就地新建无 name 残缺条目 → 崩溃。
// 端到端验证（经仓内 cpx-cli wrapper 起真 CLI + 真 proxy server，agent 用假
// codex 脚本把最终 argv 落盘，不真跑 codex）：
//   ① 隔离场景（CODEX_HOME ≠ 宿主 home）：宿主 config 的 provider 不注入
//      （宇宙外）；argv -c 的 base_url token 被改写为隧道（路径保真）；
//      name/env_key/wire_api/model_provider 等用户 token 原样保留；
//      openai_base_url 兜底注入在子命令位
//   ② 启动日志：argv 层改道与活跃 provider 声明可见（排障第一线索）
//   ③ 同作用域场景（无 CODEX_HOME）：config 层条目全字段自足注入
//      （name/env_key/wire_api 全回放——不依赖子进程合并基础）
//   ④ 无流量 → 占位捕获清理，退出码 0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { runCpx as harnessRunCpx } from './harness/session';

let sandbox: Sandbox;
let HOST_CODEX: string;     // 操作员宿主 ~/.codex（cpx 修复前的错误读取面）
let ISOLATED_CODEX: string; // harness 隔离的 CODEX_HOME（子进程真实宇宙）
let AGENT: string;          // 假 codex（--help 吐 codex 形态；正式调用落盘 argv）
let DUMP: string;           // 假 agent 落盘的最终 argv（每行一个 token）

const CODEX_HELP = [
  'Codex CLI',
  '',
  'Usage: codex [OPTIONS] [PROMPT]',
  '       codex [OPTIONS] <COMMAND> [ARGS]',
  '',
  'Commands:',
  '  exec              Run Codex non-interactively [aliases: e]',
  '  resume            Resume a previous interactive session',
  '',
  'Options:',
  '  -c, --config <key=value>',
  '          Override a configuration value',
].join('\n');

beforeAll(() => {
  sandbox = createSandbox('cpx-codex-scope-it-');
  HOST_CODEX = path.join(sandbox.home, '.codex');
  ISOLATED_CODEX = path.join(sandbox.root, 'isolated-codex-home');
  // 宿主 config：两个自建 provider（客户现场形态——zhipu/blue 网关）
  fs.mkdirSync(HOST_CODEX, { recursive: true });
  fs.writeFileSync(path.join(HOST_CODEX, 'config.toml'), [
    '[model_providers.zhipu]',
    'name = "Zhipu Bigmodel"',
    'base_url = "https://open.bigmodel.cn/api/paas/v4"',
    'env_key = "ZHIPU_API_KEY"',
    'wire_api = "chat"',
    '',
    '[model_providers.blue]',
    'name = "Blue Gateway"',
    'base_url = "https://blue.example.com/api/v3"',
    '',
  ].join('\n'));
  // 隔离 CODEX_HOME：空宇宙（harness 自管 provider 注入，config 里没有）
  fs.mkdirSync(ISOLATED_CODEX, { recursive: true });
  // 假 codex：--help 吐 Commands: 段（probeHelp → parseCodexSubcommands）；
  // 正式调用把最终 argv 逐 token 落盘（引号形态原样——改写断言的关键面）
  DUMP = path.join(sandbox.root, 'codex-argv.txt');
  AGENT = path.join(sandbox.bin, 'fake-codex');
  const script = [
    '#!/bin/sh',
    'if [ "${1:-}" = "--help" ]; then',
    "  cat <<'HELP'",
    CODEX_HELP,
    'HELP',
    '  exit 0',
    'fi',
    `: > '${DUMP}'`,
    `for a in "$@"; do printf '%s\\n' "$a" >> '${DUMP}'; done`,
    'exit 0',
  ].join('\n');
  fs.writeFileSync(AGENT, script);
  fs.chmodSync(AGENT, 0o755);
});

afterAll(() => {
  sandbox.cleanup();
});

function readDump(): string[] {
  return fs.readFileSync(DUMP, 'utf-8').split('\n').filter((l) => l !== '');
}

/** harness 形态的子进程调用：-c 注入完整 provider 条目（带 name——客户确认） */
function harnessAgentArgs(): string[] {
  return [
    'exec', '--skip-git-repo-check', '--cd', '/opt/ws',
    '-c', 'model_providers.zhipu.name="Zhipu"',
    '-c', 'model_providers.zhipu.base_url="https://zhipu-relay.example.com/api/v3"',
    '-c', 'model_providers.zhipu.env_key="ZHIPU_KEY"',
    '-c', 'model_providers.zhipu.wire_api="chat"',
    '-c', 'model_provider=zhipu',
    '--', '任务描述',
  ];
}

function runCpx(extraEnv: Record<string, string | undefined>, agentArgs: string[]) {
  return harnessRunCpx(sandbox, ['--agent', 'codex', '--', AGENT, ...agentArgs], { env: extraEnv });
}

describe('cpx codex 配置作用域失配（issue #156 客户现场回归 IT）', () => {
  it('①②④ 隔离 CODEX_HOME + argv -c provider：宿主条目不注入；argv token 改道隧道；活跃选择原样；干净退出', async () => {
    const r = await runCpx({ CODEX_HOME: ISOLATED_CODEX }, harnessAgentArgs());
    const out = r.output;
    expect(r.code, `cpx output:\n${out}`).toBe(0);

    const args = readDump();
    const flat = args.join('\n');

    // 修复锚①：宿主 config 的 provider 不注入（子进程宇宙里没有它们——
    // 修复前从操作员 ~/.codex 读出并注入 base_url-only 残缺条目 → 0.169 崩溃）。
    // zhipu 只剩 harness 自己的（已改写的）argv token——无 config 层注入副本
    expect(flat).not.toContain('model_providers.blue');
    const zhipuTokens = args.filter((a) => a.startsWith('model_providers.zhipu.base_url='));
    expect(zhipuTokens, `zhipu base_url tokens:\n${zhipuTokens.join('\n')}`).toHaveLength(1);

    // 修复锚②：argv -c 的 base_url token 被改写为隧道（路径保真 + 双引号）
    expect(zhipuTokens[0]).toMatch(
      /^model_providers\.zhipu\.base_url="http:\/\/127\.0\.0\.1:\d+\/zhipu\/api\/v3"$/,
    );

    // 修复锚③：harness 的其余 token 原样保留（cpx 不动用户语义与活跃选择）
    for (const expected of [
      'model_providers.zhipu.name="Zhipu"',
      'model_providers.zhipu.env_key="ZHIPU_KEY"',
      'model_providers.zhipu.wire_api="chat"',
      'model_provider=zhipu',
      '--skip-git-repo-check',
      '--cd',
      '/opt/ws',
      '任务描述',
    ]) {
      expect(args).toContain(expected);
    }
    // openai_base_url 兜底注入在子命令位（exec 之后、用户 token 之前）
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('-c');
    expect(args[2]).toMatch(/^openai_base_url="http:\/\/127\.0\.0\.1:\d+\/v1"$/);

    // ② 启动日志：作用域与改道可见（排障第一线索）
    expect(out).toContain('codex config:');
    expect(out).toContain('no custom [model_providers]');
    expect(out).toContain('codex argv -c providers (rewritten to tunnel): zhipu');
    expect(out).toContain('codex active provider (argv): zhipu');

    // ④ 无流量 → 占位捕获被清理
    const leftovers = fs.existsSync(sandbox.captures)
      ? fs.readdirSync(sandbox.captures).filter(f => f.endsWith('.jsonl') || f.endsWith('.sids'))
      : [];
    expect(leftovers).toEqual([]);
  }, 120_000);

  it('③ 同作用域（无 CODEX_HOME 隔离）：config 层条目全字段自足注入', async () => {
    const r = await runCpx({ CODEX_HOME: undefined }, ['exec', '任务']);
    const out = r.output;
    expect(r.code, `cpx output:\n${out}`).toBe(0);

    const args = readDump();
    const flat = args.join('\n');
    // 两个宿主 provider 的隧道全字段注入（name/env_key/wire_api 尽收尽回放，
    // blue 无 env_key/wire_api 则不回放——解析不到的不臆造）
    expect(flat).toContain('model_providers.zhipu.name="Zhipu Bigmodel"');
    expect(flat).toContain('model_providers.zhipu.env_key="ZHIPU_API_KEY"');
    expect(flat).toContain('model_providers.zhipu.wire_api="chat"');
    expect(flat).toContain('model_providers.blue.name="Blue Gateway"');
    expect(flat).not.toContain('model_providers.blue.env_key=');
    expect(flat).not.toContain('model_providers.blue.wire_api=');
    // 隧道 base_url（路径保真：宿主 path 各自保留）
    expect(flat).toMatch(/model_providers\.zhipu\.base_url="http:\/\/127\.0\.0\.1:\d+\/zhipu\/api\/paas\/v4"/);
    expect(flat).toMatch(/model_providers\.blue\.base_url="http:\/\/127\.0\.0\.1:\d+\/blue\/api\/v3"/);
    // openai_base_url 兜底（中途切回内置 openai 的流量也可捕获）
    expect(flat).toMatch(/openai_base_url="http:\/\/127\.0\.0\.1:\d+\/v1"/);
    // 注入在子命令位
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('-c');
    // 启动日志：config 层隧道可见
    expect(out).toContain('2 provider tunnel(s)');
  }, 120_000);
});
