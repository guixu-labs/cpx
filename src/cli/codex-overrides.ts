// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex 捕获计划（纯函数模块——cpx-cli.ts 顶层执行 main()，UT 无法直接
// import；与 codex-providers.ts / codex-args.ts 同款拆分）。
//
// ── 问题类：配置作用域失配（config-scope divergence）─────────────────────
// cpx 的发现层与子进程 codex 必须看见同一个「有效配置宇宙」，宇宙的来源有
// 两层（与 codex 自身语义同构）：
//   L1 config.toml —— 作用域由 CODEX_HOME 锚定（codex-providers.ts 单点）
//   L2 argv `-c/--config key=value` 覆盖 —— harness 场景常用来注入 provider
//      （客户现场 #156：活跃 provider 只存在于 -c，宿主 config 里没有）
// 此前 cpx 只看 L1 且硬编码操作员 ~/.codex，产生两个方向的镜像失败：
//   - 假阳性隧道（cpx 看得见、子进程看不见）：注入 base_url-only 覆盖 →
//     子进程就地新建无 name 残缺条目 → codex 0.169 加载校验崩溃（#156）
//   - 假阴性隧道（子进程用得上、cpx 看不见）：-c 注入的 provider 流量直连
//     上游 → 捕获零落盘
//
// ── 修复原则（全部实验钉死，见各条目依据）──────────────────────────────
// 1. 作用域同构：L1 经 codexHome 单点读取（#156 根修）。
// 2. 配置层同构：L2 纳入发现层——argv 覆盖分层归并（全局位 < 子命令位，
//    同位后者胜；codex 0.169 实验 E1/E2），四种 -c 形态全收（`-c v`、
//    `-cv` 连写、`--config v`、`--config=v` 连写；实验 F1/F2），`--` 之后
//    不再按 flag 解析（实验 F3）。
// 3. 注入自足：cpx 经 -c 注入的 provider 条目带全字段（name 必带，缺失时
//    fallback id；env_key/wire_api/requires_openai_auth 尽收尽回放）——
//    无论子进程是否已有同名条目可按键合并，注入产物独立通过加载校验。
// 4. 改写优于竞争：对 L2 已有的 base_url / openai_base_url token 就地改值
//    （token 位置与 flag 形态原样保留），不靠「注入同 key 再赌优先级」赢
//    ——优先级是 codex 内部实现细节，0.162→0.169 已经变过一次（全局位
//    整组丢弃规则消失，codex-args.ts 头注的坑即为其产物）。

import type { CodexProviderTable, CodexProviderEntry } from './codex-providers.ts';
import { BARE_ID, RESERVED_IDS, tunnelBaseUrl, codexProviderTable } from './codex-providers.ts';
import { CODEX_VALUE_FLAGS, findCodexSubcommandIndex, withCodexTunnel } from './codex-args.ts';

// ── L2 解析：argv 覆盖层 ──────────────────────────────────────────────

/** 可改写 token（改写目标只有两类 key：provider base_url 与顶层
 *  openai_base_url——其余 key 不动，用户的语义原样保留） */
export interface CodexArgvOverrideToken {
  /** 改写目标 token 在 agentArgs 中的下标（连写形态即 flag token 自身） */
  index: number;
  /** 改写后重组 token 的前缀：'' = 独立值 token 形态；'-c' / '--config=' =
   *  连写形态（位置与 flag 形态原样保留——改写优于竞争原则） */
  flagPrefix: '' | '-c' | '--config=';
  key: string;
  /** 解析后的值（剥引号） */
  value: string;
}

/** argv 层归并后的 provider 条目（字段可缺——harness 只给部分键时如实反映） */
type ArgvProviderEntry = Partial<CodexProviderEntry>;

export interface CodexArgvOverrides {
  /** argv -c 声明的 provider（id → 已知字段；分层归并后的有效表） */
  providers: Record<string, ArgvProviderEntry>;
  /** argv -c 的顶层 openai_base_url（null=未覆盖） */
  openaiBaseUrl: string | null;
  /** argv -c 的活跃 provider 选择（null=未覆盖；cpx 从不改动它，仅透传感知） */
  modelProvider: string | null;
  /** base_url / openai_base_url 两类 key 的可改写 token（含层序信息丢失，
   *  改写不需要优先级——同 key 多 token 一并改写为同一隧道值） */
  tokens: CodexArgvOverrideToken[];
}

/** `-c key=value` / `--config key=value` 单体解析（key=value 形态、引号
 *  剥离）。无 '=' / 空 key → null（非覆盖形态，跳过）。 */
function parseOverrideValue(raw: string): { key: string; value: string } | null {
  const eq = raw.indexOf('=');
  if (eq <= 0) return null;
  const key = raw.slice(0, eq);
  const val = raw.slice(eq + 1);
  // 值引号形态：codex 的 -c 值按 TOML 解析（字符串带引号；裸值按
  // 数字/布尔/字符串宽松处理——实验 F1 裸串生效）。剥引号归一存储。
  if (val.length >= 2 && ((val[0] === '"' && val[val.length - 1] === '"') || (val[0] === "'" && val[val.length - 1] === "'"))) {
    return { key, value: val.slice(1, -1) };
  }
  return { key, value: val };
}

/** provider 字段键 `model_providers.<id>.<field>` 的解析（field 收注入
 *  自足所需的子集；id 过滤与 config 层同一词表——BARE_ID/RESERVED_IDS） */
function applyOverride(key: string, value: string, out: CodexArgvOverrides): void {
  const mp = key.match(/^model_providers\.([A-Za-z0-9_.-]+)\.([A-Za-z0-9_]+)$/);
  if (mp) {
    const [, id, field] = mp;
    if (!BARE_ID.test(id) || RESERVED_IDS.has(id)) return;
    const p = (out.providers[id] ??= {});
    if (field === 'base_url') p.baseUrl = value;
    else if (field === 'name') p.name = value;
    else if (field === 'env_key') p.envKey = value;
    else if (field === 'wire_api') p.wireApi = value;
    else if (field === 'requires_openai_auth') p.requiresOpenaiAuth = value === 'true';
    return;
  }
  if (key === 'openai_base_url') out.openaiBaseUrl = value;
  else if (key === 'model_provider') out.modelProvider = value;
}

/** 可改写 token 的 key 判定：`model_providers.<id>.base_url`（id 过
 *  BARE_ID/RESERVED——同 config 层词表）或顶层 `openai_base_url`。 */
function isRewritableKey(key: string): boolean {
  if (key === 'openai_base_url') return true;
  const mp = key.match(/^model_providers\.([^.]+)\.base_url$/);
  return !!mp && BARE_ID.test(mp[1]) && !RESERVED_IDS.has(mp[1]);
}

/** agent 启动参数的 argv 覆盖层解析（发现层的 L2）。
 *  分层归并（实验 E1/E2：子命令位覆盖全局位、同位后者胜）：全局段 token
 *  先应用、子命令段后应用，段内按出现序；subcommands=null（探测失败）时
 *  无法分层，全量按 argv 序归并（近似 fail-safe——探测失败时注入同样退
 *  全局位，见 codex-args.ts）。
 *  四种 -c 形态全收（实验 F1/F2）；`--` 之后不再解析（实验 F3）。 */
export function parseCodexArgvOverrides(
  agentArgs: readonly string[],
  subcommands: ReadonlySet<string> | null,
): CodexArgvOverrides {
  const out: CodexArgvOverrides = { providers: {}, openaiBaseUrl: null, modelProvider: null, tokens: [] };
  const subIdx = findCodexSubcommandIndex(agentArgs, subcommands);
  const segments: number[][] = subIdx < 0
    ? [agentArgs.map((_, i) => i)]
    : [agentArgs.map((_, i) => i).filter((i) => i < subIdx), agentArgs.map((_, i) => i).filter((i) => i >= subIdx)];
  for (const seg of segments) {
    let k = 0;
    while (k < seg.length) {
      const i = seg[k];
      const t = agentArgs[i];
      if (t === '--') break; // prompt 吸收边界（实验 F3）
      if (t === '-c' || t === '--config') {
        const raw = agentArgs[i + 1];
        if (raw !== undefined) {
          const parsed = parseOverrideValue(raw);
          if (parsed) {
            applyOverride(parsed.key, parsed.value, out);
            if (isRewritableKey(parsed.key)) {
              out.tokens.push({ index: i + 1, flagPrefix: '', key: parsed.key, value: parsed.value });
            }
          }
          k += 2;
          continue;
        }
      } else if (t.startsWith('--config=') && t.length > '--config='.length) {
        const parsed = parseOverrideValue(t.slice('--config='.length));
        if (parsed) {
          applyOverride(parsed.key, parsed.value, out);
          if (isRewritableKey(parsed.key)) {
            out.tokens.push({ index: i, flagPrefix: '--config=', key: parsed.key, value: parsed.value });
          }
        }
      } else if (t.startsWith('-c') && t.length > 2 && !t.startsWith('--')) {
        const parsed = parseOverrideValue(t.slice(2));
        if (parsed) {
          applyOverride(parsed.key, parsed.value, out);
          if (isRewritableKey(parsed.key)) {
            out.tokens.push({ index: i, flagPrefix: '-c', key: parsed.key, value: parsed.value });
          }
        }
      } else if (CODEX_VALUE_FLAGS.has(t)) {
        k += 2; // 其他带值 flag：连带跳过其独立值 token
        continue;
      }
      k += 1;
    }
  }
  return out;
}

// ── L2 改写：token 就地改值 ────────────────────────────────────────────

/** argv 层 base_url 的可路由性收口（与 config 层同一语义）：new URL 不可
 *  解析的条目不改写、不进 upstream 表——改写出坏 origin 会把请求转发到
 *  无关主机（错误转发比不捕获严重一个量级）。 */
function routableArgvProviders(argv: CodexArgvOverrides): string[] {
  return Object.entries(argv.providers)
    .filter(([, p]) => {
      if (!p.baseUrl) return false;
      try { new URL(p.baseUrl); return true; } catch { return false; }
    })
    .map(([id]) => id);
}

/** argv 层 token 改写 + upstream origin 表。
 *  改写值统一双引号包裹（TOML 合法字符串形态；harness 原值若是裸串，
 *  URL 裸值的解析行为未验证——加引号规避未知，语义不变）。
 *  返回 upstream origin（argv 层胜 config 层的合并语义由调用方做）。 */
export function rewriteCodexArgvTunnels(
  agentArgs: readonly string[],
  argv: CodexArgvOverrides,
  proxyUrl: string,
): { args: string[]; upstreamOrigins: Record<string, string> } {
  const args = [...agentArgs];
  const upstreamOrigins: Record<string, string> = {};
  for (const tok of argv.tokens) {
    const mp = tok.key.match(/^model_providers\.([A-Za-z0-9_.-]+)\.base_url$/);
    if (mp) {
      const id = mp[1];
      const p = argv.providers[id];
      if (!p?.baseUrl) continue;
      let origin: string;
      try { origin = new URL(p.baseUrl).origin; } catch { continue; } // 不可路由 → 不改写（直连）
      const tunnel = tunnelBaseUrl(proxyUrl, id, p.baseUrl);
      args[tok.index] = `${tok.flagPrefix}${tok.key}="${tunnel}"`;
      upstreamOrigins[id] = origin;
    } else if (tok.key === 'openai_base_url') {
      args[tok.index] = `${tok.flagPrefix}openai_base_url="${proxyUrl}/v1"`;
    }
  }
  return { args, upstreamOrigins };
}

// ── L1 注入构造：全字段自足 ────────────────────────────────────────────

/** config 层隧道的 -c 注入串构造（注入自足原则）。
 *  每个 provider 回放全部已解析字段（name 必带——codex 0.169+ 加载校验
 *  非空，缺失时 fallback id），末尾补 openai_base_url 兜底——中途切回
 *  内置 openai provider 的流量也能捕获。
 *  argvTunnelIds（L2 已声明 base_url 的 id）的 base_url 不注入：argv 改道
 *  是唯一权威（改写优于竞争），若再注入 config base_url，用户 argv token
 *  在全局位时子命令位的注入会胜出，proxy 却按 argv origin 转发 → 路径失配
 *  404（见 tunnelOrigins 合并语义）。其余字段照补。 */
export function buildCodexTunnelOverrides(
  proxyUrl: string,
  table: CodexProviderTable,
  argvTunnelIds: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  for (const [id, p] of Object.entries(table.providers)) {
    if (!argvTunnelIds.has(id)) {
      out.push(`model_providers.${id}.base_url="${tunnelBaseUrl(proxyUrl, id, p.baseUrl)}"`);
    }
    out.push(`model_providers.${id}.name="${p.name ?? id}"`);
    if (p.envKey != null) out.push(`model_providers.${id}.env_key="${p.envKey}"`);
    if (p.wireApi != null) out.push(`model_providers.${id}.wire_api="${p.wireApi}"`);
    if (p.requiresOpenaiAuth != null) out.push(`model_providers.${id}.requires_openai_auth=${p.requiresOpenaiAuth}`);
  }
  out.push(`openai_base_url="${proxyUrl}/v1"`);
  return out;
}

// ── 发现层与注入层的组合 ───────────────────────────────────────────────

/** 发现层产物：proxy 无关的 codex 捕获决策输入（主流程在 proxy 端口分配
 *  前就需要 upstream 表与 responses 链输入，注入层再按端口构造参数） */
export interface CodexCaptureDiscovery {
  argv: CodexArgvOverrides;
  /** L1：config.toml 隧道表（CODEX_HOME-aware，codexProviderTable()） */
  table: CodexProviderTable | null;
  /** 合并 upstream origin 表（L1 ∪ L2，argv 层胜——codex 语义：-c 覆盖 config） */
  tunnelOrigins: Record<string, string>;
  /** openai_base_url 的有效值（L2 胜 L1；responses 协议真实上游依据） */
  openaiBaseUrl: string | null;
  /** openai_base_url 有效值的来源（argv -c 层 / config.toml 顶层 / 未设）——
   *  启动日志 source 标注用，不参与解析优先级 */
  openaiBaseUrlSource: 'argv' | 'config' | null;
  /** argv 层声明的活跃 provider（日志与排障用；cpx 从不改动） */
  modelProvider: string | null;
  /** L2 可隧道的 provider id（改写目标） */
  argvTunnelIds: string[];
}

/** codex 捕获发现层（L1 config + L2 argv 归并）。table 可注入（测试直读
 *  临时路径，绕开 codexProviderTable 的模块级缓存）；缺省读运行时缓存表
 *  （CODEX_HOME-aware）。 */
export function discoverCodexCapture(
  agentArgs: readonly string[],
  subcommands: ReadonlySet<string> | null,
  table?: CodexProviderTable | null,
): CodexCaptureDiscovery {
  const argv = parseCodexArgvOverrides(agentArgs, subcommands);
  const config = table !== undefined ? table : codexProviderTable();
  const argvTunnelIds = routableArgvProviders(argv);
  const tunnelOrigins: Record<string, string> = {};
  // L1 origin（config 层，readCodexProviderTable 已过滤不可路由项）
  for (const [id, p] of Object.entries(config?.providers ?? {})) {
    try { tunnelOrigins[id] = new URL(p.baseUrl).origin; } catch { /* 已过滤，不达 */ }
  }
  // L2 origin（argv 层，后写胜——同 id 时 -c 里的 base_url 是 codex 真正会用的）
  for (const id of argvTunnelIds) {
    try { tunnelOrigins[id] = new URL(argv.providers[id].baseUrl!).origin; } catch { /* 已过滤，不达 */ }
  }
  return {
    argv,
    table: config,
    tunnelOrigins,
    openaiBaseUrl: argv.openaiBaseUrl ?? config?.openaiBaseUrl ?? null,
    openaiBaseUrlSource: argv.openaiBaseUrl != null ? 'argv' : (config?.openaiBaseUrl != null ? 'config' : null),
    modelProvider: argv.modelProvider,
    argvTunnelIds,
  };
}

/** 注入层：最终 agent 启动参数（L2 改写在前——token 下标基于原始
 *  agentArgs；L1 注入在后——withCodexTunnel 定位基于结构不变的改写结果）。
 *
 *  分支序（cpx 永不改动用户的活跃 provider 选择）：
 *  1. config 层有隧道表 → 全字段自足注入 + openai_base_url 兜底
 *  2. argv 层声明了 provider（harness -c 注入形态）→ 仅 openai_base_url
 *     兜底注入；provider 流量靠 token 改道（改写优于竞争）
 *  3. 无自定义 provider + OPENAI_API_KEY（纯 OpenAI 用户）→ cpx_proxy
 *     合成条目（自带全字段）并启用
 *  4. 无表无 key（ChatGPT 登录）→ 仅 openai_base_url 覆盖，保留登录态
 */
export function applyCodexCapture(opts: {
  proxyUrl: string;
  agentArgs: readonly string[];
  subcommands: ReadonlySet<string> | null;
  discovery: CodexCaptureDiscovery;
  hasOpenaiApiKey: boolean;
}): string[] {
  const { proxyUrl, agentArgs, subcommands, discovery, hasOpenaiApiKey } = opts;
  const rewritten = rewriteCodexArgvTunnels(agentArgs, discovery.argv, proxyUrl);
  const configIds = discovery.table ? Object.keys(discovery.table.providers) : [];
  const argvDeclaresProvider = discovery.modelProvider !== null || discovery.argvTunnelIds.length > 0;
  let overrides: string[];
  if (configIds.length > 0) {
    overrides = buildCodexTunnelOverrides(proxyUrl, discovery.table!, new Set(discovery.argvTunnelIds));
  } else if (argvDeclaresProvider) {
    overrides = [`openai_base_url="${proxyUrl}/v1"`];
  } else if (hasOpenaiApiKey) {
    overrides = [
      'model_provider=cpx_proxy',
      'model_providers.cpx_proxy.name="cpx-proxy"',
      `model_providers.cpx_proxy.base_url="${proxyUrl}/v1"`,
      'model_providers.cpx_proxy.env_key="OPENAI_API_KEY"',
      'model_providers.cpx_proxy.wire_api="responses"',
      'model_providers.cpx_proxy.requires_openai_auth=false',
    ];
  } else {
    overrides = [`openai_base_url="${proxyUrl}/v1"`];
  }
  return withCodexTunnel(rewritten.args, overrides.flatMap((o) => ['-c', o]), subcommands);
}
