// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// cpx 参数解析：cpx 保留参数（--autoupload / --submitter / --category /
// --desc / --opgen / --baseline / --agent）在任何位置都被 cpx 拦截消费，
// 绝不透传给 agent —— 否则 `cpx opencode --autoupload` 会把 flag 递给
// opencode，agent 打印帮助即退（零捕获闪退）。其余位置参数原样转发。

export type AgentProfile = 'claude' | 'opencode' | 'cannbot' | 'codex' | 'openai' | 'generic';

export interface CpxArgs {
  profile: AgentProfile;
  agentCmd: string;
  agentArgs: string[];
  /** 补传/自动上传相关保留参数原样回放给 runUpload（flag 与值成对） */
  uploadArgs: string[];
  autoUpload: boolean;
}

const VALUE_FLAGS = new Set(['--submitter', '--desc', '--category', '--opgen']);

export function parseArgs(argv: string[]): CpxArgs {
  const args = argv.slice(2);
  let profile: AgentProfile | null = null;
  let autoUpload = false;
  const rest: string[] = [];
  const uploadArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--agent' && args[i + 1]) { profile = args[i + 1] as AgentProfile; i++; continue; }
    if (a === '--autoupload') { autoUpload = true; continue; }
    if (VALUE_FLAGS.has(a)) {
      if (args[i + 1] !== undefined) { uploadArgs.push(a, args[i + 1]); i++; }
      continue;
    }
    if (a === '--baseline') { uploadArgs.push(a); continue; }
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
  return { profile: profile!, agentCmd, agentArgs, uploadArgs, autoUpload };
}
