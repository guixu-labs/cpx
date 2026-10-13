// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { describe, it, expect } from 'vitest';
import { createReassembler, reassembleOpenAIJson, reassembleResponsesJson } from '../../src/stream-reassembler.ts';

function sse(events: object[]): string {
  return events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

describe('stream-reassembler: Anthropic', () => {
  it('accumulates text deltas into a text block', () => {
    const r = createReassembler('anthropic');
    r.feed(sse([
      { type: 'message_start', message: { model: 'claude-opus-x', usage: { input_tokens: 10, cache_read_input_tokens: 2 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]));
    const res = r.result();
    expect(res.model).toBe('claude-opus-x');
    expect(res.stop_reason).toBe('end_turn');
    expect(res.content.length).toBe(1);
    expect(res.content[0].text).toBe('Hello world');
    expect(res.usage?.input_tokens).toBe(10);
    expect(res.usage?.cache_read_input_tokens).toBe(2);
    expect(res.usage?.output_tokens).toBe(3);
  });

  it('reassembles tool_use input_json_delta into parsed input', () => {
    const r = createReassembler('anthropic');
    r.feed(sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Read' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/x' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '.ts"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ]));
    const res = r.result();
    expect(res.content.length).toBe(1);
    expect(res.content[0].type).toBe('tool_use');
    expect(res.content[0].name).toBe('Read');
    expect(res.content[0].input).toEqual({ file_path: '/x.ts' });
  });

  // GLM 等 anthropic 兼容网关把最终全量 usage 放 message_delta（message_start
  // 只给占位 input_tokens:0）——旧实现只抄 output_tokens，input/cache 全丢：
  // 现场 3.5 天会话 wire 捕获 input/cacheRead 记 0，原生 transcript 却全量
  // （claude-code 聚合了 delta 全量），同会话 token 对账差 4.5 倍
  it('GLM 形态：message_delta 携带全量 usage（start 为占位 0）→ 完整记账', () => {
    const r = createReassembler('anthropic');
    r.feed(sse([
      { type: 'message_start', message: { model: 'glm-5.2', usage: { input_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 8265, cache_read_input_tokens: 16896, output_tokens: 284 } },
      { type: 'message_stop' },
    ]));
    const res = r.result();
    expect(res.usage?.input_tokens).toBe(8265);
    expect(res.usage?.cache_read_input_tokens).toBe(16896);
    expect(res.usage?.output_tokens).toBe(284);
  });

  it('病态保护：delta 的零值不覆盖 message_start 已有的真值', () => {
    const r = createReassembler('anthropic');
    r.feed(sse([
      { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 100, cache_read_input_tokens: 50 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 } },
      { type: 'message_stop' },
    ]));
    const res = r.result();
    expect(res.usage?.input_tokens).toBe(100);
    expect(res.usage?.cache_read_input_tokens).toBe(50);
    expect(res.usage?.output_tokens).toBe(3);
  });
});

describe('stream-reassembler: OpenAI', () => {
  it('accumulates content deltas and tool_calls', () => {
    const r = createReassembler('openai');
    r.feed(sse([
      { model: 'gpt-4-x', choices: [{ delta: { role: 'assistant', content: 'Hi ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'there' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"p' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ath":42}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12, prompt_tokens_details: { cached_tokens: 3 } } },
    ]));
    const res = r.result();
    expect(res.model).toBe('gpt-4-x');
    expect(res.stop_reason).toBe('tool_calls');
    const text = res.content.find(c => c.type === 'text');
    expect(text?.text).toBe('Hi there');
    const tc = res.content.find(c => c.type === 'tool_use');
    expect(tc?.id).toBe('call_1');
    expect(tc?.name).toBe('read');
    expect(tc?.input).toEqual({ path: 42 });
    expect(res.usage?.input_tokens).toBe(8);
    expect(res.usage?.output_tokens).toBe(4);
    expect(res.usage?.cache_read_input_tokens).toBe(3);
  });

  it('preserves the tool_call id when later chunks repeat id:"" (dashscope streaming)', () => {
    // dashscope streams a tool_call across many chunks: the FIRST carries the
    // real id+name, subsequent chunks carry only arguments and repeat id:"".
    // The reassembler must NOT let the empty id overwrite the real one — else
    // tool_use.id="" can't pair with the tool_result's tool_use_id and the result
    // (e.g. a subagent's read of agents/<name>.md) is dropped during ingest.
    const r = createReassembler('openai');
    r.feed(sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'read', arguments: '{"' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: '', type: 'function', function: { arguments: 'path":"foo.txt"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]));
    const tc = r.result().content.find(c => c.type === 'tool_use');
    expect(tc?.id).toBe('call_abc');
    expect(tc?.name).toBe('read');
    expect(tc?.input).toEqual({ path: 'foo.txt' });
  });
});

// DeepSeek 系网关思考通道：思考内容走 delta.reasoning_content（部分网关叫
// delta.reasoning），与 delta.content 并列的独立字段 —— opencode 内置 AI SDK
// 读双名存为 reasoning part。漏收该字段 → 捕获件里这些 assistant 只剩
// tool_use、无任何文本，insight 查看大量 turn 没有 LLM Output（现场
// ses_f4da12dc：cpx 件 vs native 件按 tool_use id 对齐，109/182 轮
// <thinking> 整块丢失）。
describe('stream-reassembler: OpenAI reasoning（DeepSeek 思考流）', () => {
  it('reasoning_content 多 chunk → thinking 块置首（thinking → text → tool_use 时序）+ usage reasoning_tokens', () => {
    const r = createReassembler('openai');
    r.feed(sse([
      { model: 'deepseek-v4-pro', choices: [{ delta: { role: 'assistant', reasoning_content: '让我先' }, finish_reason: null }] },
      { choices: [{ delta: { reasoning_content: '想想' }, finish_reason: null }] },
      { choices: [{ delta: { content: '结果如下' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_r1', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17, completion_tokens_details: { reasoning_tokens: 5 } } },
    ]));
    const res = r.result();
    expect(res.content.map(c => c.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(res.content[0]).toEqual({ type: 'thinking', thinking: '让我先想想' });
    expect(res.content[1]).toEqual({ type: 'text', text: '结果如下' });
    expect(res.content[2].id).toBe('call_r1');
    expect(res.usage?.reasoning_tokens).toBe(5);
  });

  it('bug 真实形态：纯思考 + tool_calls 无正文 → [thinking, tool_use]（旧实现 thinking 整块丢失）', () => {
    const r = createReassembler('openai');
    r.feed(sse([
      { choices: [{ delta: { reasoning_content: '先看实现再决定' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_r2', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]));
    const res = r.result();
    expect(res.content.map(c => c.type)).toEqual(['thinking', 'tool_use']);
    expect(res.content[0].thinking).toBe('先看实现再决定');
    expect(res.content[1].name).toBe('bash');
  });

  it('reasoning 别名字段（delta.reasoning，部分网关命名）同样累积', () => {
    const r = createReassembler('openai');
    r.feed(sse([
      { choices: [{ delta: { reasoning: '别名通道' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]));
    expect(r.result().content).toEqual([{ type: 'thinking', thinking: '别名通道' }]);
  });

  it('ttft：仅有 reasoning delta 也触发 firstTokenAt（思考模型首个输出是思考，旧实现等到正文块 → 纯思考轮 ttft 恒 null）', () => {
    const r = createReassembler('openai');
    r.feed(sse([
      { choices: [{ delta: { reasoning_content: '思' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]));
    expect(r.result().firstTokenAt).toBeTypeOf('number');
  });
});

// 非流式路径（server.ts handleNonStream → reassembleOpenAIJson，自 server.ts
// 迁入本模块后可直测）：思考通道与流式同族修复。
describe('reassembleOpenAIJson（非流式）: reasoning 通道', () => {
  it('message.reasoning_content → thinking 块置首 + usage reasoning_tokens', () => {
    const res = reassembleOpenAIJson({
      model: 'deepseek-v4-pro',
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: '思考过程',
          tool_calls: [{ id: 'call_n1', function: { name: 'read', arguments: '{"path":"x"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 3, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 3 } },
    });
    expect(res.content.map(c => c.type)).toEqual(['thinking', 'tool_use']);
    expect(res.content[0]).toEqual({ type: 'thinking', thinking: '思考过程' });
    expect(res.content[1].id).toBe('call_n1');
    expect(res.usage?.reasoning_tokens).toBe(3);
  });

  it('message.reasoning 别名同样收取，正文 text 块在思考块之后', () => {
    const res = reassembleOpenAIJson({
      choices: [{ message: { role: 'assistant', content: '答案', reasoning: '推理' }, finish_reason: 'stop' }],
    });
    expect(res.content.map(c => c.type)).toEqual(['thinking', 'text']);
    expect(res.content[0].thinking).toBe('推理');
    expect(res.content[1].text).toBe('答案');
  });

  it('无思考字段的响应不受影响（纯正文/工具形态不变）', () => {
    const res = reassembleOpenAIJson({
      choices: [{ message: { role: 'assistant', content: '普通回答' }, finish_reason: 'stop' }],
    });
    expect(res.content).toEqual([{ type: 'text', text: '普通回答' }]);
  });
});

describe('stream-reassembler: ttft (firstTokenAt)', () => {
  it('anthropic: firstTokenAt set on first content_block_delta, null without deltas', () => {
    const r = createReassembler('anthropic');
    r.feed(sse([
      { type: 'message_start', message: { model: 'm', usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'H' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'i' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ]));
    expect(r.result().firstTokenAt).toBeTypeOf('number');
    // message with no content deltas → null
    const r2 = createReassembler('anthropic');
    r2.feed(sse([{ type: 'message_start', message: { model: 'm' } }, { type: 'message_stop' }]));
    expect(r2.result().firstTokenAt).toBeNull();
  });

  it('openai: firstTokenAt set on first delta.content', () => {
    const r = createReassembler('openai');
    r.feed(sse([
      { choices: [{ delta: { content: 'H' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'i' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]));
    expect(r.result().firstTokenAt).toBeTypeOf('number');
    // no content → null
    const r2 = createReassembler('openai');
    r2.feed(sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]));
    expect(r2.result().firstTokenAt).toBeNull();
  });
});

// Responses API（codex）：SSE 事件流 + 非流式 JSON 两形态。事件形状取自
// 真机 codex 网关捕获（response.output_item.added / output_text.delta /
// function_call_arguments.delta / reasoning_summary_text.delta /
// output_item.done / response.completed）。
describe('stream-reassembler: Responses API（codex）', () => {
  it('reasoning + message + function_call → thinking 置首、tool_use 参数解析 + usage 全通道', () => {
    const r = createReassembler('responses');
    r.feed(sse([
      { type: 'response.created', response: { model: 'deepseek-v4-pro' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '先分析' },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '任务' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant' } },
      { type: 'response.output_text.delta', output_index: 1, delta: '派发子代理' },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', name: 'spawn_agent', call_id: 'call-s1' } },
      { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"message":"任务文本"}' },
      { type: 'response.completed', response: { model: 'deepseek-v4-pro', status: 'completed', usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 12 } } } },
    ]));
    const res = r.result();
    expect(res.content.map(c => c.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(res.content[0]).toEqual({ type: 'thinking', thinking: '先分析任务' });
    expect(res.content[1]).toEqual({ type: 'text', text: '派发子代理' });
    expect(res.content[2]).toEqual({ type: 'tool_use', id: 'call-s1', name: 'spawn_agent', input: { message: '任务文本' } });
    expect(res.model).toBe('deepseek-v4-pro');
    expect(res.stop_reason).toBe('completed');
    expect(res.usage).toEqual({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, reasoning_tokens: 12 });
  });

  it('reasoning 的 output_item.done summary 全文覆盖 delta 累积（done 是权威形态）', () => {
    const r = createReassembler('responses');
    r.feed(sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '部分思考' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', summary: [{ type: 'summary_text', text: '权威全文' }] } },
      { type: 'response.completed', response: { status: 'completed' } },
    ]));
    const res = r.result();
    expect(res.content).toEqual([{ type: 'thinking', thinking: '权威全文' }]);
  });

  it('网关变体：reasoning_text.delta/done + output_item.done 的 content[]（volcano/deepseek 实测形状）', () => {
    const r = createReassembler('responses');
    r.feed(sse([
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rsn-1', type: 'reasoning' } },
      { type: 'response.reasoning_text.delta', output_index: 0, content_index: 0, delta: '网关思考' },
      { type: 'response.reasoning_text.delta', output_index: 0, content_index: 0, delta: '片段' },
      { type: 'response.reasoning_text.done', output_index: 0, content_index: 0, text: '网关思考片段（权威）' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'rsn-1', type: 'reasoning', content: [{ type: 'reasoning_text', text: '网关思考片段（权威）' }] } },
      { type: 'response.completed', response: { status: 'completed' } },
    ]));
    expect(r.result().content).toEqual([{ type: 'thinking', thinking: '网关思考片段（权威）' }]);
  });

  it('ttft：reasoning_summary_text.delta 也触发 firstTokenAt（思考先于正文）', () => {
    const r = createReassembler('responses');
    r.feed(sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '思' },
      { type: 'response.completed', response: { status: 'completed' } },
    ]));
    expect(r.result().firstTokenAt).toBeTypeOf('number');
  });
});

describe('reassembleResponsesJson（非流式）: output[] 三类 item + usage', () => {
  it('message/function_call/reasoning → text/tool_use/thinking + reasoning_tokens', () => {
    const res = reassembleResponsesJson({
      model: 'deepseek-v4-pro',
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '思考过程' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '正文回答' }] },
        { type: 'function_call', name: 'exec_command', call_id: 'call-e1', arguments: '{"command":"ls"}' },
      ],
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } },
    });
    expect(res.content.map(c => c.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(res.content[0]).toEqual({ type: 'thinking', thinking: '思考过程' });
    expect(res.content[2]).toEqual({ type: 'tool_use', id: 'call-e1', name: 'exec_command', input: { command: 'ls' } });
    expect(res.stop_reason).toBe('completed');
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4, reasoning_tokens: 3 });
  });

  it('网关变体：reasoning 的 content[]（reasoning_text）同样成 thinking 块', () => {
    const res = reassembleResponsesJson({
      model: 'deepseek-v4-pro',
      status: 'completed',
      output: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: '网关思考全文' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答' }] },
      ],
    });
    expect(res.content).toEqual([{ type: 'thinking', thinking: '网关思考全文' }, { type: 'text', text: '答' }]);
  });

  it('空 output / 缺 usage → 空内容 + null usage（不抛）', () => {
    const res = reassembleResponsesJson({ model: 'm', status: 'failed', output: [] });
    expect(res.content).toEqual([]);
    expect(res.usage).toBeNull();
    expect(res.stop_reason).toBe('failed');
  });
});
