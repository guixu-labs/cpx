// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// Tab 补全（bash/zsh）：`cpx completion <shell>` 打印脚本，脚本把整行词表转给
// 隐藏命令 `cpx __complete <words...>`（末词 = 正在输入的词），候选逻辑全部
// 在 TS 内单一实现（跨 shell 一致、可测）；shell 侧只做转发。agent 命令之后
// 不补全——那是 agent 自己的参数域（opencode 有自己的补全），cpx 越界补反而
// 干扰；agent 域 TAB 静默（用户裁决：文件名兜底是噪音）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUBCOMMANDS = ['list', 'ls', 'status', 'upload', 'config', 'lfs-setup', 'completion'];
const AGENT_CMDS = ['claude', 'opencode', 'codex', 'cannbot'];
const PROFILES = ['claude', 'opencode', 'cannbot', 'codex', 'openai', 'generic'];
const TOP_FLAGS = ['--agent', '--autoupload', '--help', '--version', '-h', '-v'];
const UPLOAD_FLAGS = ['--submitter', '--category', '--desc', '--opgen', '--baseline'];
const VALUE_FLAGS = new Set(['--agent', '--submitter', '--desc', '--category', '--opgen']);

function captureDir(): string {
  return process.env.CANNBOT_PROXY_DIR ?? path.join(os.homedir(), '.cannbot-insight', 'proxy');
}

/** 捕获会话 sid 候选：明文/压缩同 stem 去重、非空、mtime 新 → 旧。 */
export function listCaptureSids(dir: string = captureDir()): string[] {
  const stems = new Map<string, number>();
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    const m = e.name.match(/^(?:cpx-)?([\w.-]+)\.jsonl(\.7z|\.gz)?$/);
    if (!m || !e.isFile()) continue;
    try {
      const st = fs.statSync(path.join(dir, e.name));
      if (st.size === 0) continue;
      const prev = stems.get(m[1]);
      if (prev === undefined || st.mtimeMs > prev) stems.set(m[1], st.mtimeMs);
    } catch { /* 竞态删除忽略 */ }
  }
  return [...stems.entries()].sort((a, b) => b[1] - a[1]).map(([sid]) => sid);
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

  // 值参数场景（--agent p<TAB> / --opgen s<TAB>）优先于上下文
  if (prev === '--agent') return filterByPrefix(PROFILES, cur);
  if (prev === '--opgen') return filterByPrefix(['success', 'failure'], cur);
  if (VALUE_FLAGS.has(prev)) return [];

  // 首词：子命令 + 常见 agent 命令 + 顶层保留参数（任意 agent 命令仍可用，
  // 只是未收录者无候选）
  if (isTop) {
    return filterByPrefix([...SUBCOMMANDS, ...AGENT_CMDS, ...TOP_FLAGS], cur);
  }

  if (SUBCOMMANDS.includes(first)) {
    if (first === 'status') return filterByPrefix(['--kill', '--all'], cur);
    if (first === 'config') {
      if (words[2] === 'dedup' || words[2] === 'lfs') return filterByPrefix(['on', 'off'], cur);
      return filterByPrefix(words.length <= 3 ? ['dedup', 'lfs'] : [], cur);
    }
    if (first === 'upload') {
      if (cur.startsWith('-')) return filterByPrefix(UPLOAD_FLAGS, cur);
      return filterByPrefix(listCaptureSids(), cur);
    }
    return [];
  }

  // 非子命令 → agent 命令域（含保留参数透传场景）：不补全（TAB 静默，
  // 文件名兜底按用户裁决移除）；顶层 --autoupload 等 flag 允许在 agent 前缀词上继续给候选
  if (cur.startsWith('-') && words.length <= 3) return filterByPrefix(['--autoupload', '--agent'], cur);
  return [];
}

export interface CompletionResult { code: number; message?: string }

function fastBundlePath(): string | null {
  // 补全热路径：postinstall 用 esbuild 预编译的微型 bundle（纯 node 直跑，
  // 免 tsx 运行时转换整个 CLI 导入图的 ~0.5s 税）。源码态在 src/cli/ 下，
  // bundle 态在 dist/ 下——两种上下文各探一次
  const candidates = [
    path.resolve(__dirname, '../../dist/cpx-complete.mjs'),
    path.resolve(__dirname, 'cpx-complete.mjs'),
  ];
   return candidates.find(p => fs.existsSync(p)) ?? null;
 }

function completionCall(bin: string): string {
  const fast = fastBundlePath();
  const words = '"${COMP_WORDS[@]}"';
  if (!fast) return `${bin} __complete ${words} 2>/dev/null`;
  return `if [ -f "${fast}" ]; then node "${fast}" __complete ${words} 2>/dev/null
  else ${bin} __complete ${words} 2>/dev/null; fi`;
}

/**
 * 补全函数体：静态上下文（首词/profile/on-off/flag 表）在生成时从上方常量
 * 灌入 bash，纯内建执行零进程（TAB ~0ms，node 冷启 130ms 只付给真正需要
 * fs 扫描的 sid 场景）；动态分支（upload 的 sid）才起 node
 * bundle。语义与 completeCandidates 逐上下文对齐（含 agent 域静默）。
 */
function completionBody(bin: string): string {
  const dyn = completionCall(bin);
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
      --opgen) words="success failure";;
      --submitter|--desc|--category) words="";;
      *)
        case "\$first" in
          status) words="--kill --all";;
          config)
            case "\${COMP_WORDS[2]}" in
              dedup|lfs) words="on off";;
              *) words="dedup lfs";;
            esac;;
          upload)
            case "\$cur" in
              -*) words="${UPLOAD_FLAGS.join(' ')}";;
              *) words="\$(${dyn})";;
            esac;;
          normalize) words="\$(${dyn})";;
          *)
            # agent 命令域静默；紧随其后的首个 flag 词仍给 cpx 保留 flag
            case "\$cur" in -*) [ "\$COMP_CWORD" -eq 2 ] && words="--autoupload --agent";; esac;;
        esac;;
    esac
  fi
  # 不改 IFS：compgen -W 按默认 IFS 切分（静态表空格分隔、动态 sid 换行
  # 分隔均正确，sid 不含空格）；改成仅换行切会把整张静态表当单个候选
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
  return `# cpx bash 补全：转发整行词表给补全引擎（末词 = 正在输入的词）
# 启用：eval "$(${bin} completion bash)"  或  ${bin} completion bash --install
`;
}

function zshHeader(bin: string): string {
  return `#compdef ${bin}
# cpx zsh 补全：bashcompinit 复用 bash 同款逻辑（候选仍由补全引擎产出）
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
