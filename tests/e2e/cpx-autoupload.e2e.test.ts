// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// `cpx <agent> --autoupload` E2E IT（直传模式）：经仓内 wrapper 起 cpx-cli
// 真身，mock insight（observe 探活/预填、import-file）+ 真实本地 bare CANNBay
// 仓（CANNBAY2_REMOTE_URL/PUSH_URL/CPX_CACHE_DIR 环境注入）+ 假 agent（经
// proxy 发一次真实请求产生非空捕获），验证：
//   ① 保留参数拦截：--autoupload/--submitter/--category 绝不透传 agent
//   ② 全链路：压缩 → 自动导入（insight 在跑）→ 直传成功 → bare 仓 main 树
//      含 agent-sift/<sid>/（jsonl.7z + meta），commit 首行「提交人:」
//   ③ ★insight 未运行仍完成直传（直传核心能力）
//   ④ 缺必选 flag 的非交互 autoupload：指路补传话术，进程退出码仍 0（捕获优先）
//   ⑤ parseArgs 单元：保留参数任意位置消费、位置参数/转发参数原样、
//      profile 自动识别不受影响

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../../src/cli/cpx-args';

const WRAPPER = path.join(path.resolve(__dirname, '../../'), 'cpx-cli');

let tmp: string;
let bare: string;
let captureDir: string;
let server: http.Server;
let serverBase = '';
let insightDown = false;
let stubBin = '';
const requests: Array<{ method: string; url: string; body: any }> = [];

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-autoupload-e2e-'));
  // xdg-open/open 桩：自动导入成功后 cpx 真身会 openBrowser(<sid> 页)——
  // 不拦截会在开发机真弹浏览器标签（PATH 前置，与假 npx 同款纪律）
  stubBin = path.join(tmp, 'bin');
  fs.mkdirSync(stubBin, { recursive: true });
  for (const name of ['xdg-open', 'open']) {
    const stub = path.join(stubBin, name);
    fs.writeFileSync(stub, `#!/usr/bin/env bash\nexit 0\n`);
    fs.chmodSync(stub, 0o755);
  }
  bare = path.join(tmp, 'cannbay.git');
  captureDir = path.join(tmp, 'captures');
  fs.mkdirSync(captureDir, { recursive: true });
  execSync(`git init --bare -b main "${bare}"`, { stdio: 'pipe' });
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(path.join(seed, 'agent-sift'), { recursive: true });
  fs.mkdirSync(path.join(seed, 'others'), { recursive: true });
  fs.writeFileSync(path.join(seed, '.gitattributes'), '*.gz filter=lfs\n');
  fs.writeFileSync(path.join(seed, 'agent-sift', '.gitkeep'), '');
  fs.writeFileSync(path.join(seed, 'others', '.gitkeep'), '');
  execSync('git init -b main . && git -c user.name=s -c user.email=s@s add -A && git -c user.name=s -c user.email=s@s commit -qm i && git push -q "' + bare + '" main', { cwd: seed, stdio: 'pipe' });

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      requests.push({ method: req.method!, url: req.url!, body });
      const json = (status: number, b: any) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.url === '/api/observe/data?pageSize=1') {
        if (insightDown) return json(503, { error: 'down' });
        return json(200, { sessions: [] });
      }
      if (req.url?.startsWith('/api/observe/session')) return json(404, { error: 'not found' });
      if (req.url === '/api/ingest/import-file') return json(200, { imported: true, query: 'e2e-first-query' });
      if (req.url === '/v1/chat/completions' || req.url === '/v1/messages') return json(200, { id: 'cmpl', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      json(404, { error: 'unmocked' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  serverBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (!process.env.CPX_E2E_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFakeAgent(name: string, selfUpload = false): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(path.join(tmp, name + '.argv'))}, JSON.stringify(process.argv.slice(2)));
require('node:fs').writeFileSync(${JSON.stringify(path.join(tmp, name + '.env'))}, 'CPX_SESSION_ID=' + (process.env.CPX_SESSION_ID || 'MISSING'));
const base = process.env.OPENAI_BASE_URL;
const sleep = (ms) => new Promise(rs => setTimeout(rs, ms));
// 瞬态抖动（proxy 冷启/上游瞬时失败会丢首个请求）重试兜底：确保捕获非空
const attempt = async (n) => {
  try {
    const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'e2e', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }) });
    const bodyTxt = await r.text();
    ${selfUpload ? `require('node:fs').writeFileSync(${JSON.stringify(path.join(tmp, name + '.upload.log'))}, 'FETCH ok=' + r.ok + ' status=' + r.status + ' server=' + r.headers.get('server') + ' body=' + bodyTxt.slice(0, 200) + '\\n');` : ''}
    if (!r.ok) throw new Error('HTTP ' + r.status);
    await sleep(400);
    ${selfUpload ? `
    // 工作流收尾片段：agent 自执行 cpx upload（env 工牌自动定位本会话）
    const { execSync } = require('node:child_process');
    const phase = (s) => require('node:fs').writeFileSync(${JSON.stringify(path.join(tmp, name + '.upload.log'))}, s);
    try {
      phase('BEFORE');
      const up = execSync('bash ' + process.env.CPX_BIN + ' upload --desc "agent-self-upload e2e" --category agent-sift', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      phase(up);
    } catch (e) { phase('EXIT' + (e && e.status) + ' ' + (e && e.message || '').slice(0, 500)); }` : ''}
    process.exit(0);
  } catch (e) {
    if (n > 0) { await sleep(300); return attempt(n - 1); }
    require('node:fs').writeFileSync(${JSON.stringify(path.join(tmp, name + '.upload.log'))}, 'GIVEUP ' + (e && e.message || e) + ' base=' + base + '\\n');
    process.exit(0);
  }
};
attempt(5);
`);
  fs.chmodSync(file, 0o755);
  return file;
}

function runCpx(agent: string, extraArgs: string[], opts: { insightDown?: boolean } = {}): Promise<{ code: number; stderr: string }> {
  insightDown = opts.insightDown === true;
  return new Promise((resolve) => {
    const p = spawn('bash', [WRAPPER, agent, ...extraArgs], {
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        CANNBOT_PROXY_DIR: captureDir,
        CANNBOT_CPX_INSIGHT_BASE: serverBase,
        CANNBOT_PROXY_OPENAI_UPSTREAM: serverBase,
        CANNBAY2_REMOTE_URL: bare,
        CANNBAY2_PUSH_URL: bare,
        CANNBAY2_CPX_CACHE_DIR: path.join(tmp, 'cache'),
        // 钉 blob 模式：e2e 断言 bare 仓 blob 布局（LFS 默认开后未设 env 会
        // 翻转 LFS 路径且要求 git-lfs 在机）；LFS 全链路见 cannbay-lfs.test.ts
        CANNBAY2_LFS: '0',
        CPX_BIN: WRAPPER,
        HOME: tmp,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    let stdout = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', (d) => { stdout += d; });
    p.on('close', (code) => resolve({ code: code ?? -1, stderr: err + stdout }));
  });
}

function bareTree(sub: string): string[] {
  return execSync(`git ls-tree -r --name-only main -- ${sub}`, { cwd: bare }).toString().trim().split('\n').filter(Boolean);
}

describe('parseArgs 保留参数', () => {
  it('--autoupload 系列被消费，agent 参数原样转发，profile 识别不受影响', () => {
    const r = parseArgs(['node', 'cpx-cli', 'opencode', '--autoupload', '--submitter', '张三', '--category', 'agent-sift', '--mini', '--model', 'x']);
    expect(r.profile).toBe('opencode');
    expect(r.agentArgs).toEqual(['--mini', '--model', 'x']);
    expect(r.autoUpload).toBe(true);
    expect(r.uploadArgs).toEqual(['--submitter', '张三', '--category', 'agent-sift']);
  });
  it('保留参数在前/中/后任意位置均可；无保留参数时行为与旧版完全一致', () => {
    const r = parseArgs(['node', 'cpx-cli', '--autoupload', 'claude', '-c']);
    expect(r.profile).toBe('claude');
    expect(r.agentArgs).toEqual(['-c']);
    const r2 = parseArgs(['node', 'cpx-cli', 'opencode', '--autoupload=never']);
    expect(r2.autoUpload).toBe(false);
    expect(r2.agentArgs).toEqual(['--autoupload=never']);
  });
});

describe('cpx <agent> --autoupload E2E（直传，真 bare 仓 + mock insight）', () => {
  it('① ② flag 不透传 agent；压缩→导入→直传全链路落 bare 仓', async () => {
    const agent = writeFakeAgent('agent-ok');
    const r = await runCpx(agent, ['--autoupload', '--submitter', '张三', '--category', 'agent-sift']);
    expect(r.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'agent-ok.argv'), 'utf8'))).toEqual([]);
    const imp = requests.find(x => x.url === '/api/ingest/import-file');
    expect(imp?.body.source).toBe('claude-jsonl');
    const files = bareTree('agent-sift');
    const sidDir = files.find(f => /agent-sift\/[^/]+\/[^/]+\.jsonl\.7z$/.test(f));
    expect(sidDir).toBeTruthy();
    const log = execSync('git -c core.quotepath=off log -1 --pretty=%s main', { cwd: bare }).toString();
    expect(log).toContain('提交人: 张三');
    expect(r.stderr).toContain('✅ uploaded');
  }, 180_000);

  it('③ ★insight 未运行仍完成直传（probe 503 也不影响）', async () => {
    const agent = writeFakeAgent('agent-noin');
    const r = await runCpx(agent, ['--autoupload', '--submitter', '李四', '--category', 'agent-sift'], { insightDown: true });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('✅ uploaded');
    const log = execSync('git -c core.quotepath=off log -1 --pretty=%s main', { cwd: bare }).toString();
    expect(log).toContain('提交人: 李四');
  }, 180_000);

  it('④ ★零参数无感 autoupload：默认 others 直传（不弹向导不报错，退出码 0）', async () => {
    const agent = writeFakeAgent('agent-hint');
    const r = await runCpx(agent, ['--autoupload']);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('默认 others');
    expect(r.stderr).toContain('✅ uploaded');
    const othersTree = bareTree('others');
    expect(othersTree.find(f => /others\/[^/]+\/[^/]+\.jsonl\.7z$/.test(f))).toBeTruthy();
    const z7 = fs.readdirSync(captureDir).filter(f => f.endsWith('.jsonl.7z'));
    expect(z7.length).toBeGreaterThanOrEqual(3);
  }, 180_000);

  it('⑤ ★工作流收尾片段全链路：agent 自执行 cpx upload（env 工牌定位），退出 autoupload 静默跳过', async () => {
    const agent = writeFakeAgent('agent-self', true);
    const r = await runCpx(agent, ['--autoupload']);
    fs.writeFileSync(path.join(tmp, 'stderr5.log'), r.stderr);
    expect(r.code).toBe(0);
    // 会话工牌已注入 agent（pinned sid）
    expect(fs.readFileSync(path.join(tmp, 'agent-self.env'), 'utf8')).toMatch(/^CPX_SESSION_ID=[\w-]+$/);
    // agent 子进程执行的上传成功（快照直传，live 明文走治理慢路径）
    const upLog = fs.readFileSync(path.join(tmp, 'agent-self.upload.log'), 'utf8');
    expect(upLog).toContain('✅ uploaded');
    const files = bareTree('agent-sift');
    expect(files.find(f => /agent-sift\/[^/]+\/[^/]+\.jsonl\.7z$/.test(f))).toBeTruthy();
    const log = execSync('git -c core.quotepath=off log -1 --pretty=%s main', { cwd: bare }).toString();
    expect(log).toContain('提交人: '); // git user.name（agent 未填提交人）
    // 退出路径 autoupload：sidecar 存在且捕获无新增 → 静默跳过，不再上传
    expect(r.stderr).toContain('跳过');
    expect(r.stderr).not.toContain('autoupload 未完成');
  }, 180_000);
});
