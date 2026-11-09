// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// dsh 旅程（wire 自描述框架——与注入契约无关的另一半识别机制）：
//   · 框架标签不靠 --agent 说了算，靠 body.dsh_session_log 判定：行级
//     source='dsh-proxy'、meta framework='dsh'（claude/opencode 靠注入，
//     dsh/cannbot 靠 wire 形态——同一 anthropic 协议的三种出身）
//   · 血缘权威在 body（dsh 官方 wireHeader 序列化的 session 对象，非
//     HTTP 头——实测 dsh 头里无 parent 标识）：子会话带自己的
//     x-deepseek-harness-session-id + body 内 parentSession → 落
//     <父sid>/subagents/<子sid>.jsonl（与 claude 子代理同布局，insight
//     侧 listSubagentSessions 零改动发现）
//   · descriptor 事件（label/mode）→ 子 meta 的 name/agentType

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { startUpstreamStub, type UpstreamStub, type UpstreamScript } from './harness/upstream-stub';
import { protocolAgent } from './harness/fake-agent';
import { readCaptureLines, captureFile, assertClaudeJsonlContract } from './harness/capture';
import { runCpx } from './harness/session';
import { ENV, ROUTES } from './harness/constants';

let sandbox: Sandbox;
let stub: UpstreamStub;

beforeAll(async () => {
  sandbox = createSandbox('cpx-dsh-');
  stub = await startUpstreamStub();
});

afterAll(() => {
  sandbox.cleanup();
  return stub.close();
});

const MAIN_SID = 'e2e-dsh-main';
const CHILD_SID = 'e2e-dsh-child';

function anthropicText(text: string): UpstreamScript {
  return {
    kind: 'json',
    body: { id: 'msg_dsh', model: 'deepseek-v4', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 2 } },
  };
}

describe('cpx dsh 旅程（wire 自描述框架标签 + body 血缘子代理）', () => {
  it('dsh 主会话：body 判定框架标签（dsh-proxy / framework=dsh）；子会话按 parentSession 归树', async () => {
    stub.scriptQueue(ROUTES.anthropic, [anthropicText('主回答'), anthropicText('子回答')]);
    const agent = protocolAgent(sandbox, {
      mode: 'dsh',
      name: 'fake-dsh',
      requests: [
        {
          sid: MAIN_SID,
          body: {
            model: 'deepseek-v4', max_tokens: 32,
            dsh_session_log: { session: { id: MAIN_SID, origin: 'main', delegationDepth: 0 } },
            messages: [{ role: 'user', content: 'dsh 主会话提问' }],
          },
        },
        {
          sid: CHILD_SID,
          body: {
            model: 'deepseek-v4', max_tokens: 32,
            dsh_session_log: {
              session: { id: CHILD_SID, parentSession: MAIN_SID, origin: 'subagent', delegationDepth: 1 },
              events: [{ type: 'subagent/descriptor', data: { label: '研究员', mode: 'research' } }],
            },
            messages: [{ role: 'user', content: 'dsh 子代理任务' }],
          },
        },
      ],
    });

    const r = await runCpx(sandbox, ['--agent', 'dsh', agent.path], {
      env: { [ENV.ANTHROPIC_UPSTREAM]: stub.url },
    });
    expect(r.code, `cpx output:\n${r.output}`).toBe(0);

    // ── 主会话：wire 自描述判定——source=dsh-proxy、framework=dsh ──
    const main = readCaptureLines(sandbox, MAIN_SID);
    assertClaudeJsonlContract(main);
    expect(JSON.stringify(main)).toContain('dsh 主会话提问');
    expect((main.find((l) => l.type === 'user') as { source: string }).source).toBe('dsh-proxy');
    const mainMetaPath = captureFile(sandbox, MAIN_SID).replace(/\.jsonl(\.7z|\.gz)?$/, '.meta.json');
    const mainMeta = JSON.parse(fs.readFileSync(mainMetaPath, 'utf8')) as { x_lake: { schema: string; data: { framework: string; protocol: string } } };
    expect(mainMeta.x_lake.schema).toBe('cc-session-meta');
    expect(mainMeta.x_lake.data.framework).toBe('dsh');
    expect(mainMeta.x_lake.data.protocol).toBe('anthropic');

    // ── 子会话：<父sid>/subagents/<子sid>.jsonl（与 claude 同布局）────
    const childRel = `${MAIN_SID}/subagents/${CHILD_SID}`;
    const child = readCaptureLines(sandbox, MAIN_SID, childRel);
    assertClaudeJsonlContract(child);
    expect(JSON.stringify(child)).toContain('dsh 子代理任务');
    expect((child.find((l) => l.type === 'user') as { source: string }).source).toBe('dsh-proxy');

    // ── 子 meta：toolUseId=null（父侧推导不做）+ descriptor 的名与型号 ──
    const childMetaPath = captureFile(sandbox, MAIN_SID, childRel).replace(/\.jsonl(\.7z|\.gz)?$/, '.meta.json');
    expect(fs.existsSync(childMetaPath), `child meta ${childMetaPath}`).toBe(true);
    const childMeta = JSON.parse(fs.readFileSync(childMetaPath, 'utf8')) as {
      toolUseId: string | null; name: string | null; agentType: string | null;
      x_lake: { schema: string; data: Record<string, unknown> };
    };
    expect(childMeta.toolUseId).toBeNull();
    expect(childMeta.name).toBe('研究员');
    expect(childMeta.agentType).toBe('research');
    expect(childMeta.x_lake.schema).toBe('cc-subagent-meta');
    expect(childMeta.x_lake.data).toEqual({
      toolUseId: null, name: '研究员', agentType: 'research', subagentSessionId: CHILD_SID,
    });
  }, 120_000);
});
