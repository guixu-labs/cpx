// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// opencode provider 发现（纯函数，路径注入可测）：cpx 捕获 opencode 会话的
// 前提是把用到的 provider baseURL 重定向到本机 proxy（OPENCODE_CONFIG_CONTENT，
// 进程级、tier 6）。provider 候选有四个来源：
//   ① 命令行 `-m <provider>/<model>`（精确，优先）
//   ② auth.json 的 provider keys（opencode 官方凭据存储）
//   ③ 用户全局配置（~/.config/opencode/opencode.json[c] 的 provider 段）
//   ④ 项目级配置（opencode.json[c] / .opencode/opencode.json[c]，cwd 向上到
//      git 根遍历——opencode 文档：先在 cwd 找，再向上到最近的 git 目录）
// ③④ 的自定义 provider（如私有 AI 网关）baseURL 就在配置本体里，此前只看 ①②
// → 自定义 provider 的 baseURL 从未被重定向 → 整个会话的 LLM 流量直连上游、
// proxy 颗粒无收（客户现场 ses_fa840cd30ffe：gateway/glm-5.3 走 volceapi 直连，
// cpx 捕获 0 字节；当时修复只覆盖了全局配置，漏了项目级配置）。
// 自定义 provider 的真实上游 baseURL 从配置本体读（不在 opencode 二进制里，
// binary strings 扫描必 miss）。
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

// JSONC 注释剥离（字符串感知）：opencode.jsonc 允许 // 行注释与 /* */ 块
// 注释，但配置值里的 URL（"https://…"）自带 `//` —— 裸正则替换会把 URL
// 腰斩。逐字符状态机：仅在双引号字符串外剥注释；处理 \" 转义。
export function stripJsoncComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        // 保留转义对（\" 等）——下一个字符原样带上
        if (i + 1 < text.length) { out += text[i + 1]; i++; }
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n'; // 保留换行（行号语义，错误信息可读）
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // 越过 '/'
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

// 解析单个 opencode 配置文件（.json 直读；.jsonc 剥注释）。失败返回 null。
function parseConfigFile(file: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(stripJsoncComments(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// auth.json 的 provider keys（opencode 官方凭据存储；值是凭据对象才算）。
export function readAuthProvidersFromFile(authJsonPath: string): string[] {
  try {
    const obj = JSON.parse(fs.readFileSync(authJsonPath, 'utf-8')) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return [];
    return Object.keys(obj).filter(k => obj[k] && typeof obj[k] === 'object');
  } catch {
    return [];
  }
}

// 用户 opencode 配置的自定义 provider：provider.<id>.options.baseURL →
// { id: baseURL }。cannbot（opencode 系 fork）双配置根都查，先 cannbot 后
// opencode（与 cannbotGatewayUpstream 的根序一致），同 id 首见即定（先到根
// 优先）。每根依次尝试 opencode.json / opencode.jsonc。
export function readCustomProvidersFromRoots(roots: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const root of roots) {
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      const cfg = parseConfigFile(path.join(root, name));
      if (!cfg) continue;
      const provider = cfg.provider;
      if (!provider || typeof provider !== 'object') continue;
      for (const [id, def] of Object.entries(provider as Record<string, unknown>)) {
        if (out[id]) continue; // 先到根优先
        if (!def || typeof def !== 'object') continue;
        const baseURL = (def as { options?: { baseURL?: unknown } }).options?.baseURL;
        if (typeof baseURL === 'string' && baseURL) out[id] = baseURL;
      }
      break; // 该根已解析成功（.json 优先于 .jsonc），不再试下一个文件名
    }
  }
  return out;
}

// `-m <provider>/<model>` 解析（opencode 模型格式）。命中则只覆盖该 provider
// （精确）；否则返回 null（调用方走 auth ∪ custom 全量）。
export function parseOpencodeProvider(agentArgs: string[]): string | null {
  for (let i = 0; i < agentArgs.length; i++) {
    if ((agentArgs[i] === '-m' || agentArgs[i] === '--model') && agentArgs[i + 1]) {
      const m = agentArgs[i + 1];
      const slash = m.indexOf('/');
      return slash > 0 ? m.slice(0, slash) : null;
    }
    const eq = agentArgs[i].match(/^-m=(.+)$/);
    if (eq) {
      const m = eq[1];
      const slash = m.indexOf('/');
      return slash > 0 ? m.slice(0, slash) : null;
    }
  }
  return null;
}

// 覆盖列表解析（纯）：-m 精确优先；否则 auth keys ∪ 自定义配置 keys
// （交互式 `cpx opencode` 不知道运行时会选哪个模型，全部可调用 provider
// 一并重定向——未用到的覆盖是死代码无副作用）。cannbot 恒含内建 cannbot
// provider（默认模型走它，二进制扫描 miss 由 cannbotGatewayUpstream 兜底）。
export function resolveProviderIds(opts: {
  profile: 'opencode' | 'cannbot';
  agentArgs: string[];
  authProviders: string[];
  customProviders: Record<string, string>;
}): string[] {
  const fromArg = parseOpencodeProvider(opts.agentArgs);
  if (fromArg) return [fromArg];
  const ids = [...new Set([...opts.authProviders, ...Object.keys(opts.customProviders)])];
  return opts.profile === 'cannbot' ? ['cannbot', ...ids] : ids;
}

// 项目级配置目录（opencode 文档 §Locations/Per project：先在 cwd 找
// opencode.json，再向上遍历到最近的 git 目录）。逐层产出 <dir> 与
// <dir>/.opencode 两个候选根；<dir>/.opencode/opencode.json[c] 是 CANN fork /
// 部分版本的项目配置位置（客户现场 huoshan-ai-gateway 只定义在项目级
// .opencode/opencode.json，全局配置扫不到 → 直连上游 0 捕获）。cwd 参数可注入
// （测试），缺省 process.cwd()。
export function opencodeProjectConfigRoots(cwd?: string): string[] {
  const roots: string[] = [];
  let dir = path.resolve(cwd ?? process.cwd());
  for (;;) {
    roots.push(dir, path.join(dir, '.opencode'));
    // opencode 以最近的 git 目录为项目根（.git 可能是目录或 worktree 文件）
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // 已到文件系统根
    dir = parent;
  }
  return roots;
}

// 配置根（XDG 感知，cannbot/opencode 双根——cannbot 是 opencode 系 fork，
// 两边都可能有自定义 provider 定义）。项目级配置优先（opencode 项目配置
// 优先级高于全局配置；readCustomProvidersFromRoots 先到根优先）。
export function opencodeConfigRoots(): string[] {
  const xdg = process.env.XDG_CONFIG_HOME;
  const home = xdg ? [xdg] : [path.join(process.env.HOME ?? '', '.config')];
  const roots: string[] = [...opencodeProjectConfigRoots()];
  for (const base of home) {
    roots.push(path.join(base, 'cannbot'), path.join(base, 'opencode'));
  }
  return roots;
}

// ── opencode 2.x：models.dev catalog（内建 provider 元数据的运行时来源）──
//
// 2.x 起内建 provider 注册表不再以 1.x 的
//   id:"<pid>",env:[...],npm:"...",api:"<baseURL>"
// JS 字面量嵌在二进制里（实测 2.0.18：该形态 0 命中），内建 provider 的
// baseURL 改从 models.dev catalog 解析（https://models.opencode.ai/api.json，
// 条目的 api 字段 → provider 默认 baseURL）。opencode 自身的加载链：
// --models-dev 文件 → kv 缓存 → 内嵌 snapshot → 网络拉取；kv 缓存由服务
// 进程的后台 refresh 循环异步写入（快进快出的短命令可能来不及写，实测
// `opencode models` 30s 内退出无写入）。
// cpx 镜像其磁盘来源（只读用户自己的数据，不联网、不凭空造 URL）：
//   ① <dataDir>/opencode.db 的 kv 表（key=models-dev:catalog，node:sqlite
//      只读；实测 2.26GB 活库 + WAL 可见性 OK）
//   ② 同文件 raw 字节扫描（node:sqlite 不可用的老 node 兜底；记录跨
//      overflow 页非连续时 JSON 截断/digest 不符 → 弃，fail-safe）
//   ③ <cacheDir>/models.json（1.x 风格扁平缓存；新旧版本混装的机器上
//      存在，实测与 catalog 语义同源）
// 全 miss → null（调用方 warn + CANNBOT_PROXY_OPENAI_UPSTREAM 兜底）。
// 已知限制：catalog 并非每个 provider 都带 api（实测 225 个中 26 个无，
// 如 anthropic——其 SDK 硬编码默认端点），这些依旧走 warn 路径。
const MODELS_DEV_KV_KEY = 'models-dev:catalog';

// node:sqlite 最小面（避免静态 import 依赖 @types/node 的版本面；老 node
// 上模块不存在 → require 抛错 → null → 走 raw 扫描兜底）
interface SqliteStatement { get(...params: unknown[]): unknown }
interface SqliteDatabaseSync { prepare(sql: string): SqliteStatement; close(): void }
interface NodeSqliteModule { DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => SqliteDatabaseSync }

let cachedNodeSqlite: NodeSqliteModule | null | undefined;
function nodeSqlite(): NodeSqliteModule | null {
  if (cachedNodeSqlite !== undefined) return cachedNodeSqlite;
  try {
    // 基址对内建模块解析无影响（node:sqlite 恒可解析，与 require 发起
    // 位置无关）；node <22.5 / 23.4 前未开 flag 时抛错
    cachedNodeSqlite = createRequire(process.execPath)('node:sqlite') as NodeSqliteModule;
  } catch { cachedNodeSqlite = null; }
  return cachedNodeSqlite;
}

// catalog（JSON 字符串或已解析对象）→ {providerId: api}；api 缺失（SDK
// 硬编码默认端点，如 anthropic）或非 http(s) 的条目跳过。
function parseModelsDevCatalog(catalog: unknown): Record<string, string> | null {
  let cat = catalog;
  if (typeof cat === 'string') {
    try { cat = JSON.parse(cat); } catch { return null; }
  }
  if (!cat || typeof cat !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [id, def] of Object.entries(cat as Record<string, unknown>)) {
    const api = (def as { api?: unknown } | null)?.api;
    if (typeof api === 'string' && /^https?:\/\//.test(api)) out[id] = api;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// kv 值形态 {updatedAt, digest, body}（body 是 catalog 的 JSON 字符串；
// digest = sha256(body 原始字节)，实测 2.0.18）。digest 校验防 raw 扫描的
// 碎片损伤静默产出错误 upstream；digest 字段缺失时尽力接受（schema 演进
// 容错）。bodyByteEncoding：sqlite 路径 body 是正经 utf-8 解码的 JS 字符串；
// raw 扫描路径是 latin1 解码（bijective），各自按原编码还原字节后哈希。
function parseModelsDevKvValue(value: string, bodyByteEncoding: 'utf8' | 'latin1'): Record<string, string> | null {
  let parsed: { digest?: unknown; body?: unknown };
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.body !== 'string') return null;
  if (typeof parsed.digest === 'string') {
    const actual = crypto.createHash('sha256').update(Buffer.from(parsed.body, bodyByteEncoding)).digest('hex');
    if (actual !== parsed.digest) return null;
  }
  return parseModelsDevCatalog(parsed.body);
}

// raw 扫描的读取上限/块大小（catalog 实测 5.9MB，留量级余量）
const SCRAPE_CHUNK_BYTES = 8 * 1024 * 1024;
const SCRAPE_TAIL_BYTES = 64 * 1024 * 1024;
const SCRAPE_VALUE_CAP_BYTES = 64 * 1024 * 1024;

// 从 fd 的 start 位置顺序读取并平衡扫描出完整 JSON（跨 chunk 状态机：
// depth/inString/escape；sqlite 记录里 key 列值与 value 列值相邻无分隔，
// 值溢出到 overflow 页时字节在文件里不保证连续——扫描不出/解析失败由
// 调用方弃）。返回 latin1 解码的 JSON 文本。
function extractBalancedJsonAt(fd: number, start: number): string | null {
  let pos = start;
  let acc = '';
  let depth = 0;
  let inString = false;
  let escape = false;
  const buf = Buffer.allocUnsafe(SCRAPE_CHUNK_BYTES);
  while (pos - start < SCRAPE_VALUE_CAP_BYTES) {
    let len: number;
    try {
      len = fs.readSync(fd, buf, 0, Math.min(buf.length, SCRAPE_VALUE_CAP_BYTES - (pos - start)), pos);
    } catch { return null; }
    if (len <= 0) return null;
    const chunk = buf.toString('latin1', 0, len);
    acc += chunk;
    let i = 0;
    for (; i < chunk.length; i++) {
      const c = chunk[i];
      if (inString) {
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}') { if (--depth === 0) return acc.slice(0, acc.length - (chunk.length - i - 1)); }
    }
    pos += len;
  }
  return null;
}

// raw 字节扫描提取 kv 值（latin1 空间：标记/结构/转义全 ASCII，非 ASCII
// 只表现为字符串值内的 mojibake，api URL 恒 ASCII 不受影响）。尾部 64MB
// 优先（kv 行多在近期写入的页——catalog 由后台 refresh 周期刷新），失败
// 再全量。多个命中逐个尝试（freelist 里的陈旧副本解析失败/digest 不符自
// 动跳过）。2GiB+ 的库 readFileSync 直接失败（ERR_FS_FILE_TOO_LARGE），
// 必须 chunked。
function scrapeModelsDevKvValue(dbPath: string): string | null {
  let size: number;
  try { size = fs.statSync(dbPath).size; } catch { return null; }
  const regions: Array<[number, number]> = [];
  if (size > SCRAPE_TAIL_BYTES) regions.push([size - SCRAPE_TAIL_BYTES, size]);
  regions.push([0, size]);
  const needle = MODELS_DEV_KV_KEY + '{"updatedAt"';
  for (const [from, to] of regions) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(dbPath, 'r');
      let pos = from;
      let carry = '';
      while (pos < to) {
        const len = Math.min(SCRAPE_CHUNK_BYTES, to - pos);
        const buf = Buffer.allocUnsafe(len);
        fs.readSync(fd, buf, 0, len, pos);
        const chunk = carry + buf.toString('latin1');
        let searchFrom = 0;
        for (;;) {
          const hit = chunk.indexOf(needle, searchFrom);
          if (hit < 0) break;
          const value = extractBalancedJsonAt(fd, pos - carry.length + hit + MODELS_DEV_KV_KEY.length);
          if (value !== null) return value;
          searchFrom = hit + 1;
        }
        carry = chunk.slice(Math.max(0, chunk.length - (needle.length + 64)));
        pos += len;
      }
    } catch { return null; }
    finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* */ } }
    }
  }
  return null;
}

// ① node:sqlite 只读读 kv 值。失败一律 null（文件不存在/非 sqlite 库/无
// kv 表——1.x 时代的库/行不存在/忙锁），由调用方落下一层。
function readKvValueViaSqlite(dbPath: string): string | null {
  const mod = nodeSqlite();
  if (!mod) return null;
  let db: SqliteDatabaseSync | null = null;
  try {
    db = new mod.DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(MODELS_DEV_KV_KEY) as { value?: unknown } | undefined;
    return row && typeof row.value === 'string' ? row.value : null;
  } catch { return null; }
  finally { if (db) { try { db.close(); } catch { /* */ } } }
}

// models.dev catalog 的磁盘来源读取（路径注入可测）：
// <dataDir>/opencode.db（kv 表 / raw 扫描）→ <cacheDir>/models.json。
// 任何一层解析成功即返回 {providerId: api}；全线 miss 返回 null。
export function readModelsDevUpstreams(sources: { dataDir: string; cacheDir: string }): Record<string, string> | null {
  const dbPath = path.join(sources.dataDir, 'opencode.db');
  const viaSqlite = readKvValueViaSqlite(dbPath);
  if (viaSqlite !== null) {
    const r = parseModelsDevKvValue(viaSqlite, 'utf8');
    if (r) return r;
  }
  const viaScrape = scrapeModelsDevKvValue(dbPath);
  if (viaScrape !== null) {
    const r = parseModelsDevKvValue(viaScrape, 'latin1');
    if (r) return r;
  }
  try {
    const text = fs.readFileSync(path.join(sources.cacheDir, 'models.json'), 'utf-8');
    return parseModelsDevCatalog(JSON.parse(text));
  } catch { return null; }
}
