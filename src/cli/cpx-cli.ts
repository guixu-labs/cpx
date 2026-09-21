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
import { parseOpencodeProvider, readAuthProvidersFromFile, readCustomProvidersFromRoots, resolveProviderIds, opencodeConfigRoots } from './opencode-providers';
import { resolveTsxLoader } from './tsx-launcher';
import { runUpload } from './cpx-upload';
import { parseArgs } from './cpx-args';
import { runCompleteMain } from './cpx-complete';
import { resolveLfs } from '../cannbay/remote';
import { ensureLfsBinaryAvailable, gitLfsSource, lfsBinaryPath } from '../lfs-setup';
import { dropSessionScratch, sweepLeakedPlaceholders } from './cpx-scratch';

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
  /** LFS 上传：.jsonl.7z 以 LFS 指针出仓。仅用户显式设置时存在（undefined = 跟随默认开）。 */
  lfsUpload?: boolean;
}

function loadCpxConfig(): CpxConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CPX_CONFIG_FILE, 'utf-8'));
    const cfg: CpxConfig = { dedupInjection: raw.dedupInjection === true };
    // lfsUpload 三态保留（undefined = 未设置）：老配置文件（仅 dedup）不得被
    // 隐式归一成 false——那会把 dedup 用户静默打到 blob 模式
    if (raw && typeof raw.lfsUpload === 'boolean') cfg.lfsUpload = raw.lfsUpload;
    return cfg;
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
  if (args[0] === 'lfs' && (args[1] === 'on' || args[1] === 'off')) {
    cfg.lfsUpload = args[1] === 'on';
    saveCpxConfig(cfg);
    console.log(`lfs upload      : ${cfg.lfsUpload ? 'on' : 'off'}  (已写入 ${CPX_CONFIG_FILE})`);
    return;
  }
  if (args.length === 0) {
    const lfs = resolveLfs();
    console.log(`config file     : ${CPX_CONFIG_FILE}`);
    console.log(`dedup injection : ${cfg.dedupInjection ? 'on' : 'off'}   (cpx config dedup on|off 切换，热生效；压缩仅作用于捕获记录，不改动转发)`);
    console.log(`lfs upload      : ${lfs.enabled ? 'on' : 'off'}（${lfs.source === 'default' ? '默认' : lfs.source}）  (cpx config lfs on|off 切换；.jsonl.7z 以 LFS 指针出仓，容量脱离 git 仓配额)`);
    return;
  }
  console.error('用法: cpx config [dedup on|off] [lfs on|off]');
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
  cpx <agent-cmd> --autoupload [args...] 会话结束无感上传 CANNBay（六框架通用；提交人
                                         自动取 git 用户名，范式目录缺省默认 others，
                                         全程零交互；精确分类显式给 --category）
  cpx list                              列出全部捕获会话文件（按时间降序，只读）
  cpx status [--kill [--all]]            查看状态；--kill 清理无 sid 的孤儿 proxy，--all 连活跃会话一起清
  cpx config [dedup on|off] [lfs on|off]  查看/配置；dedup=注入压缩（默认 off，热生效，只压缩捕获记录不改转发）；
                                          lfs=LFS 上传（默认 on，.jsonl.7z 以 LFS 指针出仓，容量脱离 git 仓配额）
  cpx lfs-setup                           git-lfs 自举：系统件缺失时自动下载 cpx 私有件（sha256 校验，零全局污染）；
                                          上传时也会自动触发，此命令供预取/配镜像后重试
  cpx upload [sid] [flags]               补传会话到 CANNBay（直传，无需 insight；缺省 sid = 最新捕获，
                                         零参数即走默认：提交人=git 用户名、范式目录=others）。
                                         flags：--category 精确分类 [--submitter] [--desc] [--opgen success|failure]
  cpx completion [bash|zsh] [--install]  打印/安装 Tab 补全脚本（sid 动态补全；agent 命令之后不越界）
  cpx --version | -v                     版本号 + 生效代码路径（多仓共存时确认当前副本）
  cpx --help | -h                        本帮助

cpx 保留参数（被 cpx 拦截消费，不透传 agent）：--agent --autoupload --submitter
--category --desc --opgen --baseline；其余参数原样转发。

在原有 claude / opencode 命令前加 cpx，其他使用完全无变化。捕获无需 insight：
agent 退出后自动压缩 + 生成 norm/ 规范文件；insight 在运行则自动导入并开浏览器，
否则保留捕获（\`cpx list\` 查看，导入走 insight：Web UI「Import Session → JSONL」
选 \`~/.cannbot-insight/proxy/\` 目录）。安装：./proxy/install.sh（独立）或根
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
  extraArgs: string[];
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
  // 自定义 provider 的 upstream 从配置本体叠加（配置优先于二进制结果）
  for (const id of providerIds) if (custom[id]) out[id] = custom[id];
  return out;
}

function buildLaunch(profile: AgentProfile, proxyPort: number, claude: ClaudeSettings, agentArgs: string[] = []): LaunchPlan {
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
        extraArgs: ['--settings', JSON.stringify({ env: settingsEnv })],
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
      return { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider }) }, extraArgs: [] };
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
        return { env: {}, extraArgs: overrides };
      }
      // ChatGPT 登录用户：仅覆盖 base_url，不碰 auth
      return { env: {}, extraArgs: ['-c', `openai_base_url="${proxyUrl}/v1"`] };
    }
    case 'openai':
    case 'generic':
      return { env: { OPENAI_BASE_URL: proxyUrl }, extraArgs: [] };
  }
}

function openBrowser(url: string): void {
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

const PROXY_SERVER_REL = path.join('proxy', 'src', 'server.ts');
const CLK_TCK = 100;

interface ProxyProc {
  pid: number; ppid: number | null; sid: string | null;
  upstream: string | null; ageSec: number | null; port: number | null;
}

function readProcFile(pid: number, name: string): string | null {
  try { return fs.readFileSync(`/proc/${pid}/${name}`, 'utf-8'); } catch { return null; }
}

function parseEnviron(s: string): Record<string, string> {
  const e: Record<string, string> = {};
  for (const kv of s.split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0) e[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return e;
}

// pid → listening port on 127.0.0.1, via `ss` (best-effort; absent → empty map).
function readListenPorts(): Map<number, number> {
  const m = new Map<number, number>();
  let out = '';
  try { out = spawnSync('ss', ['-ltnp'], { encoding: 'utf-8' }).stdout ?? ''; } catch { return m; }
  if (!out) return m;
  for (const line of out.split('\n')) {
    const pm = line.match(/pid=(\d+)/);
    const ptm = line.match(/127\.0\.0\.1:(\d+)/);
    if (pm && ptm) {
      const pid = parseInt(pm[1]); const port = parseInt(ptm[1]);
      if (pid && port) m.set(pid, port);
    }
  }
  return m;
}

function findProxyProcs(): ProxyProc[] {
  let pids: number[] = [];
  try { pids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).map(Number); } catch { return []; }
  const portMap = readListenPorts();
  let uptime: number | null = null;
  try { uptime = parseFloat(fs.readFileSync('/proc/uptime', 'utf-8').split(/\s+/)[0]); } catch { /* */ }
  const out: ProxyProc[] = [];
  for (const pid of pids) {
    const cmd = readProcFile(pid, 'cmdline');
    if (!cmd) continue;
    if (!cmd.replace(/\0/g, ' ').includes(PROXY_SERVER_REL)) continue;
    const env = parseEnviron(readProcFile(pid, 'environ') ?? '');
    let ppid: number | null = null; let ageSec: number | null = null;
    const stat = readProcFile(pid, 'stat');
    if (stat) {
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      ppid = parseInt(after[1]) || null;
      const st = parseInt(after[19]);
      if (uptime && Number.isFinite(st)) ageSec = Math.max(0, uptime - st / CLK_TCK);
    }
    out.push({
      pid, ppid,
      sid: env.CANNBOT_PROXY_SESSION_ID ?? null,
      upstream: env.CANNBOT_PROXY_ANTHROPIC_UPSTREAM ?? null,
      ageSec, port: portMap.get(pid) ?? null,
    });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

// Dedupe the (npx-parent → node-child) pair: the npx wrapper has no port and
// is the parent of the actual server child. Keep the child (port bearer);
// drop port-less procs that are an ancestor of another matched proc.
function dedupePairs(procs: ProxyProc[]): ProxyProc[] {
  return procs.filter(p => !(p.port == null && procs.some(q => q.ppid === p.pid)));
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
    const stale = p.sid == null ? '  [stale: no sid, likely orphaned]' : '';
    console.log(`  pid ${p.pid}  port ${p.port ?? '-'}  age ${fmtAge(p.ageSec)}${stale}`);
    console.log(`    sid ${p.sid ?? '-'}  upstream ${p.upstream ?? '-'}`);
  }

  if (opts.kill) {
    const targets = opts.all ? proxies : proxies.filter(p => p.sid == null);
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
  const lfs = resolveLfs();
  const src = gitLfsSource();
  const lfsNote = !lfs.enabled
    ? '(cpx config lfs on 开启)'
    : src === 'system'
      ? 'git-lfs system'
      : src === 'private'
        ? `git-lfs cpx 私有（${lfsBinaryPath()}）`
        : 'git-lfs 缺失——上传时自动获取（cpx lfs-setup 可预取/重试）';
  console.log(`lfs upload      : ${lfs.enabled ? 'on' : 'off'}（${lfs.source === 'default' ? '默认' : lfs.source}）  ${lfsNote}`);
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
      const xb = JSON.parse(fs.readFileSync(c, 'utf-8'))?.x_cannbay;
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
  if (sub === 'lfs-setup') {
    try {
      const r = await ensureLfsBinaryAvailable();
      console.log(r.source === 'system'
        ? `git-lfs : system 已安装（无需自举）`
        : `git-lfs : cpx 私有件就绪 → ${lfsBinaryPath()}${r.downloaded ? '（本次自动获取）' : ''}`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
    return;
  }
  if (sub === 'upload') {
    process.exitCode = await runUpload(process.argv.slice(3));
    return;
  }
  if (sub === 'completion' || sub === '__complete') {
    // 补全引擎共用入口（与 dist/cpx-complete.mjs bundle 同一实现）
    process.exitCode = runCompleteMain(process.argv.slice(2));
    return;
  }
  if (sub === 'list' || sub === 'ls') {
    runList();
    return;
  }
  // `cpx import` 已移除（与 insight 自身导入能力重复）：老习惯敲进来时指路，
  // 而不是把它当 agent 命令 spawn 报 ENOENT。
  if (sub === 'import') {
    log('`cpx import` 已移除 —— 导入是 insight 自身的职责：');
    log('  · insight 在运行时，捕获退出即自动导入并开浏览器');
    log('  · 手动导入：insight Web UI「Import Session → JSONL」选 ~/.cannbot-insight/proxy/ 目录');
    log('  · 查看捕获清单：cpx list');
    process.exit(2);
  }
  // `cpx normalize` 已移除（norm/ 镜像层退役：与 verbatim 逐行相同的冗余
  // 副本，insight 直读 verbatim 导入与 serving）：老习惯敲进来时指路，
  // 而不是把它当 agent 命令 spawn 报 ENOENT。存量 norm/ 件不迁移不删除。
  if (sub === 'normalize') {
    log('`cpx normalize` 已移除 —— norm/ 镜像层退役（insight 直读 verbatim，无需规范文件）：');
    log('  · 导入：insight Web UI「Import Session → JSONL」或捕获退出自动导入');
    log('  · 盘上存量 norm/ 文件不受影响（不迁移不删除）');
    process.exit(2);
  }
  const { profile, agentCmd, agentArgs, uploadArgs, autoUpload } = parseArgs(process.argv);
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
  const { env, extraArgs } = buildLaunch(profile, sessionProxy.port, claude, agentArgs);

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
      else log(`    ${id} → (upstream not found in binary/config; will use default ${openaiUpstream} — set CANNBOT_PROXY_OPENAI_UPSTREAM if wrong)`);
    }
  }
  log(`proxy: http://127.0.0.1:${sessionProxy.port}  (per-session, sid pinned via env)`);
  // claude 会话的捕获文件按 claude 自己的 session id（请求头）命名 —— 与
  // claude 原生 jsonl 1:1 对应；cpx 钉定的占位文件仅在无 header 的协议
  // （opencode/generic）下承载记录。live watch 跟踪整个目录。
  log(`capture: ${PROXY_DIR}/cpx-<claude-session-id>.jsonl  (本次占位: cpx-${sid.slice(0, 8)}…)`);
  log(`  watch live: tail -F "${PROXY_DIR}"/*.jsonl`);
  const maskSecrets = (args: string[]) => args.map(a => redactString(a));
  log(`launching: ${agentCmd} ${maskSecrets([...extraArgs, ...agentArgs]).join(' ')}`);

  const child = spawn(agentCmd, [...extraArgs, ...agentArgs], {
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
  // cannbay2 上传侧据此走直传快路径（免解压重洗重压）。
  const markGoverned = (sidRaw: string): void => {
    try {
      const metaPath = sessionMetaPath(sidRaw);
      if (!fs.existsSync(metaPath)) return;
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const xb = meta?.x_cannbay;
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
    // 直接导入 verbatim 捕获（norm/ 镜像层已退役）：adapter 双形态透明解压，
    // taskId 用清单里的真实 sid（无 cpx- 前缀），subagents 按 <sid>/subagents/
    // 布局发现。sourcePath 一次定型为压缩态 verbatim。存量 norm/ 件不迁移
    // 不删除（`cpx normalize` 降级为兼容命令，按需手动重生成）。
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
  // --autoupload：逐会话直传 CANNBay（零 insight 依赖）。复用 runUpload
  // （直传 + TTY 向导 + governance 透传；insight 在跑仅增强预填/顺带导入）；
  // 信息不全时 runUpload 自行指路（cpx upload <sid> 补传），捕获已在本地，
  // 不因上传失败改退出码
  if (autoUpload) {
    for (const { sid: captureSid } of produced) {
      log(`autoupload: ${captureSid}`);
      const code = await runUpload([captureSid, ...uploadArgs]);
      if (code !== 0) log(`autoupload 未完成（exit ${code}）—— 捕获保留本地，稍后可 cpx upload ${captureSid} 补传`);
    }
  }
  process.exit(0);
}

main().catch((e) => { log(e instanceof Error ? e.message : String(e)); process.exit(1); });
