// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. Do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 全框架上游解析 IT：镜像契约回归锁——cpx 代理必须把流量转发到「子进程
// agent 在无 cpx 时真正会用的上游」。假 agent 按各族真实端点发现机制取址
// （claude 解析 --settings 注入 / dsh 读 $DEEPSEEK_BASE_URL / openai 读
// $OPENAI_BASE_URL / codex 解析 -c openai_base_url=）→ 真实 POST 本会话
// proxy → 假上游记录命中 = 端到端证明转发目标正确。
//
// 层级序依据（真机实测，非文档推测）：
// - claude 2.1.278 三向冲突实验：--settings > .claude/settings.local.json >
//   .claude/settings.json(project) > ~/.claude/settings.json(user) > 进程 env
//   > 官方默认（进程 env 是最低层——settings env 覆盖同名 shell 变量）
// - codex 二进制探针：OPENAI_BASE_URL 仅现于 network-proxy 凭据擦除列表，
//   不作端点解析 → codex 链无 env 层；端点源只有 config.toml
//
// 客户反馈根因（本组用例①）：claude 族此前只读 user settings，进程 env 的
// ANTHROPIC_BASE_URL 被无视 → 硬编码回退官方地址，代理转发到错误上游。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const WRAPPER = path.join(path.resolve(__dirname, '../../'), 'cpx-cli');

let TMP: string;
let HOME: string;
let PROJ: string;
let CAPTURES: string;
let AGENT: string;

/** 命名假上游端口（一个进程多个 server；命中按 name 记录断言） */
const UPSTREAM_NAMES = [
  'ENV', 'USER', 'PROJ', 'PROJLOCAL', 'KNOB',
  'OPENAI_ENV', 'OPENAI_KNOB', 'CODEX_CFG', 'RESP_KNOB', 'DSH', 'DSH_KNOB',
] as const;
type UpstreamName = (typeof UPSTREAM_NAMES)[number];
const ports: Record<UpstreamName, number> = {} as Record<UpstreamName, number>;

interface UpstreamHit { name: string; method: string; url: string }
const hits: UpstreamHit[] = [];

const url = (name: UpstreamName): string => `http://127.0.0.1:${ports[name]}`;

beforeAll(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-upstream-it-'));
  HOME = path.join(TMP, 'home');
  PROJ = path.join(TMP, 'proj');
  CAPTURES = path.join(TMP, 'captures');
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(CAPTURES, { recursive: true });

  for (const name of UPSTREAM_NAMES) {
    await new Promise<void>(resolve => {
      const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => { body += c; });
        req.on('end', () => {
          hits.push({ name, method: req.method ?? '', url: req.url ?? '' });
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'upstream-probe' } }));
        });
      });
      srv.listen(0, '127.0.0.1', () => {
        ports[name] = (srv.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  // 假 agent：按 CPX_TEST_AGENT_MODE 复刻各族的端点发现机制（与真实 agent
  // 同源），CPX_TEST_AGENT_CALL=1 时向注入的 proxy 地址真实 POST 一条请求。
  // fetch 带 8s 超时：上游 400/网络不可达（离线 CI）不影响 agent 退出码。
  AGENT = path.join(TMP, 'fake-agent');
  fs.writeFileSync(AGENT, [
    '#!/usr/bin/env node',
    `const fs = require('fs');`,
    `const mode = process.env.CPX_TEST_AGENT_MODE || 'claude';`,
    `const argv = process.argv.slice(2);`,
    `const dump = process.env.FAKE_AGENT_DUMP;`,
    `let base = null;`,
    `if (mode === 'claude') {`,
    `  const i = argv.indexOf('--settings');`,
    `  const settings = i >= 0 ? JSON.parse(argv[i + 1]) : {};`,
    `  if (dump) fs.writeFileSync(dump, JSON.stringify(settings));`,
    `  base = settings.env && settings.env.ANTHROPIC_BASE_URL;`,
    `} else if (mode === 'dsh') {`,
    `  base = process.env.DEEPSEEK_BASE_URL;`,
    `} else if (mode === 'openai') {`,
    `  base = process.env.OPENAI_BASE_URL;`,
    `} else if (mode === 'codex') {`,
    `  for (let i = 0; i < argv.length; i++) {`,
    `    if (argv[i] === '-c' && argv[i + 1]) {`,
    `      const m = argv[i + 1].match(/^openai_base_url="(.*)"$/);`,
    `      if (m) { base = m[1]; break; }`,
    `    }`,
    `  }`,
    `}`,
    `(async () => {`,
    `  if (process.env.CPX_TEST_AGENT_CALL === '1' && base) {`,
    `    const p = mode === 'openai' ? '/v1/chat/completions' : mode === 'codex' ? '/responses' : '/v1/messages';`,
    `    const headers = { 'content-type': 'application/json' };`,
    `    if (mode === 'openai' || mode === 'codex') headers.authorization = 'Bearer test-key';`,
    `    else headers['x-api-key'] = 'test-key';`,
    `    try {`,
    `      await fetch(base.replace(/\\/+$/, '') + p, {`,
    `        method: 'POST', headers,`,
    `        body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }),`,
    `        signal: AbortSignal.timeout(8000),`,
    `      });`,
    `    } catch (e) { /* 上游 400/不可达不影响 agent 退出码 */ }`,
    `    await new Promise(r => setTimeout(r, 400));`,
    `  }`,
    `})();`,
  ].join('\n'));
  fs.chmodSync(AGENT, 0o755);
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// —— 环境与配置文件操纵 ——————————————————————————————————————————

/** 开发机 shell 可能残留这些变量（含 cpx 旋钮），全部清零保证确定性 */
const SCRUB_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'DEEPSEEK_BASE_URL',
  'CONTEXT_PROXY_ANTHROPIC_UPSTREAM', 'CONTEXT_PROXY_OPENAI_UPSTREAM', 'CONTEXT_PROXY_RESPONSES_UPSTREAM',
];

function writeClaudeSettings(dir: string, env?: Record<string, string>): void {
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  // env 省略 = 客户实况：只有 hooks/theme，无 env 段
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(env ? { env } : { theme: 'dark' }));
}

function resetCodexHome(setup?: { configToml?: string; authJson?: boolean }): void {
  fs.rmSync(path.join(HOME, '.codex'), { recursive: true, force: true });
  if (!setup) return;
  fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true });
  if (setup.configToml) fs.writeFileSync(path.join(HOME, '.codex', 'config.toml'), setup.configToml);
  if (setup.authJson) fs.writeFileSync(path.join(HOME, '.codex', 'auth.json'), '{"mode":"chatgpt"}');
}

// cpx 运行器：必须用 async spawn 而非 spawnSync——本文件的 11 个假上游
// 监听器跑在 vitest worker 进程内，spawnSync 会阻塞 worker 事件循环，
// 监听器无法 accept（proxy 转发 → 监听器卡死 → agent 超时，结构性死锁；
// cpx-nonstream-stall e2e 同款 async spawn 先例）。
function runCpx(profile: 'claude' | 'openai' | 'codex' | 'dsh', extra: {
  env?: Record<string, string>;
  cwd?: string;
  call?: boolean;
  dump?: string;
} = {}): Promise<{ status: number | null; signal: string | null; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of SCRUB_KEYS) delete env[k];
  env.HOME = HOME;
  env.CONTEXT_PROXY_DIR = CAPTURES;
  // 钉死不可达：探测必败 → 不机会主义导入开发机在跑的真 insight、不开浏览器
  env.CONTEXT_CPX_INSIGHT_BASE = 'http://127.0.0.1:1';
  env.CPX_TEST_AGENT_MODE = profile;
  if (extra.call) env.CPX_TEST_AGENT_CALL = '1';
  if (extra.dump) env.FAKE_AGENT_DUMP = extra.dump;
  Object.assign(env, extra.env ?? {});
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [WRAPPER, '--agent', profile, '--', AGENT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: extra.cwd ?? TMP,
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cpx run timeout (profile=${profile})`));
    }, 120_000);
    child.stdout?.on('data', () => { /* cpx 日志走 stderr */ });
    child.stderr?.on('data', (d: Buffer) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stderr });
    });
  });
}

// —— 断言 ——————————————————————————————————————————————————————

function assertHit(run: UpstreamHit[], name: string): void {
  expect(
    run.some(h => h.name === name),
    `假上游 ${name} 应收到转发（实际命中：${JSON.stringify(run.map(h => h.name))}）`,
  ).toBe(true);
}

function assertNoHit(run: UpstreamHit[], name: string): void {
  expect(run.some(h => h.name === name), `假上游 ${name} 不应被命中`).toBe(false);
}

// —— 用例 ——————————————————————————————————————————————————————

describe('cpx 上游解析：镜像契约（各族解析链 = agent 自身配置源优先级同构）', () => {
  it('① claude 客户案：settings 无 env 段 + 进程 env ANTHROPIC_BASE_URL → 转发到该地址；进程 env 的 apiKey 经 --settings 注入', async () => {
    writeClaudeSettings(HOME, undefined);
    const before = hits.length;
    const dump = path.join(TMP, 'dump-case1.json');
    const r = await runCpx('claude', {
      call: true,
      dump,
      env: { ANTHROPIC_BASE_URL: url('ENV'), ANTHROPIC_API_KEY: 'k_env_test' },
    });
    const run = hits.slice(before);
    expect(r.status).toBe(0);
    assertHit(run, 'ENV');
    expect(r.stderr).toContain(`upstream: ${url('ENV')}  (source: process env ANTHROPIC_BASE_URL)`);
    // ⑦ apiKey 链回归：无 settings env 时进程 env 的 key 注入子进程 --settings
    const injected = JSON.parse(fs.readFileSync(dump, 'utf-8')) as { env: Record<string, string> };
    expect(injected.env.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1:\d+/);
    expect(injected.env.ANTHROPIC_API_KEY).toBe('k_env_test');
  }, 180_000);

  it('② claude：user settings env 优先于进程 env（真机 E1/E2 语义）', async () => {
    writeClaudeSettings(HOME, { ANTHROPIC_BASE_URL: url('USER') });
    const before = hits.length;
    const r = await runCpx('claude', { call: true, env: { ANTHROPIC_BASE_URL: url('ENV') } });
    const run = hits.slice(before);
    expect(r.status).toBe(0);
    assertHit(run, 'USER');
    assertNoHit(run, 'ENV');
    expect(r.stderr).toContain(`upstream: ${url('USER')}  (source: ~/.claude/settings.json env)`);
  }, 180_000);

  it('③ claude：project settings 优先于 user settings（真机 E3 语义）', async () => {
    writeClaudeSettings(HOME, { ANTHROPIC_BASE_URL: url('USER') });
    writeClaudeSettings(PROJ, { ANTHROPIC_BASE_URL: url('PROJ') });
    const before = hits.length;
    const r = await runCpx('claude', { call: true, cwd: PROJ });
    const run = hits.slice(before);
    expect(r.status).toBe(0);
    assertHit(run, 'PROJ');
    assertNoHit(run, 'USER');
    expect(r.stderr).toContain(`upstream: ${url('PROJ')}  (source: .claude/settings.json env (project))`);
  }, 180_000);

  it('③b claude：settings.local.json 优先于 project settings（真机 E4 语义）', async () => {
    writeClaudeSettings(HOME, { ANTHROPIC_BASE_URL: url('USER') });
    writeClaudeSettings(PROJ, { ANTHROPIC_BASE_URL: url('PROJ') });
    fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(PROJ, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: url('PROJLOCAL') } }));
    const before = hits.length;
    const r = await runCpx('claude', { call: true, cwd: PROJ });
    const run = hits.slice(before);
    expect(r.status).toBe(0);
    assertHit(run, 'PROJLOCAL');
    assertNoHit(run, 'PROJ');
    expect(r.stderr).toContain(`upstream: ${url('PROJLOCAL')}  (source: .claude/settings.local.json env (project))`);
  }, 180_000);

  it('④ claude：settings 与进程 env 双缺 → 官方默认（仅日志，不打真网）', async () => {
    writeClaudeSettings(HOME, undefined);
    const before = hits.length;
    const r = await runCpx('claude', {});
    const run = hits.slice(before);
    expect(r.status).toBe(0);
    expect(run).toEqual([]);
    expect(r.stderr).toContain('upstream: https://api.anthropic.com  (source: default (api.anthropic.com))');
  }, 180_000);

  it('⑤ claude：空白串进程 env 视为未设 → 官方默认（空串不产生空上游）', async () => {
    writeClaudeSettings(HOME, undefined);
    const before = hits.length;
    const r = await runCpx('claude', { env: { ANTHROPIC_BASE_URL: '   ' } });
    const run = hits.slice(before);
    expect(r.status).toBe(0);
    expect(run).toEqual([]);
    expect(r.stderr).toContain('upstream: https://api.anthropic.com  (source: default (api.anthropic.com))');
  }, 180_000);

  it('⑥ claude：CONTEXT_PROXY_ANTHROPIC_UPSTREAM 旋钮置顶（胜过 settings 与进程 env）', async () => {
    writeClaudeSettings(HOME, { ANTHROPIC_BASE_URL: url('USER') });
    const before = hits.length;
    const r = await runCpx('claude', {
      call: true,
      env: {
        CONTEXT_PROXY_ANTHROPIC_UPSTREAM: url('KNOB'),
        ANTHROPIC_BASE_URL: url('ENV'),
      },
    });
    const run = hits.slice(before);
    expect(r.status).toBe(0);
    assertHit(run, 'KNOB');
    assertNoHit(run, 'ENV');
    assertNoHit(run, 'USER');
    expect(r.stderr).toContain(`upstream: ${url('KNOB')}  (source: CONTEXT_PROXY_ANTHROPIC_UPSTREAM override)`);
  }, 180_000);

  it('⑧ openai/generic：进程 env OPENAI_BASE_URL → 转发到该地址（与 claude 同病补齐）', async () => {
    const before = hits.length;
    const r = await runCpx('openai', { call: true, env: { OPENAI_BASE_URL: url('OPENAI_ENV') } });
    const run = hits.slice(before);
    expect(r.status).toBe(0);
    assertHit(run, 'OPENAI_ENV');
    expect(r.stderr).toContain(`upstream: ${url('OPENAI_ENV')}  (source: process env OPENAI_BASE_URL)`);
  }, 180_000);

  it('⑨ openai/generic：CONTEXT_PROXY_OPENAI_UPSTREAM 旋钮优先于进程 env（既有旋钮语义保持）', async () => {
    const before = hits.length;
    const r = await runCpx('openai', {
      call: true,
      env: {
        CONTEXT_PROXY_OPENAI_UPSTREAM: url('OPENAI_KNOB'),
        OPENAI_BASE_URL: url('OPENAI_ENV'),
      },
    });
    const run = hits.slice(before);
    expect(r.status).toBe(0);
    assertHit(run, 'OPENAI_KNOB');
    assertNoHit(run, 'OPENAI_ENV');
  }, 180_000);

  it('⑩ codex：config.toml 顶层 openai_base_url（/v1 结尾）→ responses 协议转发 base + /responses（verbatim 采纳 + 剥路径前缀 /v1）', async () => {
    resetCodexHome({ configToml: `openai_base_url = "${url('CODEX_CFG')}/v1"\n` });
    const before = hits.length;
    const r = await runCpx('codex', { call: true });
    const run = hits.slice(before);
    expect(r.status).toBe(0);
    assertHit(run, 'CODEX_CFG');
    // 转发 = verbatim base(含 /v1) + /responses（codex 直连字节形态）
    expect(run.find(h => h.name === 'CODEX_CFG')?.url).toBe('/v1/responses');
    expect(r.stderr).toContain(`upstream: ${url('CODEX_CFG')}/v1  (source: config.toml openai_base_url)`);
  }, 180_000);

  it('⑩b codex：config.toml 顶层 openai_base_url 不以 /v1 结尾（网关路径）→ 不拼出多余 /v1，转发 base + /responses', async () => {
    resetCodexHome({ configToml: `openai_base_url = "${url('CODEX_CFG')}/openai"\n` });
    const before = hits.length;
    const r = await runCpx('codex', { call: true });
    const run = hits.slice(before);
    expect(r.status).toBe(0);
    assertHit(run, 'CODEX_CFG');
    // 镜像契约：codex 直连时发 base + /responses = /openai/responses，
    // 剥错地方（剥 base 尾部 /v1）会拼成 /openai/v1/responses 多出一段 /v1
    expect(run.find(h => h.name === 'CODEX_CFG')?.url).toBe('/openai/responses');
    expect(r.stderr).toContain(`upstream: ${url('CODEX_CFG')}/openai  (source: config.toml openai_base_url)`);
  }, 180_000);

  it('⑪ codex：CONTEXT_PROXY_RESPONSES_UPSTREAM 旋钮不被 chatgpt auth 检测覆写（旋钮真最高层）', async () => {
    resetCodexHome({ authJson: true });
    const before = hits.length;
    const r = await runCpx('codex', {
      call: true,
      env: { CONTEXT_PROXY_RESPONSES_UPSTREAM: url('RESP_KNOB') },
    });
    const run = hits.slice(before);
    expect(r.status).toBe(0);
    assertHit(run, 'RESP_KNOB');
    expect(r.stderr).toContain(`upstream: ${url('RESP_KNOB')}  (source: CONTEXT_PROXY_RESPONSES_UPSTREAM override)`);
  }, 180_000);

  it('⑫ dsh：DEEPSEEK_BASE_URL 进程 env → 转发到该地址（既有行为回归锁）', async () => {
    const before = hits.length;
    const r = await runCpx('dsh', { call: true, env: { DEEPSEEK_BASE_URL: url('DSH') } });
    const run = hits.slice(before);
    expect(r.status).toBe(0);
    assertHit(run, 'DSH');
    expect(r.stderr).toContain(`upstream: ${url('DSH')}  (source: process env DEEPSEEK_BASE_URL)`);
  }, 180_000);

  it('⑬ dsh：CONTEXT_PROXY_ANTHROPIC_UPSTREAM 旋钮置顶（anthropic 族共用旋钮）', async () => {
    const before = hits.length;
    const r = await runCpx('dsh', {
      call: true,
      env: {
        CONTEXT_PROXY_ANTHROPIC_UPSTREAM: url('DSH_KNOB'),
        DEEPSEEK_BASE_URL: url('DSH'),
      },
    });
    const run = hits.slice(before);
    expect(r.status).toBe(0);
    assertHit(run, 'DSH_KNOB');
    assertNoHit(run, 'DSH');
  }, 180_000);
});
