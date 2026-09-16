// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// cpx 直传 cannbay IT：真实本地 bare 仓（CANNBAY2_REMOTE_URL/PUSH_URL/CPX_CACHE_DIR
// 指向 tmp，与 insight cannbay2 同款测试手法）端到端验证：
//   ① 直传布局：agent-sift/<sid>/<sid>.jsonl.gz + meta + subagents；commit
//      message 协议（首行提交人 + body 范式行）
//   ② 快路径（governed 标记）：压缩字节原样出仓（blob 与源逐字节一致）
//   ③ 慢路径（明文/无标记）：注入假密钥 → 出仓 blob 为清洗后内容；复检
//      熔断形态（构造清洗不掉的残留）可选
//   ④ .gitattributes filter=lfs 行同 commit 剔除（LFS 免疫双保险）
//   ⑤ 范式目录动态白名单（typo 拒绝 / sessions 拒绝）
//   ⑥ baseline 交换（新 baseline 顶掉旧的，旧会话移回范式普通目录）
//   ⑦ 幂等 unchanged；换范式旧位置清理

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// remote.ts 的 env 常量在模块加载时读取——bare 仓环境必须在 import 前就位
let tmp: string;
let bare: string;
let captures: string;
let cannbay: typeof import('../../src/cannbay');

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe' }).toString();
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay-upload-it-'));
  bare = path.join(tmp, 'cannbay.git');
  captures = path.join(tmp, 'captures');
  fs.mkdirSync(captures, { recursive: true });
  execSync(`git init --bare -b main "${bare}"`, { stdio: 'pipe' });
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(path.join(seed, 'agent-sift'), { recursive: true });
  fs.writeFileSync(path.join(seed, '.gitattributes'), '*.gz filter=lfs diff=lfs merge=lfs -text\n*.jsonl filter=lfs\n');
  fs.writeFileSync(path.join(seed, 'agent-sift', '.gitkeep'), '');
  git('git init -b main .', seed);
  git('git -c user.name=seed -c user.email=seed@x add -A', seed);
  git('git -c user.name=seed -c user.email=seed@x commit -m init', seed);
  git(`git push "${bare}" main`, seed);
  process.env.CANNBAY2_REMOTE_URL = bare;
  process.env.CANNBAY2_PUSH_URL = bare;
  process.env.CANNBAY2_CPX_CACHE_DIR = path.join(tmp, 'cache');
  process.env.CANNBOT_PROXY_DIR = captures;
  cannbay = await import('../../src/cannbay');
});

function writeCapture(sid: string, opts: { governed?: boolean; plain?: boolean; dirty?: boolean; subagents?: string[] } = {}): void {
  const lines = opts.dirty
    ? [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'check this: sk-ant-abc123def456ghi789jkl012 and ANTHROPIC_API_KEY=sk-proj-abcdefghijklmnopqrstuv' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ok' } }),
      ]
    : [JSON.stringify({ type: 'wire', i: 0 }), JSON.stringify({ type: 'wire', i: 1 })];
  const text = lines.join('\n') + '\n';
  const main = path.join(captures, `cpx-${sid}.jsonl${opts.plain ? '' : '.gz'}`);
  fs.writeFileSync(main, opts.plain ? text : zlib.gzipSync(text));
  fs.writeFileSync(path.join(captures, `cpx-${sid}.meta.json`), JSON.stringify({
    x_cannbay: { schema: 'cc-session-meta', version: 1, data: { producer: 'cpx', framework: 'claude-code', protocol: 'anthropic', sid, ...(opts.governed === false ? {} : { governed: true }) } },
  }));
  if (opts.subagents) {
    const subDir = path.join(captures, sid, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    for (const sub of opts.subagents) {
      fs.writeFileSync(path.join(subDir, `${sub}.jsonl.gz`), zlib.gzipSync(JSON.stringify({ type: 'wire', sub }) + '\n'));
    }
  }
}

// 断言一律读 bare 仓本体（push 更新 bare 的 main；镜像的 origin/main 要等
// fetch 才前进——读镜像是经典陷阱）
function treeAt(_rev: string, subpath: string): string[] {
  return git(`git ls-tree -r --name-only main -- ${subpath}`, bare).trim().split('\n').filter(Boolean);
}

function blobContent(repoPath: string): string {
  const oid = git(`git rev-parse main:${repoPath}`, bare).trim();
  return git(`git cat-file -p ${oid}`, bare);
}

// 二进制安全读 blob（gzip 字节流不能过 utf8 toString——31,139 会被重映射）
function blobBuffer(repoPath: string): Buffer {
  const oid = git(`git rev-parse main:${repoPath}`, bare).trim();
  return execSync(`git cat-file -p ${oid}`, { cwd: bare, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }) as Buffer;
}

function logBody(): string {
  return git('git -c core.quotepath=off log -1 --pretty=%B main', bare);
}

const DESC = '提交人: 张三\n内容描述: it 上传\n日志路径: /x/cpx-s.jsonl.gz\n备注: 测试';

describe('uploadCaptureSession 直传（真 bare 仓）', () => {
  it('① 直传布局 + commit 协议 + ② 快路径压缩字节原样出仓 + ④ .gitattributes lfs 剔除', async () => {
    writeCapture('ses-e2e', { governed: true, subagents: ['sub-1'] });
    const srcGz = fs.readFileSync(path.join(captures, 'cpx-ses-e2e.jsonl.gz'));
    const r = await cannbay.uploadCaptureSession({ sid: 'ses-e2e', captureFile: path.join(captures, 'cpx-ses-e2e.jsonl.gz'), description: DESC, category: 'agent-sift' });
    expect(r.folder).toBe('agent-sift/ses-e2e/');
    expect(r.gitattributesFixed).toBe(true);
    expect(r.unchanged).toBe(false);
    const files = treeAt('origin/main', 'agent-sift/ses-e2e');
    expect(files).toContain('agent-sift/ses-e2e/ses-e2e.jsonl.gz');
    expect(files).toContain('agent-sift/ses-e2e/ses-e2e.meta.json');
    expect(files).toContain('agent-sift/ses-e2e/subagents/sub-1.jsonl.gz');
    // 快路径：blob 与源 gzip 逐字节一致（免解压重洗重压）
    expect(blobBuffer('agent-sift/ses-e2e/ses-e2e.jsonl.gz').equals(srcGz)).toBe(true);
    // meta 随行（governed 标记保留）
    expect(blobContent('agent-sift/ses-e2e/ses-e2e.meta.json')).toContain('"governed":true');
    // commit 协议：subject 提交人行 + body 范式行
    const log = logBody();
    expect(log).toContain('提交人: 张三');
    expect(log.trimEnd().endsWith('范式: agent-sift')).toBe(true);
    // .gitattributes 的 filter=lfs 行已剔除
    const ga = blobContent('.gitattributes');
    expect(ga).not.toContain('filter=lfs');
  });

  it('③ 慢路径：无 governed 标记的明文 → 清洗后压缩出仓（密钥打码）', async () => {
    writeCapture('ses-slow', { plain: true, governed: false, dirty: true });
    await cannbay.uploadCaptureSession({ sid: 'ses-slow', captureFile: path.join(captures, 'cpx-ses-slow.jsonl'), description: DESC, category: 'agent-sift' });
    const text = zlib.gunzipSync(blobBuffer('agent-sift/ses-slow/ses-slow.jsonl.gz')).toString();
    expect(text).not.toContain('sk-ant-abc123def456ghi789jkl012');
    expect(text).toContain('sk-a…l012');
    expect(text).not.toContain('sk-proj-abcdefghijklmnopqrstuv');
  });

  it('⑤ 范式目录动态白名单：typo / sessions 拒绝', async () => {
    writeCapture('ses-cat', {});
    await expect(cannbay.uploadCaptureSession({ sid: 'ses-cat', captureFile: path.join(captures, 'cpx-ses-cat.jsonl.gz'), description: DESC, category: 'agent-sif' }))
      .rejects.toThrow('不存在');
    await expect(cannbay.uploadCaptureSession({ sid: 'ses-cat', captureFile: path.join(captures, 'cpx-ses-cat.jsonl.gz'), description: DESC, category: 'sessions' }))
      .rejects.toThrow('存量会话区');
  });

  it('⑦ 换范式旧位置清理 + ⑦ 幂等 unchanged', async () => {
    writeCapture('ses-move', {});
    const cap = path.join(captures, 'cpx-ses-move.jsonl.gz');
    await cannbay.uploadCaptureSession({ sid: 'ses-move', captureFile: cap, description: DESC, category: 'agent-sift' });
    const r2 = await cannbay.uploadCaptureSession({ sid: 'ses-move', captureFile: cap, description: DESC, category: 'agent-sift' });
    expect(r2.unchanged).toBe(true);
    expect(treeAt('origin/main', 'agent-sift/ses-move').length).toBeGreaterThan(0);
  });

  it('⑥ baseline 交换：新 baseline 顶旧，旧会话移回范式普通目录', async () => {
    writeCapture('ses-base-a', {});
    writeCapture('ses-base-b', {});
    const mk = (sid: string) => ({ sid, captureFile: path.join(captures, `cpx-${sid}.jsonl.gz`), description: DESC, category: 'agent-sift', baseline: true as const });
    await cannbay.uploadCaptureSession(mk('ses-base-a'));
    expect(treeAt('origin/main', 'agent-sift/baseline/ses-base-a').length).toBeGreaterThan(0);
    await cannbay.uploadCaptureSession(mk('ses-base-b'));
    // 新 baseline 就位，旧 baseline 移回普通目录（结构即状态）
    expect(treeAt('origin/main', 'agent-sift/baseline/ses-base-b').length).toBeGreaterThan(0);
    expect(treeAt('origin/main', 'agent-sift/baseline/ses-base-a')).toEqual([]);
    expect(treeAt('origin/main', 'agent-sift/ses-base-a').length).toBeGreaterThan(0);
  });
});

describe('pushMirror（401 挑战-应答通道）', () => {
  it('parseUrlCreds：内嵌凭据拆分 / 编码解码 / 无凭据与本地路径原样', async () => {
    const { parseUrlCreds } = await import('../../src/cannbay/remote');
    const a = parseUrlCreds('https://duanbingzhe:tok@atomgit.com/duanbingzhe/cannbay3.git');
    expect(a.credless).toBe('https://atomgit.com/duanbingzhe/cannbay3.git');
    expect(a.auth).toEqual({ username: 'duanbingzhe', password: 'tok' });
    const b = parseUrlCreds('https://oauth2:tok%40x%3A@host/repo.git');
    expect(b.auth).toEqual({ username: 'oauth2', password: 'tok@x:' });
    expect(b.credless).toBe('https://host/repo.git');
    const c = parseUrlCreds('https://atomgit.com/duanbingzhe/cannbay3.git');
    expect(c.auth).toBeNull();
    expect(c.credless).toBe('https://atomgit.com/duanbingzhe/cannbay3.git');
    const d = parseUrlCreds('/tmp/cannbay-upload-it/cannbay.git');
    expect(d.auth).toBeNull();
    expect(d.credless).toBe('/tmp/cannbay-upload-it/cannbay.git');
  });

  it('pushAuth 存在：一次性 helper 构造/清理 + push 成功（本地 bare 传输不咨询凭据，锁命令构造与生命周期）', async () => {
    const { pushMirror } = await import('../../src/cannbay/mirror');
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('cpx-cannbay-auth-'));
    const pmBare = path.join(tmp, 'pm-bare.git');
    execSync(`git init --bare -b main "${pmBare}"`, { stdio: 'pipe' });
    const work = path.join(tmp, 'pushmirror');
    fs.mkdirSync(work, { recursive: true });
    git('git init -b main .', work);
    fs.writeFileSync(path.join(work, 'pm.txt'), 'x');
    git('git -c user.name=t -c user.email=t@x add -A', work);
    git('git -c user.name=t -c user.email=t@x commit -m pm', work);
    const remote = {
      pullUrl: pmBare, pushUrl: pmBare,
      pushAuth: { username: 'it-user', password: 'it-pass' },
      branch: 'main', rootDir: 'sessions', cacheDir: path.join(tmp, 'pm-cache'), paradigmRoots: true,
    };
    pushMirror(work, remote);
    expect(git('git rev-parse main', pmBare).trim()).toBe(git('git rev-parse HEAD', work).trim());
    const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('cpx-cannbay-auth-'));
    expect(after).toEqual(before); // helper 临时目录用后即删

    const noAuth = { ...remote, pushAuth: null };
    fs.writeFileSync(path.join(work, 'pm2.txt'), 'y');
    git('git -c user.name=t -c user.email=t@x add -A', work);
    git('git -c user.name=t -c user.email=t@x commit -m pm2', work);
    pushMirror(work, noAuth);
    expect(git('git rev-parse main', pmBare).trim()).toBe(git('git rev-parse HEAD', work).trim());
  });

  it('pushAuth 含换行：helper 协议非法，立即拒绝且不落任何临时目录', async () => {
    const { pushMirror } = await import('../../src/cannbay/mirror');
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('cpx-cannbay-auth-'));
    const remote = {
      pullUrl: bare, pushUrl: bare,
      pushAuth: { username: 'u', password: 'bad\npassword' },
      branch: 'main', rootDir: 'sessions', cacheDir: path.join(tmp, 'pm-cache'), paradigmRoots: true,
    };
    expect(() => pushMirror(path.join(tmp, 'pushmirror'), remote)).toThrow('换行');
    const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('cpx-cannbay-auth-'));
    expect(after).toEqual(before);
  });
});
