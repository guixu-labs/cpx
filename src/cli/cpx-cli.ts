// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { sessionFilePath, sidsFilePath, resolveCapturePath, compressCaptureFile, readCaptureText, sessionMetaPath } from '../writer.ts';
import { VERSION, VERSION_DISPLAY } from '../version.ts';
import { redactString } from '../redactor.ts';
import { parseOpencodeProvider, readAuthProvidersFromFile, readCustomProvidersFromRoots, resolveProviderIds, opencodeConfigRoots, readModelsDevUpstreams } from './opencode-providers';
import { resolveTsxLoader } from './tsx-launcher';
import { parseArgs } from './cpx-args';
import { runCompleteMain } from './cpx-complete';
import { dropSessionScratch, sweepLeakedPlaceholders } from './cpx-scratch';
import { findProxyProcs, dedupePairs, isOrphanedProc, type ProxyProc } from './proxy-procs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROXY_PKG = path.resolve(__dirname, '..', '..');
const PROXY_SERVER = path.join(PROXY_PKG, 'src', 'server.ts');
const TSX_LOADER = resolveTsxLoader(__filename);
const PROXY_DIR = process.env.CANNBOT_PROXY_DIR ?? path.join(os.homedir(), '.cannbot-insight', 'proxy');
const CPX_CONFIG_FILE = path.join(path.dirname(PROXY_DIR), 'cpx-config.json');

interface CpxConfig {
  /** 注入压缩：记录 jsonl 时把重复的注册表/skills 注入替换为 [已压缩] 标记。默认关闭。 */
  dedupInjection: boolean;
}

function loadCpxConfig(): CpxConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CPX_CONFIG_FILE, 'utf-8'));
    return { dedupInjection: raw.dedupInjection === true };
  } catch {
    return { dedupInjection: false };
  }
}

function saveCpxConfig(cfg: CpxConfig): void {
  fs.mkdirSync(path.dirname(CPX_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CPX_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

function runConfig(args: string[]): void {
  const cfg = loadCpxConfig();
  if (args[0] === 'dedup' && (args[1] === 'on' || args[1] === 'off')) {
    cfg.dedupInjection = args[1] === 'on';
    saveCpxConfig(cfg);
    console.log(`dedup injection : ${cfg.dedupInjection ? 'on' : 'off'}  (已写入 ${CPX_CONFIG_FILE})`);
    return;
  }
  if (args.length === 0) {
    console.log(`config file     : ${CPX_CONFIG_FILE}`);
    console.log(`dedup injection : ${cfg.dedupInjection ? 'on' : 'off'}   (cpx config dedup on|off 切换，热生效；压缩仅作用于捕获记录，不改动转发)`);
    return;
  }
  console.error('用法: cpx config [dedup on|off]');
  process.exit(2);
}
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const INSIGHT_PORT = 21025;
// 环境可覆写（IT 用 mock insight 走完整链路；不影响默认行为）
const INSIGHT_BASE = process.env.CANNBOT_CPX_INSIGHT_BASE ?? `http://localhost:${INSIGHT_PORT}`;

const USAGE = `cpx ${VERSION_DISPLAY} — agent↔模型明文捕获代理编排器

用法：
  cpx <agent-cmd> [args...]              例: cpx claude / cpx codex / cpx cannbot
  cpx --agent <claude|opencode|cannbot|codex|openai|generic> -- <cmd> [args]
  cpx list                              列出全部捕获会话文件（按时间降序，只读）
  cpx status [--kill [--all]]            查看状态；--kill 清理孤儿 proxy（父进程已死的泄漏实例），--all 连活跃会话一起清
  cpx config [dedup on|off]              查看/配置注入压缩（默认 off，热生效，只压缩捕获记录不改转发）
  cpx completion [bash|zsh] [--install]  打印/安装 Tab 补全脚本（agent 命令之后不越界）
  cpx --version | -v                     版本号 + 生效代码路径（多仓共存时确认当前副本）
  cpx --help | -h                        本帮助

cpx 保留参数（被 cpx 拦截消费，不透传 agent）：--agent 及若干历史保留 flag；
其余参数原样转发。

在原有 claude / opencode 命令前加 cpx，其他使用完全无变化。捕获无需 insight：
agent 退出后自动压缩归档；insight 在运行则自动导入并开浏览器，否则保留捕获
（\`cpx list\` 查看，导入走 insight：Web UI「Import Session → JSONL」选
\`~/.cannbot-insight/proxy/\` 目录）。安装：./proxy/install.sh（独立）或根
目录 ./start.sh（一体化，内部调用前者）。`;

type AgentProfile = 'claude' | 'opencode' | 'cannbot' | 'codex' | 'openai' | 'generic';

function log(msg: string): void { console.error(`[cpx-cli] ${msg}`); }

interface ClaudeSettings {
  upstream: string;
  apiKey: string | null;
  model: string | null;
}

function readClaudeSettings(): ClaudeSettings {
  const fallback: ClaudeSettings = {
    upstream: 'https://api.anthropic.com',
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    model: process.env.ANTHROPIC_MODEL ?? null,
  };
  try {
    const raw = fs.readFileSync(CLAUDE_SETTINGS, 'utf-8');
    const env = (JSON.parse(raw).env ?? {}) as Record<string, string>;
    return {
      upstream: env.ANTHROPIC_BASE_URL ?? fallback.upstream,
      apiKey: env.ANTHROPIC_API_KEY ?? fallback.apiKey,
      model: env.ANTHROPIC_MODEL ?? fallback.model,
    };
  } catch {
    return fallback;
  }
}


// Fast single-shot probe (localhost connection-refused is instant) — used to
// decide opportunistic import at capture exit and for the startup info line.
// Never starts insight: capture must work standalone.
async function insightUp(): Promise<boolean> {
  try {
    const r = await fetch(`${INSIGHT_BASE}/api/observe/data?pageSize=1`, { signal: AbortSignal.timeout(1500) });
    return r.ok || r.status < 500;
  } catch { return false; }
}

interface SessionProxy {
  port: number;
  child: ChildProcess;
  stop: () => void;
}

function startSessionProxy(sid: string, anthropicUpstream: string, openaiUpstream: string, providerUpstreams: Record<string, string>): Promise<SessionProxy> {
  fs.mkdirSync(PROXY_DIR, { recursive: true });
  // 会话代理以 node --import <tsx loader> 起 TS 源码：loader 从本文件位置标准
  // 解析（bin/cpx.mjs 同款纪律——npm i -g 嵌套 / 用户项目安装 hoist 提升两布局
  // 都命中，不再硬编码 <pkg>/node_modules/.bin/tsx——hoist 布局下该路径不存在，
  // 回落 npx 会从 registry 现场下载 tsx，网络依赖且慢）；解析失败才回落 npx。
  return new Promise((resolve, reject) => {
    const child = spawn(
      TSX_LOADER ? process.execPath : 'npx',
      TSX_LOADER ? ['--import', TSX_LOADER, PROXY_SERVER] : ['tsx', PROXY_SERVER],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: PROXY_PKG,
        detached: true,
        env: {
          ...process.env,
          CANNBOT_PROXY_PORT: '0',
          CANNBOT_PROXY_SESSION_ID: sid,
          CANNBOT_PROXY_ANTHROPIC_UPSTREAM: anthropicUpstream,
          CANNBOT_PROXY_OPENAI_UPSTREAM: openaiUpstream,
          CANNBOT_PROXY_PROVIDER_UPSTREAMS: JSON.stringify(providerUpstreams),
        },
      });
    let port = 0;
    const onPort = (p: number) => {
      if (port || !p) return;
      port = p;
      const stop = () => { try { child.kill('SIGTERM') ; } catch { /* */ } };
      resolve({ port, child, stop });
    };
    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString();
      const m = s.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) onPort(parseInt(m[1]));
    });
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
    const timer = setTimeout(() => {
      if (!port) reject(new Error('cannbot-proxy did not report a port within 30s'));
    }, 30000);
    child.on('exit', () => { clearTimeout(timer); if (!port) reject(new Error('cannbot-proxy exited before reporting a port')); });
  });
}

interface LaunchPlan {
  env: Record<string, string>;
  // 完整 agent 启动参数（含 agentArgs）。原 extraArgs 前缀模型改为全量：
  // opencode 2.x 的 --standalone 必须按"子命令前/后"位置插入，前缀模型装不下。
  args: string[];
}

// opencode stores provider credentials in auth.json (XDG data dir). Its keys
// are the provider ids opencode knows (alibaba-cn, zhipuai-coding-plan, ...).
// opencode's provider baseURLs are BUILT-IN to the binary — not in auth.json,
// not in opencode.json — so the only way to redirect opencode to the proxy is
// OPENCODE_CONFIG_CONTENT, and cpx must know which provider id(s) to override.
// 自定义 provider（用户 opencode.json[c] provider 段，如私有 AI 网关）的
// 发现/upstream 解析在 opencode-providers.ts（纯函数模块）。
function opencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? path.join(xdg, 'opencode') : path.join(os.homedir(), '.local', 'share', 'opencode');
}

// opencode 缓存目录（XDG 感知）：1.x 时代 models.dev catalog 的扁平缓存
// （models.json）落在这里；2.x 改存 opencode.db 的 kv 表，但新旧版本混装
// 的机器上该文件仍可能存在且新鲜（readModelsDevUpstreams 的第三来源）。
function opencodeCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg ? path.join(xdg, 'opencode') : path.join(os.homedir(), '.cache', 'opencode');
}

// 收集 opencode 的可调用 provider 候选（模块级缓存：auth.json / 用户配置
// 在 cpx 单次运行生命周期内不变）：
//   auth   = auth.json 的 provider keys（官方凭据存储）
//   custom = 用户 opencode.json[c] 的自定义 provider（id → 真实上游 baseURL，
//            客户现场 ses_fa840cd30ffe：gateway/glm-5.3 只在配置里定义，
//            auth.json 看不见 → 修复前整个会话直连 volceapi、捕获 0 字节）
function collectOpencodeProviders(): { auth: string[]; custom: Record<string, string> } {
  if (!collectedProviders) {
    collectedProviders = {
      auth: readAuthProvidersFromFile(path.join(opencodeDataDir(), 'auth.json')),
      custom: readCustomProvidersFromRoots(opencodeConfigRoots()),
    };
  }
  return collectedProviders;
}
let collectedProviders: { auth: string[]; custom: Record<string, string> } | null = null;

// Resolve the provider ids to override via OPENCODE_CONFIG_CONTENT:
// -m <provider>/<model> → just that one (precise); otherwise:
//   auth.json keys ∪ 用户配置自定义 provider keys（交互式 `cpx opencode`
//   不知道运行时选哪个模型，可调用的一并重定向）
//   cannbot → 再并入内建 cannbot provider（默认模型走它）
// Empty = misconfiguration（仅 opencode 可能；cannbot 恒含内建项）。
function resolveProviderIdsFor(profile: AgentProfile, agentArgs: string[]): string[] {
  const { auth, custom } = collectOpencodeProviders();
  return resolveProviderIds({
    // 调用点只在 opencode/cannbot 分支进来；其余 profile 不达此处
    profile: profile === 'cannbot' ? 'cannbot' : 'opencode',
    agentArgs,
    authProviders: auth,
    customProviders: custom,
  });
}

// claude 原生转录：~/.claude/projects/<cwd-slug>/<session-id>.jsonl。捕获
// sid 即 claude 的真实 session id（header 路由），文件名精确同名；slug
// 规则 = cwd 非字母数字全部转 '-'（claude-code 约定）。候选不存在时全
// projects 目录扫一遍兜底（agent 内部切换过 cwd 的场景）。
function claudeNativeLogPath(sid: string): string | null {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const slug = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
  const candidate = path.join(base, slug, `${sid}.jsonl`);
  if (fs.existsSync(candidate)) return candidate;
  try {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, `${sid}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* */ }
  return null;
}

// opencode ≥1.17 会话统一存单一 sqlite（opencode.db），无 per-session
// 转录文件；运行日志在 log/ 下。
function opencodeNativePaths(): string {
  const dir = opencodeDataDir();
  return `${path.join(dir, 'opencode.db')} · ${path.join(dir, 'log', 'opencode.log')}`;
}

// Resolve the opencode binary path (follow symlinks to the real .exe). opencode
// is on PATH (cpx spawns it as `opencode`); we need the real file to scan for
// built-in provider baseURLs. Returns null if not resolvable.
function opencodeBinaryPath(): string | null {
  try {
    const r = spawnSync('sh', ['-c', 'command -v opencode'], { encoding: 'utf-8' });
    const p = (r.stdout || '').trim();
    if (!p || !fs.existsSync(p)) return null;
    return fs.realpathSync(p);
  } catch { return null; }
}

// cannbot 内建 provider 的网关上游解析链（docs/CANNBOT-DESIGN.md §5.1）：
//   ① 用户全局 config 的 provider.cannbot.options.baseURL（/connect 写入；
//     私有化网关部署可自助改，cannbot/opencode 两个 config 根都尝试）
//   ② 兜底 = 二进制代码常量（strings 双处验证，公网网关稳定 URL）
const CANNBOT_GATEWAY_FALLBACK = 'https://cannbot.hicann.cn/gateway/compatible-mode/v1';

function cannbotGatewayUpstream(): string {
  // 与自定义 provider 同一读取链（readCustomProvidersFromRoots：双根 +
  // .json/.jsonc 双形态）——jsonc 注释不再直接 parse 失败走兜底
  return collectOpencodeProviders().custom['cannbot'] ?? CANNBOT_GATEWAY_FALLBACK;
}

// Resolve each provider's real upstream baseURL by scanning the opencode
// binary with `strings`. opencode's provider registry embeds, per provider:
//   id:"<pid>",env:[...],npm:"...",api:"<baseURL>"
// The api URL is the OpenAI-compatible base opencode would call WITHOUT the
// proxy. This is READ from the user's own installed binary (not fabricated),
// so cpx can forward to the correct upstream per provider — fully transparent,
// no CANNBOT_PROXY_OPENAI_UPSTREAM env needed for known providers. Returns
// {providerId: baseURL} for the requested ids that were found in the binary.
// cannbot 的内建 cannbot provider 是代码常量、不在注册表形态里 → 二进制扫描
// 必然 miss，改走 cannbotGatewayUpstream() 解析链。
// 自定义 provider（用户 opencode.json[c] 定义）不在二进制里 → upstream 从
// 配置本体读（collectOpencodeProviders().custom），且配置优先于二进制扫描
// 结果 —— 与 opencode 自身配置优先级一致（用户配置覆盖内建 provider 默认）。
function discoverProviderUpstreams(providerIds: string[]): Record<string, string> {
  const bin = opencodeBinaryPath();
  const custom = collectOpencodeProviders().custom;
  const out: Record<string, string> = {};
  if (providerIds.includes('cannbot')) out['cannbot'] = cannbotGatewayUpstream();
  if (bin && providerIds.length > 0) {
    // One `strings` pass (~1s for a 167MB binary); grep -o extracts every
    // provider block as its own line, then we pair id↔api per line.
    const quotedBin = `'${bin.replace(/'/g, `'\\''`)}'`;
    const r = spawnSync('sh', ['-c',
      `strings -n 8 ${quotedBin} | grep -oaE 'id:"[^"]*",env:\\[[^]]*\\],npm:"[^"]*",api:"[^"]*"'`,
    ], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    const all: Record<string, string> = {};
    for (const line of (r.stdout || '').split('\n')) {
      const idM = line.match(/id:"([^"]+)"/);
      const apiM = line.match(/api:"([^"]+)"/);
      if (idM && apiM) all[idM[1]] = apiM[1];
    }
    for (const id of providerIds) if (all[id]) out[id] = all[id];
  }
  // opencode 2.x：内建 provider 注册表移出二进制（上面的 strings 扫描必
  // miss），从 models.dev catalog 的磁盘缓存补齐（opencode.db kv → raw
  // 扫描 → legacy models.json，详见 opencode-providers.ts）。1.x 不受影响
  // （strings 已命中，catalog 只补缺；二进制才是被 spawn 的权威源，先到先得）。
  const missing = providerIds.filter((id) => !out[id]);
  if (missing.length > 0) {
    const catalog = readModelsDevUpstreams({ dataDir: opencodeDataDir(), cacheDir: opencodeCacheDir() });
    if (catalog) for (const id of missing) if (catalog[id]) out[id] = catalog[id];
  }
  // 自定义 provider 的 upstream 从配置本体叠加（配置优先于二进制结果）
  for (const id of providerIds) if (custom[id]) out[id] = custom[id];
  return out;
}

// ── opencode 2.x 客户端-服务端架构隔离（--standalone 特性探测）──
//
// opencode 2.x 起 TUI 只是客户端：默认经 ~/.local/state/opencode/service.json
// 发现并连接常驻的共享后台服务，LLM 调用由服务进程发出——它不在 cpx 的子
// 进程树内，读不到注入的 OPENCODE_CONFIG_CONTENT，流量直连上游、捕获 0 字节
// （实测 ses_f13dcb27：会话落入共享服务的数据根，cpx 代理零流量）。只有本机
// 恰无热服务时才碰巧走"客户端自建服务"的继承路径，故 2.x 上几乎必然失败。
// --standalone 让客户端改用随自身进程树起的私有服务（serve 引导实测：数据根
// 跟随进程 env），注入恢复生效；退出干净，且不写 service.json（不劫持共享
// 服务的注册，实测确认）。
//
// 1.x（及未跟进该架构的 fork）不认识此 flag，未知 flag 会让 opencode 打印
// help 直接退出（零捕获，见 cpx-args.ts 的先例注释）——必须探测后追加，
// 绝不无条件注入；探测失败一律视为"不支持"（方向安全：退化为 1.x 现状）。
//
// flag 位置敏感（opencode 解析器按位置归属 flag，实测 2.0.18）：
//   opencode --standalone / --standalone <dir>   ✓ 根位置（TUI 默认命令）
//   opencode run --standalone …                  ✓ 子命令后
//   opencode --standalone run …                  ✗ Unrecognized flag
//
// help 判定必须用行首锚定的定义行（^\s*--standalone\b）：每个子命令的
// --print-logs 描述都提到 "(server logs require --standalone)"，朴素包含
// 匹配会把 serve/auth/session 误判为支持（实测仅 root/run/mini/api/models
// 真支持）。
// 行首锚定的定义行判定：只允许行内缩进（[ \t] 不跨行），且 flag 名后不能
// 跟字词/连字符（防 --standalone-mode 之类误命中）。
const STANDALONE_FLAG_RE = /^[ \t]*--standalone(?![\w-])/m;
const HELP_PROBE_TIMEOUT_MS = 15_000;

const rootHelpCache = new Map<string, string | null>();
const subHelpCache = new Map<string, string | null>();

// <agentCmd> [args…] --help 的探测结果（按进程缓存）。失败/非零退出 → null。
function probeHelp(agentCmd: string, args: string[], cache: Map<string, string | null>, cacheKey: string): string | null {
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;
  let text: string | null = null;
  try {
    const r = spawnSync(agentCmd, [...args, '--help'], { encoding: 'utf-8', timeout: HELP_PROBE_TIMEOUT_MS });
    if (r.status === 0) text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  } catch { text = null; }
  cache.set(cacheKey, text);
  return text;
}

// help 的 SUBCOMMANDS 段解析（"  run    Run OpenCode with a message" →
// {"run"}；"  upgrade, update    …" 的别名逐个入集）。缩进但不匹配的行视为
// 描述折行跳过，顶格行（下一节标题）终止。解析不出（无该段/零条目）返回
// null——调用方据此放弃注入（宁可不捕获，不打坏启动）。
function parseSubcommandNames(help: string | null): Set<string> | null {
  if (!help) return null;
  const lines = help.split('\n');
  const idx = lines.findIndex((l) => l.trim() === 'SUBCOMMANDS');
  if (idx < 0) return null;
  const names = new Set<string>();
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (!line.startsWith(' ')) break; // 顶格 = 下一节（GLOBAL FLAGS 等）
    const m = line.match(/^\s+([\w][\w,-]*(?:,\s*[\w][\w,-]*)*)\s{2,}/);
    if (!m) continue; // 缩进但不匹配 = 描述折行
    for (const n of m[1].split(/\s*,\s*/)) names.add(n);
  }
  return names.size > 0 ? names : null;
}

// opencode 系启动参数的 --standalone 注入。返回完整的最终 agentArgs：
//   空参 / 根 flag 开头（-s/--continue…）→ TUI 默认命令，根位置前置
//   子命令开头（run/mini…）→ 紧跟子命令后插入；该子命令不支持则不注入
//   目录位置参数 → 根位置前置（实测 flag 先于位置参数可解析）
//   子命令集合解析不出 → 一律不注入（fail-safe）
function withStandalone(agentCmd: string, agentArgs: string[]): string[] {
  // 用户已显式传入该 flag：原样返回（不重复注入，启动日志的"已注入"判断
  // 也以 args 是否含该 flag 为准，语义保持真值）
  if (agentArgs.includes('--standalone')) return agentArgs;
  const rootHelp = probeHelp(agentCmd, [], rootHelpCache, agentCmd);
  const rootSupported = rootHelp !== null && STANDALONE_FLAG_RE.test(rootHelp);
  const first = agentArgs[0];
  if (first === undefined || first.startsWith('-')) {
    return rootSupported ? ['--standalone', ...agentArgs] : agentArgs;
  }
  const subcommands = parseSubcommandNames(rootHelp);
  if (subcommands === null) return agentArgs;
  if (!subcommands.has(first)) {
    return rootSupported ? ['--standalone', ...agentArgs] : agentArgs;
  }
  const subHelp = probeHelp(agentCmd, [first], subHelpCache, `${agentCmd}\0${first}`);
  return subHelp !== null && STANDALONE_FLAG_RE.test(subHelp)
    ? [first, '--standalone', ...agentArgs.slice(1)]
    : agentArgs;
}

function buildLaunch(profile: AgentProfile, proxyPort: number, claude: ClaudeSettings, agentArgs: string[] = [], agentCmd = ''): LaunchPlan {
  // Per-session port: no sid encoded in URL path. The proxy pins sid via env,
  // so base_url is a clean host (survives SDK URL normalization).
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  switch (profile) {
    case 'claude': {
      // Process-scoped override via `claude --settings`. Does NOT touch
      // ~/.claude/settings.json — when this process exits, the override is gone,
      // so a subsequent plain `claude` is unaffected even if cpx-cli crashes.
      const settingsEnv: Record<string, string> = {
        ANTHROPIC_BASE_URL: proxyUrl,
      };
      if (claude.apiKey) settingsEnv.ANTHROPIC_API_KEY = claude.apiKey;
      if (claude.model) settingsEnv.ANTHROPIC_MODEL = claude.model;
      return {
        env: {},
        args: ['--settings', JSON.stringify({ env: settingsEnv }), ...agentArgs],
      };
    }
    case 'opencode':
    case 'cannbot': {
      // Process-scoped override via OPENCODE_CONFIG_CONTENT (inline runtime
      // config, precedence tier 6 — above project/global config). Symmetric to
      // claude's `--settings`: only this process is affected, exit = clean,
      // ~/.config/opencode/ is never touched.
      //
      // opencode's provider baseURLs are BUILT-IN (e.g. alibaba-cn → dashscope),
      // NOT read from OPENAI_BASE_URL — verified via `opencode debug config`.
      // So we override baseURL per provider via OPENCODE_CONFIG_CONTENT.
      // cannbot（opencode 系 fork，docs/CANNBOT-DESIGN.md）机制相同：内建 cannbot
      // provider + auth.json 项一并覆盖。
      //
      // Per-provider path-prefix routing: baseURL is set to
      // http://<proxy>/<providerId>/ (trailing slash). opencode/ai-sdk appends
      // the model path AFTER the baseURL's path (verified: yields
      // POST /<providerId>/chat/completions), so the prefix survives SDK URL
      // normalization and the proxy routes each request to that provider's real
      // upstream (discovered from the opencode binary). This is fully
      // transparent — no CANNBOT_PROXY_OPENAI_UPSTREAM needed — and supports
      // multiple providers with different upstreams in one session.
      // Caller validates the list is non-empty before starting the proxy
      // (cannbot 恒非空：内建 cannbot 项保底).
      const providerIds = resolveProviderIdsFor(profile, agentArgs);
      const provider: Record<string, { options: { baseURL: string } }> = {};
      for (const id of providerIds) provider[id] = { options: { baseURL: `${proxyUrl}/${id}/` } };
      // 2.x 必须 --standalone（私有服务）才能让上面的注入落到真正发 LLM 调用
      // 的进程上；1.x 无此 flag，探测后按位置规则注入（见 withStandalone）。
      return { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider }) }, args: withStandalone(agentCmd, agentArgs) };
    }
    case 'codex': {
      // codex 有两种 auth：ChatGPT 登录（~/.codex/auth.json，默认）或 API key。
      // 有 API key → 创建自定义 provider（requires_openai_auth=false，env_key 走
      // API key）；无 API key → 仅覆盖 openai_base_url，保留内置 openai provider
      // 的 ChatGPT 登录 auth。codex 在 base_url 后追加 /responses，所以 base_url
      // 需带 /v1 后缀 → codex 发 POST /v1/responses，proxy 按路径分发。
      if (process.env.OPENAI_API_KEY) {
        const overrides = [
          'model_provider=cpx_proxy',
          'model_providers.cpx_proxy.name="cpx-proxy"',
          `model_providers.cpx_proxy.base_url="${proxyUrl}/v1"`,
          'model_providers.cpx_proxy.env_key="OPENAI_API_KEY"',
          'model_providers.cpx_proxy.wire_api="responses"',
          'model_providers.cpx_proxy.requires_openai_auth=false',
        ].flatMap((o) => ['-c', o]);
        return { env: {}, args: [...overrides, ...agentArgs] };
      }
      // ChatGPT 登录用户：仅覆盖 base_url，不碰 auth
      return { env: {}, args: ['-c', `openai_base_url="${proxyUrl}/v1"`, ...agentArgs] };
    }
    case 'openai':
    case 'generic':
      return { env: { OPENAI_BASE_URL: proxyUrl }, args: agentArgs };
  }
}

function openBrowser(url: string): void {
  // 测试环境熔断（结构性防弹窗）：vitest worker 及其全部子进程（wrapper →
  // agent）继承 VITEST env；显式 kill-switch 优先。PATH 桩方案对 WSL 的
  // cmd.exe 分支结构性无效（绝对路径 exec，PATH 拦不住——实测 autoupload
  // e2e 三场景真弹浏览器，2026-09-22）
  if (process.env.CANNBOT_NO_BROWSER || process.env.VITEST) return;
  try {
    if (fs.existsSync('/proc/version') && fs.readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft')
        && fs.existsSync('/mnt/c/Windows/System32/cmd.exe')) {
      spawnSync('/mnt/c/Windows/System32/cmd.exe', ['/c', 'start', url], { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      spawnSync('open', [url], { stdio: 'ignore' });
    } else {
      spawnSync('xdg-open', [url], { stdio: 'ignore' });
    }
  } catch { /* best-effort */ }
}

async function triggerIngest(sid: string, jsonlPath: string): Promise<{ imported: boolean; query: string | null } | null> {
  try {
    const r = await fetch(`${INSIGHT_BASE}/api/ingest/import-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'claude-jsonl', sessionId: sid, filePath: jsonlPath }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) { log(`ingest failed: HTTP ${r.status} ${await r.text()}`); return null; }
    return (await r.json()) as { imported: boolean; query: string | null };
  } catch (e) {
    log(`ingest error: ${String(e)}`);
    return null;
  }
}

async function probeUrl(url: string, ms: number): Promise<boolean> {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok || r.status < 500; } catch { return false; }
}

function fmtAge(s: number | null): string {
  if (s == null || !Number.isFinite(s)) return '-';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// SIGTERM first, grace period, then SIGKILL stragglers.
async function killProcs(pids: number[]): Promise<void> {
  for (const pid of pids) { if (isAlive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch { /* */ } } }
  await new Promise(r => setTimeout(r, 1500));
  for (const pid of pids) { if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } }
}

function fmtSize(b: number): string {
  if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1048576).toFixed(1)}MB`;
}

async function runStatus(opts: { kill?: boolean; all?: boolean } = {}): Promise<void> {
  const proxies = dedupePairs(findProxyProcs());
  const insightUp = await probeUrl(`${INSIGHT_BASE}/api/observe/data?pageSize=1`, 1500);

  console.log(`cannbot-insight : ${insightUp ? `up   ${INSIGHT_BASE}` : 'down (capture runs without it; import via insight Web UI)'}`);
  console.log(`proxy processes : ${proxies.length} running${proxies.length === 0 ? '  (none — proxy only lives during a cpx run)' : ''}`);
  for (const p of proxies) {
    const stale = isOrphanedProc(p, isAlive) ? '  [stale: orphaned (parent gone)]' : '';
    console.log(`  pid ${p.pid}  port ${p.port ?? '-'}  age ${fmtAge(p.ageSec)}${stale}`);
    console.log(`    sid ${p.sid ?? '-'}  upstream ${p.upstream ?? '-'}`);
  }

  if (opts.kill) {
    // env 标记模型下 sid 恒非空：孤儿 = 父进程已死（cpx-cli 退出后泄漏的
    // proxy，重挂 init）——见 proxy-procs.ts isOrphanedProc
    const targets = opts.all ? proxies : proxies.filter(p => isOrphanedProc(p, isAlive));
    const spared = proxies.length - targets.length;
    if (!targets.length) {
      console.log(`\nkill: nothing to ${opts.all ? 'kill (no proxy procs)' : 'kill (no stale orphans)'}`);
    } else {
      const label = opts.all ? 'proxy process(es)' : 'stale orphan(s)';
      console.log(`\nkill: terminating ${targets.length} ${label} (spared ${spared} live session(s)) ...`);
      await killProcs(targets.map(t => t.pid));
      const remaining = dedupePairs(findProxyProcs());
      console.log(`  done. ${remaining.length} still running.`);
    }
  }

  console.log(`captures dir    : ${PROXY_DIR}`);
  console.log(`dedup injection : ${loadCpxConfig().dedupInjection ? 'on' : 'off'}  (cpx config dedup on|off)`);
  let caps: { f: string; size: number; mt: number }[] = [];
  try {
    caps = fs.readdirSync(PROXY_DIR)
      .filter(f => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz') || f.endsWith('.jsonl.7z'))
      .map(f => { try { const st = fs.statSync(path.join(PROXY_DIR, f)); return st.size === 0 ? null : { f, size: st.size, mt: st.mtimeMs }; } catch { return null; } })
      .filter((x): x is { f: string; size: number; mt: number } => !!x)
      .sort((a, b) => b.mt - a.mt)
      .slice(0, 8);
  } catch { console.log('  (dir missing)'); }
  if (caps.length) {
    const now = Date.now() / 1000;
    console.log('recent captures :');
    let savedTotal = 0;
    let dedupTotal = 0;
    for (const c of caps) {
      const { savedChars, dedupedCount } = dedupStats(path.join(PROXY_DIR, c.f));
      savedTotal += savedChars;
      dedupTotal += dedupedCount;
      const ratio = savedChars / (c.size + savedChars);
      const comp = dedupedCount > 0
        ? `  dedup ×${dedupedCount}  压缩率 ${(ratio * 100).toFixed(1)}%`
        : '';
      console.log(`  ${c.f}   ${fmtSize(c.size).padStart(9)}   ${fmtAge(now - c.mt / 1000)} ago${comp}`);
    }
    if (dedupTotal > 0) {
      const allSize = caps.reduce((s, c) => s + c.size, 0);
      console.log(`  注入去重合计    : ${dedupTotal} 份重复注入已压缩，节省约 ${fmtSize(savedTotal)}（压缩率 ${(savedTotal / (allSize + savedTotal) * 100).toFixed(1)}%）`);
    }
  }
}

// Sum dedup marker lines in a capture: {deduped:true, originalChars} lines
// record how much repeated injection content was replaced by a marker.
function dedupStats(file: string): { savedChars: number; dedupedCount: number } {
  let savedChars = 0;
  let dedupedCount = 0;
  try {
    const raw = readCaptureText(file).split('\n');
    for (const line of raw) {
      if (!line.includes('"deduped":true')) continue;
      try {
        const j = JSON.parse(line);
        if (j.deduped === true && typeof j.originalChars === 'number') {
          savedChars += j.originalChars;
          dedupedCount++;
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* unreadable */ }
  return { savedChars, dedupedCount };
}

// ── `cpx list` — 捕获会话清单（只读，按 mtime 降序）──────────────────────
// 导入是 insight 的职责（Web UI「Import Session」支持选 proxy 目录扫描；
// 捕获退出时若 insight 在运行则自动导入）。list 只回答"我捕了什么"：sid
// （= insight taskId）、大小、框架（cc-session-meta 声明）、子代理数、压缩状态。
// 同 stem 的明文/压缩态合并为一条（明文优先 = live/resume scratch 态，
// writer.resolveCapturePath 同款优先级）。

interface CaptureEntry {
  sid: string;
  file: string;
  size: number;
  mt: number;
  framework: string | null;
  protocol: string | null;
  subagents: number;
  live: boolean;
}

function readSessionMetaFor(stem: string, sid: string): { framework: string | null; protocol: string | null } {
  // emitter 统一写 <stem>.meta.json（stem 含 cpx- 前缀）；裸 sid 手动拷贝的
  // 老文件兜底再试一次 cpx-<sid>.meta.json。
  const candidates = [
    path.join(PROXY_DIR, `${stem}.meta.json`),
    path.join(PROXY_DIR, `cpx-${sid}.meta.json`),
  ];
  for (const c of candidates) {
    try {
      const xb0 = JSON.parse(fs.readFileSync(c, 'utf-8'));
      const xb = xb0?.x_lake ?? xb0?.x_cannbay;
      if (xb?.schema === 'cc-session-meta' && xb.data && typeof xb.data === 'object') {
        return {
          framework: typeof xb.data.framework === 'string' ? xb.data.framework : null,
          protocol: typeof xb.data.protocol === 'string' ? xb.data.protocol : null,
        };
      }
    } catch { /* next candidate */ }
  }
  return { framework: null, protocol: null };
}

function countSubagents(sid: string): number {
  // subagents 目录按 sid（无 cpx- 前缀）挂载；.jsonl/.jsonl.7z/.jsonl.gz 同 stem 去重。
  const stems = new Set<string>();
  try {
    for (const n of fs.readdirSync(path.join(PROXY_DIR, sid, 'subagents'))) {
      const m = n.match(/^(.+)\.jsonl(\.7z|\.gz)?$/);
      if (m) stems.add(m[1]);
    }
  } catch { /* no subagents */ }
  return stems.size;
}

function scanCaptureEntries(): CaptureEntry[] {
  const byStem = new Map<string, { file: string; size: number; mt: number; live: boolean }>();
  let names: string[] = [];
  try { names = fs.readdirSync(PROXY_DIR); } catch { return []; }
  for (const name of names) {
    const m = name.match(/^(.+)\.jsonl(\.7z|\.gz)?$/);
    if (!m) continue;
    const stem = m[1];
    if (byStem.has(stem)) continue;
    // 优先级与 resolveCapturePath 同款：明文（live）> .7z（新）> .gz（存量）
    const plain = path.join(PROXY_DIR, `${stem}.jsonl`);
    const z7 = path.join(PROXY_DIR, `${stem}.jsonl.7z`);
    const gz = path.join(PROXY_DIR, `${stem}.jsonl.gz`);
    const file = fs.existsSync(plain) ? plain : fs.existsSync(z7) ? z7 : gz;
    try {
      const st = fs.statSync(file);
      if (st.size === 0) continue; // 占位空文件（无记录的 pinned 候选）
      byStem.set(stem, { file, size: st.size, mt: st.mtimeMs, live: file === plain });
    } catch { /* raced/deleted */ }
  }
  const out: CaptureEntry[] = [];
  for (const [stem, v] of byStem) {
    const sid = stem.replace(/^cpx-/, '');
    const { framework, protocol } = readSessionMetaFor(stem, sid);
    out.push({ sid, ...v, framework, protocol, subagents: countSubagents(sid) });
  }
  return out.sort((a, b) => b.mt - a.mt);
}

function fmtLocalTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function runList(): void {
  const entries = scanCaptureEntries();
  console.log(`captures dir : ${PROXY_DIR}`);
  if (entries.length === 0) {
    console.log('no captures yet — 用 `cpx <agent-cmd>` 开始第一次捕获（例: cpx claude）');
    return;
  }
  const total = entries.reduce((s, e) => s + e.size, 0);
  console.log(`共 ${entries.length} 个会话 · 合计 ${fmtSize(total)} — 按时间降序\n`);
  console.log('  TIME                 SID                                    SIZE       FRAMEWORK    PROTOCOL   SUB  STATE  FILE');
  for (const e of entries) {
    const fw = (e.framework ?? '-').padEnd(10);
    const proto = (e.protocol ?? '-').padEnd(9);
    const state = e.live ? 'live' : 'rest';
    console.log(
      `  ${fmtLocalTime(e.mt)}  ${(e.sid.length > 38 ? e.sid.slice(0, 37) + '…' : e.sid).padEnd(38)}  ${fmtSize(e.size).padStart(9)}   ${fw}  ${proto}  ${String(e.subagents).padStart(3)}  ${state.padEnd(5)}  ${path.basename(e.file)}`,
    );
  }
  const liveCount = entries.filter(e => e.live).length;
  if (liveCount > 0) console.log(`\n  live = 明文态（捕获进行中 / 未归档压缩）；rest = 7z at rest（存量 gz 同样可读）`);
  console.log(`\n导入分析：insight Web UI「Import Session → JSONL」选择上述目录（或单选某个文件）；insight 在运行时捕获退出即自动导入`);
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === '-h' || sub === '--help' || sub === 'help') { console.log(USAGE); process.exit(0); }
  if (sub === '--version' || sub === '-v') { console.log(`cpx ${VERSION_DISPLAY} (${PROXY_PKG})`); process.exit(0); }
  if (sub === 'status') {
    const flags = process.argv.slice(3);
    await runStatus({ kill: flags.includes('--kill'), all: flags.includes('--all') });
    return;
  }
  if (sub === 'config') {
    runConfig(process.argv.slice(3));
    return;
  }
  if (sub === 'completion' || sub === '__complete') {
    // 补全引擎共用入口（脚本生成与测试消费同一实现）
    process.exitCode = runCompleteMain(process.argv.slice(2));
    return;
  }
  if (sub === 'list' || sub === 'ls') {
    runList();
    return;
  }
  const { profile, agentCmd, agentArgs } = parseArgs(process.argv);
  if (!agentCmd) {
    console.error(USAGE);
    process.exit(2);
  }

  // Capture is insight-independent: never start insight here. If it happens to
  // be running, the exit path imports + opens the browser (opportunistic);
  // otherwise captures are kept for import via insight's own UI.
  log(`cpx     : ${VERSION_DISPLAY} (${PROXY_PKG})`);
  log(`insight : ${(await insightUp())
    ? `up — 退出后自动导入并开浏览器`
    : 'not running — 捕获独立完成，之后在 insight Web UI「Import Session → JSONL」导入'}`);

  const claude = readClaudeSettings();
  // opencode's real upstream (OpenAI-protocol) — best-effort from env, since
  // opencode's built-in provider baseURLs live in opencode internals, not the
  // user's opencode.json. Override via CANNBOT_PROXY_OPENAI_UPSTREAM if wrong.
  const openaiUpstream = process.env.CANNBOT_PROXY_OPENAI_UPSTREAM ?? 'https://api.openai.com';

  // Validate opencode capture preconditions BEFORE starting the proxy, so a
  // missing provider config exits cleanly instead of starting an orphan proxy
  // that captures nothing (the original "0 capture file" bug). opencode ignores
  // OPENAI_BASE_URL, so without at least one provider to override via
  // OPENCODE_CONFIG_CONTENT, capture is impossible — fail loudly, don't silently
  // fall back to a no-op env override. cannbot 免检：内建 cannbot provider 恒在
  // 覆盖列表里（docs/CANNBOT-DESIGN.md §5.1）。
  if (profile === 'opencode' && resolveProviderIdsFor(profile, agentArgs).length === 0) {
    log('opencode: no provider to override for capture.');
    log('  fix: pass `-m <provider>/<model>` (e.g. -m gateway/glm-5.3),');
    log('        or log into a provider first (`opencode providers login`) so cpx');
    log('        can read its id from auth.json, or define the provider in a');
    log('        project config (opencode.json[c] / .opencode/opencode.json[c]) or');
    log('        ~/.config/opencode/opencode.json[c] (custom provider).');
    log('  (opencode ignores OPENAI_BASE_URL, so cpx cannot capture without an');
    log('   explicit OPENCODE_CONFIG_CONTENT provider override.)');
    process.exit(2);
  }

  // Discover each opencode provider's REAL upstream baseURL by scanning the
  // opencode binary (provider registry embeds api:"<url>"). Forwarded to the
  // proxy as a per-provider map so it routes /<providerId>/… to the right host —
  // fully transparent, no CANNBOT_PROXY_OPENAI_UPSTREAM needed for known providers.
  const opencodeProviderIds = profile === 'opencode' || profile === 'cannbot' ? resolveProviderIdsFor(profile, agentArgs) : [];
  const providerUpstreams = profile === 'opencode' || profile === 'cannbot' ? discoverProviderUpstreams(opencodeProviderIds) : {};

  const sid = randomUUID();

  // 启动期扫除泄漏占位（信号击杀/SIGKILL 残留的历史积压）：活运行以 proxy
  // 进程的 CANNBOT_PROXY_SESSION_ID 判定，绝不误清进行中会话；/proc 不可用
  // （macOS）无法判定 liveness 时跳过（信号路径清理已由 handler 覆盖）
  if (fs.existsSync('/proc')) {
    try {
      const livePinned = new Set(dedupePairs(findProxyProcs()).map(p => p.sid).filter((s): s is string => !!s));
      const swept = sweepLeakedPlaceholders(PROXY_DIR, livePinned);
      if (swept > 0) log(`swept ${swept} leaked empty placeholder(s)（Ctrl+C/击杀残留）`);
    } catch { /* best-effort */ }
  }

  // codex ChatGPT 登录用户：proxy 上游需指向 chatgpt.com 后端（不是
  // api.openai.com）。检测 ~/.codex/auth.json 是否存在来判断 auth 模式。
  // cpx 已有 API key 的走自定义 provider（api.openai.com），不需要此覆盖。
  if (profile === 'codex' && !process.env.OPENAI_API_KEY) {
    const codexAuth = path.join(os.homedir(), '.codex', 'auth.json');
    if (fs.existsSync(codexAuth)) {
      process.env.CANNBOT_PROXY_RESPONSES_UPSTREAM = 'https://chatgpt.com/backend-api/codex';
    }
  }

  const sessionProxy = await startSessionProxy(sid, claude.upstream, openaiUpstream, providerUpstreams);
  const jsonlPath = sessionFilePath(sid);
  const { env, args } = buildLaunch(profile, sessionProxy.port, claude, agentArgs, agentCmd);

  const displayUpstream = profile === 'opencode' || profile === 'cannbot' || profile === 'openai' || profile === 'generic' || profile === 'codex'
    ? (profile === 'cannbot' ? (providerUpstreams['cannbot'] ?? openaiUpstream) : openaiUpstream)
    : claude.upstream;

  // Ensure the per-session proxy dies with cpx-cli, even on signals. Kill the
  // whole process GROUP (npx → tsx → node server.ts + esbuild grandchild):
  // SIGTERM to the npx wrapper alone leaves the node grandchild alive — it
  // inherits the stdout pipe fd, keeping cpx's event loop from exiting (the
  // "no capture file produced — nothing to import" hang) and accumulating as
  // orphan proxy processes.
  // SIGINT path: SIGTERM the group first, wait ~1s for the proxy's
  // handleStream client-disconnect catch to flush the in-flight record to
  // disk (emit runs even on partial stream), THEN SIGKILL stragglers. Direct
  // SIGKILL on Ctrl+C would lose the in-flight record (stream not yet emitted).
  const killProxyGroup = (signal: 'SIGTERM' | 'SIGKILL' = 'SIGKILL') => {
    const pid = sessionProxy.child.pid;
    if (pid) { try { process.kill(-pid, signal); } catch { /* group gone */ } }
    if (signal === 'SIGKILL') {
      try { sessionProxy.child.stdout?.destroy(); } catch { /* */ }
      try { sessionProxy.child.stderr?.destroy(); } catch { /* */ }
    }
  };
  const cleanup = () => {
    killProxyGroup('SIGTERM');
    // grace period: let the proxy flush in-flight stream (client disconnect
    // → catch → emit partial record). ~800ms covers a disk write + stream end.
    try { killProxyGroupSync(800); } catch { /* */ }
  };
  function killProxyGroupSync(graceMs: number) {
    const pid = sessionProxy.child.pid;
    if (!pid) return;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      // busy-wait is fine — sub-second, and we're exiting anyway
    }
    try { process.kill(-pid, 'SIGKILL'); } catch { /* */ }
    try { sessionProxy.child.stdout?.destroy(); } catch { /* */ }
    try { sessionProxy.child.stderr?.destroy(); } catch { /* */ }
  }
  process.on('SIGINT', () => { cleanup(); dropSessionScratch(PROXY_DIR, sid); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); dropSessionScratch(PROXY_DIR, sid); process.exit(143); });
  // 挂断后 stdout/stderr 指向已死 pty：后续任何日志写入收到 EIO —— 与 EPIPE
  // 不同，Node 对 stdout 的 EIO 默认不忽略，会以 uncaught error 崩掉孤儿态收尾
  // 流程（真实 pty 挂断复测发现：SIGHUP handler 自己的 log() 就足以触发）。
  // 装 noop error 监听吞掉，保证压缩→导入全程不被日志写崩。
  process.stdout?.on?.('error', () => {});
  process.stderr?.on?.('error', () => {});
  // SIGHUP = 终端/ssh 挂断（内核发给前台进程组，agent 也一并收到）。此前无
  // handler → Node 默认裸死，零清理：捕获留明文、.sids/占位残留、永不压缩
  // （实测 ses 9fd46cc3：ssh 掉线杀 cpx，孤儿 claude 后续退出无人收尾）。
  // 修复：handler 只"不死"——main() 本就在 await agent 退出，挂断后：
  //   - agent 随挂断而死 → child.on('exit') 立即触发 → 完整收尾（压缩→导入）
  //   - agent 扛过挂断（claude bg-pty-host，断线可重连）→ cpx 同步存活陪跑，
  //     会话继续捕获，agent 最终退出时（哪怕数小时后）仍走完整收尾——
  //     不主动杀 agent，保住断线重连工作流。
  process.on('SIGHUP', () => {
    log('SIGHUP（终端/ssh 挂断）—— 存活等待 agent 退出后走完整收尾（压缩→导入）');
  });
  process.on('exit', () => { try { killProxyGroup('SIGKILL'); } catch { /* */ } });

  log(`session: ${sid}`);
  log(`profile: ${profile}  upstream: ${displayUpstream}`);
  if (profile === 'opencode' || profile === 'cannbot') {
    const ids = opencodeProviderIds;
    const src = parseOpencodeProvider(agentArgs) ? '-m'
      : 'auth.json + opencode.json[c]';
    log(`  opencode providers: ${ids.join(', ')}  (from ${src}; baseURL → proxy via /<providerId>/ prefix)`);
    for (const id of ids) {
      const up = providerUpstreams[id];
      if (up) log(`    ${id} → ${up}`);
      else log(`    ${id} → (upstream not found in binary/models.dev cache/config; will use default ${openaiUpstream} — set CANNBOT_PROXY_OPENAI_UPSTREAM if wrong)`);
    }
    log(`  2.x isolation: ${args.includes('--standalone')
      ? '--standalone 已注入（私有服务，OPENCODE_CONFIG_CONTENT 对发调进程生效）'
      : '未注入（未检测到该 flag / 子命令不支持——若为 2.x 共享服务形态，捕获可能为空）'}`);
  }
  log(`proxy: http://127.0.0.1:${sessionProxy.port}  (per-session, sid pinned via env)`);
  // claude 会话的捕获文件按 claude 自己的 session id（请求头）命名 —— 与
  // claude 原生 jsonl 1:1 对应；cpx 钉定的占位文件仅在无 header 的协议
  // （opencode/generic）下承载记录。live watch 跟踪整个目录。
  log(`capture: ${PROXY_DIR}/cpx-<claude-session-id>.jsonl  (本次占位: cpx-${sid.slice(0, 8)}…)`);
  log(`  watch live: tail -F "${PROXY_DIR}"/*.jsonl`);
  const maskSecrets = (args: string[]) => args.map(a => redactString(a));
  log(`launching: ${agentCmd} ${maskSecrets(args).join(' ')}`);

  const child = spawn(agentCmd, args, {
    stdio: 'inherit',
    // CPX_SESSION_ID：会话定位工牌——agent 及其 bash 工具子进程自动继承，
    // 收尾时裸跑 `cpx upload` 即可精确命中本会话（并发机器不传错别人的）
    env: { ...process.env, ...env, CPX_SESSION_ID: sid },
  });

  await new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
    child.on('error', (e) => { log(`agent error: ${e.message}`); resolve(); });
  });

  cleanup();

  // The proxy routes each record by claude's REAL session id (request header),
  // which differs from cpx's pinned sid — and /resume can switch ids mid-run,
  // producing several capture files. The <pinned>.sids manifest (appended on
  // first emit per sid) is the authoritative list of files this run produced.
  const sidsFile = sidsFilePath(sid);
  // {sid, file}: sid is the REAL session id (manifest value, unprefixed) — it
  // becomes the insight taskId/URL; file is the cpx- prefixed capture path.
  const produced: Array<{ sid: string; file: string }> = [];
  try {
    const seen = new Set<string>();
    for (const s of fs.readFileSync(sidsFile, 'utf-8').split('\n').map(x => x.trim()).filter(Boolean)) {
      if (seen.has(s)) continue;
      seen.add(s);
      const p = sessionFilePath(s);
      const rp = resolveCapturePath(p);
      if (fs.existsSync(rp) && fs.statSync(rp).size > 0) produced.push({ sid: s, file: p });
    }
  } catch { /* no manifest (no records emitted) */ }
  // Legacy/no-header protocols (opencode/generic) emit to the pinned file only.
  const jsonlResolved = resolveCapturePath(jsonlPath);
  if (produced.length === 0 && fs.existsSync(jsonlResolved) && fs.statSync(jsonlResolved).size > 0) {
    produced.push({ sid, file: jsonlPath });
  }

  // The pinned placeholder file is eagerly created at proxy startup so the
  // printed path / tail work before the first request; drop it when this run
  // routed everything elsewhere (both plaintext and compressed forms).
  // The manifest is per-run scratch — always drop.
  try {
    if (!produced.some(x => x.file === jsonlPath)) {
      for (const f of [jsonlPath, `${jsonlPath}.7z`, `${jsonlPath}.gz`]) {
        if (fs.existsSync(f)) fs.rmSync(f);
      }
    }
  } catch { /* best-effort */ }
  try { if (fs.existsSync(sidsFile)) fs.unlinkSync(sidsFile); } catch { /* best-effort */ }

  if (produced.length === 0) {
    log('no capture file produced — nothing to import');
    process.exit(0);
  }

  // 7z at rest（docs/COMPRESSION-DESIGN.md）：会话关闭，所有本运行产物 + 其
  // subagents 压缩为 .jsonl.7z —— 在 normalize/import 之前，sourcePath 一次
  // 定型为 .7z。同时给伴生 cc-session-meta 打 governed 标记（spec §4.4）：
  // 字节流已经 cpx 落盘咽喉 redactor 全量清洗（server.ts dispatchEmit），
  // lake 上传侧据此走直传快路径（免解压重洗重压）。
  const markGoverned = (sidRaw: string): void => {
    try {
      const metaPath = sessionMetaPath(sidRaw);
      if (!fs.existsSync(metaPath)) return;
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const xb = meta?.x_lake ?? meta?.x_cannbay;
      if (xb?.schema === 'cc-session-meta' && xb.data && xb.data.producer === 'cpx') {
        xb.data.governed = true;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
      }
    } catch { /* meta 缺失/畸形：不打标，上传走治理兜底路径 */ }
  };
  for (const { file: p } of produced) {
    const sid0 = path.basename(p, '.jsonl').replace(/^cpx-/, '');
    const subDir = path.join(PROXY_DIR, sid0, 'subagents');
    try {
      compressCaptureFile(p);
      if (fs.existsSync(subDir)) {
        for (const f of fs.readdirSync(subDir)) {
          if (f.endsWith('.jsonl')) compressCaptureFile(path.join(subDir, f));
        }
      }
      markGoverned(sid0);
    } catch (e) { log(`compress failed (${p}): ${e instanceof Error ? e.message : String(e)}`); }
  }

  // Opportunistic import only: insight running → import + browser; otherwise
  // keep captures at rest and point at insight's own import UI (never start
  // insight here).
  const importLive = await insightUp();
  if (!importLive) {
    log(`insight not running — ${produced.length} capture(s) kept at ${PROXY_DIR}; import later via insight Web UI「Import Session → JSONL」（cpx-<sid>.jsonl.7z 可直接选，cpx- 前缀与 .7z/.gz 自动处理）or \`cpx list\` to browse`);
  }
  let lastUrl: string | null = null;
  for (const { sid: captureSid, file: p } of produced) {
    const pGz = resolveCapturePath(p);
    log(`captured ${(fs.statSync(pGz).size / 1024).toFixed(1)}KB [${captureSid}]`);
    log(`  capture  : ${pGz}`);
    const agentLog = profile === 'claude' ? claudeNativeLogPath(captureSid)
      : profile === 'opencode' || profile === 'cannbot' ? opencodeNativePaths()
      : null;
    if (agentLog) log(`  agent log: ${agentLog}`);
    // 直接导入 verbatim 捕获：adapter 双形态透明解压，taskId 用清单里的
    // 真实 sid（无 cpx- 前缀），subagents 按 <sid>/subagents/ 布局发现，
    // sourcePath 一次定型为压缩态 verbatim。
    const importPath = pGz;
    if (!importLive) continue;
    log(`  importing: ${importPath}`);
    const result = await triggerIngest(captureSid, importPath);
    if (result) lastUrl = `${INSIGHT_BASE}/session/${captureSid}`;
    else log('  ingest failed; you can import manually via the cannbot-insight UI');
  }
  if (lastUrl) {
    log(`✅ imported → opening ${lastUrl}`);
    openBrowser(lastUrl);
  }
  process.exit(0);
}

main().catch((e) => { log(e instanceof Error ? e.message : String(e)); process.exit(1); });
