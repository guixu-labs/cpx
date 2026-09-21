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
//   ① .jsonl.7z 出仓为 LFS 指针（staging ensure7z 统一迁移存量 gz；blob =
//      version/oid/size 文本），实体落 bare.git/lfs/objects/<oid 前缀分桶>，
//      字节与本地同款转换的期望 7z 档案一致；meta.json 仍为普通 blob（只有
//      .7z/.gz 声明走 LFS）
//   ② .gitattributes 的 filter=lfs 行保留（LFS 模式与默认模式的"剔除"互为
//      镜像操作）；缺行自动补（*.gz 存量 + *.7z 新形态）
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
import { ensure7z } from '../../src/compression';

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe' }).toString();
}

let tmp: string;
let bare: string;
let bareUrl: string;
let captures: string;
let cannbay: typeof import('../../src/cannbay');

// skip/run 判定同源钉住（describe 收集期生效，先于 beforeAll）：hasGitLfs 的
// 私有件解析 lfsBinDir() 由 CANNBOT_PROXY_DIR 推导——不先钉，collection 期
// 读到 home 私有自举件即放行整组用例，beforeAll 重定向后运行期又解析不到，
// 无网络机器自动下载必炸；且同 worker 先跑文件的 env 残留会让 skip/run
// 赌执行顺序。home 私有件（cpx lfs-setup 产物）复制进重定向 bin 目录：
// skipIf 放行的机器运行期 privateGitLfsOk 命中，链路不依赖网络下载。
tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay-lfs-it-'));
bare = path.join(tmp, 'cannbay.git');
bareUrl = `file://${bare}`;
captures = path.join(tmp, 'captures');
fs.mkdirSync(captures, { recursive: true });
process.env.CANNBOT_PROXY_DIR = captures;
const homeLfs = path.join(os.homedir(), '.cannbot-insight', 'bin', 'git-lfs');
if (fs.existsSync(homeLfs)) {
  try {
    const priv = path.join(tmp, 'bin', 'git-lfs');
    fs.mkdirSync(path.dirname(priv), { recursive: true });
    fs.copyFileSync(homeLfs, priv);
    fs.chmodSync(priv, 0o755);
  } catch { /* best-effort：失败则运行期走自动下载链 */ }
}

beforeAll(async () => {
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

// staging 出仓形态的期望字节：uploadCaptureSession 对源做「拷贝 → ensure7z」
// （存量 gz 借此迁移新格式），确定性开关保证同内容同字节——本地同款转换即
// 得期望档案（条目名 <stem>.jsonl 与 staging 一致）
function expectedStaged7z(sourceGz: string, stem: string): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cannbay-lfs-exp-'));
  const staged = path.join(dir, `${stem}.jsonl.gz`);
  fs.copyFileSync(sourceGz, staged);
  return fs.readFileSync(ensure7z(staged));
}

const DESC = '提交人: 李四\n内容描述: lfs it 上传\n日志路径: /x/cpx-s.jsonl.gz\n备注: 测试';

describe.skipIf(!hasGitLfs())('LFS 模式直传（file:// bare + standalone 传输）', () => {
  it('①②⑤ 指针出仓 + 实体落 LFS 存储 + .gitattributes 保留 + subagents 同走 LFS', async () => {
    writeCapture('ses-lfs-e2e', { subagents: ['sub-1'] });
    // staging 统一 ensure7z 出仓：仓内/实体是 .jsonl.7z（确定性 → 本地同款转换即期望字节）
    const z7 = expectedStaged7z(path.join(captures, 'cpx-ses-lfs-e2e.jsonl.gz'), 'ses-lfs-e2e');
    const subZ7 = expectedStaged7z(path.join(captures, 'ses-lfs-e2e', 'subagents', 'sub-1.jsonl.gz'), 'sub-1');
    const r = await cannbay.uploadCaptureSession({ sid: 'ses-lfs-e2e', captureFile: path.join(captures, 'cpx-ses-lfs-e2e.jsonl.gz'), description: DESC, category: 'agent-sift' });
    expect(r.folder).toBe('agent-sift/ses-lfs-e2e/');
    // LFS 模式不做"剔除"修复
    expect(r.gitattributesFixed).toBe(false);

    // 主文件仓内 = LFS 指针文本（oid/size 与 staging 7z 档案一致）
    const pointer = blobBuffer('agent-sift/ses-lfs-e2e/ses-lfs-e2e.jsonl.7z').toString('utf8');
    const oidHex = createHash('sha256').update(z7).digest('hex');
    expect(pointer.startsWith('version https://git-lfs.github.com/spec/v1')).toBe(true);
    expect(pointer).toContain(`oid sha256:${oidHex}`);
    expect(pointer).toContain(`size ${z7.length}`);
    // 实体已落 bare 的 LFS 存储，字节与期望档案一致
    expect(fs.existsSync(lfsObjectPath(oidHex))).toBe(true);
    expect(fs.readFileSync(lfsObjectPath(oidHex)).equals(z7)).toBe(true);

    // subagent 同走 LFS
    const subPointer = blobBuffer('agent-sift/ses-lfs-e2e/subagents/sub-1.jsonl.7z').toString('utf8');
    const subOid = createHash('sha256').update(subZ7).digest('hex');
    expect(subPointer).toContain(`oid sha256:${subOid}`);
    expect(fs.existsSync(lfsObjectPath(subOid))).toBe(true);

    // meta.json 仍是普通 blob（只有 .7z/.gz 声明走 LFS）
    const meta = blobBuffer('agent-sift/ses-lfs-e2e/ses-lfs-e2e.meta.json').toString('utf8');
    expect(meta).toContain('"producer":"cpx"');
    expect(meta).not.toContain('git-lfs');

    // .gitattributes 的 filter=lfs 行保留（*.gz 存量行不重复追加 + *.7z 新形态补行）
    const ga = blobBuffer('.gitattributes').toString('utf8');
    expect(ga).toContain('*.gz filter=lfs');
    expect(ga).toContain('*.7z filter=lfs');
    expect((ga.match(/^\*\.gz filter=lfs/gm) ?? []).length).toBe(1);
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

  it('⑥ 默认开：无 env 无 config → 直接走 LFS 路径（指针出仓）', async () => {
    // 决议链终验：CANNBAY2_LFS 未设 + cpx-config.json 不存在（CANNBOT_PROXY_DIR
    // 已重定向 tmp）→ resolveLfs 默认开，uploadCaptureSession 落 LFS 指针
    delete process.env.CANNBAY2_LFS;
    try {
      writeCapture('ses-lfs-default', {});
      await cannbay.uploadCaptureSession({ sid: 'ses-lfs-default', captureFile: path.join(captures, 'cpx-ses-lfs-default.jsonl.gz'), description: DESC, category: 'agent-sift' });
      const pointer = blobBuffer('agent-sift/ses-lfs-default/ses-lfs-default.jsonl.7z').toString('utf8');
      const oidHex = createHash('sha256').update(expectedStaged7z(path.join(captures, 'cpx-ses-lfs-default.jsonl.gz'), 'ses-lfs-default')).digest('hex');
      expect(pointer.startsWith('version https://git-lfs.github.com/spec/v1')).toBe(true);
      expect(pointer).toContain(`oid sha256:${oidHex}`);
      expect(fs.existsSync(lfsObjectPath(oidHex))).toBe(true);
    } finally {
      process.env.CANNBAY2_LFS = '1';
    }
  });
});
