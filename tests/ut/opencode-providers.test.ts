// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// opencode provider 发现单测：JSONC 剥离（URL 保真）、自定义 provider 读取
// （双根 / .json 与 .jsonc / 注释 / 畸形容错）、覆盖列表解析（-m 精确 /
// auth ∪ custom / cannbot 内建）。
// 客户现场回归：ses_fa840cd30ffeY7qbw9q77JTvxj 用 gateway/glm-5.3（自定义
// provider，~/.config/opencode/opencode.jsonc 定义、baseURL 直连 volceapi），
// 修复前 cpx 只看 auth.json → gateway 的 baseURL 从未被重定向 → 132 条消息
// 全部直连上游，cpx 捕获 0 字节。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  stripJsoncComments,
  readAuthProvidersFromFile,
  readCustomProvidersFromRoots,
  resolveProviderIds,
  parseOpencodeProvider,
  opencodeProjectConfigRoots,
  opencodeConfigRoots,
} from '../../src/cli/opencode-providers';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-providers-test-'));

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('stripJsoncComments（字符串感知）', () => {
  it('URL 里的 // 不被当行注释剥离', () => {
    const text = '{"baseURL": "https://example.com/v1", "note": "a//b"}';
    expect(JSON.parse(stripJsoncComments(text))).toEqual({ baseURL: 'https://example.com/v1', note: 'a//b' });
  });
  it('行注释与块注释剥离', () => {
    const text = [
      '{',
      '  // line comment',
      '  /* block',
      '     comment */',
      '  "a": 1',
      '}',
    ].join('\n');
    expect(JSON.parse(stripJsoncComments(text))).toEqual({ a: 1 });
  });
  it('字符串内的 /* 与转义引号保真', () => {
    const text = '{"a": "x/*y", "b": "he said \\"hi // there\\""}';
    expect(JSON.parse(stripJsoncComments(text))).toEqual({ a: 'x/*y', b: 'he said "hi // there"' });
  });
});

describe('readCustomProvidersFromRoots', () => {
  it('客户现场形态：opencode.jsonc 自定义 gateway provider（含注释）被识别', () => {
    const root = path.join(TMP, 'root-jsonc');
    fs.mkdirSync(path.join(root, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(root, 'opencode', 'opencode.jsonc'), [
      '{',
      '  // 私有 AI 网关',
      '  "provider": {',
      '    "gateway": {',
      '      "npm": "@ai-sdk/openai-compatible",',
      '      "options": {',
      `        "baseURL": "https://gw.example.com/v1",`,
      '        "apiKey": "secret-1234"',
      '      },',
      '      "models": { "glm-5.3": { "name": "GLM 5.3" } }',
      '    }',
      '  }',
      '}',
    ].join('\n'));
    expect(readCustomProvidersFromRoots([path.join(root, 'opencode')]))
      .toEqual({ gateway: 'https://gw.example.com/v1' });
  });
  it('无 baseURL 的 provider 不产出（proxy 无法转发到未知上游）', () => {
    const root = path.join(TMP, 'root-nobase');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify({
      provider: { noBase: { npm: '@ai-sdk/openai-compatible', options: { apiKey: 'k' } } },
    }));
    expect(readCustomProvidersFromRoots([root])).toEqual({});
  });
  it('多根多 provider 合并；同 id 首见根优先；.json 优先于 .jsonc', () => {
    const r1 = path.join(TMP, 'multi-1');
    const r2 = path.join(TMP, 'multi-2');
    fs.mkdirSync(r1, { recursive: true });
    fs.mkdirSync(r2, { recursive: true });
    fs.writeFileSync(path.join(r1, 'opencode.json'), JSON.stringify({
      provider: { shared: { options: { baseURL: 'https://first.example.com' } }, onlyA: { options: { baseURL: 'https://a.example.com' } } },
    }));
    fs.writeFileSync(path.join(r1, 'opencode.jsonc'), JSON.stringify({
      provider: { jsoncOnly: { options: { baseURL: 'https://ignored.example.com' } } },
    }));
    fs.writeFileSync(path.join(r2, 'opencode.json'), JSON.stringify({
      provider: { shared: { options: { baseURL: 'https://second.example.com' } }, onlyB: { options: { baseURL: 'https://b.example.com' } } },
    }));
    expect(readCustomProvidersFromRoots([r1, r2])).toEqual({
      shared: 'https://first.example.com',
      onlyA: 'https://a.example.com',
      onlyB: 'https://b.example.com',
    });
  });
  it('缺失/畸形文件容错返回空', () => {
    const root = path.join(TMP, 'root-empty');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'opencode.json'), '{ broken json !!!');
    expect(readCustomProvidersFromRoots([root])).toEqual({});
    expect(readCustomProvidersFromRoots([path.join(TMP, 'no-such-root')])).toEqual({});
  });
});

describe('opencodeProjectConfigRoots', () => {
  it('cwd 向上到 git 根，逐层产出 <dir> 与 <dir>/.opencode（git 根本身计入）', () => {
    const proj = path.join(TMP, 'proj-walk');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    const sub = path.join(proj, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    expect(opencodeProjectConfigRoots(sub)).toEqual([
      sub, path.join(sub, '.opencode'),
      path.join(proj, 'a'), path.join(proj, 'a', '.opencode'),
      proj, path.join(proj, '.opencode'),
    ]);
  });
  it('无 .git 时逐层到文件系统根（不越界、不抛）', () => {
    const leaf = path.join(TMP, 'no-git', 'x');
    fs.mkdirSync(leaf, { recursive: true });
    const roots = opencodeProjectConfigRoots(leaf);
    // 首层 = leaf 与 leaf/.opencode；遍历覆盖到文件系统根层
    expect(roots[0]).toBe(leaf);
    expect(roots[1]).toBe(path.join(leaf, '.opencode'));
    expect(roots).toContain(path.parse(leaf).root); // 文件系统根目录
    expect(roots.length % 2).toBe(0); // 每层产出 <dir> 与 <dir>/.opencode 成对
  });
  it('项目级 .opencode/opencode.json 自定义 provider 被识别（客户现场 huoshan-ai-gateway）', () => {
    const proj = path.join(TMP, 'proj-dot-opencode');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.opencode'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.opencode', 'opencode.json'), JSON.stringify({
      provider: { 'huoshan-ai-gateway': { options: { baseURL: 'https://ark.cn-beijing.volces.com/api/v3' } } },
    }));
    expect(readCustomProvidersFromRoots(opencodeProjectConfigRoots(proj)))
      .toEqual({ 'huoshan-ai-gateway': 'https://ark.cn-beijing.volces.com/api/v3' });
  });
  it('项目级 opencode.json（根级）与全局同名 provider 冲突时项目优先', () => {
    const proj = path.join(TMP, 'proj-precedence');
    const glob = path.join(TMP, 'glob-precedence');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.mkdirSync(path.join(glob, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'opencode.json'), JSON.stringify({
      provider: { shared: { options: { baseURL: 'https://project.example.com/v1' } } },
    }));
    fs.writeFileSync(path.join(glob, 'opencode', 'opencode.json'), JSON.stringify({
      provider: { shared: { options: { baseURL: 'https://global.example.com/v1' } } },
    }));
    const roots = [...opencodeProjectConfigRoots(proj), path.join(glob, 'opencode')];
    expect(readCustomProvidersFromRoots(roots)).toEqual({
      shared: 'https://project.example.com/v1',
    });
  });
  it('opencodeConfigRoots 项目级配置根排在全局配置根之前', () => {
    const proj = path.join(TMP, 'proj-order');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    const spy = (process as unknown as { cwd: () => string }).cwd;
    try {
      (process as unknown as { cwd: () => string }).cwd = () => proj;
      const roots = opencodeConfigRoots();
      // 项目级（proj 与 proj/.opencode）在前，全局（cannbot/opencode）在后
      expect(roots[0]).toBe(proj);
      expect(roots[1]).toBe(path.join(proj, '.opencode'));
      expect(roots.at(-2)).toMatch(/[\\/]cannbot$/);
      expect(roots.at(-1)).toMatch(/[\\/]opencode$/);
    } finally {
      (process as unknown as { cwd: () => string }).cwd = spy;
    }
  });
});

describe('readAuthProvidersFromFile', () => {
  it('凭据对象才算 provider；标量值忽略；缺失容错', () => {
    const f = path.join(TMP, 'auth.json');
    fs.writeFileSync(f, JSON.stringify({ 'alibaba-cn': { type: 'api' }, 'zhipuai-coding-plan': {}, junk: 'scalar' }));
    expect(readAuthProvidersFromFile(f)).toEqual(['alibaba-cn', 'zhipuai-coding-plan']);
    expect(readAuthProvidersFromFile(path.join(TMP, 'no-auth.json'))).toEqual([]);
  });
});

describe('resolveProviderIds', () => {
  const auth = ['alibaba-cn', 'zhipuai-coding-plan'];
  const custom = { gateway: 'https://gw.example.com/v1' };

  it('客户现场回归：无 -m 时 auth ∪ custom —— gateway 必在覆盖列表', () => {
    const ids = resolveProviderIds({ profile: 'opencode', agentArgs: [], authProviders: auth, customProviders: custom });
    expect(ids).toContain('gateway');
    expect(ids).toContain('alibaba-cn');
    expect(ids).toContain('zhipuai-coding-plan');
  });
  it('-m provider/model 精确优先（只覆盖该 provider）', () => {
    expect(resolveProviderIds({ profile: 'opencode', agentArgs: ['-m', 'gateway/glm-5.3'], authProviders: auth, customProviders: custom }))
      .toEqual(['gateway']);
    expect(parseOpencodeProvider(['-m=alibaba-cn/glm-5.2'])).toBe('alibaba-cn');
    expect(parseOpencodeProvider(['--model', 'gateway/glm-5.3'])).toBe('gateway');
  });
  it('cannbot 恒含内建 cannbot provider', () => {
    expect(resolveProviderIds({ profile: 'cannbot', agentArgs: [], authProviders: [], customProviders: {} }))
      .toEqual(['cannbot']);
  });
  it('全空 = 不可捕获（调用方 exit 2 的前置条件）', () => {
    expect(resolveProviderIds({ profile: 'opencode', agentArgs: [], authProviders: [], customProviders: {} })).toEqual([]);
  });
});
