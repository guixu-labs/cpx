// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// cpx 直传 git 镜像层（自 insight cannbay2/mirror.ts 受控移植，只保留上传
// 域：镜像生命周期 + uploadFolder；下载域 list/materialize/cat-file 不移植）。
// 两份实现由 tests/cannbay-parity.test.ts / cannbay-upload.test.ts 锁定关键
// 行为一致（LFS 中和配置、push --no-verify、baseline 交换、.gitattributes
// strip、幂等 unchanged）——这里的 git 序列漂移即测试失败。归档轮转
// （cannbay-archive planArchive）insight cannbay2 上传路径本就未接线，不移植。

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveCannbayRemote, stripUrlCreds, escapeRegExp, type CannbayRemote,
} from './remote';

// LFS 免疫（与 insight mirror.ts LFS_NEUTRALIZE 逐字一致，parity 锁定）：
// 数据仓 .gitattributes 历史带 filter=lfs 行 + 客户机装 git-lfs 时，smudge
// 会孤儿指针 403、clean 会把新文件指针化——per-command 中和让镜像内 git
// 操作对"装没装 git-lfs"完全不敏感
export const LFS_NEUTRALIZE = '-c filter.lfs.process= -c filter.lfs.smudge=cat -c filter.lfs.clean=cat -c filter.lfs.required=false';

export function runGit(cmd: string, cwd: string, timeoutMs = 120_000): Buffer {
  const neutral = cmd.startsWith('git ')
    ? `git ${LFS_NEUTRALIZE} ${cmd.slice('git '.length)}`
    : cmd;
  return execSync(neutral, { cwd, stdio: 'pipe', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
}

function runGitText(cmd: string, cwd: string): string {
  return runGit(cmd, cwd).toString();
}

// 跨进程初始化锁：O_EXCL 创建，持锁者完成后删除；崩溃残留按 mtime 超龄击穿
function withMirrorInitLock(dir: string, fn: () => void): void {
  const lock = `${dir}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const STALE_MS = 15 * 60_000;
  const deadline = Date.now() + STALE_MS;
  const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch {
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch { /* 锁刚被释放 —— 立即重试 */ }
      if (Date.now() > deadline) throw new Error(`cannbay mirror init lock timeout: ${lock}`);
      sleep(250);
    }
  }
  try {
    fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// tmp 克隆 + 原子 rename：目标目录只在克隆完整落盘后才存在；--no-local
// 保证本地 bare 测试远端不退化成全量硬链接克隆（忽略 --filter）
function cloneMirror(dir: string, remote: CannbayRemote): void {
  const target = path.resolve(dir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    runGit(`git clone --quiet --no-local --filter=blob:none --no-checkout "${remote.pullUrl}" "${tmp}"`, path.dirname(target), 600_000);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

function mirrorLocallyUsable(dir: string, remote: CannbayRemote): boolean {
  try {
    const originUrl = runGitText('git remote get-url origin', dir).trim();
    if (stripUrlCreds(originUrl) !== stripUrlCreds(remote.pullUrl)) return false;
    runGit(`git rev-parse --verify -q "refs/remotes/origin/${remote.branch}"`, dir);
    return true;
  } catch {
    return false;
  }
}

function tryFetchMirror(dir: string, remote: CannbayRemote): boolean {
  if (!fs.existsSync(path.join(dir, '.git'))) return false;
  try {
    runGit(`git fetch --quiet origin ${remote.branch}`, dir);
    return true;
  } catch {
    return mirrorLocallyUsable(dir, remote);
  }
}

/** 确保 partial clone 镜像存在且 origin/<branch> 元数据最新（不下载 blob）。 */
export function ensureMirror(remote: CannbayRemote = resolveCannbayRemote()): string {
  const dir = path.resolve(remote.cacheDir);
  if (tryFetchMirror(dir, remote)) return dir;
  withMirrorInitLock(dir, () => {
    if (!tryFetchMirror(dir, remote)) {
      cloneMirror(dir, remote);
    }
  });
  return dir;
}

export function revParseMain(dir: string, remote: CannbayRemote = resolveCannbayRemote()): string | null {
  try {
    return runGitText(`git rev-parse origin/${remote.branch}`, dir).trim();
  } catch {
    return null;
  }
}

// ── ls-tree 解析（quotepath 防线，-z 路径永不转义）─────────────────────

function decodeGitPath(p: string): string {
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p) as string;
  } catch {
    return p.replace(/^"|"$/g, '');
  }
}

function splitLsTreeEntry(rec: string): { meta: string; path: string } | null {
  const tab = rec.indexOf('\t');
  if (tab < 0) return null;
  return { meta: rec.slice(0, tab), path: decodeGitPath(rec.slice(tab + 1)) };
}

function lsTreeFiles(dir: string, spec: string, remote: CannbayRemote): string[] {
  const out = runGit(`git ls-tree -r -z --name-only origin/${remote.branch}${spec}`, dir).toString('utf8');
  return out.split('\0').map(l => l.trim()).filter(Boolean);
}

/** 数据仓顶层目录（范式注册表）——cpx 直传的范式目录白名单来源。 */
export function listParadigmDirs(remote: CannbayRemote = resolveCannbayRemote()): string[] {
  const dir = ensureMirror(remote);
  if (!revParseMain(dir, remote)) return [];
  const out = runGit(`git ls-tree -z --name-only origin/${remote.branch}`, dir).toString('utf8');
  const names: string[] = [];
  for (const line of out.split('\0')) {
    const name = decodeGitPath(line).trim().replace(/\/$/, '');
    if (name) names.push(name);
  }
  return names.filter(name => name !== remote.rootDir && name !== '.gitattributes').sort();
}

export interface SessionLocation {
  root: string;
  baseline: boolean;
}

function locationPath(loc: SessionLocation, sid: string): string {
  return loc.baseline ? `${loc.root}/baseline/${sid}` : `${loc.root}/${sid}`;
}

/** sid 在仓内的全部既有位置（多根：范式目录 + baseline + 存量区）。 */
function locateSessionLocations(dir: string, remote: CannbayRemote, sid: string): SessionLocation[] {
  if (!/^[\w.-]+$/.test(sid)) throw new Error(`Invalid session id: "${sid}"`);
  const out = runGit(`git ls-tree -r -z --name-only origin/${remote.branch}`, dir).toString('utf8');
  const re = new RegExp(`^(\\S+)/(baseline/)?${escapeRegExp(sid)}/`);
  const locs = new Map<string, SessionLocation>();
  for (const line of out.split('\0')) {
    const m = decodeGitPath(line).trim().match(re);
    if (m) locs.set(`${m[1]}/${m[2] ?? ''}`, { root: m[1], baseline: m[2] != null });
  }
  return [...locs.values()];
}

function locateBaselineSids(dir: string, remote: CannbayRemote, paradigm: string): string[] {
  const out = runGit(`git ls-tree -z --name-only origin/${remote.branch} ${paradigm}/baseline/`, dir).toString('utf8');
  const sids: string[] = [];
  for (const line of out.split('\0')) {
    const m = decodeGitPath(line).trim().match(/^[^/]+\/baseline\/([^/]+)\/?$/);
    if (m && m[1] !== '.gitkeep') sids.push(m[1]);
  }
  return sids;
}

// 进程内写锁：上传序列互斥
let writeLock: Promise<unknown> | null = null;
async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  while (writeLock) await writeLock;
  let release: () => void = () => {};
  writeLock = new Promise<void>(r => { release = r; });
  try {
    return await fn();
  } finally {
    writeLock = null;
    release();
  }
}

export interface UploadResult {
  folder: string;
  unchanged: boolean;
  gitattributesFixed: boolean;
}

/**
 * 把 stagingDir/sessions/<sid>/ 提交推送到远端 main（与 insight
 * uploadFolder 同序列）：baseline 交换语义 / sid 全仓唯一（旧位置同 commit
 * 删除）/ .gitattributes filter=lfs 行剔除 / push --no-verify + 并发重试。
 */
export async function uploadFolder(
  stagingDir: string, sid: string, commitMessage: string,
  remote: CannbayRemote = resolveCannbayRemote(), category?: string, baseline?: boolean,
): Promise<UploadResult> {
  return withWriteLock(async () => {
    if (!/^[\w.-]+$/.test(sid)) throw new Error(`Invalid session id: "${sid}"`);
    if (category != null && !/^[\w.-]+$/.test(category)) throw new Error(`Invalid paradigm dir: "${category}"`);
    const targetRoot = category ?? remote.rootDir;
    const dir = ensureMirror(remote);
    if (!revParseMain(dir, remote)) throw new Error('cannbay mirror has no main branch');

    const staleLocs = locateSessionLocations(dir, remote, sid)
      .filter(l => !(l.root === targetRoot && l.baseline === !!baseline));
    const swapBack: string[] = baseline
      ? locateBaselineSids(dir, remote, targetRoot).filter(s => s !== sid)
      : [];

    runGit('git sparse-checkout init --no-cone', dir);
    runGit(`git sparse-checkout set "/${targetRoot}/${sid}/**" "/.gitattributes"${staleLocs.map(l => ` "/${locationPath(l, sid)}/**"`).join('')}${baseline ? ` "/${targetRoot}/baseline/**"` : ''}${swapBack.map(s => ` "/${targetRoot}/${s}/**"`).join('')}`, dir);
    runGit(`git checkout -B ${remote.branch} origin/${remote.branch}`, dir);
    runGit('git reset --quiet', dir);

    for (const l of [...staleLocs.map(l => locationPath(l, sid)), baseline ? `${targetRoot}/baseline/${sid}` : `${targetRoot}/${sid}`]) {
      fs.rmSync(path.join(dir, ...l.split('/')), { recursive: true, force: true });
    }
    const targetRel = baseline ? `${targetRoot}/baseline/${sid}` : `${targetRoot}/${sid}`;
    const targetDir = path.join(dir, ...targetRel.split('/'));
    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(path.join(stagingDir, 'sessions', sid), targetDir, { recursive: true });

    const swapPaths: string[] = [];
    if (baseline) {
      fs.rmSync(path.join(dir, ...targetRoot.split('/'), 'baseline', '.gitkeep'), { force: true });
      for (const old of swapBack) {
        fs.rmSync(path.join(dir, ...targetRoot.split('/'), old), { recursive: true, force: true });
        fs.renameSync(
          path.join(dir, ...targetRoot.split('/'), 'baseline', old),
          path.join(dir, ...targetRoot.split('/'), old),
        );
        swapPaths.push(`${targetRoot}/${old}`);
      }
    }

    let gitattributesFixed = false;
    const gaPath = path.join(dir, '.gitattributes');
    if (fs.existsSync(gaPath)) {
      const ga = fs.readFileSync(gaPath, 'utf8');
      const fixed = ga.split('\n').filter(l => !l.includes('filter=lfs')).join('\n');
      if (fixed !== ga) {
        fs.writeFileSync(gaPath, fixed);
        runGit('git add .gitattributes', dir);
        gitattributesFixed = true;
      }
    }

    const addPaths = [targetRel, ...staleLocs.map(l => locationPath(l, sid)), ...swapPaths, ...(baseline ? [`${targetRoot}/baseline`] : [])];
    runGit(`git add ${addPaths.join(' ')}`, dir);
    const msgFile = path.join(dir, '_commit_msg.txt');
    fs.writeFileSync(msgFile, commitMessage);
    let unchanged = false;
    try {
      runGit(`git -c user.name=cpx -c user.email=cpx@localhost commit -F "${msgFile}"`, dir);
    } catch {
      try {
        runGit('git diff --cached --quiet', dir);
        unchanged = true;
      } catch {
        throw new Error(`git commit failed for session "${sid}" while staged changes exist`);
      }
    }
    try { fs.unlinkSync(msgFile); } catch { /* ignore */ }

    if (!unchanged) {
      const push = () => { runGit(`git push --no-verify "${remote.pushUrl}" ${remote.branch}`, dir, 300_000); };
      try {
        push();
      } catch {
        runGit(`git fetch --quiet origin ${remote.branch}`, dir);
        runGit(`git -c user.name=cpx -c user.email=cpx@localhost merge --allow-unrelated-histories --no-edit origin/${remote.branch}`, dir);
        push();
      }
    }
    return { folder: `${targetRel}/`, unchanged, gitattributesFixed };
  });
}
