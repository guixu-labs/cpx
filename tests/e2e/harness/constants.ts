// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// E2E harness 单一事实源（对齐 insight tests/e2e/constants.ts 的定位）：仓内
// wrapper 路径、cpx ↔ proxy ↔ insight 的全部环境契约名、三协议路由、sid 头
// 锚——全部只在这里声明，spec 与 harness 其余模块一律引用，契约漂移一处红。
//
// 契约三方（env 名与 src/server.ts / src/cli/agent-upstream.ts 逐字对齐）：
//   agent ──env 注入──▶ proxy：ANTHROPIC_BASE_URL / OPENAI_BASE_URL / argv -c
//   cpx-cli ──spawn env──▶ proxy：CONTEXT_PROXY_{PORT,SESSION_ID,*_UPSTREAM,DIR}
//   cpx-cli ──HTTP──▶ insight：CONTEXT_CPX_INSIGHT_BASE / claude-jsonl import

import path from 'node:path';

/** 仓根（tests/e2e/harness → tests/e2e → tests → 仓根）。 */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** 真仓内 wrapper：bash 脚本，自行寻 tsx 后 exec 真源码 cpx-cli.ts——E2E 全走
 *  真用户入口，绝不 import 源码进测试进程（与 insight「真构建真服务」同款
 *  纪律：被测物必须是真实启动形态）。 */
export const WRAPPER = path.join(REPO_ROOT, 'cpx-cli');

/** 环境契约名（cpx 的「协议面」——改名必须动这里，spec 永不写字面量）。 */
export const ENV = {
  /** 捕获目录（proxy 落盘 + cpx-cli 清单读取的同一根） */
  PROXY_DIR: 'CONTEXT_PROXY_DIR',
  /** insight 实例地址（退出自动导入 + 开浏览器；测试钉死不可达或指 mock） */
  INSIGHT_BASE: 'CONTEXT_CPX_INSIGHT_BASE',
  /** 浏览器副作用熔断（vitest 继承链结构性防弹窗的显式开关） */
  NO_BROWSER: 'CONTEXT_NO_BROWSER',
  /** 三协议上游（agent-upstream 解析的最高优先 override） */
  ANTHROPIC_UPSTREAM: 'CONTEXT_PROXY_ANTHROPIC_UPSTREAM',
  OPENAI_UPSTREAM: 'CONTEXT_PROXY_OPENAI_UPSTREAM',
  RESPONSES_UPSTREAM: 'CONTEXT_PROXY_RESPONSES_UPSTREAM',
  /** per-provider 上游表（opencode 路由） */
  PROVIDER_UPSTREAMS: 'CONTEXT_PROXY_PROVIDER_UPSTREAMS',
  /** 会话定位工牌（agent 及其子进程继承；upload/status 按它命中本会话） */
  SESSION_ID: 'CPX_SESSION_ID',
} as const;

/** 代理路由 → 协议（session-resolver.protocolFromPath 的锚子集）。 */
export const ROUTES = {
  anthropic: '/v1/messages',
  openai: '/v1/chat/completions',
  responses: '/v1/responses',
} as const;

/** sid 头契约（session-resolver 的两个 header 锚）。 */
export const SID_HEADERS = {
  /** claude-code 每个 /v1/messages 请求必带；捕获文件按它命名（1:1 对应
   *  claude 原生 jsonl）——与 cpx 钉定 sid 不同值，是头路由的核心断言点 */
  claude: 'x-claude-code-session-id',
  /** opencode 逐请求声明（子会话另带 x-parent-session-id） */
  openai: 'x-session-id',
} as const;

/** 测试默认 insight 指向：127.0.0.1:1 连接必拒——不机会主义导入开发机在跑
 *  的真 insight、不开浏览器（要真导入断言的用例改指 mock insight）。 */
export const UNREACHABLE_INSIGHT = 'http://127.0.0.1:1';

/** 捕获文件名形态（writer.captureStem 的契约复述——reader 直接复用生产件）。 */
export const CAPTURE_PREFIX = 'cpx-';
