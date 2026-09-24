// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// cpx argument parsing: reserved flags (--agent and a few legacy ones) are
// consumed by cpx anywhere on the command line and NEVER forwarded to the
// agent — forwarding unknown flags would make e.g. `cpx opencode --autoupload`
// hand the flag to opencode, which prints help and exits with zero capture.
// All other positional args pass through unchanged.

export type AgentProfile = 'claude' | 'opencode' | 'cannbot' | 'codex' | 'openai' | 'generic';

export interface CpxArgs {
  profile: AgentProfile;
  agentCmd: string;
  agentArgs: string[];
}

// Flags consumed silently (never forwarded to the agent): --autoupload and
// the value-taking legacy flags below. Silently swallowing them keeps old
// wrapper invocations running instead of crashing the agent with unknown
// options.
const SILENT_FLAGS = new Set(['--autoupload', '--baseline', '--submitter', '--desc', '--category', '--opgen']);

export function parseArgs(argv: string[]): CpxArgs {
  const args = argv.slice(2);
  let profile: AgentProfile | null = null;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--agent' && args[i + 1]) { profile = args[i + 1] as AgentProfile; i++; continue; }
    if (SILENT_FLAGS.has(a)) {
      // Value-taking variants: also swallow the following token
      if (a !== '--autoupload' && a !== '--baseline' && args[i + 1] !== undefined) i++;
      continue;
    }
    rest.push(a);
  }
  let rest2 = rest;
  if (rest2[0] === '--') rest2 = rest2.slice(1);
  const agentCmd = rest2[0] ?? '';
  const agentArgs = rest2.slice(1);
  if (!profile) {
    const base = agentCmd.split('/').pop() ?? '';
    if (base === 'claude' || base === 'claude-code') profile = 'claude';
    else if (base === 'opencode') profile = 'opencode';
    else if (base === 'cannbot') profile = 'cannbot';
    else if (base === 'codex') profile = 'codex';
    else profile = 'generic';
  }
  return { profile: profile!, agentCmd, agentArgs };
}
