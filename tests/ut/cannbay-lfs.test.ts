// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cpx LFS 模式 IT：CANNBAY2_LFS=1 + 本地 bare 仓（file:// 协议——git-lfs 的
// standalone 传输适配器只认 file:// URL，本地裸路径报 "no valid file:// URLs
// found"）。端到端验证：
//   ① .jsonl.gz 出仓为 LFS 指针（blob = version/oid/size 文本），实体落
//      bare.git/lfs/objects/<oid 前缀分桶>，字节与源一致；meta.json 仍为
//      普通 blob（只有 .gz 声明走 LFS）
//   ② .gitattributes 的 filter=lfs 行保留（LFS 模式与默认模式的"剔除"互为
//      镜像操作）；缺行自动补
//   ③ 幂等：指针级 unchanged（重复上传同内容零新 commit）
//   ④ CANNBAY2_MAX_SESSION_MB 覆写：压缩字节超限熔断（LFS 模式的配套
//      容量开关，默认 100MB 是 git blob 的平台钳制）
//   ⑤ subagents 同走 LFS

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { hasGitLfs } from '../../src/cannbay/mirror';

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe' }).toString();
}

let tmp: string;
let bare: string;
let bareUrl: string;
let captures: string;
let cannbay: typeof import('../../src/cannbay');

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay-lfs-it-'));
  bare = path.join(tmp, 'cannbay.git');
  bareUrl = `file://${bare}`;
  captures = path.join(tmp, 'captures');
  fs.mkdirSync(captures, { recursive: true });
  execSync(`git init --bare -b main "${bare}"`, { stdio: 'pipe' });
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(path.join(seed, 'agent-sift'), { recursive: true });
  fs.writeFileSync(path.join(seed, '.gitattributes'), '*.gz filter=lfs diff=lfs merge=lfs -text\n');
  fs.writeFileSync(path.join(seed, 'agent-sift', '.gitkeep'), '');
  git('git init -b main .', seed);
  git('git -c user.name=seed -c user.email=seed@x add -A', seed);
  git('git -c user.name=seed -c user.email=seed@x commit -m init', seed);
  git(`git push "${bare}" main`, seed);
  process.env.CANNBAY2_REMOTE_URL = bareUrl;
  process.env.CANNBAY2_PUSH_URL = bareUrl;
  process.env.CANNBAY2_CPX_CACHE_DIR = path.join(tmp, 'cache');
  process.env.CANNBAY2_LFS = '1';
  process.env.CANNBOT_PROXY_DIR = captures;
  cannbay = await import('../../src/cannbay');
});

afterAll(() => {
  delete process.env.CANNBAY2_LFS;
  delete process.env.CANNBAY2_MAX_SESSION_MB;
});

function writeCapture(sid: string, opts: { rawBytes?: number; subagents?: string[] } = {}): Buffer {
  const lines = [JSON.stringify({ type: 'wire', i: 0 }), JSON.stringify({ type: 'wire', i: 1 })];
  const text = lines.join('\n') + '\n';
  const gz = opts.rawBytes
    // 不可压缩随机负载（gzip 后 ≈ 原始字节）：测大小限熔断用
    ? zlib.gzipSync(Buffer.concat([Buffer.from(text), randomBytes(opts.rawBytes)]))
    : zlib.gzipSync(text);
  fs.writeFileSync(path.join(captures, `cpx-${sid}.jsonl.gz`), gz);
  fs.writeFileSync(path.join(captures, `cpx-${sid}.meta.json`), JSON.stringify({
    x_cannbay: { schema: 'cc-session-meta', version: 1, data: { producer: 'cpx', framework: 'claude-code', protocol: 'anthropic', sid, governed: true } },
  }));
  if (opts.subagents) {
    const subDir = path.join(captures, sid, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    for (const sub of opts.subagents) {
      fs.writeFileSync(path.join(subDir, `${sub}.jsonl.gz`), zlib.gzipSync(JSON.stringify({ type: 'wire', sub }) + '\n'));
    }
  }
  return gz;
}

function blobBuffer(repoPath: string): Buffer {
  const oid = git(`git rev-parse main:${repoPath}`, bare).trim();
  return execSync(`git cat-file -p ${oid}`, { cwd: bare, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }) as Buffer;
}

function lfsObjectPath(oidHex: string): string {
  return path.join(bare, 'lfs', 'objects', oidHex.slice(0, 2), oidHex.slice(2, 4), oidHex);
}

const DESC = '提交人: 李四\n内容描述: lfs it 上传\n日志路径: /x/cpx-s.jsonl.gz\n备注: 测试';

describe.skipIf(!hasGitLfs())('LFS 模式直传（file:// bare + standalone 传输）', () => {
  it('①②⑤ 指针出仓 + 实体落 LFS 存储 + .gitattributes 保留 + subagents 同走 LFS', async () => {
    const gz = writeCapture('ses-lfs-e2e', { subagents: ['sub-1'] });
    const subGz = fs.readFileSync(path.join(captures, 'ses-lfs-e2e', 'subagents', 'sub-1.jsonl.gz'));
    const r = await cannbay.uploadCaptureSession({ sid: 'ses-lfs-e2e', captureFile: path.join(captures, 'cpx-ses-lfs-e2e.jsonl.gz'), description: DESC, category: 'agent-sift' });
    expect(r.folder).toBe('agent-sift/ses-lfs-e2e/');
    // LFS 模式不做"剔除"修复
    expect(r.gitattributesFixed).toBe(false);

    // 主文件仓内 = LFS 指针文本（oid/size 与源 gzip 一致）
    const pointer = blobBuffer('agent-sift/ses-lfs-e2e/ses-lfs-e2e.jsonl.gz').toString('utf8');
    const oidHex = createHash('sha256').update(gz).digest('hex');
    expect(pointer.startsWith('version https://git-lfs.github.com/spec/v1')).toBe(true);
    expect(pointer).toContain(`oid sha256:${oidHex}`);
    expect(pointer).toContain(`size ${gz.length}`);
    // 实体已落 bare 的 LFS 存储，字节与源一致
    expect(fs.existsSync(lfsObjectPath(oidHex))).toBe(true);
    expect(fs.readFileSync(lfsObjectPath(oidHex)).equals(gz)).toBe(true);

    // subagent 同走 LFS
    const subPointer = blobBuffer('agent-sift/ses-lfs-e2e/subagents/sub-1.jsonl.gz').toString('utf8');
    const subOid = createHash('sha256').update(subGz).digest('hex');
    expect(subPointer).toContain(`oid sha256:${subOid}`);
    expect(fs.existsSync(lfsObjectPath(subOid))).toBe(true);

    // meta.json 仍是普通 blob（只有 .gz 声明走 LFS）
    const meta = blobBuffer('agent-sift/ses-lfs-e2e/ses-lfs-e2e.meta.json').toString('utf8');
    expect(meta).toContain('"producer":"cpx"');
    expect(meta).not.toContain('git-lfs');

    // .gitattributes 的 filter=lfs 行保留
    expect(blobBuffer('.gitattributes').toString('utf8')).toContain('*.gz filter=lfs');
  });

  it('③ 幂等：重复上传同内容 → 指针级 unchanged（零新 commit）', async () => {
    const cap = path.join(captures, 'cpx-ses-lfs-e2e.jsonl.gz');
    const commitsBefore = git('git rev-list --count main', bare).trim();
    const r = await cannbay.uploadCaptureSession({ sid: 'ses-lfs-e2e', captureFile: cap, description: DESC, category: 'agent-sift' });
    expect(r.unchanged).toBe(true);
    expect(git('git rev-list --count main', bare).trim()).toBe(commitsBefore);
  });

  it('④ CANNBAY2_MAX_SESSION_MB 覆写：压缩字节超限熔断', async () => {
    writeCapture('ses-lfs-big', { rawBytes: 2 * 1024 * 1024 });
    process.env.CANNBAY2_MAX_SESSION_MB = '1';
    try {
      await expect(cannbay.uploadCaptureSession({ sid: 'ses-lfs-big', captureFile: path.join(captures, 'cpx-ses-lfs-big.jsonl.gz'), description: DESC, category: 'agent-sift' }))
        .rejects.toThrow('exceeds single-file size limit');
      expect(git('git ls-tree --name-only main agent-sift/ses-lfs-big', bare).trim()).toBe('');
    } finally {
      delete process.env.CANNBAY2_MAX_SESSION_MB;
    }
  });
});
