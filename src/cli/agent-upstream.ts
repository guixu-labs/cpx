// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 各 agent 族的「真实上游」解析单点（镜像契约）。
//
// 契约：捕获代理必须把流量转发到「子进程 agent 在无 cpx 时真正会用的
// 上游」，否则捕获到的请求发向了与真实运行不同的目标（客户案：进程 env
// 的 ANTHROPIC_BASE_URL 被无视 → 回退官方地址 → 代理转发到错误上游）。
// 因此每族的解析链与该 agent 自身配置源的优先级同构，且**作用域同构**——
// agent 的配置宇宙可被 env 重定位（CODEX_HOME / CLAUDE_CONFIG_DIR，harness
// 隔离场景的标配），cpx 必须在子进程的作用域里解析，而非操作员 home：
//   - claude：user 层 settings 锚定 claudeConfigDir（$CLAUDE_CONFIG_DIR →
//     ~/.claude；实测 2.1.278 凭据随目录迁移）
//   - codex：auth.json 检测锚定 codexAuthPath（$CODEX_HOME → ~/.codex）
// 链内优先级（非文档推测）：
// - claude（真机实测 claude 2.1.278 三向冲突实验）：
//     .claude/settings.local.json > .claude/settings.json(project)
//     > user settings.json > 进程 env > 官方默认
//     （settings 的 env 段覆盖同名 shell 变量——进程 env 是最低层）
// - dsh：CONTEXT 旋钮 > 进程 env DEEPSEEK_BASE_URL > 官方默认。
//   cordis.patch.yml 显式 baseURL 优先于 env 但路径不可知，不镜像
//   （运行时已有警告，属已知限制）
// - openai/generic（opencode 未发现 provider 时同链兜底）：
//     旋钮 > 进程 env OPENAI_BASE_URL > 官方默认
// - codex responses：旋钮 > openai_base_url 有效值（argv -c 层 ??
//     config.toml 顶层，调用方归并后注入）> chatgpt auth.json 检测
//     > 官方默认。
//   codex 不读 OPENAI_BASE_URL env（二进制探针：仅 network-proxy 凭据
//   擦除列表出现，不作端点解析）→ 链中无 env 层；采纳 openai_base_url
//   时剥尾部 /v1（codex 向 base 追加 /responses，proxy 侧请求路径已含
//   /v1，不剥会拼出 /v1/v1/responses）
//
// cpx 级旋钮（CONTEXT_PROXY_*_UPSTREAM）置顶：有意打破镜像的手动控制面。
// claude 的 managed-settings 企业层/Bedrock/Vertex 模式不镜像（前者还会
// 击穿 --settings 注入使捕获失效，另一类问题）。
//
// 分层：本模块只收「单协议上游」的链式解析（纯函数，全依赖可注入）；
// opencode/cannbot 的 per-provider 发现（二进制/配置扫描）与 codex 隧道
// 表读取属机械层，留在 cpx-cli 计算后以参数注入。解析结果逐路带 source
// 标注，启动日志打印来源保证可解释性。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentProfile } from './cpx-args';

export interface UpstreamResolution {
  upstream: string;
  /** 人类可读来源标注（启动日志与测试共同锁定的固定词表） */
  source: string;
}

/** claude 族注入 --settings 所需的凭据/模型（与上游同链解析） */
export interface ClaudeAuthConfig {
  apiKey: string | null;
  model: string | null;
}

export interface ProxyUpstreams {
  /** anthropic 协议上游（claude 链或 dsh 链，按 profile） */
  anthropic: UpstreamResolution;
  /** openai 协议上游（openai/generic 直用；opencode 未发现 provider 的兜底） */
  openai: UpstreamResolution;
  /** codex responses 协议上游（仅 codex 流量使用） */
  responses: UpstreamResolution;
  /** per-provider 隧道表（opencode 发现 / codex config 隧道；其余族空） */
  providerUpstreams: Record<string, string>;
  /** claude --settings 注入的 apiKey/model */
  claude: ClaudeAuthConfig;
}

export interface ResolveUpstreamsOpts {
  /** 进程 env（默认 process.env；测试注入） */
  processEnv?: NodeJS.ProcessEnv;
  /** 用户主目录（默认 os.homedir()；控制 ~/.claude、~/.codex fallback） */
  homeDir?: string;
  /** 项目目录（默认 process.cwd()；控制 .claude/settings*.json 两层） */
  projectDir?: string;
  /** opencode/cannbot 已发现的 per-provider 上游表（cpx-cli 机械层产物） */
  opencodeUpstreams?: Record<string, string>;
  /** codex 已发现的 per-provider 隧道 origin 表（config 层 ∪ argv -c 层） */
  codexTunnels?: Record<string, string>;
  /** codex openai_base_url 有效值（argv -c 层 ?? config.toml 顶层；null=未设） */
  codexOpenaiBaseUrl?: string | null;
  /** codex auth.json 路径（CODEX_HOME-aware，codexAuthPath 产物；chatgpt
   *  登录检测作用域与子进程同宇宙——issue #156 同类作用域失配的收口） */
  codexAuthJson?: string;
}

const CLAUDE_OFFICIAL = 'https://api.anthropic.com';
const DEEPSEEK_OFFICIAL = 'https://api.deepseek.com/anthropic';
const OPENAI_OFFICIAL = 'https://api.openai.com';

/** 取非空值：空串/纯空白视为未设（避免空 env 产生空上游拼出畸形 URL） */
function pickEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

/** 读 claude settings.json 的 env 段（文件缺失/解析失败 = 无该层） */
function readSettingsEnv(file: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
    return (JSON.parse(raw).env ?? {}) as Record<string, string>;
  } catch {
    return {};
  }
}

/** claude 配置目录单点（作用域同构）：$CLAUDE_CONFIG_DIR（env 重定位，
 *  harness 隔离场景）→ ~/.claude。实测 claude 2.1.278：CLAUDE_CONFIG_DIR
 *  指向空目录时凭据/配置随之迁移（"Not logged in"）——settings 的 user 层
 *  与原生转录路径都锚定在这里。cpx-cli 的 claudeNativeLogPath 同源引用。 */
export function claudeConfigDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const v = env.CLAUDE_CONFIG_DIR?.trim();
  return v ? v : path.join(homeDir, '.claude');
}

/** claude 配置层（真机实测优先级：proj-local > proj > user；cpx 注入的
 *  --settings 是最高层，由 buildLaunch 全量覆写保证，不在本表）。
 *  user 层锚定 claudeConfigDir（CLAUDE_CONFIG_DIR 感知——harness 隔离时
 *  cpx 必须读 harness 侧的 user settings，而非操作员 home 的）。 */
interface ClaudeTier { source: string; env: Record<string, string> }

function claudeTiers(env: NodeJS.ProcessEnv, homeDir: string, projectDir: string): ClaudeTier[] {
  return [
    { source: '.claude/settings.local.json env (project)', env: readSettingsEnv(path.join(projectDir, '.claude', 'settings.local.json')) },
    { source: '.claude/settings.json env (project)', env: readSettingsEnv(path.join(projectDir, '.claude', 'settings.json')) },
    { source: 'user settings.json env', env: readSettingsEnv(path.join(claudeConfigDir(env, homeDir), 'settings.json')) },
  ];
}

/** 层内取值（空串视为未设）；无命中返回 null */
function pickTier(tiers: ClaudeTier[], key: string): { value: string; source: string } | null {
  for (const t of tiers) {
    const v = t.env[key]?.trim();
    if (v) return { value: v, source: t.source };
  }
  return null;
}

function resolveClaudeUpstream(env: NodeJS.ProcessEnv, tiers: ClaudeTier[]): UpstreamResolution {
  const knob = pickEnv(env, 'CONTEXT_PROXY_ANTHROPIC_UPSTREAM');
  if (knob) return { upstream: knob, source: 'CONTEXT_PROXY_ANTHROPIC_UPSTREAM override' };
  const tier = pickTier(tiers, 'ANTHROPIC_BASE_URL');
  if (tier) return { upstream: tier.value, source: tier.source };
  const fromEnv = pickEnv(env, 'ANTHROPIC_BASE_URL');
  if (fromEnv) return { upstream: fromEnv, source: 'process env ANTHROPIC_BASE_URL' };
  return { upstream: CLAUDE_OFFICIAL, source: 'default (api.anthropic.com)' };
}

function resolveDshUpstream(env: NodeJS.ProcessEnv): UpstreamResolution {
  const knob = pickEnv(env, 'CONTEXT_PROXY_ANTHROPIC_UPSTREAM');
  if (knob) return { upstream: knob, source: 'CONTEXT_PROXY_ANTHROPIC_UPSTREAM override' };
  const fromEnv = pickEnv(env, 'DEEPSEEK_BASE_URL');
  if (fromEnv) return { upstream: fromEnv, source: 'process env DEEPSEEK_BASE_URL' };
  return { upstream: DEEPSEEK_OFFICIAL, source: 'default (api.deepseek.com/anthropic)' };
}

function resolveOpenaiUpstream(env: NodeJS.ProcessEnv): UpstreamResolution {
  const knob = pickEnv(env, 'CONTEXT_PROXY_OPENAI_UPSTREAM');
  if (knob) return { upstream: knob, source: 'CONTEXT_PROXY_OPENAI_UPSTREAM override' };
  const fromEnv = pickEnv(env, 'OPENAI_BASE_URL');
  if (fromEnv) return { upstream: fromEnv, source: 'process env OPENAI_BASE_URL' };
  return { upstream: OPENAI_OFFICIAL, source: 'default (api.openai.com)' };
}

function resolveResponsesUpstream(env: NodeJS.ProcessEnv, codexAuthJson: string, codexOpenaiBaseUrl: string | null): UpstreamResolution {
  const knob = pickEnv(env, 'CONTEXT_PROXY_RESPONSES_UPSTREAM');
  if (knob) return { upstream: knob, source: 'CONTEXT_PROXY_RESPONSES_UPSTREAM override' };
  const cfg = codexOpenaiBaseUrl?.trim() || null;
  if (cfg) {
    // codex 配置采纳的上游 verbatim（只剥尾斜杠）：codex 向 base 追加
    // /responses，cpx 注入 base_url=<proxy>/v1 使请求路径为 /v1/responses，
    // 转发时（server.ts）剥路径前缀 /v1 → 还原 codex 直连 base + /responses
    // 的字节形态——base 不以 /v1 结尾（网关路径）时同样成立；整条 base 结尾
    // 各异的 /v1 剥法只对 /v1 结尾的 base 对，会把网关路径拼出多余 /v1。
    return { upstream: cfg.replace(/\/+$/, ''), source: 'config.toml openai_base_url' };
  }
  // chatgpt 登录用户：codex 走 chatgpt 后端而非 API key 端点（auth.json
  // 存在且未设 OPENAI_API_KEY 即视为该形态）。auth.json 作用域与 config
  // 同源（CODEX_HOME-aware，codexAuthPath 由调用方注入——cpx 与子进程
  // 看同一个宇宙）。
  if (!pickEnv(env, 'OPENAI_API_KEY') && fs.existsSync(codexAuthJson)) {
    return { upstream: 'https://chatgpt.com/backend-api/codex', source: 'chatgpt auth.json' };
  }
  // 内置 openai 端点默认带 /v1 后缀（codex 向 base 追加 /responses）——
  // 与转发侧剥路径前缀 /v1 对齐后还原出 https://api.openai.com/v1/responses
  return { upstream: 'https://api.openai.com/v1', source: 'default (api.openai.com/v1)' };
}

export function resolveProxyUpstreams(profile: AgentProfile, opts: ResolveUpstreamsOpts = {}): ProxyUpstreams {
  const env = opts.processEnv ?? process.env;
  const homeDir = opts.homeDir ?? os.homedir();
  const projectDir = opts.projectDir ?? process.cwd();

  const tiers = claudeTiers(env, homeDir, projectDir);
  const anthropic = profile === 'dsh' ? resolveDshUpstream(env) : resolveClaudeUpstream(env, tiers);

  // apiKey/model 与 upstream 同链同层序（settings env 覆盖同名 shell 变量）
  const apiKey = pickTier(tiers, 'ANTHROPIC_API_KEY')?.value ?? pickEnv(env, 'ANTHROPIC_API_KEY') ?? null;
  const model = pickTier(tiers, 'ANTHROPIC_MODEL')?.value ?? pickEnv(env, 'ANTHROPIC_MODEL') ?? null;

  return {
    anthropic,
    openai: resolveOpenaiUpstream(env),
    responses: resolveResponsesUpstream(env, opts.codexAuthJson ?? path.join(homeDir, '.codex', 'auth.json'), opts.codexOpenaiBaseUrl ?? null),
    providerUpstreams:
      profile === 'opencode' || profile === 'cannbot' ? (opts.opencodeUpstreams ?? {})
      : profile === 'codex' ? (opts.codexTunnels ?? {})
      : {},
    claude: { apiKey, model },
  };
}

/** 启动日志的单一展示上游（每族取「该 profile 主流量」的解析结果），
 *  与既有 displayUpstream 语义一致 + source 标注 */
export function primaryUpstream(profile: AgentProfile, u: ProxyUpstreams): UpstreamResolution {
  switch (profile) {
    case 'claude':
    case 'dsh':
      return u.anthropic;
    case 'cannbot': {
      const cannbot = u.providerUpstreams['cannbot'];
      return cannbot
        ? { upstream: cannbot, source: 'opencode provider discovery (binary/config)' }
        : u.openai;
    }
    case 'codex': {
      const tunnels = Object.keys(u.providerUpstreams).length;
      return tunnels > 0
        ? { upstream: `${tunnels} provider tunnel(s) + ${u.responses.upstream}`, source: `config.toml [model_providers] + responses (${u.responses.source})` }
        : u.responses;
    }
    case 'opencode':
    case 'openai':
    case 'generic':
      return u.openai;
  }
}
