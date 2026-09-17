// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// `cpx upload` 直传模式 IT：uploadImpl 注入假直传（真直传的 bare 仓端到端见
// cannbay-upload.test.ts），mock insight 仅覆盖可选增强路径，验证：
//   ① ★insight 未运行仍完成上传（直传核心行为）
//   ② insight 在跑：observe 命中即预填（不再强依赖 import-file）；未导入则
//      顺带导入失败也不阻断上传
//   ③ 非交互：必缺 flag（--submitter / --category）→ 2；齐备 → 直传载荷契约
//   ④ governance 拒绝（GovernanceError）→ 1 且原因透传；git 错误脱敏（push
//      URL 凭据不出现在日志）
//   ⑤ sid 解析：缺省取最新 mtime；cpx- 前缀容忍；meta framework 进备注
//   ⑥ TTY 向导：脚本化应答连按回车全默认；提交人空默认循环追问
//   ⑦ description 行协议（首行提交人 / 内容描述可选行 / 日志路径 / 备注）

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  parseUploadArgs, buildUploadDescription, resolveCaptureTarget, resolveSessionByEnv, readMetaFramework,
  readUploadStash, writeUploadStash, captureBytes,
  runUpload, promptUploadInfo, type UploadFlags, type UploadDeps,
} from '../../src/cli/cpx-upload';
import { GovernanceError } from '../../src/cannbay/govern';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-upload-it-'));
  process.env.CANNBOT_PROXY_DIR = dir;
});

function writeCapture(sid: string, opts: { mtime?: Date; framework?: string; size?: number; sub?: string } = {}): void {
  const target = opts.sub ? path.join(dir, opts.sub) : dir;
  fs.mkdirSync(target, { recursive: true });
  const lines = Array.from({ length: opts.size ?? 3 }, (_, i) => JSON.stringify({ type: 'wire', i })).join('\n') + '\n';
  fs.writeFileSync(path.join(target, `cpx-${sid}.jsonl.gz`), zlib.gzipSync(lines));
  if (opts.framework !== null) {
    fs.writeFileSync(path.join(target, `cpx-${sid}.meta.json`), JSON.stringify({
      x_cannbay: { schema: 'cc-session-meta', version: 1, data: { producer: 'cpx', framework: opts.framework ?? 'claude-code', protocol: 'anthropic', sid } },
    }));
  }
  if (opts.mtime) fs.utimesSync(path.join(target, `cpx-${sid}.jsonl.gz`), opts.mtime, opts.mtime);
}

function mockInsight(opts: {
  session?: { query?: string | null; model?: string | null } | 'not-found';
  importFile?: { status: number; body: any };
  down?: boolean;
} = {}) {
  const calls: Array<{ url: string; body?: any }> = [];
  const fetchImpl = (async (url: any, init?: any) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined });
    const json = (status: number, body: any) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/api/observe/data')) {
      if (opts.down) throw new Error('ECONNREFUSED');
      return json(200, { sessions: [] });
    }
    if (u.includes('/api/observe/session')) {
      if (opts.session === 'not-found' || !opts.session) return json(404, { error: 'not found' });
      return json(200, { sessions: [{ taskId: 'x', query: opts.session.query ?? null, model: opts.session.model ?? null }] });
    }
    if (u.includes('/api/ingest/import-file')) {
      const cfg = opts.importFile ?? { status: 200, body: { imported: true, query: 'imported-query' } };
      return json(cfg.status, cfg.body);
    }
    throw new Error(`unmocked url: ${u}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function fakeUpload(opts: { result?: any; error?: Error } = {}) {
  const payloads: any[] = [];
  const uploadImpl = (async (p: any) => {
    payloads.push(p);
    if (opts.error) throw opts.error;
    return opts.result ?? { sid: p.sid, folder: `agent-sift/${p.sid}/`, unchanged: false, gitattributesFixed: false };
  }) as UploadDeps['uploadImpl'];
  return { uploadImpl, payloads };
}

function outputs(): { errs: string[]; outs: string[] } {
  const errs: string[] = []; const outs: string[] = [];
  return { errs, outs, err: (m: string) => errs.push(m), log: (m: string) => outs.push(m) };
}

describe('parseUploadArgs', () => {
  it('位置参数 sid + 全量 flag 解析', () => {
    const r = parseUploadArgs(['abc-123', '--submitter', '张三', '--category', 'agent-sift', '--desc', 'd', '--opgen', 'success', '--baseline']);
    expect(r).toEqual({ flags: { sid: 'abc-123', submitter: '张三', category: 'agent-sift', desc: 'd', opgen: 'success', baseline: true } });
  });
  it('非法 opgen / 未知 flag / 多余位置参数 → error', () => {
    expect('error' in parseUploadArgs(['--opgen', 'ok'])).toBe(true);
    expect('error' in parseUploadArgs(['--nope'])).toBe(true);
    expect('error' in parseUploadArgs(['a', 'b'])).toBe(true);
  });
});

describe('resolveCaptureTarget / readMetaFramework', () => {
  it('cpx- 前缀容忍 + meta framework 读取', () => {
    writeCapture('ses-pre', { framework: 'opencode', sub: 'iso1' });
    const t = resolveCaptureTarget('cpx-ses-pre', path.join(dir, 'iso1'));
    expect('sid' in t ? t.sid : '').toBe('ses-pre');
    expect(readMetaFramework((t as any).file)).toBe('opencode');
  });
  it('缺省 sid 取 mtime 最新；无捕获 → error', () => {
    writeCapture('older', { mtime: new Date(Date.now() - 7200_000), sub: 'iso2' });
    writeCapture('newer', { mtime: new Date(Date.now() - 60_000), sub: 'iso2' });
    const t = resolveCaptureTarget(undefined, path.join(dir, 'iso2'));
    expect((t as any).sid).toBe('newer');
    expect('error' in resolveCaptureTarget(undefined, path.join(dir, 'iso2', 'empty-sub'))).toBe(true);
  });
});

describe('buildUploadDescription 行协议', () => {
  it('首行提交人；内容描述可选行；日志路径 + 备注（框架/模型/时间）', () => {
    const target = { sid: 's1', file: '/p/cpx-s1.jsonl.gz', mtimeMs: Date.parse('2026-09-12T10:00:00Z') };
    const info = { framework: 'claude-code', model: 'glm-5.2', startTime: '2026-09-12T02:00:00.000Z', endTime: '2026-09-12T02:05:00.000Z', firstQuery: 'q' };
    const full = buildUploadDescription(target, info, '张三', '修了个端口 bug');
    expect(full.split('\n')[0]).toBe('提交人: 张三');
    expect(full).toContain('内容描述: 修了个端口 bug');
    expect(full).toContain('日志路径: /p/cpx-s1.jsonl.gz');
    expect(full).toContain('框架 claude-code');
    expect(full).toContain('模型 glm-5.2');
    const noDesc = buildUploadDescription(target, { ...info, model: null }, '李四', '  ');
    expect(noDesc).not.toContain('内容描述');
    expect(noDesc).not.toContain('模型');
  });
});

describe('runUpload 直传链路', () => {
  it('★insight 未运行仍完成直传（载荷契约：sid/captureFile/category/首行提交人）+ sidecar 记忆', async () => {
    writeCapture('ses-direct');
    const insight = mockInsight({ down: true });
    const up = fakeUpload();
    const o = outputs();
    const code = await runUpload(['ses-direct', '--submitter', '张三', '--category', 'agent-sift'], {
      fetchImpl: insight.fetchImpl, uploadImpl: up.uploadImpl, listDirsImpl: () => ["agent-sift"], isTTY: false, ...o,
    });
    expect(code).toBe(0);
    expect(up.payloads.length).toBe(1);
    expect(up.payloads[0].sid).toBe('ses-direct');
    expect(up.payloads[0].category).toBe('agent-sift');
    expect(String(up.payloads[0].description).startsWith('提交人: 张三\n')).toBe(true);
    expect(up.payloads[0].captureFile).toContain('cpx-ses-direct.jsonl.gz');
    expect(o.outs.join('\n')).toContain('✅ uploaded');
    expect(insight.calls.find(c => c.url.includes('observe'))).toBeTruthy();
    const stash = readUploadStash(path.join(dir, 'cpx-ses-direct.jsonl.gz'));
    expect(stash).toMatchObject({ category: 'agent-sift', submitter: '张三' });
    // 逻辑字节（解压后）：明文/压缩态可比的增量基准
    expect(stash!.capturedBytes).toBe(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'cpx-ses-direct.jsonl.gz'))).length);
  });

  it('★sidecar 三态：无新增 → 静默跳过不调上传；有新增 → 免交互用 stash 重传（env 工牌定位）', async () => {
    writeCapture('ses-stash', { sub: 'iso3' });
    const sub3 = path.join(dir, 'iso3');
    const gz = path.join(sub3, 'cpx-ses-stash.jsonl.gz');
    const up = fakeUpload();
    const deps = () => ({
      uploadImpl: up.uploadImpl, listDirsImpl: () => ['agent-sift'], isTTY: false,
      fetchImpl: mockInsight({ down: true }).fetchImpl, proxyDir: sub3,
    });
    const o1 = outputs();
    expect(await runUpload(['ses-stash', '--submitter', '张三', '--category', 'agent-sift'], { ...deps(), ...o1 })).toBe(0);
    expect(up.payloads.length).toBe(1);
    // 第二次：无参（env 工牌）+ 捕获未变 → 跳过、不再调上传
    const o2 = outputs();
    expect(await runUpload([], { ...deps(), env: { CPX_SESSION_ID: 'ses-stash' }, ...o2 })).toBe(0);
    expect(up.payloads.length).toBe(1);
    expect(o2.errs.join('\n')).toContain('跳过');
    // 第三次：捕获增长 → stash 免交互重传（无 flag 无报错，提交人/目录来自 stash）
    fs.appendFileSync(gz, zlib.gzipSync(JSON.stringify({ type: 'wire', more: 1 }) + '\n'));
    const o3 = outputs();
    expect(await runUpload([], { ...deps(), env: { CPX_SESSION_ID: 'ses-stash' }, ...o3 })).toBe(0);
    expect(up.payloads.length).toBe(2);
    expect(up.payloads[1].category).toBe('agent-sift');
    expect(String(up.payloads[1].description).startsWith('提交人: 张三\n')).toBe(true);
    // 显式 sid + 无新信息 + 未变 → 同样跳过（幂等）；带新信息 flag → 重传替换
    const o4 = outputs();
    expect(await runUpload(['ses-stash'], { ...deps(), ...o4 })).toBe(0);
    expect(up.payloads.length).toBe(2);
    const o5 = outputs();
    expect(await runUpload(['ses-stash', '--category', 'opgen-corpus'], { ...deps(), ...o5 })).toBe(0);
    expect(up.payloads.length).toBe(3);
    expect(up.payloads[2].category).toBe('opgen-corpus');
  });

  it('★env 工牌换算：pinned sid 经 .sids 清单定位真实 sid（claude 场景）', () => {
    writeCapture('real-sid-a', { sub: 'iso4' });
    fs.writeFileSync(path.join(dir, 'iso4', 'cpx-PINNED001.sids'), 'real-sid-a\n');
    const t = resolveSessionByEnv('PINNED001', path.join(dir, 'iso4'));
    expect((t as any)?.sid).toBe('real-sid-a');
    expect(resolveSessionByEnv('no-such-pin', path.join(dir, 'iso4'))).toBeNull();
  });

  it('insight 在跑：observe 命中预填 query/model，不再调 import-file', async () => {
    writeCapture('ses-prefill');
    const insight = mockInsight({ session: { query: '怎样配置端口？', model: 'glm-5.2' } });
    const up = fakeUpload();
    const o = outputs();
    expect(await runUpload(['ses-prefill', '--submitter', '张三', '--category', 'agent-sift'], {
      fetchImpl: insight.fetchImpl, uploadImpl: up.uploadImpl, listDirsImpl: () => ["agent-sift"], isTTY: false, ...o,
    })).toBe(0);
    expect(insight.calls.find(c => c.url.includes('import-file'))).toBeUndefined();
    expect(String(up.payloads[0].description)).toContain('怎样配置端口？');
  });

  it('insight 导入失败不阻断直传', async () => {
    writeCapture('ses-impfail');
    const insight = mockInsight({ session: 'not-found', importFile: { status: 500, body: { error: 'boom' } } });
    const up = fakeUpload();
    const o = outputs();
    expect(await runUpload(['ses-impfail', '--submitter', '张三', '--category', 'agent-sift'], {
      fetchImpl: insight.fetchImpl, uploadImpl: up.uploadImpl, listDirsImpl: () => ["agent-sift"], isTTY: false, ...o,
    })).toBe(0);
    expect(o.errs.join('\n')).not.toContain('上传中止');
  });

  it('★零参数无感直传：范式目录默认 others、提交人走 git 兜底（不弹向导不报错）', async () => {
    writeCapture('ses-flags');
    const up = fakeUpload();
    const o = outputs();
    // fetchImpl 必须注入（insight down）：默认会落到真 fetch——开发机 insight
    // 在跑时"机会主义导入"把测试夹具写进真实 dev.db（占位会话残留主页）
    expect(await runUpload(['ses-flags'], { fetchImpl: mockInsight({ down: true }).fetchImpl, uploadImpl: up.uploadImpl, listDirsImpl: () => ['agent-sift', 'others'], isTTY: false, defaultSubmitterImpl: () => 'dbz', ...o })).toBe(0);
    expect(up.payloads.length).toBe(1);
    expect(up.payloads[0].category).toBe('others');
    expect(String(up.payloads[0].description).startsWith('提交人: dbz\n')).toBe(true);
    expect(o.errs.join('\n')).toContain('默认 others');
    // 无 git 用户且非交互：仅提交人缺失才报错（目录已默认；换 sid 避开上一段的 sidecar 记忆）
    writeCapture('ses-nosub');
    const o2 = outputs();
    expect(await runUpload(['ses-nosub'], { fetchImpl: mockInsight({ down: true }).fetchImpl, uploadImpl: up.uploadImpl, listDirsImpl: () => ['others'], isTTY: false, defaultSubmitterImpl: () => '', ...o2 })).toBe(2);
    const msg2 = o2.errs.join('\n');
    expect(msg2).toContain('非交互环境缺少必选信息: --submitter（或用交互模式）');
    expect(msg2).not.toContain('必选信息: --submitter（或用交互模式）、--category');
    expect(up.payloads.length).toBe(1);
  });

  it('governance 拒绝 → 1 原因透传；git 错误日志脱敏（凭据 URL 不外泄）', async () => {
    writeCapture('ses-gov');
    const gov = fakeUpload({ error: new GovernanceError('清洗后仍检出疑似密钥残留') });
    const o1 = outputs();
    expect(await runUpload(['ses-gov', '--submitter', '张三', '--category', 'agent-sift'], {
      uploadImpl: gov.uploadImpl, listDirsImpl: () => ["agent-sift"], isTTY: false, fetchImpl: mockInsight({ down: true }).fetchImpl, ...o1,
    })).toBe(1);
    expect(o1.errs.join('\n')).toContain('governance 拒绝');
    expect(o1.errs.join('\n')).toContain('密钥残留');

    const git = fakeUpload({ error: new Error(`git push failed: https://duanbingzhe:secret@atomgit.com/... fatal`) });
    const o2 = outputs();
    expect(await runUpload(['ses-gov', '--submitter', '张三', '--category', 'agent-sift'], {
      uploadImpl: git.uploadImpl, listDirsImpl: () => ["agent-sift"], isTTY: false, fetchImpl: mockInsight({ down: true }).fetchImpl, ...o2,
    })).toBe(1);
    const msg2 = o2.errs.join('\n');
    expect(msg2).not.toContain('secret@');
    expect(msg2).toContain('upload failed');
  });
});

describe('TTY 向导（脚本化应答）', () => {
  it('连按回车：提交人取默认、目录取 1（sessions 被过滤）、opgen 跳过、baseline 关', async () => {
    const questions: string[] = [];
    const answers = ['', '', '', '', ''];
    const rl = { question: async (q: string) => { questions.push(q); return answers.shift() ?? ''; }, close() {} };
    const a = await promptUploadInfo(rl as any, {} as UploadFlags, ['agent-sift', 'sessions'], 'dbz', '首问预填');
    expect(a).toEqual({ submitter: 'dbz', desc: '首问预填', category: 'agent-sift', opgen: undefined, baseline: false });
    expect(questions[0]).toContain('提交人');
  });
  it('提交人默认为空时循环追问直到非空', async () => {
    const answers = ['', '最终名字', '1', '', '', ''];
    const rl = { question: async () => answers.shift() ?? '', close() {} };
    const a = await promptUploadInfo(rl as any, {} as UploadFlags, ['agent-sift'], '', '');
    expect(a.submitter).toBe('最终名字');
  });
  it('零 flag 默认链：insight down 也可无感直传（提交人=注入兜底、目录=others、opgen 走 flag）', async () => {
    writeCapture('ses-wizard');
    const up = fakeUpload();
    const o = outputs();
    const code = await runUpload(['ses-wizard', '--opgen', 'success'], {
      fetchImpl: mockInsight({ down: true }).fetchImpl, uploadImpl: up.uploadImpl, listDirsImpl: () => ["agent-sift", "others"], defaultSubmitterImpl: () => 'env-user', ...o,
    });
    expect(code).toBe(0);
    expect(up.payloads[0].description.startsWith('提交人: env-user\n')).toBe(true);
    expect(up.payloads[0].category).toBe('others');
    expect(up.payloads[0].opGen).toBe('success');
  });
});
