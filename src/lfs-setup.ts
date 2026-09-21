// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// git-lfs 自举：LFS 上传默认开启后 git-lfs 成为上传路径的硬依赖，缺件时
// 自动下载 cpx 私有件到 ~/.cannbot-insight/bin/git-lfs（PROXY_DIR 推导，
// pack-context 品牌随包翻转）——零提权、零全局污染：只在 cpx 自己 spawn 的
// git 进程 env 里前置私有 bin 目录（runGit / 钩子 / filter 进程是其子进程，
// 继承 env 自然命中），系统级 PATH 与 gitconfig 一概不碰。
// 版本 pin + sha256 校验（源：git-lfs v3.8.0 release 的 sha256sums.asc），
// 下载源支持 env CANNBOT_CPX_LFS_BASE 覆写（按 releases/download 路径结构
// 镜像的自建源/代理），失败降级为指引报错（不比无自举的现状差）。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROXY_DIR } from './writer';

const GIT_LFS_VERSION = '3.8.0';
const GIT_LFS_SHA256: Record<string, string> = {
  'linux-x64': 'e455e00f15d9b95661b8d53498ffb0c3367962cf1ec73c31ab7369516cd6ab8d',
  'linux-arm64': 'ac9c8efac980bb0505ead384d087e2acb6486fd8498691a2165fa174ec6118c2',
  'darwin-x64': 'f1c17aeca0b4eaab9ea606226477dbed3b84b56fe0811a9f967d2ea2b2393c53',
  'darwin-arm64': 'caff76a7d070d8160c89bc39b6e85d98f24135b6fed038a3b4de2590d25102d8',
};
const DEFAULT_BASE = 'https://github.com/git-lfs/git-lfs/releases/download';

export function platformKey(): string {
  const p = process.platform;
  const a = process.arch;
  if (p === 'linux' && (a === 'x64' || a === 'arm64')) return `linux-${a}`;
  if (p === 'darwin' && (a === 'x64' || a === 'arm64')) return `darwin-${a}`;
  return '';
}

export function lfsAssetName(key: string): string {
  const arch = key.endsWith('-x64') ? 'amd64' : 'arm64';
  return key.startsWith('darwin')
    ? `git-lfs-darwin-${arch}-v${GIT_LFS_VERSION}.zip`
    : `git-lfs-linux-${arch}-v${GIT_LFS_VERSION}.tar.gz`;
}

export function lfsDownloadUrl(key: string, baseUrl?: string): string {
  const base = (baseUrl ?? process.env.CANNBOT_CPX_LFS_BASE ?? DEFAULT_BASE).replace(/\/+$/, '');
  return `${base}/v${GIT_LFS_VERSION}/${lfsAssetName(key)}`;
}

/** 私有 bin 目录（~/.cannbot-insight/bin；CANNBOT_PROXY_DIR 重定向优先——测试隔离）。 */
export function lfsBinDir(): string {
  return path.join(path.dirname(process.env.CANNBOT_PROXY_DIR ?? PROXY_DIR), 'bin');
}

export function lfsBinaryPath(): string {
  return path.join(lfsBinDir(), 'git-lfs');
}

/** 系统 git-lfs 健康检查（`git lfs version`，经 git 按 PATH 解析）。 */
export function systemGitLfsOk(): boolean {
  try {
    const r = spawnSync('git', ['lfs', 'version'], { stdio: 'pipe', timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** 私有件健康检查（直接执行 `<path> version`）。 */
export function privateGitLfsOk(): boolean {
  const p = lfsBinaryPath();
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    return spawnSync(p, ['version'], { stdio: 'pipe', timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

export type LfsSource = 'system' | 'private' | 'none';

export function gitLfsSource(): LfsSource {
  if (systemGitLfsOk()) return 'system';
  if (privateGitLfsOk()) return 'private';
  return 'none';
}

/** cpx 自身 git 子进程的 env：私有件存在时前置 bin 目录（仅影响本进程树，
 *  不碰用户 PATH/gitconfig——钩子与 filter 进程是这些 git 的子进程，继承
 *  env 自然命中）。无私有件时原样返回（行为逐字节不变）。 */
export function gitSpawnEnv(): NodeJS.ProcessEnv {
  if (!fs.existsSync(lfsBinaryPath())) return process.env;
  const PATH = [lfsBinDir(), process.env.PATH].filter(Boolean).join(path.delimiter);
  return { ...process.env, PATH };
}

export function lfsSetupGuidance(reason: string): string {
  return `LFS 模式需要 git-lfs，自动获取失败（${reason}）。出路：
  1. 配置可达镜像后重试：export CANNBOT_CPX_LFS_BASE=<镜像基址>（按 git-lfs releases/download 路径结构镜像），再运行 cpx lfs-setup
  2. 系统安装 git-lfs：https://git-lfs.github.com（apt install git-lfs / brew install git-lfs）
  3. 关闭 LFS 走普通 git 存储：cpx config lfs off（或 CANNBAY2_LFS=0）`;
}

export interface LfsSetupDeps {
  fetchImpl?: typeof fetch;
  /** 测试注入：覆写下载基址（缺省 env CANNBOT_CPX_LFS_BASE > GitHub 官方） */
  baseUrl?: string;
  /** 测试注入：覆写期望 sha256（缺省 = pin 表） */
  sha256?: string;
  log?: (msg: string) => void;
}

export interface LfsSetupResult {
  source: 'system' | 'private';
  downloaded: boolean;
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function extractArchive(archive: string, dest: string): void {
  const r = archive.endsWith('.tar.gz')
    ? spawnSync('tar', ['-xzf', archive, '-C', dest], { stdio: 'pipe', timeout: 60_000 })
    : spawnSync('unzip', ['-o', archive, '-d', dest], { stdio: 'pipe', timeout: 60_000 });
  if (r.error || r.status !== 0) {
    throw new Error(`解压失败（${archive.endsWith('.tar.gz') ? 'tar' : 'unzip'} ${r.error ? r.error.message : `exit ${r.status}`}）`);
  }
}

// release 归档为单顶层目录 git-lfs-<ver>/git-lfs；walk 兜底不依赖该布局
function findBinary(root: string): string | null {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === 'git-lfs') return p;
      if (e.isDirectory()) stack.push(p);
    }
  }
  return null;
}

/** 确保 git-lfs 可用：系统件 > cpx 私有件 > 自动下载私有件（sha256 校验）。
 *  任一环节就绪即返回；全部失败抛指引错误（上传路径据此拒绝，捕获保留本地）。 */
export async function ensureLfsBinaryAvailable(deps: LfsSetupDeps = {}): Promise<LfsSetupResult> {
  if (systemGitLfsOk()) return { source: 'system', downloaded: false };
  if (privateGitLfsOk()) return { source: 'private', downloaded: false };

  const key = platformKey();
  if (!key) {
    throw new Error(lfsSetupGuidance(`当前平台 ${process.platform}-${process.arch} 无自举资产（覆盖 linux/darwin x64/arm64）`));
  }
  const log = deps.log ?? ((m: string) => console.error(`[cpx] ${m}`));
  const url = lfsDownloadUrl(key, deps.baseUrl);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `cpx-lfs-setup-${process.pid}-`));
  try {
    log(`git-lfs 自举：下载 ${url}（约 6MB，慢网络可 export CANNBOT_CPX_LFS_BASE 配镜像）`);
    const res = await (deps.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`下载 HTTP ${res.status}`);
    fs.writeFileSync(path.join(staging, lfsAssetName(key)), Buffer.from(await res.arrayBuffer()));

    const expect = deps.sha256 ?? GIT_LFS_SHA256[key];
    const got = sha256File(path.join(staging, lfsAssetName(key)));
    if (got !== expect) {
      throw new Error(`sha256 校验失败（期望 ${expect.slice(0, 12)}…，实得 ${got.slice(0, 12)}…）——下载源可能损坏或被污染`);
    }

    const ex = path.join(staging, 'ex');
    fs.mkdirSync(ex);
    extractArchive(path.join(staging, lfsAssetName(key)), ex);
    const bin = findBinary(ex);
    if (!bin) throw new Error('归档中未找到 git-lfs 可执行件');

    fs.mkdirSync(lfsBinDir(), { recursive: true });
    fs.copyFileSync(bin, lfsBinaryPath());
    fs.chmodSync(lfsBinaryPath(), 0o755);
    if (!privateGitLfsOk()) throw new Error('安装后自检失败（私有件不可执行）');
    log(`git-lfs 私有件就绪 → ${lfsBinaryPath()}`);
    return { source: 'private', downloaded: true };
  } catch (e) {
    throw new Error(lfsSetupGuidance(e instanceof Error ? e.message : String(e)));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
