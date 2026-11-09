// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cpx 会话旅程驱动（insight webServer/boot 的 cpx 等价物）：真 wrapper（bash
// cpx-cli → tsx → 真源码）在沙箱 env 里 spawn 真 agent，stdout/stderr 全量
// 收集，等待退出。cpx 的生命周期内嵌在这一次进程里（startSessionProxy →
// 注入 spawn agent → 收尾压缩/导入），spec 只与「进程退出 + 落盘产物」对账
// ——与 insight「真服务真浏览器」同层的真栈纪律。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveTsxLoader } from '../../../src/cli/tsx-launcher.ts';
import { REPO_ROOT, WRAPPER } from './constants';
import type { Sandbox } from './sandbox';

export interface CpxRunResult {
  /** cpx-cli 退出码。 */
  code: number;
  /** stdout+stderr 全量（断言失败信息里带它——现场就在断言消息里）。 */
  output: string;
}

/** 跑任意命令（沙箱 env + cwd + 超时预算）：runCpx 的底层；安装态 bin
 *  （node PKG/bin/cpx.mjs）等非 wrapper 入口的用例用这个。 */
export function runCommand(
  sandbox: Sandbox,
  command: string,
  argv: string[],
  opts: { env?: Record<string, string | undefined>; cwd?: string; timeoutMs?: number } = {},
): Promise<CpxRunResult> {
  return new Promise((resolve) => {
    const p = spawn(command, argv, {
      env: sandbox.env(opts.env),
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      output += '\n[E2E] run timeout — killing';
      try { p.kill('SIGKILL'); } catch { /* already gone */ }
    }, opts.timeoutMs ?? 120_000);
    p.stdout.on('data', (d) => { output += d; });
    p.stderr.on('data', (d) => { output += d; });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n[E2E] spawn error: ${e.message}` });
    });
  });
}

/** 跑一次完整 cpx 会话：bash cpx-cli <argv…>，等退出（默认 120s 预算）。 */
export function runCpx(
  sandbox: Sandbox,
  argv: string[],
  opts: { env?: Record<string, string | undefined>; cwd?: string; timeoutMs?: number } = {},
): Promise<CpxRunResult> {
  return runCommand(sandbox, 'bash', [WRAPPER, ...argv], opts);
}

/** 读取假 agent 落盘的 CPX_SESSION_ID（cpx 钉定 sid——工牌对账用）。 */
export function readSidDump(sandbox: Sandbox, agentName: string): string {
  return fs.readFileSync(path.join(sandbox.root, `${agentName}.sid`), 'utf8').trim();
}

/** 读取假 agent 落盘的响应全文（透传保真断言：agent 收到 == 桩发出）。 */
export function readAgentResponse(sandbox: Sandbox, agentName: string): string {
  return fs.readFileSync(path.join(sandbox.root, `${agentName}.resp`), 'utf8');
}

export interface ProxyHandle {
  /** 会话代理监听地址（agent/cpx 注入的目标）。 */
  url: string;
  port: number;
  /** 杀进程组（SIGTERM 到负 pid——npx→tsx→node 孙进程同归）。 */
  kill(): void;
}

/** 直起会话代理（proxy 层 IT 用——不经 cpx-cli，被测物是 server.ts 本身；
 *  startSessionProxy 同款纪律：node --import tsx loader，端口 0 动态，
 *  stdout 端口行就绪即 resolve）。 */
export function spawnProxy(
  sandbox: Sandbox,
  opts: { sid?: string; upstreams?: Record<string, string> } = {},
): Promise<ProxyHandle> {
  const TSX_LOADER = resolveTsxLoader(__filename);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER!, path.join(REPO_ROOT, 'src', 'server.ts')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
      env: sandbox.env({
        CONTEXT_PROXY_PORT: '0',
        CONTEXT_PROXY_SESSION_ID: opts.sid ?? 'e2e-proxy-direct',
        ...Object.fromEntries(Object.entries(opts.upstreams ?? {}).map(([k, v]) => [k, v])),
      }),
    });
    let port = 0;
    const timer = setTimeout(() => reject(new Error('proxy did not report port within 30s')), 30_000);
    const onData = (d: Buffer): void => {
      const m = d.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m && !port) {
        port = parseInt(m[1], 10);
        clearTimeout(timer);
        resolve({ url: `http://127.0.0.1:${port}`, port, kill: () => { try { child.kill('SIGTERM'); } catch { /* gone */ } } });
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', (d) => process.stderr.write(d));
    child.on('exit', () => { if (!port) { clearTimeout(timer); reject(new Error('proxy exited before reporting a port')); } });
  });
}
