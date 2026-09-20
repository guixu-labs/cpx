// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// `cpx opencode` 项目级 provider 捕获 IT（客户现场回归：huoshan-ai-gateway）：
// 用户模型走项目级配置定义的 provider（.opencode/opencode.json 的
// huoshan-ai-gateway，baseURL 直连 volceapi），auth.json 只有别的官方 provider。
// 修复前 provider 发现链只扫全局配置（~/.config/opencode、~/.config/cannbot），
// 项目级 .opencode/opencode.json 从未被扫描 → 该 provider 对 cpx 完全不可见 →
// baseURL 未重定向、opencode 直连上游、proxy 颗粒无收（捕获 0 字节）。
// 端到端验证（经仓内 cpx-cli wrapper 起真 CLI + 真 proxy server，agent 用假
// 脚本把注入的 OPENCODE_CONFIG_CONTENT 落盘，不真跑 opencode）：
//   ① 注入内容：provider.huoshan-ai-gateway.options.baseURL =
//      http://127.0.0.1:<port>/huoshan-ai-gateway/（cwd 设为项目目录，验证
//      项目级配置被扫描）
//   ② 启动日志：providers 列表含 auth.json 项 + huoshan-ai-gateway；
//      huoshan-ai-gateway 的 upstream 从项目配置本体解析（volceapi），不是
//      "(not found)"
//   ③ 无流量 → 占位捕获清理，退出码 0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROXY_ROOT = path.resolve(__dirname, '../../');
const WRAPPER = path.join(PROXY_ROOT, 'cpx-cli');

let TMP: string;
let PROJECT: string;
let CFG: string;
let DATA: string;
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
      'huoshan-ai-gateway': {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
          apiKey: 'test-key-1234567890',
        },
        models: { 'glm-5.3-flash': { name: 'GLM 5.3 Flash' } },
      },
    },
  }));
  // auth.json：另有一个官方 provider（客户现场 zhipuai-coding-plan）
  fs.mkdirSync(path.join(DATA, 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'opencode', 'auth.json'), JSON.stringify({ 'zhipuai-coding-plan': { type: 'api', key: 'k' } }));
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
      CANNBOT_PROXY_DIR: CAPTURES,
      ...extraEnv,
    },
  });
}

describe('cpx opencode 项目级 provider 捕获（客户现场回归 IT）', () => {
  // 流水线门禁跳过（scripts/run-tests.sh 设 CANNBOT_TEST_SKIP_SLOW=1），原因
  // 与 cpx-custom-provider.e2e.test.ts 同（WSL 下 upstream 扫描告警误红）
  it.skipIf(process.env.CANNBOT_TEST_SKIP_SLOW === '1')('①②③ 项目级 provider 注入 baseURL 重定向；upstream 从项目配置解析；干净退出', () => {
    const r = runCpx({});
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, `cpx output:\n${out}`).toBe(0);

    // ① 注入内容：项目级 provider baseURL 重定向到本机 proxy（/<providerId>/ 前缀）
    expect(fs.existsSync(INJECTED)).toBe(true);
    const injected = JSON.parse(fs.readFileSync(INJECTED, 'utf-8'));
    const huo = injected?.provider?.['huoshan-ai-gateway']?.options;
    expect(huo).toBeTruthy();
    expect(huo.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/huoshan-ai-gateway\/$/);
    // 注入只含 baseURL 覆盖（apiKey/models 由 opencode 从项目配置深合并保留）
    expect(Object.keys(injected.provider['huoshan-ai-gateway'].options)).toEqual(['baseURL']);
    // auth.json 的官方 provider 同样在注入里
    expect(injected.provider['zhipuai-coding-plan'].options.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/zhipuai-coding-plan\/$/);

    // ② 启动日志：providers 列表 = auth ∪ 项目配置；upstream 来自项目配置本体
    expect(out).toContain('huoshan-ai-gateway');
    expect(out).toContain('zhipuai-coding-plan');
    expect(out).toContain('https://ark.cn-beijing.volces.com/api/v3');
    expect(out).not.toContain('upstream not found in binary/config');

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
      expect(injected?.provider?.['huoshan-ai-gateway']?.options?.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/huoshan-ai-gateway\/$/);
    } finally {
      fs.writeFileSync(authPath, backup);
    }
  }, 120_000);
});
