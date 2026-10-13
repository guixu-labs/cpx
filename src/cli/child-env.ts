// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Child-process env sanitation (pure module — cpx-cli.ts runs main() at module
// top level and cannot be imported by unit tests).
//
// The agent→proxy hop is ALWAYS loopback. When the user's shell exports a
// proxy ladder (global, or window/project-scoped via a script-launched
// terminal), HTTP(S)_PROXY is inherited by the agent child — reqwest (codex),
// undici (opencode) and curl-family clients all honor it, and without an
// explicit exclusion the LOCAL hop can get routed into the ladder too.
// Injecting NO_PROXY (both cases — clients differ in which they read) keeps
// the local hop direct in every network scenario, decoupled from how the
// proxy's own EGRESS is configured (server.ts EnvHttpProxyAgent).

export function loopbackNoProxy(env: NodeJS.ProcessEnv = process.env): string {
  // NO_PROXY 与 no_proxy 可能同时存在且值不同（不同工具各写一个）——两个
  // 都要并入，只读其一会让另一方的排除项静默丢失。去重按小写归一
  // （NO_PROXY 匹配语义本就大小写不敏感），保留首个出现的原始大小写。
  const parts = ['localhost', '127.0.0.1'];
  const seen = new Set(parts.map((p) => p.toLowerCase()));
  for (const raw of [env.NO_PROXY, env.no_proxy]) {
    for (const piece of String(raw ?? '').split(',')) {
      const t = piece.trim();
      const key = t.toLowerCase();
      if (t && !seen.has(key)) {
        seen.add(key);
        parts.push(t);
      }
    }
  }
  return parts.join(',');
}
