// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// E2E 沙箱（insight「环境五件套隔离」的 cpx 等价物——cpx 无 DB 无端口登记，
// 隔离面换成本仓的真实状态载体）：
//   1. 捕获目录   CONTEXT_PROXY_DIR → 一次性 tmp（绝写用户 ~/.context-insight）
//   2. HOME       → 一次性 tmp（claude settings / codex config.toml / opencode
//                   配置的读取面全部隔离；防开发机配置泄进解析链）
//   3. 网络代理   HTTP(S)_PROXY/ALL_PROXY 全剥（proxy→upstream 跳必须直连
//                   本机桩——server.ts 对代理 env 会挂 EnvHttpProxyAgent）
//   4. cpx 契约   CONTEXT_PROXY_* / CONTEXT_CPX_INSIGHT_BASE 继承值全清后重钉
//                   （insight 钉不可达防机会主义导入；CONTEXT_NO_BROWSER=1
//                   防弹窗；VITEST 继承是 browser-guard 的结构性第二道）
//   5. PATH       bin/ 前置（假 agent / 假 npx / open 桩按名字 spawn 的用例；
//                   绝对路径 spawn 同样可用）
// 外加 XDG 三目录（config/data/cache 预建——opencode/cannbot 族的配置读取
// 面），与 agent 端点发现变量剥除（ANTHROPIC_*/OPENAI_*/DEEPSEEK_*——上游
// 解析链的确定性；用例要什么经 overrides 显式给，而非继承开发机残留）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV, UNREACHABLE_INSIGHT } from './constants';

export interface Sandbox {
  /** 沙箱根（一次性 tmp）。 */
  root: string;
  /** CONTEXT_PROXY_DIR：本沙箱全部捕获文件落这里。 */
  captures: string;
  /** 隔离 HOME（agent 配置读取面）。 */
  home: string;
  /** 假 agent 二进制目录（PATH 前置）。 */
  bin: string;
  /** XDG_CONFIG_HOME（opencode/cannbot 全局配置）。 */
  config: string;
  /** XDG_DATA_HOME（auth.json / catalog 缓存）。 */
  data: string;
  /** XDG_CACHE_HOME（钉死到空——不读开发机真实缓存）。 */
  cache: string;
  /** 构造子进程 env：以 process.env 为底、五件套清洗后叠加 overrides。 */
  env(overrides?: Record<string, string | undefined>): Record<string, string>;
  /** 递归删除（CPX_E2E_KEEP=1 时保留现场排障）。 */
  cleanup(): void;
}

/** 出口网络代理 env（server.ts 的 EnvHttpProxyAgent 触发面）——子进程必须剥净。
 *  NO_PROXY / no_proxy 一并剥：开发机残留的绕过清单若漏进子进程，会让「本跳
 *  恒直连 127.0.0.1 桩」的确定性承诺出现旁路（与注释「NO_PROXY 同剥」对齐）。 */
const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy',
  'NO_PROXY', 'no_proxy',
] as const;

/** agent 端点发现变量（上游解析链的输入）：默认剥除保确定性，用例按需
 *  经 env overrides 显式注入（upstream-resolution 的既证清单）。 */
const AGENT_DISCOVERY_ENV_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'DEEPSEEK_BASE_URL',
] as const;

export function createSandbox(prefix: string): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const captures = path.join(root, 'captures');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const config = path.join(root, 'config');
  const data = path.join(root, 'data');
  const cache = path.join(root, 'cache');
  for (const d of [captures, home, bin, config, data, cache]) fs.mkdirSync(d, { recursive: true });

  const env = (overrides: Record<string, string | undefined> = {}): Record<string, string> => {
    const child: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      // 五件套 3+4：出口代理与 cpx 契约 env 一律不继承（NO_PROXY 同剥——
      // 上游是 127.0.0.1 桩，本跳恒直连；agent→proxy 跳由 cpx-cli 自己注入）
      if (PROXY_ENV_KEYS.includes(k as (typeof PROXY_ENV_KEYS)[number])) continue;
      if (k.startsWith('CONTEXT_PROXY_')) continue;
      if (k === ENV.INSIGHT_BASE) continue;
      if (AGENT_DISCOVERY_ENV_KEYS.includes(k as (typeof AGENT_DISCOVERY_ENV_KEYS)[number])) continue;
      child[k] = v;
    }
    child[ENV.PROXY_DIR] = captures;
    child[ENV.INSIGHT_BASE] = UNREACHABLE_INSIGHT;
    child[ENV.NO_BROWSER] = '1';
    child.HOME = home;
    child.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete child[k];
      else child[k] = v;
    }
    return child;
  };

  const cleanup = (): void => {
    if (!process.env.CPX_E2E_KEEP) fs.rmSync(root, { recursive: true, force: true });
  };

  return { root, captures, home, bin, config, data, cache, env, cleanup };
}
