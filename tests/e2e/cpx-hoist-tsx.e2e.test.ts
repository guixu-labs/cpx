// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cpx 会话代理 tsx 启动 IT（npm 安装布局回归）：用户项目 npm 装包
// （node_modules/context-cpx）+ tsx/esbuild/@esbuild 提升到顶层 node_modules（npm hoist）。
// 断言四件事：
//   ① bin 启动器起 cpx-cli 成功（createRequire 解析提升的 tsx loader）
//   ② 会话代理（src/server.ts）经 node --import <loader> 真启动——假 agent 收到
//      OPENAI_BASE_URL=http://127.0.0.1:<port>
//   ③ npx 回退从未触发：PATH 前置一个假 npx（落盘标记后 exit 1），标记文件
//      必须不存在——修复前 <pkg>/node_modules/.bin/tsx 硬编码在 hoist 布局下
//      miss，回落 npx 从 registry 现场下载 tsx（网络依赖、慢、离线即挂）
//   ④ 无流量 → 占位捕获清理，退出码 0
// harness 侧：沙箱（HOME 隔离 + bin/ 前置 PATH——假 npx 与 open 桩落
// sandbox.bin）+ runCommand（被测入口是安装态 bin 而非仓内 wrapper，故不走
// runCpx）；hoist 布局本身是测试素材，本地搭建。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSandbox, type Sandbox } from './harness/sandbox';
import { runCommand } from './harness/session';

const PROXY_ROOT = path.resolve(__dirname, '../../');
const REPO_NM = path.join(PROXY_ROOT, 'node_modules');

let sandbox: Sandbox;
let PROJECT: string;
let PKG: string;
let AGENT: string;
let AGENT_ENV: string;
let NPX_MARKER: string;

beforeAll(() => {
  sandbox = createSandbox('cpx-hoist-tsx-it-');
  PROJECT = path.join(sandbox.root, 'project');
  PKG = path.join(PROJECT, 'node_modules', 'context-cpx');

  // 包体拷贝（src/package.json/bin——不含 node_modules）：模拟 npm 装进用户项目
  fs.mkdirSync(PKG, { recursive: true });
  fs.cpSync(path.join(PROXY_ROOT, 'src'), path.join(PKG, 'src'), { recursive: true });
  fs.cpSync(path.join(PROXY_ROOT, 'bin'), path.join(PKG, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(PROXY_ROOT, 'package.json'), path.join(PKG, 'package.json'));

  // npm hoist：运行时依赖（tsx + fzstd + undici + 7zip-bin；tsx 的 esbuild 传递
  // 依赖）提升到顶层 node_modules，包内无副本
  for (const dep of ['tsx', 'esbuild', '@esbuild', 'fzstd', 'undici', '7zip-bin']) {
    fs.cpSync(path.join(REPO_NM, dep), path.join(PROJECT, 'node_modules', dep), { recursive: true });
  }

  // 假 npx：落盘标记后失败——证明会话代理从未走 npx 回退（sandbox.bin 由
  // 沙箱 PATH 前置，天然遮蔽真 npx）
  NPX_MARKER = path.join(sandbox.root, 'npx-marker');
  fs.writeFileSync(path.join(sandbox.bin, 'npx'), [
    '#!/bin/sh',
    `echo "npx fallback hit: $*" >> '${NPX_MARKER}'`,
    'exit 1',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(sandbox.bin, 'npx'), 0o755);
  // xdg-open/open 桩：退出路径 import 成功会 openBrowser——防真弹浏览器标签
  // （沙箱 CONTEXT_NO_BROWSER=1 之外的 belt+braces）
  for (const name of ['xdg-open', 'open']) {
    fs.writeFileSync(path.join(sandbox.bin, name), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(sandbox.bin, name), 0o755);
  }

  // 假 agent：记录注入的 OPENAI_BASE_URL（generic profile 直注入 env）
  AGENT_ENV = path.join(sandbox.root, 'agent-env');
  AGENT = path.join(sandbox.bin, 'fake-agent');
  fs.writeFileSync(AGENT, [
    '#!/bin/sh',
    `printenv OPENAI_BASE_URL > '${AGENT_ENV}'`,
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(AGENT, 0o755);
});

afterAll(() => {
  sandbox.cleanup();
});

describe('cpx 会话代理 tsx 启动（用户项目 hoist 布局）', () => {
  it('bin 起 cpx-cli + 会话代理经标准解析的 tsx loader 启动；npx 回退不触发；干净退出', async () => {
    // hoist 布局前提自检：包内无嵌套 tsx（旧硬编码路径必然 miss）
    expect(fs.existsSync(path.join(PKG, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(PROJECT, 'node_modules', 'tsx'))).toBe(true);

    const r = await runCommand(sandbox, process.execPath, [path.join(PKG, 'bin', 'cpx.mjs'), '--agent', 'generic', '--', AGENT], {
      cwd: PROJECT,
    });
    const out = r.output;
    expect(r.code, `cpx output:\n${out}`).toBe(0);

    // ① bin 启动器 + 会话代理都起来了：假 agent 收到本机 proxy 地址
    expect(fs.existsSync(AGENT_ENV), `agent env file missing; cpx output:\n${out}`).toBe(true);
    const baseUrl = fs.readFileSync(AGENT_ENV, 'utf-8').trim();
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // ② npx 回退从未触发（修复前硬编码路径 miss → npx 从 registry 取 tsx）
    expect(fs.existsSync(NPX_MARKER), `npx fallback was hit:\n${fs.existsSync(NPX_MARKER) ? fs.readFileSync(NPX_MARKER, 'utf-8') : ''}`).toBe(false);

    // ③ 无流量 → 占位捕获清理，不留残骸
    const leftovers = fs.existsSync(sandbox.captures)
      ? fs.readdirSync(sandbox.captures).filter(f => f.endsWith('.jsonl') || f.endsWith('.sids'))
      : [];
    expect(leftovers).toEqual([]);
  }, 120_000);
});
