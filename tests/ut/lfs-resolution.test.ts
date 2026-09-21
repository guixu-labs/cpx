// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// LFS 默认开启决议链 IT：env CANNBAY2_LFS 显式值（1/true/on 开、0/false/off
// 关）> cpx-config.json 的 lfsUpload（cpx config lfs on|off 持久选择）> 默认开。
// config 路径随 CANNBOT_PROXY_DIR 重定向（与 dedup 同源，测试隔离）。配套：
// requireGitLfs fail-fast（PATH shim 假装有 git 无 git-lfs）+ uploadCaptureSession
// 在 staging 之前拒绝。

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

let tmp: string;
let cfgFile: string;
let captures: string;
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(name: string): void {
  savedEnv[name] = process.env[name];
}

function restoreEnv(name: string): void {
  if (savedEnv[name] === undefined) delete process.env[name];
  else process.env[name] = savedEnv[name];
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lfs-resolution-it-'));
  captures = path.join(tmp, 'proxy');
  fs.mkdirSync(captures, { recursive: true });
  // config 落在 dirname(proxyDir)：CANNBOT_PROXY_DIR 重定向即隔离
  cfgFile = path.join(path.dirname(captures), 'cpx-config.json');
  for (const k of ['CANNBAY2_LFS', 'CANNBOT_PROXY_DIR', 'CANNBAY2_REMOTE_URL', 'CANNBAY2_PUSH_URL', 'CANNBAY2_CPX_CACHE_DIR']) saveEnv(k);
  process.env.CANNBOT_PROXY_DIR = captures;
});

afterAll(() => {
  for (const k of Object.keys(savedEnv)) restoreEnv(k);
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.CANNBAY2_LFS;
  try { fs.rmSync(cfgFile); } catch { /* 不存在 */ }
});

async function importRemote() {
  return await import('../../src/cannbay/remote');
}

describe('resolveLfs 三层决议链', () => {
  it('默认：无 env 无 config → 开（source=default）；resolveCannbayRemote 同源', async () => {
    const { resolveLfs, resolveCannbayRemote } = await importRemote();
    expect(resolveLfs()).toEqual({ enabled: true, source: 'default' });
    expect(resolveCannbayRemote().lfs).toBe(true);
  });

  it('env 显式关：0/false/off → 关（source=env）', async () => {
    const { resolveLfs } = await importRemote();
    for (const v of ['0', 'false', 'off']) {
      process.env.CANNBAY2_LFS = v;
      expect(resolveLfs()).toEqual({ enabled: false, source: 'env' });
    }
  });

  it('env 显式开：1/true/on → 开（source=env，与默认同值不同源）', async () => {
    const { resolveLfs } = await importRemote();
    for (const v of ['1', 'true', 'on']) {
      process.env.CANNBAY2_LFS = v;
      expect(resolveLfs()).toEqual({ enabled: true, source: 'env' });
    }
  });

  it('env 未设但值未识别（如空串/typo）→ 落 config/默认链', async () => {
    const { resolveLfs } = await importRemote();
    process.env.CANNBAY2_LFS = '';
    expect(resolveLfs().source).toBe('default');
  });

  it('config 持久选择：lfsUpload=false → 关（source=config）；true → 开', async () => {
    const { resolveLfs } = await importRemote();
    fs.writeFileSync(cfgFile, JSON.stringify({ dedupInjection: true, lfsUpload: false }));
    expect(resolveLfs()).toEqual({ enabled: false, source: 'config' });
    fs.writeFileSync(cfgFile, JSON.stringify({ lfsUpload: true }));
    expect(resolveLfs()).toEqual({ enabled: true, source: 'config' });
  });

  it('env 显式压过 config（双向）', async () => {
    const { resolveLfs } = await importRemote();
    fs.writeFileSync(cfgFile, JSON.stringify({ lfsUpload: false }));
    process.env.CANNBAY2_LFS = '1';
    expect(resolveLfs()).toEqual({ enabled: true, source: 'env' });
    fs.writeFileSync(cfgFile, JSON.stringify({ lfsUpload: true }));
    process.env.CANNBAY2_LFS = '0';
    expect(resolveLfs()).toEqual({ enabled: false, source: 'env' });
  });

  it('老配置文件（仅 dedupInjection，无 lfsUpload 字段）→ 跟随默认开', async () => {
    const { resolveLfs } = await importRemote();
    fs.writeFileSync(cfgFile, JSON.stringify({ dedupInjection: true }));
    expect(resolveLfs()).toEqual({ enabled: true, source: 'default' });
  });

  it('坏 config 文件（非法 JSON）→ 默认开不抛', async () => {
    const { resolveLfs } = await importRemote();
    fs.writeFileSync(cfgFile, '{not json');
    expect(resolveLfs()).toEqual({ enabled: true, source: 'default' });
  });
});

// PATH shim：只拦截 `git lfs version`（exit 1），其余 git 透传真身——
// 模拟"有 git 无 git-lfs"的机器
function withNoLfsPath<T>(fn: () => T): T {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-nolfs-bin-'));
  const realGit = execSync('command -v git', { shell: '/bin/sh' }).toString().trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nif [ "$1" = "lfs" ]; then exit 1; fi\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  try {
    return fn();
  } finally {
    process.env.PATH = prevPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

describe('requireGitLfs fail-fast（默认开后缺件必须给出路）', () => {
  it('hasGitLfs 对 shim PATH 判 false；requireGitLfs 报错含安装指引与关闭出路', async () => {
    const { hasGitLfs, requireGitLfs } = await import('../../src/cannbay/mirror');
    withNoLfsPath(() => {
      expect(hasGitLfs()).toBe(false);
      expect(() => requireGitLfs()).toThrow('git-lfs');
      expect(() => requireGitLfs()).toThrow('cpx config lfs off');
      expect(() => requireGitLfs()).toThrow('CANNBAY2_LFS=0');
    });
  });

  it('uploadCaptureSession：remote.lfs=true 且缺 git-lfs、自举失败 → staging 之前拒绝（报错即出路）', async () => {
    const { uploadCaptureSession } = await import('../../src/cannbay');
    const sid = 'ses-nolfs';
    const cap = path.join(captures, `cpx-${sid}.jsonl.gz`);
    fs.writeFileSync(cap, zlib.gzipSync('{}\n'));
    fs.writeFileSync(path.join(captures, `cpx-${sid}.meta.json`), JSON.stringify({
      x_cannbay: { schema: 'cc-session-meta', version: 1, data: { producer: 'cpx', framework: 'claude-code', protocol: 'anthropic', sid } },
    }));
    const remote = {
      pullUrl: '/nonexistent/x.git', pushUrl: '/nonexistent/x.git', pushAuth: null,
      branch: 'main', rootDir: 'sessions', cacheDir: path.join(tmp, 'no-cache'), paradigmRoots: true, lfs: true,
    };
    await withNoLfsPath(async () => {
      // 自动自举失败（注入 fetch，不打外网）→ 指引错误，staging 之前拒绝
      await expect(uploadCaptureSession({
        sid, captureFile: cap, description: '提交人: 张三', category: 'agent-sift', remote,
        lfsDeps: {
          fetchImpl: (async () => new Response(null, { status: 503 })) as typeof fetch,
          baseUrl: 'https://mirror.example.com',
        },
      })).rejects.toThrow('cpx config lfs off');
    });
  });
});
