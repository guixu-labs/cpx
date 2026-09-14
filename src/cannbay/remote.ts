// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// cpx 直传远端解析层（自 insight cannbay2/remote.ts 受控移植——两份实现由
// tests/cannbay-parity.test.ts 锁定行为一致，git 序列的漂移即测试失败）。
// cpx 直传只面向默认数据之仓（+ env 覆写）；自定义数据湖/账号密码仍走
// insight Web UI。缓存目录与 insight 镜像隔离：两套代码不共写同一 .git，
// 锁协议虽同款但独立目录让互踩面归零。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// env 三件套调用时惰性读取（不在模块加载时定死——vitest worker 跨测试文件
// 共享模块缓存，先加载者会把 env 钉死在默认值；测试与运行期均按调用时刻
// 环境解析）。测试指向本地 bare 仓 / 用户覆写同一条路。
export function envPullUrl(): string {
  return process.env.CANNBAY2_REMOTE_URL ?? 'https://atomgit.com/duanbingzhe/cannbay3.git';
}

// 密文常量（与 insight cannbay2/remote.ts 同一枚，parity 测试锁同值）
const CANNBAY2_PUSH_URL_ENCODED = 'aHR0cHM6Ly9kdWFuYmluZ3poZTpvU1I1aTF3WXZ5dlZpUmdMbXdna3NDeG5AYXRvbWdpdC5jb20vZHVhbmJpbmd6aGUvY2FubmJheTMuZ2l0';

export function envPushUrl(): string {
  return process.env.CANNBAY2_PUSH_URL ?? Buffer.from(CANNBAY2_PUSH_URL_ENCODED, 'base64').toString();
}

export function envBranch(): string {
  return process.env.CANNBAY2_BRANCH ?? 'main';
}

export interface CannbayRemote {
  pullUrl: string;
  pushUrl: string;
  branch: string;
  rootDir: string;
  cacheDir: string;
  paradigmRoots: boolean;
}

const FORBIDDEN_ADDRESS_CHARS = /["'`$;&|\n\r]/;

export function stripUrlCreds(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@]+@/i, '$1');
}

export function validateBranch(branch: string): string {
  const b = branch.trim();
  if (!/^[\w.-]+$/.test(b)) throw new Error(`无效分支名: "${b.slice(0, 40)}"`);
  return b;
}

export function normalizeDirPrefix(prefix?: string): string {
  const d = (prefix ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!d) return '';
  if (d.length > 200 || d.includes('\\')) throw new Error(`无效目录: "${d.slice(0, 60)}"`);
  const segments = d.split('/');
  if (segments.length > 16) throw new Error('目录层级过深（最多 16 段）');
  for (const seg of segments) {
    if (!/^[\w\u0080-\uFFFF.-]+$/.test(seg) || seg === '.' || seg === '..') {
      throw new Error(`无效目录: "${d.slice(0, 60)}"`);
    }
  }
  return segments.join('/');
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// cpx 镜像缓存独立于 insight（默认 ~/.cannbot-insight/cannbay-cache-cpx），
// 防两套实现共写同一镜像仓；CANNBAY2_CACHE_DIR 覆写沿用于测试指向
function defaultCacheDir(): string {
  return path.resolve(
    process.env.CANNBAY2_CPX_CACHE_DIR
    ?? path.join(os.homedir(), '.cannbot-insight', 'cannbay-cache-cpx'),
  );
}

/** 默认仓远端（cpx 直传场景）；env 三件套覆写测试用。 */
export function resolveCannbayRemote(): CannbayRemote {
  const credlessPull = (() => {
    const t = envPullUrl().trim();
    if (FORBIDDEN_ADDRESS_CHARS.test(t)) throw new Error('数据湖地址含非法字符');
    return t.replace(/\/+$/, '');
  })();
  const branch = validateBranch(envBranch());
  const cacheDir = path.join(
    defaultCacheDir(),
    createHash('sha1').update(`${stripUrlCreds(credlessPull)}|${branch}`).digest('hex').slice(0, 12),
  );
  return {
    pullUrl: credlessPull,
    pushUrl: envPushUrl(),
    branch,
    rootDir: 'sessions',
    cacheDir,
    paradigmRoots: true,
  };
}

export function redactRemoteSecrets(message: string): string {
  return message
    .replace(envPushUrl(), '<push-url>')
    .replace(/https:\/\/[^/\s"']+@/g, 'https://<creds>@');
}

export function ensureCacheParent(dir: string): void {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
}
