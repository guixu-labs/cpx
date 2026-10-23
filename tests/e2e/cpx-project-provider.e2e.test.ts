// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// `cpx opencode` 项目级 provider 捕获 IT（客户现场回归场景）：
// 用户模型走项目级配置定义的 provider（.opencode/opencode.json 的
// example-gateway，baseURL 直连真实上游），auth.json 只有别的官方 provider。
// 修复前 provider 发现链只扫全局配置（~/.config/opencode、~/.config/cannbot），
// 项目级 .opencode/opencode.json 从未被扫描 → 该 provider 对 cpx 完全不可见 →
// baseURL 未重定向、opencode 直连上游、proxy 颗粒无收（捕获 0 字节）。
// 端到端验证（经仓内 cpx-cli wrapper 起真 CLI + 真 proxy server，agent 用假
// 脚本把注入的 OPENCODE_CONFIG_CONTENT 落盘，不真跑 opencode）：
//   ① 注入内容：provider.example-gateway.options.baseURL =
//      http://127.0.0.1:<port>/example-gateway/（cwd 设为项目目录，验证
//      项目级配置被扫描）
//   ② 启动日志：providers 列表含 auth.json 项 + example-gateway；
//      example-gateway 的 upstream 从项目配置本体解析（真实上游），不是
//      "(not found)"
//   ③ 无流量 → 占位捕获清理，退出码 0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PROXY_ROOT = path.resolve(__dirname, '../../');
const WRAPPER = path.join(PROXY_ROOT, 'cpx-cli');

let TMP: string;
let PROJECT: string;
let CFG: string;
let DATA: string;
let CACHE: string;
let CAPTURES: string;
let AGENT: string;
let INJECTED: string;

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-project-provider-it-'));
  PROJECT = path.join(TMP, 'project');
  CFG = path.join(TMP, 'config');
  DATA = path.join(TMP, 'data');
  CAPTURES = path.join(TMP, 'captures');
  // 项目级配置（客户现场形态）：provider 只定义在 .opencode/opencode.json
  fs.mkdirSync(path.join(PROJECT, '.git'), { recursive: true });
  fs.mkdirSync(path.join(PROJECT, '.opencode'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, '.opencode', 'opencode.json'), JSON.stringify({
    provider: {
      'example-gateway': {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: 'https://upstream.example.com/api/v3',
          apiKey: 'test-key-1234567890',
        },
        models: { 'model-a1-flash': { name: 'Model A1 Flash' } },
      },
    },
  }));
  // auth.json：另有一个官方 provider（不在任何用户配置里——upstream 只能来自 catalog 缓存）
  fs.mkdirSync(path.join(DATA, 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'opencode', 'auth.json'), JSON.stringify({ 'example-coding-plan': { type: 'api', key: 'k' } }));
  // opencode.db：models.dev catalog 缓存（opencode 2.x 内建 provider 的
  // upstream 来源——注册表已移出二进制，strings 扫描必 miss）。伪记录：
  // 非 sqlite 字节（node:sqlite 打开必败 → raw 扫描路径，新旧 node 行为
  // 一致），key 列值与 value 列值相邻（真实库记录形态），digest 吻合。
  const catalog = JSON.stringify({
    'example-coding-plan': { id: 'example-coding-plan', npm: '@ai-sdk/openai-compatible', api: 'https://catalog.example.com/api/coding/paas/v4' },
  });
  const entry = JSON.stringify({
    updatedAt: 1759000000000,
    digest: crypto.createHash('sha256').update(Buffer.from(catalog, 'latin1')).digest('hex'),
    body: catalog,
  });
  fs.writeFileSync(path.join(DATA, 'opencode', 'opencode.db'),
    `not-a-sqlite-db\x00\x01 noise models-dev:catalog${entry} trailing \xff\xfe`);
  // 缓存目录钉死到空夹具：不读开发机真实的 ~/.cache/opencode（确定性）
  CACHE = path.join(TMP, 'cache');
  fs.mkdirSync(CACHE, { recursive: true });
  // 全局配置为空（客户现场该 provider 不在全局配置）
  fs.mkdirSync(path.join(CFG, 'opencode'), { recursive: true });
  // 假 agent：把 cpx 注入的 OPENCODE_CONFIG_CONTENT 落盘（不真跑 opencode）
  INJECTED = path.join(TMP, 'injected-config.json');
  AGENT = path.join(TMP, 'fake-agent');
  fs.writeFileSync(AGENT, [
    '#!/bin/sh',
    `printenv OPENCODE_CONFIG_CONTENT > '${INJECTED}'`,
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(AGENT, 0o755);
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function runCpx(extraEnv: Record<string, string>) {
  // cwd 设为项目目录：验证项目级 .opencode/opencode.json 被扫描（此前只在
  // 全局配置里找，项目级 provider 完全不可见）
  return spawnSync('bash', [WRAPPER, '--agent', 'opencode', '--', AGENT], {
    encoding: 'utf-8',
    cwd: PROJECT,
    timeout: 120_000,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: CFG,
      XDG_DATA_HOME: DATA,
      XDG_CACHE_HOME: CACHE,
      CONTEXT_PROXY_DIR: CAPTURES,
      // 钉死不可达：探测必败 → 不机会主义导入开发机在跑的真 insight、不开浏览器
      CONTEXT_CPX_INSIGHT_BASE: 'http://127.0.0.1:1',
      ...extraEnv,
    },
  });
}

describe('cpx opencode 项目级 provider 捕获（客户现场回归 IT）', () => {
  // 历史 skipIf 门控已摘除：原"WSL 下 upstream 扫描告警误红"的根因是
  // opencode 2.x 注册表移出二进制（strings 必 miss），已修复为从 models.dev
  // catalog 缓存读取（opencode.db kv），本用例夹具即验证该链路。
  it('①②③ 项目级 provider 注入 baseURL 重定向；upstream 从项目配置/catalog 解析；干净退出', () => {
    const r = runCpx({});
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, `cpx output:\n${out}`).toBe(0);

    // ① 注入内容：项目级 provider baseURL 重定向到本机 proxy（/<providerId>/ 前缀）
    expect(fs.existsSync(INJECTED)).toBe(true);
    const injected = JSON.parse(fs.readFileSync(INJECTED, 'utf-8'));
    const huo = injected?.provider?.['example-gateway']?.options;
    expect(huo).toBeTruthy();
    expect(huo.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/example-gateway\/$/);
    // 注入只含 baseURL 覆盖（apiKey/models 由 opencode 从项目配置深合并保留）
    expect(Object.keys(injected.provider['example-gateway'].options)).toEqual(['baseURL']);
    // auth.json 的官方 provider 同样在注入里
    expect(injected.provider['example-coding-plan'].options.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/example-coding-plan\/$/);

    // ② 启动日志：providers 列表 = auth ∪ 项目配置；upstream 来自项目配置本体，
    //    example-coding-plan upstream 来自 opencode.db 的 catalog 缓存（2.x 链路）
    expect(out).toContain('example-gateway');
    expect(out).toContain('example-coding-plan');
    expect(out).toContain('https://upstream.example.com/api/v3');
    expect(out).toContain('https://catalog.example.com/api/coding/paas/v4');
    expect(out).not.toContain('upstream not found');

    // ③ 无流量 → 占位捕获被清理（不留 0 字节残骸）
    const leftovers = fs.existsSync(CAPTURES)
      ? fs.readdirSync(CAPTURES).filter(f => f.endsWith('.jsonl') || f.endsWith('.sids'))
      : [];
    expect(leftovers).toEqual([]);
  }, 120_000);

  it('③ 前置检查：auth.json 无凭据、仅项目级 provider 定义 → 修复前 exit 2，修复后可捕获', () => {
    // 覆写 auth.json 为空对象（仅本用例；串行运行，用例内还原）
    const authPath = path.join(DATA, 'opencode', 'auth.json');
    const backup = fs.readFileSync(authPath, 'utf-8');
    fs.writeFileSync(authPath, '{}');
    try {
      fs.rmSync(INJECTED, { force: true });
      const r = runCpx({});
      const out = `${r.stdout}\n${r.stderr}`;
      expect(r.status, `cpx output:\n${out}`).toBe(0);
      // 仅有项目级 provider 也能通过前置检查并注入
      expect(fs.existsSync(INJECTED)).toBe(true);
      const injected = JSON.parse(fs.readFileSync(INJECTED, 'utf-8'));
      expect(injected?.provider?.['example-gateway']?.options?.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/example-gateway\/$/);
    } finally {
      fs.writeFileSync(authPath, backup);
    }
  }, 120_000);
});
