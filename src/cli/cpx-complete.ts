// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// Tab 补全（bash/zsh）：`cpx completion <shell>` 打印纯静态词表脚本（子命令
// /agent 命令/flag 表生成时灌入——零进程、零 node 依赖，TAB ~0ms）；隐藏
// 命令 `cpx __complete <words...>` 保留同一候选引擎（测试与脚本生成共用，
// 无动态补全场景）。agent 命令之后不补全——那是 agent 自己的参数域
// （opencode 有自己的补全），cpx 越界补反而干扰；agent 域 TAB 静默
// （用户裁决：文件名兜底是噪音）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUBCOMMANDS = ['list', 'ls', 'status', 'config', 'completion'];
const AGENT_CMDS = ['claude', 'opencode', 'codex', 'cannbot', 'dsh'];
const PROFILES = ['claude', 'opencode', 'cannbot', 'codex', 'dsh', 'openai', 'generic'];
const TOP_FLAGS = ['--agent', '--help', '--version', '-h', '-v'];
const VALUE_FLAGS = new Set(['--agent']);

/** 捕获目录（补全引擎展示/静态词表用）。 */
function captureDir(): string {
  return process.env.CONTEXT_PROXY_DIR ?? path.join(os.homedir(), '.context-insight', 'proxy');
}

function filterByPrefix(cands: string[], cur: string): string[] {
  return cur ? cands.filter(c => c.startsWith(cur)) : cands;
}

/**
 * 补全核心：words = 整行词表（words[0] = 'cpx'，末词 = 正在输入的当前词，
 * 可为空串）。返回候选（已按当前词前缀过滤）。
 */
export function completeCandidates(words: string[]): string[] {
  const cur = words[words.length - 1] ?? '';
  const prev = words.length >= 2 ? words[words.length - 2] : '';
  // words.length <= 2 时 words[1] 即正在输入的首词（补全态），不是已定格的
  // 子命令/agent 命令——首词上下文
  const isTop = words.length <= 2;
  const first = !isTop ? words[1] : '';

  // 值参数场景（--agent p<TAB>）优先于上下文
  if (prev === '--agent') return filterByPrefix(PROFILES, cur);
  if (VALUE_FLAGS.has(prev)) return [];

  // 首词：子命令 + 常见 agent 命令 + 顶层保留参数（任意 agent 命令仍可用，
  // 只是未收录者无候选）
  if (isTop) {
    return filterByPrefix([...SUBCOMMANDS, ...AGENT_CMDS, ...TOP_FLAGS], cur);
  }

  if (SUBCOMMANDS.includes(first)) {
    if (first === 'status') return filterByPrefix(['--kill', '--all'], cur);
    if (first === 'config') {
      if (words[2] === 'dedup') return filterByPrefix(['on', 'off'], cur);
      return filterByPrefix(words.length <= 3 ? ['dedup'] : [], cur);
    }
    return [];
  }

  // 非子命令 → agent 命令域（含保留参数透传场景）：不补全（TAB 静默，
  // 文件名兜底按用户裁决移除）；紧随 agent 之后的首个 flag 词仍给保留 flag
  if (cur.startsWith('-') && words.length <= 3) return filterByPrefix(['--agent'], cur);
  return [];
}

export interface CompletionResult { code: number; message?: string }

/**
 * 补全函数体：静态上下文（首词/profile/on-off/flag 表）在生成时从上方常量
 * 灌入 bash，纯内建执行零进程（TAB ~0ms，node 冷启 130ms 只付给真正需要
 * 子进程的场景）；语义与 completeCandidates 逐上下文对齐（含 agent 域静默）。
 */
function completionBody(bin: string): string {
  return `  local cur prev first words
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  first="\${COMP_WORDS[1]}"
  words=""
  if [ "\$COMP_CWORD" -le 1 ]; then
    words="${[...SUBCOMMANDS, ...AGENT_CMDS, ...TOP_FLAGS].join(' ')}"
  else
    case "\$prev" in
      --agent) words="${PROFILES.join(' ')}";;
      *)
        case "\$first" in
          status) words="--kill --all";;
          config)
            case "\${COMP_WORDS[2]}" in
              dedup) words="on off";;
              *) words="dedup";;
            esac;;
          *)
            # agent 命令域静默；紧随其后的首个 flag 词仍给 cpx 保留 flag
            case "\$cur" in -*) [ "\$COMP_CWORD" -eq 2 ] && words="--agent";; esac;;
        esac;;
    esac
  fi
  # 不改 IFS：compgen -W 按默认 IFS 切分（静态表空格分隔）；改成仅换行切
  # 会把整张静态表当单个候选
  COMPREPLY=( \$(compgen -W "\$words" -- "\$cur") )`;
}

export function bashScript(bin = 'cpx'): string {
  return `${bashHeader(bin)}_cpx() {
${completionBody(bin)}
}
complete -F _cpx ${bin}
`;
}

export function zshScript(bin = 'cpx'): string {
  return `${zshHeader(bin)}_cpx() {
${completionBody(bin)}
}
complete -F _cpx ${bin}
`;
}

function bashHeader(bin: string): string {
  return `# cpx bash 补全：纯静态词表（子命令/agent/flag），无动态分支
# 启用：eval "$(${bin} completion bash)"  或  ${bin} completion bash --install
`;
}

function zshHeader(bin: string): string {
  return `#compdef ${bin}
# cpx zsh 补全：bashcompinit 复用 bash 同款静态逻辑
# 启用：eval "$(${bin} completion zsh)"  或  ${bin} completion zsh --install
autoload -U +X bashcompinit && bashcompinit
`;
}

export interface CompletionResult { code: number; message?: string }

/** `cpx completion [bash|zsh] [--install]`：打印/安装补全脚本。 */
export function runCompletion(argv: string[], out = console.log, err = console.error): CompletionResult {
  const shell = argv[0] ?? 'bash';
  const install = argv.includes('--install');
  const bin = 'cpx';
  let script: string;
  let target: string;
  if (shell === 'bash') { script = bashScript(bin); target = path.join(os.homedir(), '.local', 'share', 'bash-completion', 'completions', 'cpx'); }
  else if (shell === 'zsh') { script = zshScript(bin); target = path.join(os.homedir(), '.zfunc', '_cpx'); }
  else {
    err(`不支持的 shell: "${shell}"（当前支持 bash / zsh）`);
    return { code: 2 };
  }
  if (install) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, script);
    out(`已安装 → ${target}`);
    if (shell === 'bash') {
      out('新开终端生效（bash-completion 自动加载该目录）');
    } else {
      // fpath 幂等入 rc：已含 ~/.zfunc 跳过；compinit 缺失才补（发行版 zshrc 常已带）
      const zshrc = path.join(os.homedir(), '.zshrc');
      try {
        const cur = fs.existsSync(zshrc) ? fs.readFileSync(zshrc, 'utf8') : '';
        if (!cur.includes('.zfunc')) {
          fs.appendFileSync(zshrc, '\n# cpx completion\nfpath=(~/.zfunc $fpath)\n');
        }
        if (!cur.includes('compinit')) {
          fs.appendFileSync(zshrc, 'autoload -Uz compinit && compinit\n');
        }
      } catch { /* rc 不可写仅提示 */ }
      out('~/.zshrc 已确保 fpath 含 ~/.zfunc（幂等），新开终端生效');
    }
    return { code: 0 };
  }
  out(script.trimEnd());
  err(`\n启用：eval "$(cpx completion ${shell})"（写入 shell rc 持久化）或 cpx completion ${shell} --install`);
  return { code: 0 };
}

/** 补全引擎独立入口：bundle 态（dist/cpx-complete.mjs）与 cpx 分发共用。 */
export function runCompleteMain(argv: string[]): number {
  if (argv[0] === '__complete') {
    for (const c of completeCandidates(argv.slice(1))) console.log(c);
    return 0;
  }
  if (argv[0] === 'completion') return runCompletion(argv.slice(1)).code;
  console.error('用法: cpx-complete __complete <words...> | completion [bash|zsh] [--install]');
  return 2;
}
