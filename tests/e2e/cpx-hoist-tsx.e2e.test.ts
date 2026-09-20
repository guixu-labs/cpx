// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 会话代理 tsx 启动 hoist 布局 IT（npm i cannbot-proxy 进用户项目 / npx
// cannbot-proxy 的安装形态回归）：
//   fixture = 用户项目布局——node_modules/cannbot-proxy（包体拷贝，**无**内嵌
//   node_modules）+ tsx/esbuild/@esbuild 提升到顶层 node_modules（npm hoist）。
//   断言四件事：
//   ① bin 启动器起 cpx-cli 成功（createRequire 解析提升的 tsx loader）
//   ② 会话代理（src/server.ts）经 node --import <loader> 真启动——假 agent 收到
//      OPENAI_BASE_URL=http://127.0.0.1:<port>
//   ③ npx 回退从未触发：PATH 前置一个假 npx（落盘标记后 exit 1），标记文件
//      必须不存在——修复前 <pkg>/node_modules/.bin/tsx 硬编码在 hoist 布局下
//      miss，回落 npx 从 registry 现场下载 tsx（网络依赖、慢、离线即挂）
//   ④ 无流量 → 占位捕获清理，退出码 0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROXY_ROOT = path.resolve(__dirname, '../../');
const REPO_NM = path.join(PROXY_ROOT, 'node_modules');

let TMP: string;
let PROJECT: string;
let PKG: string;
let HOME: string;
let CAPTURES: string;
let AGENT: string;
let AGENT_ENV: string;
let NPX_MARKER: string;

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-hoist-tsx-it-'));
  PROJECT = path.join(TMP, 'project');
  PKG = path.join(PROJECT, 'node_modules', 'cannbot-proxy');
  HOME = path.join(TMP, 'home');
  CAPTURES = path.join(TMP, 'captures');

  // 包体拷贝（src/package.json/bin——不含 node_modules）：模拟 npm 装进用户项目
  fs.mkdirSync(PKG, { recursive: true });
  fs.cpSync(path.join(PROXY_ROOT, 'src'), path.join(PKG, 'src'), { recursive: true });
  fs.cpSync(path.join(PROXY_ROOT, 'bin'), path.join(PKG, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(PROXY_ROOT, 'package.json'), path.join(PKG, 'package.json'));

  // npm hoist：运行时依赖（tsx + fzstd + undici；tsx 的 esbuild 传递依赖）提升
  // 到顶层 node_modules，包内无副本
  for (const dep of ['tsx', 'esbuild', '@esbuild', 'fzstd', 'undici']) {
    fs.cpSync(path.join(REPO_NM, dep), path.join(PROJECT, 'node_modules', dep), { recursive: true });
  }

  // 假 npx：落盘标记后失败——证明会话代理从未走 npx 回退
  NPX_MARKER = path.join(TMP, 'npx-marker');
  fs.mkdirSync(path.join(TMP, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'bin', 'npx'), [
    '#!/bin/sh',
    `echo "npx fallback hit: $*" >> '${NPX_MARKER}'`,
    'exit 1',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(TMP, 'bin', 'npx'), 0o755);

  // 假 agent：记录注入的 OPENAI_BASE_URL（generic profile 直注入 env）
  AGENT_ENV = path.join(TMP, 'agent-env');
  AGENT = path.join(TMP, 'fake-agent');
  fs.writeFileSync(AGENT, [
    '#!/bin/sh',
    `printenv OPENAI_BASE_URL > '${AGENT_ENV}'`,
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(AGENT, 0o755);

  fs.mkdirSync(HOME, { recursive: true });
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('cpx 会话代理 tsx 启动（用户项目 hoist 布局）', () => {
  it('bin 起 cpx-cli + 会话代理经标准解析的 tsx loader 启动；npx 回退不触发；干净退出', () => {
    // hoist 布局前提自检：包内无嵌套 tsx（旧硬编码路径必然 miss）
    expect(fs.existsSync(path.join(PKG, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(PROJECT, 'node_modules', 'tsx'))).toBe(true);

    const r = spawnSync(process.execPath, [path.join(PKG, 'bin', 'cpx.mjs'), '--agent', 'generic', '--', AGENT], {
      encoding: 'utf-8',
      cwd: PROJECT,
      timeout: 120_000,
      env: {
        ...process.env,
        HOME,
        CANNBOT_PROXY_DIR: CAPTURES,
        PATH: [path.join(TMP, 'bin'), process.env.PATH ?? ''].join(path.delimiter),
      },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, `cpx output:\n${out}`).toBe(0);

    // ① bin 启动器 + 会话代理都起来了：假 agent 收到本机 proxy 地址
    expect(fs.existsSync(AGENT_ENV), `agent env file missing; cpx output:\n${out}`).toBe(true);
    const baseUrl = fs.readFileSync(AGENT_ENV, 'utf-8').trim();
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // ② npx 回退从未触发（修复前硬编码路径 miss → npx 从 registry 取 tsx）
    expect(fs.existsSync(NPX_MARKER), `npx fallback was hit:\n${fs.existsSync(NPX_MARKER) ? fs.readFileSync(NPX_MARKER, 'utf-8') : ''}`).toBe(false);

    // ③ 无流量 → 占位捕获清理，不留残骸
    const leftovers = fs.existsSync(CAPTURES)
      ? fs.readdirSync(CAPTURES).filter(f => f.endsWith('.jsonl') || f.endsWith('.sids'))
      : [];
    expect(leftovers).toEqual([]);
  }, 120_000);
});
