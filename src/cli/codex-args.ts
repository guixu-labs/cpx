// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex 启动参数的隧道 -c 注入定位 —— 纯函数模块（cpx-cli.ts 顶层执行
// main()，UT 无法直接 import；与 child-env.ts / codex-providers.ts 同款拆分）。
//
// 背景（codex 0.162 实测钉死，2026-11-11 死端口探测 + RUST_LOG=debug）：
// `codex exec` 内部经 in-process app-server 建会话（rpc thread/start），其
// 配置分层是「替换而非合并」——只要子命令位（exec/resume/… token 之后）
// 出现任何 -c（用户自带的 sandbox_mode / approval_policy 等，与取值无关），
// 全局位（子命令之前）的 -c 整组被丢弃：cpx 注入的 base_url 隧道静默失
// 效、请求直连真 upstream、捕获零落盘（[cpx-cli] no capture file
// produced）。与常驻 app-server daemon 无关（in-process 通道，连接级监视
// 证实零 proxy 流量）。
//
// 修法：隧道 -c 注入到与用户 -c 同层的「子命令位」——子命令 token 之后
// （死端口对照实测：同层按键覆盖、任意顺序共存）。无子命令（TUI：无参/
// 纯 flag/根级位置 prompt）不存在该坑，维持全局位前置。子命令集合由
// cpx-cli 运行时探测 `codex --help` 的 Commands: 段（parseCodexSubcommands，
// 含 [aliases: e] 与描述折行）；探测失败 → 传 null → 回退全局位
// （fail-safe，行为等同修复前——宁可不捕获，不打坏启动）。

// 根级带值 flag（值是独立 token，扫描子命令时须连带跳过）。清单来自 codex
// 0.162 `codex --help` 的 Options 段。未来新增未知带值 flag 时，仅「值恰
// 好逐字等于子命令名」的病态场景才会误判（正常值如 deepseek /
// workspace-write 均被「非集合裸词继续扫描」规则兜住）。
const CODEX_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-c', '--config',
  '--enable', '--disable',
  '--remote', '--remote-auth-token-env',
  '-i', '--image',
  '-m', '--model',
  '--local-provider',
  '-p', '--profile',
  '-s', '--sandbox',
  '-C', '--cd',
  '--add-dir',
  '-a', '--ask-for-approval',
]);

// `codex --help` 的 Commands: 段解析（opencode 的 parseSubcommandNames 管
// SUBCOMMANDS 段，两者格式不同，故不复用）。条目行「缩进名 + 2+ 空格 +
// 描述」，描述折行（续行）并入当前条目，[aliases: a, b] 的别名逐个入集
// （用户可 `codex e` 走 exec 别名）。解析不出（无段/零条目）返回 null——
// 调用方据此回退全局位注入（fail-safe）。
export function parseCodexSubcommands(help: string | null): ReadonlySet<string> | null {
  if (!help) return null;
  const lines = help.split('\n');
  const idx = lines.findIndex((l) => l.trim() === 'Commands:');
  if (idx < 0) return null;
  const names = new Set<string>();
  let desc = '';
  const flushAliases = () => {
    const m = desc.match(/\[aliases:\s*([^\]]+)\]/);
    if (m) for (const a of m[1].split(/[\s,]+/)) if (a) names.add(a);
  };
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue; // 段内空行：忽略（不终止）
    if (!line.startsWith(' ')) break; // 顶格 = 下一节（Options: 等）
    const m = line.match(/^\s{2,}([\w][\w,-]*)\s{2,}(.*)$/);
    if (m) {
      flushAliases();
      names.add(m[1]);
      desc = m[2] ?? '';
    } else if (/^\s{4,}/.test(line)) {
      desc += ` ${line.trim()}`; // 描述折行 → 并入当前条目（apply 的 [aliases: a] 就在折行里）
    }
  }
  flushAliases();
  return names.size > 0 ? names : null;
}

// 隧道 -c 的注入定位。返回完整 agent 启动参数（含隧道）：
//   无子命令（TUI / 探测失败 fail-safe）→ 全局位（最前）
//   有子命令 → 子命令 token 之后（与用户自己的子命令位 -c 同层共存，
//             用户仍可按 key 覆盖隧道，隧道不再被整组丢弃）
export function withCodexTunnel(
  agentArgs: readonly string[],
  overrideArgs: readonly string[],
  subcommands: ReadonlySet<string> | null,
): string[] {
  const tunnel = [...overrideArgs];
  if (tunnel.length === 0) return [...agentArgs];
  if (subcommands === null) return [...tunnel, ...agentArgs];
  for (let i = 0; i < agentArgs.length; i++) {
    const t = agentArgs[i];
    if (t.startsWith('-')) {
      if (CODEX_VALUE_FLAGS.has(t)) i += 1; // 跳过带值 flag 的独立值 token
      continue;
    }
    if (!subcommands.has(t)) continue; // 非集合裸词（TUI prompt / 未知 flag 的值）→ 继续扫
    return [...agentArgs.slice(0, i + 1), ...tunnel, ...agentArgs.slice(i + 1)];
  }
  return [...tunnel, ...agentArgs];
}
