// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// git-lfs 自举 IT（全程离线——下载走注入 fetchImpl + 测试内构造的真实 tar.gz
// 夹具；系统件探测走 PATH shim）：
//   ① 资产映射：平台 → 资产名 / 下载 URL（env 基址覆写、尾斜杠归一）
//   ② gitSpawnEnv：无私有件原样返回；有私有件前置 bin 目录（只影响本进程树）
//   ③ ensureLfsBinaryAvailable：系统件在 → no-op；私有件在 → no-op；双缺 →
//      下载+sha256 校验+解压+落盘+chmod+自检（坏哈希熔断 / 下载失败给指引）
//   ④ uploadCaptureSession 接线：LFS 模式 + 双缺 + 下载失败 → 指引错误
//   ⑤ 全链路（有真 git-lfs 的机器）：真件拷入私有目录 + PATH shim 遮蔽系统件
//      → upload 走私有件出 LFS 指针（runGit env 注入终验）
//   ⑥ postinstall 门控：CPX_SKIP_LFS_SETUP=1 / CI=true 跳过自举（不打外网）

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

let tmp: string;
let captures: string;
let binDir: string;
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(name: string): void {
  savedEnv[name] = process.env[name];
}
function restoreEnv(name: string): void {
  if (savedEnv[name] === undefined) delete process.env[name];
  else process.env[name] = savedEnv[name];
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lfs-setup-it-'));
  captures = path.join(tmp, 'proxy');
  fs.mkdirSync(captures, { recursive: true });
  binDir = path.join(tmp, 'bin'); // = dirname(captures)/bin —— CANNBOT_PROXY_DIR 重定向
  for (const k of ['CANNBOT_PROXY_DIR', 'CANNBAY2_LFS', 'CANNBOT_CPX_LFS_BASE', 'CANNBAY2_REMOTE_URL', 'CANNBAY2_PUSH_URL', 'CANNBAY2_CPX_CACHE_DIR', 'PATH']) saveEnv(k);
  process.env.CANNBOT_PROXY_DIR = captures;
  delete process.env.CANNBOT_CPX_LFS_BASE;
});

afterAll(() => {
  for (const k of Object.keys(savedEnv)) restoreEnv(k);
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.CANNBAY2_LFS;
  delete process.env.CANNBOT_CPX_LFS_BASE;
  fs.rmSync(binDir, { recursive: true, force: true });
});

const lfs = () => import('../../src/lfs-setup');

// —— PATH shim ——
// noLfs：git lfs version 必败（模拟无 git-lfs 的机器）；其余 git 透传真身
function withNoLfsPath<T>(fn: () => T): T {
  return withShimPath(['lfs'], fn);
}
// systemLfs：git lfs version 直接成功（模拟系统件在，无需真件）
function withSystemLfsPath<T>(fn: () => T): T {
  return withShimPath(['ok-lfs'], fn);
}
function withShimPath<T>(modes: string[], fn: () => T): T {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'lfs-shim-'));
  const realGit = execSync('command -v git', { shell: '/bin/sh' }).toString().trim();
  const script = modes.includes('ok-lfs')
    ? '#!/bin/sh\nif [ "$1" = "lfs" ]; then echo "git-lfs/0.0.0 (shim)"; exit 0; fi\nexec "' + realGit + '" "$@"\n'
    : '#!/bin/sh\nif [ "$1" = "lfs" ]; then exit 1; fi\nexec "' + realGit + '" "$@"\n';
  fs.writeFileSync(path.join(bin, 'git'), script, { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  try {
    return fn();
  } finally {
    process.env.PATH = prevPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

// 测试内构造真实 tar.gz 夹具：单顶层目录 git-lfs-x.y.z/ 下的可执行 git-lfs 桩
function makeFixtureTarball(): { gz: Buffer; sha256: string } {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lfs-fixture-'));
  try {
    const pkg = path.join(stage, 'git-lfs-9.9.9');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'git-lfs'), '#!/bin/sh\necho "git-lfs/9.9.9 (fixture)"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(pkg, 'README.md'), 'fixture\n');
    execSync(`tar -czf ${JSON.stringify(path.join(stage, 'f.tgz'))} -C ${JSON.stringify(stage)} git-lfs-9.9.9`, { stdio: 'pipe' });
    const gz = fs.readFileSync(path.join(stage, 'f.tgz'));
    return { gz, sha256: createHash('sha256').update(gz).digest('hex') };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function mockFetchServing(body: Buffer, status = 200): typeof fetch {
  return (async (url: any) => {
    void url;
    return new Response(new Uint8Array(body), { status, headers: { 'content-type': 'application/octet-stream' } });
  }) as typeof fetch;
}

describe('资产映射', () => {
  it('平台 → 资产名（linux tar.gz / darwin zip；x64→amd64）', async () => {
    const { lfsAssetName } = await lfs();
    expect(lfsAssetName('linux-x64')).toBe('git-lfs-linux-amd64-v3.8.0.tar.gz');
    expect(lfsAssetName('linux-arm64')).toBe('git-lfs-linux-arm64-v3.8.0.tar.gz');
    expect(lfsAssetName('darwin-x64')).toBe('git-lfs-darwin-amd64-v3.8.0.zip');
    expect(lfsAssetName('darwin-arm64')).toBe('git-lfs-darwin-arm64-v3.8.0.zip');
  });
  it('下载 URL：默认 GitHub；env/deps 基址覆写 + 尾斜杠归一', async () => {
    const { lfsDownloadUrl } = await lfs();
    expect(lfsDownloadUrl('linux-x64')).toBe('https://github.com/git-lfs/git-lfs/releases/download/v3.8.0/git-lfs-linux-amd64-v3.8.0.tar.gz');
    process.env.CANNBOT_CPX_LFS_BASE = 'https://mirror.example.com/git-lfs//';
    expect(lfsDownloadUrl('linux-x64')).toBe('https://mirror.example.com/git-lfs/v3.8.0/git-lfs-linux-amd64-v3.8.0.tar.gz');
    delete process.env.CANNBOT_CPX_LFS_BASE;
    expect(lfsDownloadUrl('linux-x64', 'https://dep.example.com/')).toBe('https://dep.example.com/v3.8.0/git-lfs-linux-amd64-v3.8.0.tar.gz');
  });
});

describe('gitSpawnEnv（PATH 注入只影响本进程树）', () => {
  it('无私有件 → 原样返回 process.env（行为不变）', async () => {
    const { gitSpawnEnv } = await lfs();
    expect(gitSpawnEnv()).toBe(process.env);
  });
  it('有私有件 → PATH 前置 bin 目录；原 PATH 保留', async () => {
    const { gitSpawnEnv, lfsBinaryPath } = await lfs();
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(lfsBinaryPath(), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = gitSpawnEnv();
    expect(env).not.toBe(process.env);
    expect(env.PATH!.startsWith(`${binDir}${path.delimiter}`)).toBe(true);
    expect(env.PATH!).toContain(savedEnv.PATH ?? '');
  });
});

describe('ensureLfsBinaryAvailable（离线全链路）', () => {
  it('系统件在 → {system}，零副作用', async () => {
    const { ensureLfsBinaryAvailable } = await lfs();
    const r = await withSystemLfsPath(() => ensureLfsBinaryAvailable({}));
    expect(r).toEqual({ source: 'system', downloaded: false });
    expect(fs.existsSync(binDir)).toBe(false);
  });
  it('私有件在 → {private} 不再下载', async () => {
    const { ensureLfsBinaryAvailable, lfsBinaryPath } = await lfs();
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(lfsBinaryPath(), '#!/bin/sh\necho "git-lfs/9.9.9 (stub)"\n', { mode: 0o755 });
    let called = false;
    const r = await withNoLfsPath(() => ensureLfsBinaryAvailable({
      fetchImpl: (async () => { called = true; return new Response(null, { status: 500 }); }) as typeof fetch,
    }));
    expect(r).toEqual({ source: 'private', downloaded: false });
    expect(called).toBe(false);
  });
  it('双缺 → 下载+校验+解压+落盘+chmod+自检（真实 tar.gz 夹具）', async () => {
    const { ensureLfsBinaryAvailable, lfsBinaryPath } = await lfs();
    const fx = makeFixtureTarball();
    const logs: string[] = [];
    const r = await withNoLfsPath(() => ensureLfsBinaryAvailable({
      fetchImpl: mockFetchServing(fx.gz),
      sha256: fx.sha256,
      log: m => logs.push(m),
      baseUrl: 'https://mirror.example.com', // deps 覆写：不依赖默认源
    }));
    expect(r).toEqual({ source: 'private', downloaded: true });
    expect(fs.existsSync(lfsBinaryPath())).toBe(true);
    expect(fs.statSync(lfsBinaryPath()).mode & 0o111).toBeTruthy(); // 可执行
    const out = spawnSync(lfsBinaryPath(), ['version'], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('git-lfs/9.9.9 (fixture)');
    expect(logs.join('\n')).toContain('自举');
    // 再调一次：私有件就绪，不再下载
    let called = false;
    const r2 = await withNoLfsPath(() => ensureLfsBinaryAvailable({
      fetchImpl: (async () => { called = true; return new Response(null, { status: 500 }); }) as typeof fetch,
    }));
    expect(r2).toEqual({ source: 'private', downloaded: false });
    expect(called).toBe(false);
  });
  it('sha256 不符 → 熔断不落盘，错误含校验失败与出路', async () => {
    const { ensureLfsBinaryAvailable, lfsBinaryPath } = await lfs();
    const fx = makeFixtureTarball();
    await expect(withNoLfsPath(() => ensureLfsBinaryAvailable({
      fetchImpl: mockFetchServing(fx.gz),
      sha256: 'deadbeef'.repeat(8),
      baseUrl: 'https://mirror.example.com',
    }))).rejects.toThrow('sha256 校验失败');
    expect(fs.existsSync(lfsBinaryPath())).toBe(false);
  });
  it('下载失败（HTTP 500）→ 指引错误（镜像 env / 系统安装 / 关闭 LFS 三条出路）', async () => {
    const { ensureLfsBinaryAvailable } = await lfs();
    const err = await withNoLfsPath(() => ensureLfsBinaryAvailable({
      fetchImpl: (async () => new Response(null, { status: 500 })) as typeof fetch,
      baseUrl: 'https://mirror.example.com',
    })).catch(e => e as Error);
    expect(err.message).toContain('HTTP 500');
    expect(err.message).toContain('CANNBOT_CPX_LFS_BASE');
    expect(err.message).toContain('git-lfs.github.com');
    expect(err.message).toContain('cpx config lfs off');
    expect(err.message).toContain('CANNBAY2_LFS=0');
  });
});

describe('uploadCaptureSession 接线（上传时自动自举）', () => {
  it('LFS 模式 + 双缺 + 下载失败 → 指引错误（staging 前拒绝）', async () => {
    const cannbay = await import('../../src/cannbay');
    const sid = 'ses-lfssetup';
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
      await expect(cannbay.uploadCaptureSession({
        sid, captureFile: cap, description: '提交人: 张三', category: 'agent-sift', remote,
        lfsDeps: {
          fetchImpl: (async () => new Response(null, { status: 503 })) as typeof fetch,
          baseUrl: 'https://mirror.example.com',
        },
      })).rejects.toThrow('cpx config lfs off');
    });
  });
});

// 全链路终验：需要真系统 git-lfs（拷入私有目录 + PATH shim 遮蔽系统件，
// runGit env 注入让 clean filter / pre-push 钩子命中私有件）
function realGitLfsPath(): string {
  try {
    return execSync('command -v git-lfs', { shell: '/bin/sh' }).toString().trim();
  } catch {
    return '';
  }
}

describe('私有件全链路', () => {
  it.skipIf(!realGitLfsPath())('真件私有化 + 系统件遮蔽 → upload 出 LFS 指针（file:// bare）', async () => {
    const { lfsBinaryPath, systemGitLfsOk } = await lfs();
    expect(systemGitLfsOk()).toBe(true); // shim 前系统件确实在
    const realLfs = realGitLfsPath();
    fs.mkdirSync(binDir, { recursive: true });
    fs.copyFileSync(realLfs, lfsBinaryPath());
    fs.chmodSync(lfsBinaryPath(), 0o755);

    const bare = path.join(tmp, 'private-bare.git');
    const bareUrl = `file://${bare}`;
    execSync(`git init --bare -b main "${bare}"`, { stdio: 'pipe' });
    const seed = path.join(tmp, 'seed2');
    fs.mkdirSync(path.join(seed, 'agent-sift'), { recursive: true });
    fs.writeFileSync(path.join(seed, '.gitattributes'), '*.gz filter=lfs diff=lfs merge=lfs -text\n');
    fs.writeFileSync(path.join(seed, 'agent-sift', '.gitkeep'), '');
    execSync('git init -b main .', { cwd: seed, stdio: 'pipe' });
    execSync('git -c user.name=seed -c user.email=s@x add -A', { cwd: seed, stdio: 'pipe' });
    execSync('git -c user.name=seed -c user.email=s@x commit -m init', { cwd: seed, stdio: 'pipe' });
    execSync(`git push "${bare}" main`, { cwd: seed, stdio: 'pipe' });

    const sid = 'ses-priv-lfs';
    const gz = zlib.gzipSync('{"type":"wire"}\n');
    fs.writeFileSync(path.join(captures, `cpx-${sid}.jsonl.gz`), gz);
    fs.writeFileSync(path.join(captures, `cpx-${sid}.meta.json`), JSON.stringify({
      x_cannbay: { schema: 'cc-session-meta', version: 1, data: { producer: 'cpx', framework: 'claude-code', protocol: 'anthropic', sid, governed: true } },
    }));

    const remote = {
      pullUrl: bareUrl, pushUrl: bareUrl, pushAuth: null,
      branch: 'main', rootDir: 'sessions', cacheDir: path.join(tmp, 'priv-cache'), paradigmRoots: true, lfs: true,
    };
    const cannbay = await import('../../src/cannbay');
    await withNoLfsPath(async () => {
      // 系统件被遮蔽：hasGitLfs 只能靠私有件；上传全程（filter/钩子）经
      // runGit env 注入命中私有 git-lfs
      const { hasGitLfs } = await import('../../src/cannbay/mirror');
      expect(hasGitLfs()).toBe(true);
      await cannbay.uploadCaptureSession({
        sid, captureFile: path.join(captures, `cpx-${sid}.jsonl.gz`),
        description: '提交人: 张三', category: 'agent-sift', remote,
      });
    });
    const pointer = execSync(`git rev-parse main:agent-sift/${sid}/${sid}.jsonl.gz`, { cwd: bare, stdio: 'pipe' }).toString().trim();
    const text = execSync(`git cat-file -p ${pointer}`, { cwd: bare, stdio: 'pipe' }).toString();
    const oidHex = createHash('sha256').update(gz).digest('hex');
    expect(text.startsWith('version https://git-lfs.github.com/spec/v1')).toBe(true);
    expect(text).toContain(`oid sha256:${oidHex}`);
    expect(fs.existsSync(path.join(bare, 'lfs', 'objects', oidHex.slice(0, 2), oidHex.slice(2, 4), oidHex))).toBe(true);
  }, 120_000);
});

describe('postinstall 自举门控（不打外网）', () => {
  it('CPX_SKIP_LFS_SETUP=1 → lfs-setup 不被调用（哨兵脚本验证）', async () => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'lfs-postinst-probe-'));
    try {
      // 哨兵：把 cpx lfs-setup 会写的私有 bin 目录监控起来——门控生效则
      // postinstall 全程不触碰它（不下载、不落盘）
      const home = path.join(probe, 'home');
      const proxyDir = path.join(home, 'proxy');
      fs.mkdirSync(proxyDir, { recursive: true });
      const r = spawnSync('node', [path.join(path.resolve(__dirname, '../../'), 'scripts', 'postinstall.mjs')], {
        encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, HOME: home, SHELL: '/bin/bash', CPX_SKIP_LFS_SETUP: '1', CANNBOT_PROXY_DIR: proxyDir },
      });
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(home, 'bin'))).toBe(false); // 未自举
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  });
});
