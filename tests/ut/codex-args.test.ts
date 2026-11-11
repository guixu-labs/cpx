// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex 隧道 -c 注入定位单测：子命令位注入（0.162 配置分层「替换而非合
// 并」——全局位 -c 在子命令位出现任何 -c 时被整组丢弃，隧道必须挂子命令
// 位）；Commands: 段解析（别名/描述折行）；TUI 与探测失败的 fail-safe。

import { describe, it, expect } from 'vitest';
import { parseCodexSubcommands, withCodexTunnel } from '../../src/cli/codex-args.ts';

// 真实 `codex --help`（0.162）Commands: 段节选：apply 的 [aliases: a] 在
// 描述折行里、exec 的 [aliases: e] 在条目行内——两种形态都要入集。
const HELP = `Codex CLI

Usage: codex [OPTIONS] [PROMPT]
       codex [OPTIONS] <COMMAND> [ARGS]

Commands:
  agents            Browse all agent sessions on the shared local app-server daemon
  exec              Run Codex non-interactively [aliases: e]
  review            Run a code review non-interactively
  apply             Apply the latest diff produced by Codex agent as a \`git apply\` to your local
                    working tree [aliases: a]
  resume            Resume a previous interactive session (picker by default; use --last to continue
                    the most recent)
  fork              Fork a previous interactive session (picker by default; use --last to fork the
                    most recent)

Options:
  -c, --config <key=value>
          Override a configuration value`;

const SUBS = parseCodexSubcommands(HELP)!;

describe('parseCodexSubcommands：Commands: 段解析', () => {
  it('解析子命令名 + 两种位置的别名（条目行内 / 描述折行里）', () => {
    expect(SUBS).not.toBeNull();
    for (const n of ['agents', 'exec', 'review', 'apply', 'resume', 'fork', 'e', 'a']) {
      expect(SUBS.has(n)).toBe(true);
    }
  });

  it('null / 无 Commands: 段 → null（fail-safe）', () => {
    expect(parseCodexSubcommands(null)).toBeNull();
    expect(parseCodexSubcommands('Usage: codex [OPTIONS]\n\nOptions:\n  -h')).toBeNull();
  });
});

describe('withCodexTunnel：注入定位', () => {
  const T = ['-c', 'model_providers.volcano.base_url="http://127.0.0.1:1/volcano/v1"', '-c', 'openai_base_url="http://127.0.0.1:1/v1"'];

  it('子命令开头 → 紧跟子命令 token 之后（用户 -c 之前，同层共存）', () => {
    expect(withCodexTunnel(['exec', '-c', 'sandbox_mode="workspace-write"', '任务'], T, SUBS))
      .toEqual(['exec', ...T, '-c', 'sandbox_mode="workspace-write"', '任务']);
  });

  it('别名子命令（codex e）同样定位', () => {
    expect(withCodexTunnel(['e', '任务'], T, SUBS)).toEqual(['e', ...T, '任务']);
  });

  it('resume/fork 等其他会话子命令同样定位', () => {
    expect(withCodexTunnel(['resume', '--last'], T, SUBS)).toEqual(['resume', ...T, '--last']);
    expect(withCodexTunnel(['fork', '--last'], T, SUBS)).toEqual(['fork', ...T, '--last']);
  });

  it('全局位带值 flag（-c/-p/-s/-m/-C）先于子命令 → 跳过其值后定位子命令', () => {
    expect(withCodexTunnel(['--profile', 'deepseek', 'exec', '任务'], T, SUBS))
      .toEqual(['--profile', 'deepseek', 'exec', ...T, '任务']);
    expect(withCodexTunnel(['-c', 'k="v"', 'exec', '任务'], T, SUBS))
      .toEqual(['-c', 'k="v"', 'exec', ...T, '任务']);
    expect(withCodexTunnel(['-s', 'workspace-write', 'exec', '任务'], T, SUBS))
      .toEqual(['-s', 'workspace-write', 'exec', ...T, '任务']);
    expect(withCodexTunnel(['-C', '/tmp/x', 'exec', '任务'], T, SUBS))
      .toEqual(['-C', '/tmp/x', 'exec', ...T, '任务']);
  });

  it('未知带值 flag 的值是非集合裸词 → 继续扫描仍能定位子命令', () => {
    expect(withCodexTunnel(['--future-flag', 'val', 'exec', '任务'], T, SUBS))
      .toEqual(['--future-flag', 'val', 'exec', ...T, '任务']);
  });

  it('嵌套子命令（codex exec resume）→ 定位第一个子命令', () => {
    expect(withCodexTunnel(['exec', 'resume', '--last'], T, SUBS))
      .toEqual(['exec', ...T, 'resume', '--last']);
  });

  it('TUI：无参 / 纯 flag / 根级位置 prompt → 全局位前置（无该坑）', () => {
    expect(withCodexTunnel([], T, SUBS)).toEqual([...T]);
    expect(withCodexTunnel(['--oss'], T, SUBS)).toEqual([...T, '--oss']);
    expect(withCodexTunnel(['你好'], T, SUBS)).toEqual([...T, '你好']);
  });

  it('子命令集合为 null（探测失败）→ 全局位兜底（行为等同修复前）', () => {
    expect(withCodexTunnel(['exec', '-c', 'sandbox_mode="workspace-write"', '任务'], T, null))
      .toEqual([...T, 'exec', '-c', 'sandbox_mode="workspace-write"', '任务']);
  });

  it('overrideArgs 为空 → 原样返回（不含 -c 注入）', () => {
    expect(withCodexTunnel(['exec', '任务'], [], SUBS)).toEqual(['exec', '任务']);
  });

  it('带值 flag 的值恰好是子命令名 → 被跳过不误定位（--profile exec 指名为 exec 的 profile）', () => {
    expect(withCodexTunnel(['--profile', 'exec', '任务'], T, SUBS))
      .toEqual([...T, '--profile', 'exec', '任务']);
  });
});
