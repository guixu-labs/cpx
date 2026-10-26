// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Self-contained proxy test: verify the emitter's JSON OUTPUT is correct
// extended claude-format (no context-insight / Prisma dependency). The
// context-insight claude-jsonl adapter (its own tests) consumes this format;
// the two sides are coupled only by the format contract.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emit, ccVersionFromSystem, proxySourceMarker, agentFrameworkLabel } from '../../src/claude-emitter.ts';
import { sessionFilePath } from '../../src/writer.ts';

const SID = 'cpx-claude-fmt';
const FIXTURE = path.resolve(__dirname, 'data/cpx-claude-format.jsonl');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-emitter-'));
process.env.CONTEXT_PROXY_DIR = tmpDir; // BEFORE sessionFilePath is evaluated at module scope
const mainFile = sessionFilePath(SID); // cpx- prefixed, keyed by real sid
const subagentsDir = path.join(tmpDir, SID, 'subagents');

function readJsonl(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}
function subFiles(): string[] {
  if (!fs.existsSync(subagentsDir)) return [];
  return fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl'));
}
function metaFiles(): string[] {
  if (!fs.existsSync(subagentsDir)) return [];
  return fs.readdirSync(subagentsDir).filter(f => f.endsWith('.meta.json'));
}

beforeAll(() => {
  const lines = fs.readFileSync(FIXTURE, 'utf-8').split('\n').filter(l => l.trim());
  for (const line of lines) {
    try { emit(JSON.parse(line)); } catch { /* skip */ }
  }
});

describe('ccVersionFromSystem（版本号提取）', () => {
  it('数字 build（.467）与混合 build（.c19）都能取全，吃到 ; 为止', () => {
    expect(ccVersionFromSystem([{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.234.467; cc_entrypoint=cli;' }])).toBe('2.1.234.467');
    expect(ccVersionFromSystem([{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.234.c19; cc_entrypoint=sdk-cli;' }])).toBe('2.1.234.c19');
    expect(ccVersionFromSystem('no version here')).toBeNull();
  });
});

describe('claude-emitter: wire-record → extended claude-format JSON', () => {
  it('main session jsonl has claude user + assistant lines', () => {
    const rows = readJsonl(mainFile);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r => r.type === 'user')).toBe(true);
    expect(rows.some(r => r.type === 'assistant')).toBe(true);
  });

  it('assistant lines carry extension system + tools fields', () => {
    const asst = readJsonl(mainFile).find(r => r.type === 'assistant');
    expect(asst.tools).toBeDefined();
    expect(asst.tools.length).toBe(3); // Read, Bash, Agent
    expect(asst.tools.map((t: any) => t.name).sort()).toEqual(['Agent', 'Bash', 'Read']);
    expect(asst.system).toBeDefined();
  });

  it('title-generation record is skipped', () => {
    const all = [...readJsonl(mainFile), ...subFiles().flatMap(f => readJsonl(path.join(subagentsDir, f)))];
    expect(all.every(r => !JSON.stringify(r).includes('sentence-case title'))).toBe(true);
  });

  it('routes 2 subagents to <sid>/subagents/<subId>.jsonl + meta.json', () => {
    expect(subFiles().length).toBe(2);
    expect(metaFiles().length).toBe(2);
  });

  it('each subagent file has user(task) + assistant lines', () => {
    for (const f of subFiles()) {
      const rows = readJsonl(path.join(subagentsDir, f));
      expect(rows.some(r => r.type === 'user')).toBe(true);
      expect(rows.some(r => r.type === 'assistant')).toBe(true);
    }
  });

  it('subagent meta.json links toolUseId + name + agentType', () => {
    const metas = metaFiles().map(f => JSON.parse(fs.readFileSync(path.join(subagentsDir, f), 'utf-8')));
    const a = metas.find((m: any) => m.toolUseId === 'tu_A');
    const b = metas.find((m: any) => m.toolUseId === 'tu_B');
    expect(a).toBeDefined();
    expect(a.name).toBe('Sub A');
    expect(a.agentType).toBe('reviewer');
    expect(b).toBeDefined();
    expect(b.name).toBe('Sub B');
    expect(b.agentType).toBe('reviewer');
  });

  it('does NOT duplicate prior assistant responses (delta skips role:assistant)', () => {
    // main: dispatch (rec1 response) + done (rec5 response) = 2 assistants only.
    const mainAsst = readJsonl(mainFile).filter(r => r.type === 'assistant');
    expect(mainAsst.length).toBe(2);
    // subA: A1 (rec2) + A2 (rec4) = 2; subB: B1 (rec3) = 1.
    const counts = subFiles().map(f => readJsonl(path.join(subagentsDir, f)).filter(r => r.type === 'assistant').length).sort();
    expect(counts).toEqual([1, 2]);
  });

  it('main assistant dispatch line carries the 2 Agent tool_use blocks', () => {
    const dispatch = readJsonl(mainFile).find(r => r.type === 'assistant' && Array.isArray(r.message?.content) && r.message.content.some((b: any) => b.type === 'tool_use' && b.name === 'Agent'));
    expect(dispatch).toBeDefined();
    const agents = dispatch.message.content.filter((b: any) => b.type === 'tool_use' && b.name === 'Agent');
    expect(agents.length).toBe(2);
    expect(agents.map((b: any) => b.id).sort()).toEqual(['tu_A', 'tu_B']);
  });

  it('emits tool_result user lines (for tool_use→result linking by the consumer)', () => {
    // main: tu_A/tu_B results (rec5); subA: tu_rA result (rec4)
    const mainHas = readJsonl(mainFile).some(r => r.type === 'user' && Array.isArray(r.message?.content) && r.message.content.some((b: any) => b.type === 'tool_result'));
    expect(mainHas).toBe(true);
    const subAFile = subFiles().map(f => path.join(subagentsDir, f)).find(f => readJsonl(f).some(r => r.type === 'user' && Array.isArray(r.message?.content) && r.message.content.some((b: any) => b.type === 'tool_result')));
    expect(subAFile).toBeDefined();
  });
});

describe('claude-emitter: messages-array rewrite (stepped-away recap / edit)', () => {
  const sid = 'cpx-rewrite';
  const file = sessionFilePath(sid);

  function rec(messages: any[], respText: string) {
    return {
      sid,
      protocol: 'anthropic',
      receivedAt: 1_000,
      completedAt: 2_000,
      request: { body: { system: [{ type: 'text', text: 'main system' }], tools: [{ name: 'Read' }], messages } },
      response: { model: 'glm-5.2', content: [{ type: 'text', text: respText }], usage: { input_tokens: 1, output_tokens: 1 } },
    };
  }

  it('emits a new user message that lands INSIDE the already-consumed range after a rewrite', () => {
    // r1: [u1] → emits u1
    emit(rec([{ role: 'user', content: '第一问' }], '答1'));
    // r2: claude rewrote the array — same length, but a NEW message replaced
    // content at an already-emitted position (stepped-away consolidation).
    // Old count-based delta would skip it; occurrence counting must emit it.
    emit(rec([{ role: 'user', content: '数组重写后新落进已消费区间的问题' }], '答2'));
    const rows = readJsonl(file);
    const users = rows.filter(r => r.type === 'user');
    expect(users.some(u => (u.message.content ?? '').includes?.('数组重写后新落进已消费区间的问题') || JSON.stringify(u.message.content).includes('数组重写后新落进已消费区间的问题'))).toBe(true);
  });

  it('does NOT duplicate already-emitted messages when the array only appends', () => {
    const before = readJsonl(file).filter(r => r.type === 'user').length;
    // replay the same array (append-only, next request carries history + new)
    emit(rec([
      { role: 'user', content: '数组重写后新落进已消费区间的问题' },
      { role: 'user', content: '追问' },
    ], '答3'));
    const users = readJsonl(file).filter(r => r.type === 'user');
    expect(users.length).toBe(before + 1); // only 追问 is new
    expect(users.some(u => JSON.stringify(u.message.content).includes('追问'))).toBe(true);
  });

  it('array SHRINK (compaction) then new message still emits', () => {
    emit(rec([{ role: 'user', content: '压缩后的全新对话' }], '答4'));
    const users = readJsonl(file).filter(r => r.type === 'user');
    expect(users.some(u => JSON.stringify(u.message.content).includes('压缩后的全新对话'))).toBe(true);
  });
});

describe('claude-emitter: provenance marker', () => {
  it('every emitted line carries the agent-preserving source marker (claude-proxy)', () => {
    const sid = 'cpx-marker';
    const file = sessionFilePath(sid);
    emit({
      sid,
      protocol: 'anthropic',
      receivedAt: 1, completedAt: 2,
      request: { body: { system: [{ type: 'text', text: 'main system' }], tools: [{ name: 'Read' }], messages: [{ role: 'user', content: 'hi' }] } },
      response: { model: 'glm-5.2', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const rows = readJsonl(file);
    expect(rows.length).toBe(2); // user + assistant
    for (const r of rows) expect(r.source).toBe('claude-proxy');
  });
});

describe('claude-emitter: marker keeps the original agent name', () => {
  it('openai protocol → opencode-proxy', async () => {
    const { proxySourceMarker } = await import('../../src/claude-emitter.ts');
    expect(proxySourceMarker('anthropic')).toBe('claude-proxy');
    expect(proxySourceMarker('openai')).toBe('opencode-proxy');
  });
});

describe('claude-emitter: wire timing extension fields', () => {
  it('assistant line carries duration_ms / stopReason / ttftMs from the record', () => {
    const sid = 'cpx-timing';
    const file = sessionFilePath(sid);
    emit({
      sid,
      protocol: 'anthropic',
      receivedAt: 1_000,
      completedAt: 2_500,
      latencyMs: 1500,
      ttftMs: 200,
      request: { body: { system: [{ type: 'text', text: 's' }], tools: [{ name: 'Read' }], messages: [{ role: 'user', content: 'q' }] } },
      response: { model: 'glm-5.2', content: [{ type: 'text', text: 'a' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const asst = readJsonl(file).find(r => r.type === 'assistant');
    expect(asst).toBeDefined();
    // latency rides the native duration_ms field → flows through the standard
    // pipeline (adapter reads it → interaction.latency → turn-split → DB).
    expect(asst.duration_ms).toBe(1500);
    expect(asst.ttftMs).toBe(200);
    expect(asst.stopReason).toBe('end_turn');
    // user (input) line does NOT carry timing fields
    const user = readJsonl(file).find(r => r.type === 'user');
    expect(user.duration_ms).toBeUndefined();
    expect(user.ttftMs).toBeUndefined();
  });

  it('missing ttftMs (non-stream) is omitted, duration_ms/stopReason still emitted', () => {
    const sid = 'cpx-timing2';
    const file = sessionFilePath(sid);
    emit({
      sid,
      protocol: 'anthropic',
      receivedAt: 1_000,
      completedAt: 3_000,
      latencyMs: 2000,
      ttftMs: null,
      request: { body: { system: [{ type: 'text', text: 's' }], tools: [{ name: 'Read' }], messages: [{ role: 'user', content: 'q' }] } },
      response: { model: 'glm-5.2', content: [{ type: 'text', text: 'a' }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const asst = readJsonl(file).find(r => r.type === 'assistant');
    expect(asst.duration_ms).toBe(2000);
    expect(asst.stopReason).toBe('tool_use');
    expect(asst.ttftMs).toBeUndefined(); // null → JSON.stringify omits
  });
});

describe('claude-emitter: injection dedup (记录压缩)', () => {
  beforeAll(() => { process.env.CONTEXT_PROXY_DEDUP_INJECTION = '1'; });
  afterAll(() => { delete process.env.CONTEXT_PROXY_DEDUP_INJECTION; });
  const sid = 'cpx-dedup';
  const file = sessionFilePath(sid);
  const REGISTRY = 'Available agent types for the Agent tool:\n- claude: Catch-all. (Tools: *)\n- Explore: Read-only search agent.';
  const SKILLS = 'The following skills are available for use with the Skill tool:\n\n- dataviz: Use this skill.';

  function rec(messages: any[], respText: string) {
    return {
      sid,
      protocol: 'anthropic',
      receivedAt: 1_000,
      completedAt: 2_000,
      request: { body: { system: [{ type: 'text', text: 'main system' }], tools: [{ name: 'Read' }], messages } },
      response: { model: 'glm-5.2', content: [{ type: 'text', text: respText }], usage: { input_tokens: 1, output_tokens: 1 } },
    };
  }

  it('first injection emits in full; byte-identical re-append becomes a [已压缩] marker with originalChars', () => {
    // r1: first user + first registry copy → both full
    emit(rec([
      { role: 'user', content: '第一问' },
      { role: 'system', content: [{ type: 'text', text: REGISTRY }] },
    ], '答1'));
    // r2: claude re-appends an IDENTICAL registry copy + new tool_result
    emit(rec([
      { role: 'user', content: '第一问' },
      { role: 'system', content: [{ type: 'text', text: REGISTRY }] },
      { role: 'assistant', content: [{ type: 'text', text: '答1' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'system', content: [{ type: 'text', text: REGISTRY }] },
    ], '答2'));
    const rows = readJsonl(file);
    const fulls = rows.filter(r => r.type === 'system' && JSON.stringify(r.message.content).includes('Available agent types'));
    const markers = rows.filter(r => r.deduped === true);
    expect(fulls.length).toBe(1);            // only the first copy in full
    expect(markers.length).toBe(1);          // the re-append → one marker
    expect(markers[0].originalChars).toBe(REGISTRY.length);
    expect(markers[0].message.content[0].text).toContain('已压缩');
    expect(markers[0].source).toBe('claude-proxy');
  });

  it('CHANGED injection content is NOT deduped — emits in full', () => {
    const REGISTRY_V2 = REGISTRY + '\n- new-agent: Added mid-session.';
    emit(rec([
      { role: 'user', content: '第一问' },
      { role: 'system', content: [{ type: 'text', text: REGISTRY }] },
      { role: 'system', content: [{ type: 'text', text: REGISTRY_V2 }] },
    ], '答3'));
    const rows = readJsonl(file);
    const fulls = rows.filter(r => r.type === 'system' && JSON.stringify(r.message.content).includes('new-agent'));
    expect(fulls.length).toBe(1); // changed roster recorded verbatim
  });

  it('skills-list injection dedups independently of the agent registry', () => {
    emit(rec([
      { role: 'user', content: '第一问' },
      { role: 'system', content: [{ type: 'text', text: SKILLS }] },
      { role: 'system', content: [{ type: 'text', text: SKILLS }] },
    ], '答4'));
    const rows = readJsonl(file);
    const fullSkills = rows.filter(r => r.type === 'system' && !r.deduped && JSON.stringify(r.message.content).includes('skills are available'));
    expect(fullSkills.length).toBe(1);
  });

  it('ordinary (non-injection) system messages are never deduped', () => {
    const ORDINARY = 'some ordinary system notice';
    emit(rec([
      { role: 'system', content: [{ type: 'text', text: ORDINARY }] },
    ], '答5'));
    emit(rec([
      { role: 'system', content: [{ type: 'text', text: ORDINARY }] },
      { role: 'system', content: [{ type: 'text', text: ORDINARY }] },
    ], '答6'));
    const rows = readJsonl(file);
    const ordinary = rows.filter(r => r.type === 'system' && JSON.stringify(r.message.content).includes('ordinary system notice'));
    expect(ordinary.length).toBe(2); // second occurrence recorded (multiset), no marker
  });
});

describe('claude-emitter: dedup is opt-in (default OFF) and per-context', () => {
  const REGISTRY = 'Available agent types for the Agent tool:\n- claude: Catch-all. [dedup-optin]';

  function rec(sid: string, system: string, messages: any[]) {
    return {
      sid, protocol: 'anthropic', receivedAt: 1, completedAt: 2,
      request: { body: { system: [{ type: 'text', text: system }], tools: [{ name: 'Read' }], messages } },
      response: { model: 'glm-5.2', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
    };
  }

  it('with the flag UNSET, duplicate injections record in full (default off)', () => {
    delete process.env.CONTEXT_PROXY_DEDUP_INJECTION;
    const sid = 'cpx-dedup-off';
    const file = sessionFilePath(sid);
    const msg = [{ role: 'system', content: [{ type: 'text', text: REGISTRY }] }];
    emit(rec(sid, 'main system', [{ role: 'user', content: 'q1' }, ...msg]));
    emit(rec(sid, 'main system', [{ role: 'user', content: 'q1' }, ...msg, ...msg]));
    const rows = readJsonl(file).filter(r => r.type === 'system' && !r.deduped);
    expect(rows.length).toBe(2); // both copies verbatim, no marker
  });

  it('main and subagent contexts dedup independently (identical injection kept in each)', () => {
    process.env.CONTEXT_PROXY_DEDUP_INJECTION = '1';
    const sid = 'cpx-dedup-ctx';
    const mainFile = sessionFilePath(sid);
    const SUB_SYS = 'main system cc_is_subagent=true';
    const mainMsgs = [{ role: 'user', content: 'q1' }];
    emit(rec(sid, 'main system', mainMsgs));
    // subagent request carries its own copy of the SAME registry text
    const subMsgs = [
      { role: 'user', content: [{ type: 'text', text: '子代理任务' }] },
      { role: 'system', content: [{ type: 'text', text: REGISTRY }] },
    ];
    emit(rec(sid, SUB_SYS, subMsgs));
    const subs = listSubagentFiles(sid);
    expect(subs.length).toBe(1);
    const subRows = readJsonl(subs[0]);
    // subagent's first registry copy is FULL even though main already saw the same text
    expect(subRows.filter(r => r.type === 'system' && !r.deduped).length).toBe(1);
    expect(readJsonl(mainFile).some(r => r.deduped === true)).toBe(false);
  });

  function listSubagentFiles(sid: string): string[] {
    const dir = path.join(tmpDir, sid, 'subagents');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f));
  }
});

describe('claude-emitter: dedup hot switch (config file, no restart)', () => {
  const REGISTRY = 'Available agent types for the Agent tool:\n- claude: Catch-all. [dedup-hot]';
  const cfgFile = path.join(path.dirname(tmpDir), 'cpx-config.json');

  function rec(sid: string, messages: any[]) {
    return {
      sid, protocol: 'anthropic', receivedAt: 1, completedAt: 2,
      request: { body: { system: [{ type: 'text', text: 'main system' }], tools: [{ name: 'Read' }], messages } },
      response: { model: 'glm-5.2', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
    };
  }

  afterAll(() => { try { fs.unlinkSync(cfgFile); } catch { /* */ } });

  it('toggling the config file flips dedup on a LIVE session (env unset)', () => {
    delete process.env.CONTEXT_PROXY_DEDUP_INJECTION;
    const sid = 'cpx-dedup-hot';
    const file = sessionFilePath(sid);
    const msg = () => [{ role: 'system', content: [{ type: 'text', text: REGISTRY }] }];

    // off: single copy records in full, no markers
    fs.writeFileSync(cfgFile, JSON.stringify({ dedupInjection: false }));
    emit(rec(sid, [{ role: 'user', content: 'q1' }, ...msg()]));
    emit(rec(sid, [{ role: 'user', content: 'q1' }, ...msg(), ...msg()]));
    expect(readJsonl(file).filter(r => r.deduped === true).length).toBe(0);

    // flip ON mid-session (no restart). Multiset count is already 2 from the
    // off phase, so with 4 copies: occ1/occ2 are consumed; the FIRST new
    // occurrence bootstraps its fingerprint in FULL, the next compresses.
    fs.writeFileSync(cfgFile, JSON.stringify({ dedupInjection: true }));
    emit(rec(sid, [{ role: 'user', content: 'q2' }, ...msg(), ...msg(), ...msg(), ...msg()]));
    const rows = readJsonl(file);
    const markers = rows.filter(r => r.deduped === true);
    expect(markers.length).toBe(1);
    expect(markers[0].originalChars).toBe(REGISTRY.length);

    // flip OFF again: no further markers regardless of copy count
    fs.writeFileSync(cfgFile, JSON.stringify({ dedupInjection: false }));
    const before = readJsonl(file).filter(r => r.deduped === true).length;
    emit(rec(sid, [{ role: 'user', content: 'q3' }, ...msg(), ...msg(), ...msg(), ...msg(), ...msg()]));
    expect(readJsonl(file).filter(r => r.deduped === true).length).toBe(before);
  });
});

describe('claude-emitter: x_lake 声明式扩展（docs/lake-schema-spec.md）', () => {
  it('assistant 行双写一致：legacy ≡ x_lake.data，且带 roundIndex/requestParams/status', () => {
    const rows = readJsonl(mainFile).filter(r => r.type === 'assistant');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const xb = r.x_lake;
      expect(xb?.schema).toBe('cc-wire-round');
      expect(xb?.version).toBe(1);
      expect(r.duration_ms).toBe(xb.data.latencyMs);
      expect(r.system).toEqual(xb.data.system);
      expect(r.tools).toEqual(xb.data.tools);
      expect(r.stopReason).toBe(xb.data.stopReason);
      expect(typeof xb.data.roundIndex).toBe('number');
      expect(typeof xb.data.status).toBe('number');
    }
    // roundIndex 从 0 连续编号
    const idx = rows.map(r => r.x_lake.data.roundIndex);
    expect(idx).toEqual(idx.map((_, i) => i));
  });

  it('主会话 meta.json（cc-session-meta）已写', () => {
    const metaPath = mainFile.replace(/\.jsonl$/, '.meta.json');
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(meta.x_lake.schema).toBe('cc-session-meta');
    expect(meta.x_lake.version).toBe(1);
    expect(meta.x_lake.data.producer).toBe('cpx');
    expect(['claude-code', 'opencode']).toContain(meta.x_lake.data.framework);
  });

  it('子代理 meta 双写：cc-subagent-meta 与顶层旧字段同值', () => {
    const files = metaFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const meta = JSON.parse(fs.readFileSync(path.join(subagentsDir, f), 'utf-8'));
      expect(meta.x_lake.schema).toBe('cc-subagent-meta');
      expect(meta.x_lake.data.toolUseId).toBe(meta.toolUseId);
      expect(meta.x_lake.data.subagentSessionId).toBe(f.replace(/\.meta\.json$/, ''));
    }
  });

  it('输入行 cc-wire-input：roundIndex + kind 结构化分类', () => {
    const rows = readJsonl(mainFile).filter(r => r.x_lake?.schema === 'cc-wire-input');
    expect(rows.length).toBeGreaterThan(0);
    const KINDS = ['user', 'tool-result', 'injection', 'system', 'command-message', 'dedup-placeholder'];
    for (const r of rows) {
      expect(typeof r.x_lake.data.roundIndex).toBe('number');
      expect(KINDS).toContain(r.x_lake.data.kind);
    }
  });
});

describe('proxySourceMarker / agentFrameworkLabel（框架标签覆盖）', () => {
  const saved = process.env.CONTEXT_PROXY_AGENT_FRAMEWORK;
  afterAll(() => {
    if (saved === undefined) delete process.env.CONTEXT_PROXY_AGENT_FRAMEWORK;
    else process.env.CONTEXT_PROXY_AGENT_FRAMEWORK = saved;
  });

  it('默认（未设覆盖）：anthropic → claude-proxy，openai/responses 按协议不变', () => {
    delete process.env.CONTEXT_PROXY_AGENT_FRAMEWORK;
    expect(agentFrameworkLabel()).toBe('claude-code');
    expect(proxySourceMarker('anthropic')).toBe('claude-proxy');
    expect(proxySourceMarker('openai')).toBe('opencode-proxy');
    expect(proxySourceMarker('responses')).toBe('codex-proxy');
  });

  it('wire 自描述优先：body 里有 dsh_session_log → dsh-proxy（无需 env）', () => {
    delete process.env.CONTEXT_PROXY_AGENT_FRAMEWORK;
    const dshBody = { dsh_session_log: { session: { id: 'session-x', origin: 'subagent', parentSession: 'session-p' } } };
    expect(agentFrameworkLabel(dshBody)).toBe('dsh');
    expect(proxySourceMarker('anthropic', dshBody)).toBe('dsh-proxy');
    // 非 dsh 的 body 不受影响
    expect(proxySourceMarker('anthropic', { system: 'You are Claude Code' })).toBe('claude-proxy');
    // 协议差异仍优先于框架标签
    expect(proxySourceMarker('responses', dshBody)).toBe('codex-proxy');
  });

  it('dsh profile（CONTEXT_PROXY_AGENT_FRAMEWORK=dsh）：anthropic → dsh-proxy', () => {
    process.env.CONTEXT_PROXY_AGENT_FRAMEWORK = 'dsh';
    expect(agentFrameworkLabel()).toBe('dsh');
    expect(proxySourceMarker('anthropic')).toBe('dsh-proxy');
    // 协议差异优先于框架标签：openai/responses 的 marker 不受影响
    expect(proxySourceMarker('openai')).toBe('opencode-proxy');
    expect(proxySourceMarker('responses')).toBe('codex-proxy');
  });
});

// ── agent-id 头分桶：续会归队（x-claude-code-agent-id）──
// 实验验证（2026-10-23 真机 wire 抓取）：claude 子代理请求带专属头
// x-claude-code-agent-id（主会话无此头；a+16hex，与原生 task-notification
// task-id 同源）。按它分桶后，看门狗重启/续会的子代理流（任务 prompt 已变、
// 无新派发 → 旧 prompt-md5 分桶会裂成新文件且 meta 全 null）落回原成员文件。
describe('claude-emitter: agent-id 头分桶（续会归队）', () => {
  const SID2 = 'cpx-agent-id-bucket';
  const dir2 = path.join(tmpDir, SID2, 'subagents');
  const base = (over: Record<string, unknown>) => ({
    sid: SID2,
    protocol: 'anthropic',
    receivedAt: 1_000,
    completedAt: 2_000,
    latencyMs: 1_000,
    ttftMs: null,
    request: { path: '/v1/messages', model: 'glm-5.2', body: {}, claudeAgentId: null, ...over.request },
    response: { status: 200, model: 'glm-5.2', stop_reason: null, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
    ...over,
  });
  const subRec = (agentId: string | null, task: string) => base({
    request: {
      claudeAgentId: agentId,
      body: {
        system: [{ type: 'text', text: 'main system cc_is_subagent=true' }],
        tools: [{ name: 'Read' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: task }] }],
      },
    },
    response: { status: 200, model: 'glm-5.2', stop_reason: null, content: [{ type: 'text', text: `回:${task.slice(0, 6)}` }], usage: { input_tokens: 1, output_tokens: 1 } },
  });

  beforeAll(() => {
    // 原始流（agent-1，任务 A）→ 续会流（同 agent-1，prompt 完全不同，无派发）
    // → 另一成员（agent-2）→ 无头流（旧行为回落）
    emit(subRec('aAgentId0000000001', '原始任务：设计文档 A'));
    emit(subRec('aAgentId0000000001', '从中断点继续：继续做 B 部分（续会 prompt）'));
    emit(subRec('aAgentId0000000002', '另一成员的任务 C'));
    emit(subRec(null, '无头旧形态任务 D'));
  });

  it('同 agent-id 的续会流归回原成员文件（不裂新文件）', () => {
    const files = fs.readdirSync(dir2).filter(f => f.endsWith('.jsonl'));
    // 4 轮 → 3 个文件（agent-1 两轮合一、agent-2、无头）
    expect(files.length).toBe(3);
    const agent1File = files.map(f => path.join(dir2, f))
      .find(f => readJsonl(f).some(r => JSON.stringify(r).includes('原始任务')));
    expect(agent1File).toBeDefined();
    const rows = readJsonl(agent1File!);
    expect(rows.some(r => JSON.stringify(r).includes('原始任务'))).toBe(true);
    expect(rows.some(r => JSON.stringify(r).includes('从中断点继续'))).toBe(true);
  });

  it('meta 只写一份（续会不再写新 meta）', () => {
    const metas = fs.readdirSync(dir2).filter(f => f.endsWith('.meta.json'));
    expect(metas.length).toBe(3);
  });
});

// ── 异步派发 meta 回填 ──
// 真机后台 Agent（requestShape:background）实测顺序：子代理首轮请求先于
// 父响应落盘（父 turn 仍在流式输出）→ 首写 meta 三字段 null；父响应带
// Agent tool_use 后到 → 回填重写。原生 meta 后台型自带 toolUseId，此处对齐。
describe('claude-emitter: 异步派发 meta 回填', () => {
  const SID3 = 'cpx-async-meta';
  const dir3 = path.join(tmpDir, SID3, 'subagents');
  const TASK = '后台任务：统计捕获目录布局-async-回填用例';
  const base = (over: Record<string, unknown>) => ({
    sid: SID3,
    protocol: 'anthropic',
    receivedAt: 1_000,
    completedAt: 2_000,
    latencyMs: 1_000,
    ttftMs: null,
    request: { path: '/v1/messages', model: 'glm-5.2', body: {}, claudeAgentId: null, ...over.request },
    response: { status: 200, model: 'glm-5.2', stop_reason: null, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
    ...over,
  });
  // 子代理流（agentId + 任务 prompt 首轮）。真机形态：任务块带尾随换行，
  // 而父侧 Agent tool_use 的 prompt 无——归一化前一个 \n 即致命失配
  const subRec = (agentId: string, task: string) => base({
    request: {
      claudeAgentId: agentId,
      body: {
        system: [{ type: 'text', text: 'main system cc_is_subagent=true' }],
        tools: [{ name: 'Read' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: task + '\n' }] }],
      },
    },
  });
  // 父响应：内容为 Agent tool_use（携带派发三要素）
  const dispatchRec = (prompt: string) => base({
    request: {
      body: {
        system: [{ type: 'text', text: 'main system' }],
        tools: [{ name: 'Agent' }],
        messages: [{ role: 'user', content: 'go' }],
      },
    },
    response: {
      status: 200, model: 'glm-5.2', stop_reason: null,
      content: [{ type: 'tool_use', id: 'toolu_async_backfill_1', name: 'Agent', input: { description: '统计目录布局', subagent_type: 'Explore', prompt } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const metasOf = (): Record<string, any> => {
    const out: Record<string, any> = {};
    for (const f of fs.readdirSync(dir3).filter(f => f.endsWith('.meta.json'))) {
      out[f.replace(/\.meta\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(dir3, f), 'utf-8'));
    }
    return out;
  };

  it('子先父后：首写 null → 父派发到达后回填重写（对齐原生后台型 meta）', () => {
    emit(subRec('asyncAgentId00001', TASK));
    const subId = Object.keys(metasOf()).find(k => metasOf()[k].toolUseId === null);
    expect(subId).toBeDefined();
    emit(dispatchRec(TASK));
    const meta = metasOf()[subId!];
    expect(meta.toolUseId).toBe('toolu_async_backfill_1');
    expect(meta.name).toBe('统计目录布局');
    expect(meta.agentType).toBe('Explore');
    expect(meta.x_lake.data.toolUseId).toBe('toolu_async_backfill_1');
    expect(meta.x_lake.data.subagentSessionId).toBe(subId);
  });

  it('派发永不到达：meta 保持 null 且不再重写', () => {
    emit(subRec('lostAgentId000002', '后台任务：派发丢失场景-async'));
    const before = JSON.stringify(metasOf());
    const lost = Object.entries(metasOf()).find(([, m]) => m.toolUseId === null);
    expect(lost).toBeDefined();
    emit(subRec('lostAgentId000002', '后续轮次，任务已变'));
    expect(JSON.stringify(metasOf())).toBe(before);
  });
});
