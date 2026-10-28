// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// /proc 进程探测族（cpx status 列出/击杀 + 启动期清扫的活运行判定）。
// 从 cpx-cli.ts 抽出为独立可测模块——cpx-cli 底部 main().catch 自跑，测试
// 无法直接 import。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const CLK_TCK = 100;

export interface ProxyProc {
  pid: number; ppid: number | null; sid: string | null;
  upstream: string | null; ageSec: number | null; port: number | null;
}

function readProcFile(pid: number, name: string): string | null {
  try { return fs.readFileSync(`/proc/${pid}/${name}`, 'utf-8'); } catch { return null; }
}

// 读 /proc/<pid>/cmdline，归一为空白分隔的可读字符串（内核存 NUL 分隔的 argv）。
function readCmdline(pid: number): string | null {
  const cmd = readProcFile(pid, 'cmdline');
  return cmd == null ? null : cmd.replace(/\0/g, ' ');
}

function parseEnviron(s: string): Record<string, string> {
  const e: Record<string, string> = {};
  for (const kv of s.split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0) e[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return e;
}

// pid → listening port on 127.0.0.1, via `ss` (best-effort; absent → empty map).
function readListenPorts(): Map<number, number> {
  const m = new Map<number, number>();
  let out = '';
  try { out = spawnSync('ss', ['-ltnp'], { encoding: 'utf-8' }).stdout ?? ''; } catch { return m; }
  if (!out) return m;
  for (const line of out.split('\n')) {
    const pm = line.match(/pid=(\d+)/);
    const ptm = line.match(/127\.0\.0\.1:(\d+)/);
    if (pm && ptm) {
      const pid = parseInt(pm[1]); const port = parseInt(ptm[1]);
      if (pid && port) m.set(pid, port);
    }
  }
  return m;
}

// 活运行判定（启动期清扫的生命线）：以 env 标记 CONTEXT_PROXY_SESSION_ID 为
// 准——该变量仅由 startSessionProxy 注入 proxy 进程树，与安装布局零耦合。
// 旧实现按 cmdline 匹配 'proxy/src/server.ts'（老仓库布局的残留），新
// monorepo（packages/cpx/src/server.ts）与 npm 件（context-cpx/src/
// server.ts）全都匹配不上 → livePinned 恒为空 → 清扫把活运行的
// .sids 清单 + 0 字节占位当泄漏删除 → 该运行退出时 "no capture file
// produced"（捕获本体无损，仅自动导入丢失。实测 2026-09-21 ses_f4c5b02…
// 17MB 捕获在盘、清单被并发源码树启动清扫误删）。
// cmdline 仍要求含 'server.ts'：排除继承同一 env 的 proxy 子件（如 tsx 的
// esbuild service 子进程——env 相同但 cmdline 无 server.ts，避免 status
// 重复行）。所有布局（老仓库/monorepo/npm 件/任意品牌名）的 PROXY_SERVER
// 均以 src/server.ts 结尾，文件名耦合是安全的。
export function findProxyProcs(): ProxyProc[] {
  let pids: number[] = [];
  try { pids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).map(Number); } catch { return []; }
  const portMap = readListenPorts();
  let uptime: number | null = null;
  try { uptime = parseFloat(fs.readFileSync('/proc/uptime', 'utf-8').split(/\s+/)[0]); } catch { /* */ }
  const out: ProxyProc[] = [];
  for (const pid of pids) {
    const env = parseEnviron(readProcFile(pid, 'environ') ?? '');
    if (!env.CONTEXT_PROXY_SESSION_ID) continue;
    const cmd = readProcFile(pid, 'cmdline');
    if (!cmd || !cmd.replace(/\0/g, ' ').includes('server.ts')) continue;
    let ppid: number | null = null; let ageSec: number | null = null;
    const stat = readProcFile(pid, 'stat');
    if (stat) {
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      ppid = parseInt(after[1]) || null;
      const st = parseInt(after[19]);
      if (uptime && Number.isFinite(st)) ageSec = Math.max(0, uptime - st / CLK_TCK);
    }
    out.push({
      pid, ppid,
      sid: env.CONTEXT_PROXY_SESSION_ID ?? null,
      upstream: env.CONTEXT_PROXY_ANTHROPIC_UPSTREAM ?? null,
      ageSec, port: portMap.get(pid) ?? null,
    });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

// Dedupe the (npx-parent → node-child) pair: the npx wrapper has no port and
// is the parent of the actual server child. Keep the child (port bearer);
// drop port-less procs that are an ancestor of another matched proc.
export function dedupePairs(procs: ProxyProc[]): ProxyProc[] {
  return procs.filter(p => !(p.port == null && procs.some(q => q.ppid === p.pid)));
}

/** 孤儿 proxy 判定（`--kill` 不带 `--all` 时的目标集）。env 标记模型下匹配到的
 *  proxy 恒有 sid——旧「无 sid = 孤儿」判定结构性空转；孤儿语义改为「父进程
 *  已死」（cpx-cli 退出后内核重挂 init/pid 1 的泄漏 proxy）。父死重挂后 ppid
 *  指向重挂目标（不再指向死 pid），故判 ppid === 1 或 ppid 不可达；subreaper
 *  环境下重挂目标是活跃 subreaper 而非 pid 1 的形态检测不到——`--all` 兜底。
 *  ppid 未知（/proc stat 不可读）保守判非孤儿，宁漏杀勿误杀。alive 与 cmdline
 *  均由调用方注入（cpx-cli 的 isAlive / 本模块的 readCmdline），纯谓词可确定性
 *  单测。 */
export function isOrphanedProc(
  p: ProxyProc,
  alive: (pid: number) => boolean,
  cmdlineOf: (pid: number) => string | null = readCmdline,
): boolean {
  if (p.ppid == null) return false; // ppid 未知 → 保守非孤儿
  if (p.ppid === 1) {
    // pid 1 有两种真实身份：① 容器以 cpx 作 entrypoint（`docker run … cpx …`）时
    // pid 1 就是活着的 cpx-cli（proxy 的真父）；② 父死重挂后被 init/systemd
    // 收养。两者 ppid 都是 1，区分靠 pid 1 的 cmdline 是否 cpx 系进程——
    // cli 入口恒为 cpx-cli.ts / bin cpx（含品牌变体与 npm 件，文件名契约不换）。
    // 是 cpx 系 → 活父非孤儿（宁漏杀勿误杀，绝不误杀活着 entrypoint 的会话）；
    // 是 init/systemd → 孤儿。cmdline 不可读 → 保守非孤儿（--all 兜底）。
    const cmd = cmdlineOf(1);
    if (cmd == null) return false;
    return !cmd.includes('cpx');
  }
  return !alive(p.ppid);
}
