// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// findProxyProcs 活运行判定回归锁（2026-09-21 真实事故的编码）：
// 旧实现按 cmdline 匹配老仓库布局 'proxy/src/server.ts'——monorepo
// （packages/cpx/src/server.ts）与 npm 件（context-cpx/src/server.ts）全部
// 匹配不上 → livePinned 恒空 → 启动期清扫把并发活运行的 .sids 清单 + 0
// 字节占位当泄漏删除 → 该运行退出 "no capture file produced"（17MB 捕获
// 在盘、自动导入丢失）。本组用例锁死：env 标记判定与布局解耦 + 清扫绝不
// 误吃活运行 + 死运行照扫 + 捕获本体（真实 sid 文件/meta）任何情况不动。
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { findProxyProcs, dedupePairs, isOrphanedProc, type ProxyProc } from '../../src/cli/proxy-procs';
import { sweepLeakedPlaceholders } from '../../src/cli/cpx-scratch';

const children: ChildProcess[] = [];

// 仿真 proxy 进程：env 标记 + argv 含 server.ts（真实 proxy 的 cmdline
// 恒以 src/server.ts 结尾——老仓库/monorepo/npm 件全布局一致）
function spawnFakeProxy(pinned: string, opts: { withMarker?: boolean; withArgv?: boolean } = {}): ChildProcess {
  const { withMarker = true, withArgv = true } = opts;
  const argv = [ '-e', 'setTimeout(() => {}, 60000)', ...(withArgv ? ['server.ts'] : ['unrelated.js']) ];
  const child = spawn(process.execPath, argv, {
    stdio: 'ignore',
    env: {
      ...process.env,
      ...(withMarker ? { CONTEXT_PROXY_SESSION_ID: pinned } : {}),
    },
  });
  children.push(child);
  return child;
}

function waitExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on('exit', () => resolve());
  });
}

async function waitFor<T>(probe: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 50));
  }
}

describe('findProxyProcs 活运行判定（env 标记，布局解耦）', () => {
  afterEach(() => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* */ } }
    children.length = 0;
  });

  it('按 env 标记识别活 proxy——任意安装布局（老仓库/monorepo/npm 件）', async () => {
    if (!fs.existsSync('/proc')) return; // macOS 无 /proc，生产路径同样跳过
    const child = spawnFakeProxy('live-probe-sid-1');
    await waitFor(() => (findProxyProcs().find(p => p.pid === child.pid) ? 1 : undefined));
    const hit = findProxyProcs().find(p => p.pid === child.pid);
    expect(hit).toBeDefined();
    expect(hit!.sid).toBe('live-probe-sid-1');
  });

  it('无 env 标记的进程不是 proxy（server.ts 字样也不认）', async () => {
    if (!fs.existsSync('/proc')) return;
    const child = spawnFakeProxy('should-not-appear', { withMarker: false });
    await waitFor(() => (fs.existsSync(`/proc/${child.pid}`) ? 1 : undefined), 2000);
    expect(findProxyProcs().find(p => p.pid === child.pid)).toBeUndefined();
  });

  it('继承同一 env 的 proxy 子件（esbuild service 形态：无 server.ts argv）不识别——status 不出重复行', async () => {
    if (!fs.existsSync('/proc')) return;
    const child = spawnFakeProxy('marker-but-no-server-argv', { withArgv: false });
    await waitFor(() => (fs.existsSync(`/proc/${child.pid}`) ? 1 : undefined), 2000);
    expect(findProxyProcs().find(p => p.pid === child.pid)).toBeUndefined();
  });
});

describe('启动期清扫 × 活运行保护（2026-09-21 事故回归）', () => {
  afterEach(() => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* */ } }
    children.length = 0;
  });

  it('活运行（proxy 在场）的占位 + .sids 清单绝不被清扫；退出后照扫；捕获本体永不动', async () => {
    if (!fs.existsSync('/proc')) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-sweep-live-'));
    const pinned = '11111111-2222-3333-4444-555555555555';
    const real = 'ses_sweepLiveProbe000000000000000';
    // 复刻事故现场：header 路由运行的 scratch 形态——pinned 占位 0 字节 +
    // .sids 清单指向真实 sid；捕获本体在真实 sid 文件 + 伴生 meta
    const placeholder = path.join(dir, `cpx-${pinned}.jsonl`);
    fs.writeFileSync(placeholder, '');
    fs.writeFileSync(path.join(dir, `cpx-${pinned}.sids`), `${real}\n`);
    const captureFile = path.join(dir, `cpx-${real}.jsonl`);
    fs.writeFileSync(captureFile, '{"v":1}\n');
    fs.writeFileSync(path.join(dir, `cpx-${real}.meta.json`), '{"x_lake":{}}');

    // 活 proxy 在场（cpx-cli 启动期清扫的活运行判定输入）
    spawnFakeProxy(pinned);
    await waitFor(() => (dedupePairs(findProxyProcs()).some(p => p.sid === pinned) ? 1 : undefined));

    // 并发源码树 cpx 启动 → 清扫：livePinned 含 pinned → 活运行 scratch 全保
    const livePinned = new Set(dedupePairs(findProxyProcs()).map(p => p.sid).filter((s): s is string => !!s));
    expect(sweepLeakedPlaceholders(dir, livePinned)).toBe(0);
    expect(fs.existsSync(placeholder)).toBe(true);
    expect(fs.existsSync(path.join(dir, `cpx-${pinned}.sids`))).toBe(true);
    expect(fs.existsSync(captureFile)).toBe(true);

    // 运行退出（proxy 死亡）→ 下一次启动清扫照扫 leak
    const child = children[children.length - 1];
    child.kill('SIGKILL');
    await waitExit(child);
    const liveAfter = new Set(dedupePairs(findProxyProcs()).map(p => p.sid).filter((s): s is string => !!s));
    expect(sweepLeakedPlaceholders(dir, liveAfter)).toBe(1);
    expect(fs.existsSync(placeholder)).toBe(false);
    expect(fs.existsSync(path.join(dir, `cpx-${pinned}.sids`))).toBe(false);
    // 捕获本体 + meta 任何形态零触碰（清扫只动空壳 scratch）
    expect(fs.existsSync(captureFile)).toBe(true);
    expect(fs.existsSync(path.join(dir, `cpx-${real}.meta.json`))).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('isOrphanedProc（--kill 孤儿判定：父进程已死）', () => {
  // env 标记模型下 sid 恒非空——旧「无 sid = 孤儿」结构性空转；孤儿语义 =
  // 父进程已死（重挂 init/pid 1 或 ppid 不可达）。alive / cmdline 注入，纯谓词确定性单测
  const mk = (ppid: number | null): ProxyProc =>
    ({ pid: 123, ppid, sid: 's', upstream: null, ageSec: 1, port: 1 });
  const init1 = () => '/sbin/init';
  const cpxCli1 = () => 'node --import /tmp/loader.mjs /app/context-cpx/src/cli/cpx-cli.ts claude';

  it('ppid=1 且 pid 1 是 init/systemd（重挂收养）→ 孤儿；ppid 死 → 孤儿', () => {
    expect(isOrphanedProc(mk(1), () => true, init1)).toBe(true);
    expect(isOrphanedProc(mk(9999), pid => pid === 123)).toBe(true); // alive 表里没有 9999
  });

  it('ppid=1 但 pid 1 是活着的 cpx-cli（容器 entrypoint `docker run … cpx …`）→ 非孤儿（绝不误杀活会话）', () => {
    expect(isOrphanedProc(mk(1), () => true, cpxCli1)).toBe(false);
  });

  it('ppid 活着 → 非孤儿；ppid 未知（stat 不可读）→ 保守非孤儿（宁漏杀勿误杀）', () => {
    expect(isOrphanedProc(mk(42), pid => pid === 42)).toBe(false);
    expect(isOrphanedProc(mk(null), () => false)).toBe(false);
  });

  it('ppid=1 且 pid 1 cmdline 不可读 → 保守非孤儿（宁漏杀勿误杀，--all 兜底）', () => {
    expect(isOrphanedProc(mk(1), () => true, () => null)).toBe(false);
  });
});
