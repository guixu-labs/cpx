// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex 捕获计划单测：argv -c 覆盖层解析（分层归并/四种形态/`--` 边界）、
// token 改写（位置与 flag 形态原样保留）、全字段自足注入、发现层合并
// （L1 config ∪ L2 argv，argv 胜）与注入层分支序。
// 层序依据（codex 0.169 实测）：E1 子命令位覆盖全局位、E2 同位后者胜；
// F1/F2 连写形态生效、F3 `--` 之后不按 flag 解析。
// #156 客户现场回归锚：harness 隔离 CODEX_HOME + -c 注入活跃 provider（带
// name）+ 宿主 config 有自建 provider——cpx 不得再为「子进程看不见的 provider」
// 注入 base_url-only 残缺条目（codex 0.169 加载校验崩溃），并须改道 argv 注入
// provider 的 base_url 到隧道。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexProviderTable, type CodexProviderTable } from '../../src/cli/codex-providers.ts';
import {
  parseCodexArgvOverrides,
  rewriteCodexArgvTunnels,
  buildCodexTunnelOverrides,
  discoverCodexCapture,
  applyCodexCapture,
} from '../../src/cli/codex-overrides.ts';
import { parseCodexSubcommands } from '../../src/cli/codex-args.ts';

const HELP = `Codex CLI

Usage: codex [OPTIONS] [PROMPT]
       codex [OPTIONS] <COMMAND> [ARGS]

Commands:
  exec              Run Codex non-interactively [aliases: e]
  resume            Resume a previous interactive session

Options:
  -c, --config <key=value>
          Override a configuration value`;
const SUBS = parseCodexSubcommands(HELP)!;

const PROXY = 'http://127.0.0.1:41234';

/** 临时 config.toml → 解析后的表（发现层注入用，绕开运行时缓存） */
function tableOf(toml: string | null): CodexProviderTable | null {
  if (toml === null) return null; // CODEX_HOME 隔离且无 config → null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-codex-ovr-'));
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, toml);
  return readCodexProviderTable(file);
}

describe('parseCodexArgvOverrides：argv 覆盖层解析', () => {
  it('四种 -c 形态全收：独立 token / 短连写 / --config 独立 / --config= 连写（实验 F1/F2）', () => {
    const argv = parseCodexArgvOverrides([
      'exec',
      '-c', 'model_providers.a.base_url="https://a.example.com/v1"',
      '-cmodel_providers.a.name="A"',
      '--config', 'model_providers.a.wire_api="responses"',
      '--config=model_providers.a.env_key=A_KEY',
      '--skip-git-repo-check', '任务',
    ], SUBS);
    expect(argv.providers['a']).toEqual({
      baseUrl: 'https://a.example.com/v1',
      name: 'A',
      wireApi: 'responses',
      envKey: 'A_KEY',
    });
  });

  it('分层归并（实验 E1/E2）：子命令位的同名键覆盖全局位、同位后者胜', () => {
    const argv = parseCodexArgvOverrides([
      '-c', 'model_providers.a.base_url="https://global.example.com/v1"',
      '-c', 'model_providers.a.base_url="https://global2.example.com/v1"',
      'exec',
      '-c', 'model_providers.a.base_url="https://sub.example.com/v1"',
      '任务',
    ], SUBS);
    expect(argv.providers['a'].baseUrl).toBe('https://sub.example.com/v1');
  });

  it('全局位声明、子命令位无覆盖 → 保留全局位值；顶层 openai_base_url / model_provider 收齐', () => {
    const argv = parseCodexArgvOverrides([
      '-c', 'openai_base_url="https://relay.example.com/v1"',
      '-c', 'model_provider=gw',
      'exec',
      '-c', "model_providers.gw.name='G W'",
      '任务',
    ], SUBS);
    expect(argv.openaiBaseUrl).toBe('https://relay.example.com/v1');
    expect(argv.modelProvider).toBe('gw');
    expect(argv.providers['gw'].name).toBe('G W');
  });

  it('`--` 之后不按 flag 解析（实验 F3）：prompt 里的 -c 形态不误收', () => {
    const argv = parseCodexArgvOverrides([
      'exec', '--skip-git-repo-check', '--', 'x', '-c', 'model_provider=probe',
    ], SUBS);
    expect(argv.modelProvider).toBeNull();
    expect(argv.tokens).toEqual([]);
  });

  it('引号形态归一：双引号/单引号/裸值都取到无引号值', () => {
    const argv = parseCodexArgvOverrides([
      'exec',
      '-c', 'model_providers.a.requires_openai_auth=true',
      '-c', 'model_providers.b.base_url=https://bare.example.com/v1',
      '任务',
    ], SUBS);
    expect(argv.providers['a'].requiresOpenaiAuth).toBe(true);
    expect(argv.providers['b'].baseUrl).toBe('https://bare.example.com/v1');
  });

  it('非可改写 key 不产 token；保留 id（v1/s）与非裸 id 不进 provider 表', () => {
    const argv = parseCodexArgvOverrides([
      'exec',
      '-c', 'sandbox_mode="workspace-write"',
      '-c', 'model_providers.v1.base_url="https://reserved.example.com"',
      '-c', 'model_providers.odd/id.base_url="https://odd.example.com"',
      '-c', 'model_providers.gw.base_url="https://gw.example.com/v1"',
      '任务',
    ], SUBS);
    expect(argv.tokens.map((t) => t.key)).toEqual(['model_providers.gw.base_url']);
    expect(argv.providers['v1']).toBeUndefined();
    expect(argv.providers['odd/id']).toBeUndefined();
    expect(argv.providers['gw'].baseUrl).toBe('https://gw.example.com/v1');
  });

  it('带值 flag 的独立值 token 跳过：--profile exec（值恰为子命令名）不误判', () => {
    const argv = parseCodexArgvOverrides([
      '--profile', 'exec',
      '-c', 'model_provider=gw',
      'resume', '--last',
    ], SUBS);
    expect(argv.modelProvider).toBe('gw');
  });

  it('subcommands=null（探测失败 fail-safe）：全量按 argv 序归并（无层序信息）', () => {
    const argv = parseCodexArgvOverrides([
      '-c', 'model_providers.a.base_url="https://x.example.com/v1"',
      'exec',
      '-c', 'model_providers.a.name="A"',
    ], null);
    expect(argv.providers['a'].baseUrl).toBe('https://x.example.com/v1');
    expect(argv.providers['a'].name).toBe('A');
  });

  it('-c 无值 token（末尾悬空）不越界、不误收', () => {
    const argv = parseCodexArgvOverrides(['exec', '-c'], SUBS);
    expect(argv.tokens).toEqual([]);
    expect(argv.providers).toEqual({});
  });
});

describe('rewriteCodexArgvTunnels：token 就地改写（改写优于竞争）', () => {
  it('base_url / openai_base_url token 改写为隧道；位置与 flag 形态原样保留；非目标 token 不动', () => {
    const args = [
      'exec',
      '-c', 'model_providers.gw.base_url="https://gw.example.com/api/v3/"',
      '-cmodel_providers.gw.name="GW"',
      '--config=openai_base_url="https://relay.example.com/v1"',
      '--skip-git-repo-check', '任务',
    ];
    const argv = parseCodexArgvOverrides(args, SUBS);
    const { args: out, upstreamOrigins } = rewriteCodexArgvTunnels(args, argv, PROXY);
    // 路径保真隧道 + 双引号包裹（独立值 token：flag 在 [1]，值在 [2]）
    expect(out[2]).toBe('model_providers.gw.base_url="http://127.0.0.1:41234/gw/api/v3"');
    // 连写形态与位置保留
    expect(out[3]).toBe('-cmodel_providers.gw.name="GW"');
    // --config= 连写形态保留
    expect(out[4]).toBe('--config=openai_base_url="http://127.0.0.1:41234/v1"');
    expect(upstreamOrigins).toEqual({ gw: 'https://gw.example.com' });
  });

  it('同 key 多 token（全局位 + 子命令位）一并改写为同一隧道值', () => {
    const args = [
      '-c', 'model_providers.gw.base_url="https://global.example.com/v1"',
      'exec',
      '-c', 'model_providers.gw.base_url="https://sub.example.com/v1"',
      '任务',
    ];
    const multi = parseCodexArgvOverrides(args, SUBS);
    const { args: out } = rewriteCodexArgvTunnels(args, multi, PROXY);
    expect(out[1]).toContain('http://127.0.0.1:41234/gw');
    expect(out[4]).toContain('http://127.0.0.1:41234/gw');
  });

  it('不可路由的 base_url 不改写（直连不捕获，绝不坏转发）', () => {
    const args = ['exec', '-c', 'model_providers.bad.base_url="::not-a-url::"', '任务'];
    const bad = parseCodexArgvOverrides(args, SUBS);
    const { args: out, upstreamOrigins } = rewriteCodexArgvTunnels(args, bad, PROXY);
    expect(out[2]).toBe('model_providers.bad.base_url="::not-a-url::"');
    expect(upstreamOrigins).toEqual({});
  });
});

describe('buildCodexTunnelOverrides：全字段自足注入（注入自足原则）', () => {
  it('每个 provider 回放全部已解析字段；name 必带（缺失 fallback id）；openai_base_url 兜底', () => {
    const table = tableOf(`
[model_providers.full]
name = "Full Gateway"
base_url = "https://full.example.com/v1"
env_key = "FULL_KEY"
wire_api = "responses"
requires_openai_auth = true

[model_providers.bare]
base_url = "https://bare.example.com"
`)!;
    expect(buildCodexTunnelOverrides(PROXY, table)).toEqual([
      'model_providers.full.base_url="http://127.0.0.1:41234/full/v1"',
      'model_providers.full.name="Full Gateway"',
      'model_providers.full.env_key="FULL_KEY"',
      'model_providers.full.wire_api="responses"',
      'model_providers.full.requires_openai_auth=true',
      'model_providers.bare.base_url="http://127.0.0.1:41234/bare"',
      'model_providers.bare.name="bare"',
      'openai_base_url="http://127.0.0.1:41234/v1"',
    ]);
  });
});

describe('discoverCodexCapture / applyCodexCapture：发现层合并与注入层分支', () => {
  it('#156 客户现场锚：CODEX_HOME 隔离（子进程 config 宇宙无 provider）+ argv 注入活跃 provider → 不注入 config 层条目，argv token 改道，活跃选择原样', () => {
    // 隔离场景：cpx 读隔离的 CODEX_HOME（表为空）——宿主 config 的自建
    // provider 不再进入子进程宇宙（修复前从操作员 ~/.codex 读出 zhipu/blue
    // 并注入 base_url-only → 子进程就地新建残缺条目 → 0.169 加载崩溃）。
    // harness 用 -c 注入完整条目（带 name——客户确认）。
    const agentArgs = [
      'exec', '--skip-git-repo-check', '--cd', '/opt/ws',
      '-c', 'model_providers.zhipu.name="Zhipu"',
      '-c', 'model_providers.zhipu.base_url="https://zhipu.example.com/api/v3"',
      '-c', 'model_providers.zhipu.env_key="ZHIPU_KEY"',
      '-c', 'model_providers.zhipu.wire_api="chat"',
      '-c', 'model_provider=zhipu',
      '--', '任务',
    ];
    const discovery = discoverCodexCapture(agentArgs, SUBS, tableOf(null));
    expect(discovery.table).toBeNull();
    expect(discovery.argvTunnelIds).toEqual(['zhipu']);
    expect(discovery.tunnelOrigins).toEqual({ zhipu: 'https://zhipu.example.com' });
    expect(discovery.modelProvider).toBe('zhipu');
    const args = applyCodexCapture({ proxyUrl: PROXY, agentArgs, subcommands: SUBS, discovery, hasOpenaiApiKey: false });
    const flat = args.join(' ');
    // 不注入任何 config 层条目（宇宙里没有它们）；不劫持活跃选择
    expect(flat).not.toContain('model_provider=cpx_proxy');
    expect(flat).not.toContain('model_providers.cpx_proxy');
    // 子命令位注入 openai_base_url 兜底
    expect(flat).toContain('openai_base_url="http://127.0.0.1:41234/v1"');
    // argv token 改道到隧道；harness 自己的其余 token 原样保留
    expect(args).toContain('model_providers.zhipu.base_url="http://127.0.0.1:41234/zhipu/api/v3"');
    expect(args).toContain('model_providers.zhipu.name="Zhipu"');
    expect(args).toContain('model_providers.zhipu.env_key="ZHIPU_KEY"');
    expect(args).toContain('model_providers.zhipu.wire_api="chat"');
    expect(args).toContain('model_provider=zhipu');
    // 注入位于子命令 token 之后（0.162 全局位丢弃坑的既有防御保持）
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('-c');
  });

  it('同作用域：config 层条目全字段自足注入（不依赖子进程合并基础——#156 崩溃机制的反证）', () => {
    const table = tableOf(`
[model_providers.volcano]
name = "Volcano Gateway"
base_url = "https://gw-example.example.com/v1"
env_key = "VOLCANO_KEY"
wire_api = "responses"
`)!;
    const agentArgs = ['exec', '任务'];
    const discovery = discoverCodexCapture(agentArgs, SUBS, table);
    expect(discovery.table?.providers['volcano']).toBeTruthy();
    const args = applyCodexCapture({ proxyUrl: PROXY, agentArgs, subcommands: SUBS, discovery, hasOpenaiApiKey: false });
    expect(args.join(' ')).toContain('model_providers.volcano.base_url="http://127.0.0.1:41234/volcano/v1"');
    // name/env_key/wire_api 全字段回放（注入自足：即使子进程无该条目，
    // 注入产物也独立通过 codex 0.169 的加载校验并保留鉴权语义）
    expect(args.join(' ')).toContain('model_providers.volcano.name="Volcano Gateway"');
    expect(args.join(' ')).toContain('model_providers.volcano.env_key="VOLCANO_KEY"');
    expect(args.join(' ')).toContain('model_providers.volcano.wire_api="responses"');
    expect(args.join(' ')).toContain('openai_base_url="http://127.0.0.1:41234/v1"');
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('-c');
  });

  it('L1 ∪ L2 同 id：argv 层 base_url 是 codex 真正会用的 → upstream 与改道均以 argv 为准', () => {
    const table = tableOf(`
[model_providers.gw]
name = "Config GW"
base_url = "https://config.example.com/v1"
`)!;
    const agentArgs = [
      'exec',
      '-c', 'model_providers.gw.base_url="https://argv.example.com/override/v1"',
      '任务',
    ];
    const discovery = discoverCodexCapture(agentArgs, SUBS, table);
    expect(discovery.tunnelOrigins['gw']).toBe('https://argv.example.com');
    const args = applyCodexCapture({ proxyUrl: PROXY, agentArgs, subcommands: SUBS, discovery, hasOpenaiApiKey: false });
    // config 层注入 base_url 隧道；argv token 同 key 也改道——两者一致
    expect(args).toContain('model_providers.gw.base_url="http://127.0.0.1:41234/gw/override/v1"');
  });

  it('纯 OpenAI 用户（无自定义 provider + OPENAI_API_KEY）→ cpx_proxy 合成条目（自带全字段）', () => {
    const agentArgs = ['exec', '任务'];
    const discovery = discoverCodexCapture(agentArgs, SUBS, tableOf(''));
    const args = applyCodexCapture({ proxyUrl: PROXY, agentArgs, subcommands: SUBS, discovery, hasOpenaiApiKey: true });
    const flat = args.join(' ');
    expect(flat).toContain('model_provider=cpx_proxy');
    expect(flat).toContain('model_providers.cpx_proxy.name="cpx-proxy"');
    expect(flat).toContain('model_providers.cpx_proxy.requires_openai_auth=false');
  });

  it('argv 声明了活跃 provider 时不得劫持（cpx 永不改活跃选择）：即使 OPENAI_API_KEY 在也不走 cpx_proxy', () => {
    const agentArgs = ['exec', '-c', 'model_provider=declared_only', '任务'];
    const discovery = discoverCodexCapture(agentArgs, SUBS, tableOf(null));
    const flat = applyCodexCapture({ proxyUrl: PROXY, agentArgs, subcommands: SUBS, discovery, hasOpenaiApiKey: true }).join(' ');
    expect(flat).not.toContain('model_provider=cpx_proxy');
    expect(flat).not.toContain('model_providers.cpx_proxy');
  });

  it('无表无 key（ChatGPT 登录）→ 仅 openai_base_url 覆盖；TUI 形态注入全局位', () => {
    const agentArgs: string[] = []; // TUI 无参
    const discovery = discoverCodexCapture(agentArgs, SUBS, tableOf(null));
    expect(applyCodexCapture({ proxyUrl: PROXY, agentArgs, subcommands: SUBS, discovery, hasOpenaiApiKey: false }))
      .toEqual(['-c', 'openai_base_url="http://127.0.0.1:41234/v1"']);
  });
});
