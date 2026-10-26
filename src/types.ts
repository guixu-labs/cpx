// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

export type Protocol = 'anthropic' | 'openai' | 'responses';

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // OpenAI 协议思考计费通道（usage.completion_tokens_details.reasoning_tokens）。
  // anthropic wire 无此字段（thinking 计入 output_tokens），仅 openai 重组器
  // 填充；emitter 读它写 x_lake cc-wire-round.reasoningTokens，insight 侧
  // 既有通道恢复 Turn reasoning tokens（anthropic 通道恒不填充，无串扰）。
  reasoning_tokens?: number;
}

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Record<string, unknown> | unknown[];
}

export interface OpenAIContentBlock {
  type: string;
  text?: string;
  id?: string;
  function?: { name?: string; arguments?: string };
  tool_call_id?: string;
  content?: string | unknown[];
}

export interface AnthropicMessage {
  role: string;
  content?: string | AnthropicContentBlock[];
}

export interface OpenAIMessage {
  role: string;
  content?: string | OpenAIContentBlock[] | null;
}

export interface ProxyRecord {
  sid: string;
  protocol: Protocol;
  receivedAt: number;
  completedAt: number;
  latencyMs: number;
  // Time to first token (streaming only); null for non-stream responses.
  ttftMs: number | null;
  request: {
    path: string;
    model: string | null;
    body: unknown;
    /** claude 子代理请求专属身份头 x-claude-code-agent-id（主会话无此头）。
     *  逻辑成员级标识：续会（看门狗重启/继续）继承同值——按它分桶子代理流
     *  可把续会归回原成员，替代按任务 prompt md5 分桶的猜谜 */
    claudeAgentId: string | null;
  };
  response: {
    status: number;
    model: string | null;
    stop_reason: string | null;
    content: AnthropicContentBlock[] | unknown;
    usage: AnthropicUsage | OpenAIUsage | null;
  };
  // opencode sends `x-session-id`/`x-session-affinity` headers (value: ses_xxx).
  // Subagents are child sessions with a DIFFERENT x-session-id, so this is the
  // reliable wire-level signal for subagent routing (claude relies on system
  // prompt text cc_is_subagent instead). Null for protocols that don't set it.
  xSessionId?: string | null;
  // opencode child sessions declare their parent via the x-parent-session-id
  // request header (verified on opencode 1.17.9) — deterministic subagent
  // routing with the parent's real session id. null for main/claude requests.
  parentSessionId?: string | null;
  // 原始 user-agent（claude-cli/x.y.z / opencode/x.y.z）—— agent 版本号来源
  userAgent?: string | null;
}
