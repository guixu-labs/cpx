// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cannbot 网关 fail-fast IT（网关语义锁）：内建 cannbot provider 的网关上游
// 只从用户全局 config 的 provider.cannbot.options.baseURL 解析——不再内置
// 公网默认网关（公共化决策：网关地址属于部署环境，不随包分发）。
//   ① 未配置 → 启动即 fail-fast：退出码 1 + stderr 配置指引（指向
//      provider.cannbot.options.baseURL 与全局配置根），绝不静默直连零捕获
//   ② 已配置 → 门放行：stderr 无 fail-fast 报错（后续为正常运行链路）
// 沙箱隔离：HOME / XDG_CONFIG_HOME / cwd 全指临时目录（配置根必空，无项目
// 根泄漏）；CONTEXT_CPX_INSIGHT_BASE 指死端口（insightUp=false——退出路径
// 不开浏览器、不自动导入，宿主有真实 insight 在跑也不受影响）。

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.join(path.resolve(__dirname, '../../'), 'cpx-cli');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-gateway-test-'));

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/** 沙箱环境起一次 `cpx --agent cannbot -- <cmd>`（agentCmd 用 `true` 秒退） */
function runCannbot(): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [WRAPPER, '--agent', 'cannbot', '--', 'true'], {
    encoding: 'utf-8',
    timeout: 90_000,
    cwd: SANDBOX,
    env: {
      ...process.env,
      HOME: SANDBOX,
      XDG_CONFIG_HOME: path.join(SANDBOX, '.config'),
      CONTEXT_CPX_INSIGHT_BASE: 'http://127.0.0.1:1',
      CONTEXT_PROXY_DIR: path.join(SANDBOX, 'proxy'),
    },
  });
}

describe('cannbot 网关 fail-fast（无内置公网默认网关）', () => {
  it('① 未配置网关：fail-fast 退出码 1 + 配置指引，不静默直连零捕获', () => {
    const r = runCannbot();
    expect(r.status, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain('cannbot 网关未配置');
    expect(r.stderr).toContain('provider.cannbot.options.baseURL');
    // 指引给出配置根与写入来源（/connect 或登录流程；私有化部署手填）
    expect(r.stderr).toContain('~/.config/cannbot/opencode.json');
    expect(r.stderr).toContain('私有化网关部署');
  });

  it('② 已配置网关（provider.cannbot.options.baseURL）：门放行，无 fail-fast 报错', () => {
    const cfgDir = path.join(SANDBOX, '.config', 'cannbot');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'opencode.json'), JSON.stringify({
      provider: { cannbot: { options: { baseURL: 'http://127.0.0.1:9/v1' } } },
    }));
    const r = runCannbot();
    expect(r.stderr).not.toContain('cannbot 网关未配置');
  });
});
