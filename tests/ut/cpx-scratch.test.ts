// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 会话 scratch 治理 IT（空壳会话泄漏修复）：
//   ① dropSessionScratch：0 字节占位（三形态）+ .sids 清单落下；有记录的
//      形态（会话本体）绝不触碰；0 字节明文 + 真实 .gz 孪生并存时只删明文
//   ② sweepLeakedPlaceholders：死占位（0B/无孪生/无 meta/非活运行）扫除；
//      活运行 / 有 meta / 有压缩孪生 / 非空件 / 非 cpx- 前缀全保留
//   ③ 真 wrapper SIGINT 端到端：假 agent 零请求 → Ctrl+C 退出后重定向目录
//      无任何 cpx-*.jsonl / .sids 残留（泄漏根因——信号 handler 曾直接
//      process.exit 跳过清理）

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dropSessionScratch, sweepLeakedPlaceholders } from '../../src/cli/cpx-scratch';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-scratch-it-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function touch(rel: string, content = ''): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

describe('dropSessionScratch（信号路径清理）', () => {
  it('0 字节占位 + .sids 清单 → 全部落下', () => {
    touch('cpx-ses-a.jsonl');
    touch('cpx-ses-a.sids', 'ses-real\n');
    dropSessionScratch(dir, 'ses-a');
    expect(fs.existsSync(path.join(dir, 'cpx-ses-a.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'cpx-ses-a.sids'))).toBe(false);
  });

  it('有记录的 pinned 文件（会话本体）保留，仅清清单', () => {
    touch('cpx-ses-b.jsonl', '{"type":"wire"}\n');
    touch('cpx-ses-b.sids', 'ses-b\n');
    dropSessionScratch(dir, 'ses-b');
    expect(fs.existsSync(path.join(dir, 'cpx-ses-b.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'cpx-ses-b.sids'))).toBe(false);
  });

  it('0 字节明文 + 真实 .gz 孪生 → 只删明文，.gz（前次会话数据）保留', () => {
    touch('cpx-ses-c.jsonl');
    touch('cpx-ses-c.jsonl.gz', '\x1f\x8b（伪 gzip 数据）');
    dropSessionScratch(dir, 'ses-c');
    expect(fs.existsSync(path.join(dir, 'cpx-ses-c.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'cpx-ses-c.jsonl.gz'))).toBe(true);
  });
});

describe('sweepLeakedPlaceholders（启动期扫除）', () => {
  it('死占位（含孤儿清单）扫除；活运行 / meta / 孪生 / 非空 / 非 cpx- 全保留', () => {
    touch('cpx-dead1.jsonl'); touch('cpx-dead1.sids', 'ses-real-x\n');   // 死占位 → 扫
    touch('cpx-live1.jsonl'); touch('cpx-live1.sids', 'x\n');            // 活运行 → 留
    touch('cpx-meta1.jsonl'); touch('cpx-meta1.meta.json', '{}');        // 有 meta → 留
    touch('cpx-twin1.jsonl'); touch('cpx-twin1.jsonl.gz', 'data');       // 压缩孪生 → 留
    touch('cpx-full1.jsonl', '{"type":"wire"}\n');                        // 非空 → 留
    touch('native1.jsonl');                                                // 非 cpx- 前缀 → 留
    const swept = sweepLeakedPlaceholders(dir, new Set(['live1']));
    expect(swept).toBe(1);
    expect(fs.existsSync(path.join(dir, 'cpx-dead1.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'cpx-dead1.sids'))).toBe(false);
    for (const keep of ['cpx-live1.jsonl', 'cpx-live1.sids', 'cpx-meta1.jsonl', 'cpx-twin1.jsonl', 'cpx-twin1.jsonl.gz', 'cpx-full1.jsonl', 'native1.jsonl']) {
      expect(fs.existsSync(path.join(dir, keep))).toBe(true);
    }
  });
});

describe('SIGINT 端到端（真 wrapper，泄漏根因回归锁）', () => {
  it('Ctrl+C 退出后重定向目录无占位/清单残留', async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-sigint-it-'));
    const agentMarker = `cpx-sigint-fake-agent-${process.pid}`;
    const agent = path.join(runDir, 'fake-agent.js');
    // 零请求假 agent：长睡眠占住进程（须可执行：shebang + 0o755——spawn 直起，
    // 非 exec 件报 EACCES）。SIGINT 只发给 cpx-cli，agent 孤儿由测试收尾清理
    fs.writeFileSync(agent, `#!/usr/bin/env node\nprocess.title = '${agentMarker}'; setInterval(() => {}, 1000);\n`, { mode: 0o755 });
    try {
      const wrapper = path.join(path.resolve(__dirname, '../../'), 'cpx-cli');
      const p = spawn('bash', [wrapper, agent], {
        env: {
          ...process.env,
          CANNBOT_PROXY_DIR: path.join(runDir, 'proxy'),
          CANNBOT_CPX_INSIGHT_BASE: 'http://127.0.0.1:1',
        },
        stdio: 'ignore',
      });
      // 等 agent 进程出现（启动于信号 handler 注册之后）——占位文件由 proxy
      // 更早创建，只等文件会在 handler 就绪前发信号（启动期击杀走不到清理）
      const placeholder = path.join(runDir, 'proxy');
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const agentUp = spawnSync('pgrep', ['-f', agentMarker]).status === 0;
        if (agentUp) break;
        if (p.exitCode !== null) throw new Error(`cpx 提前退出（code ${p.exitCode}）`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
      expect(spawnSync('pgrep', ['-f', agentMarker]).status).toBe(0); // agent 在跑
      expect(fs.readdirSync(placeholder).some(f => /^cpx-.*\.jsonl$/.test(f))).toBe(true); // 占位确实创建过
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);

      p.kill('SIGINT'); // wrapper exec tsx → pid 即 cpx-cli 本体
      const code = new Promise<number | null>((resolve) => p.on('exit', c => resolve(c)));
      const c = await Promise.race([
        code,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('SIGINT 后 15s 未退出')), 15_000)),
      ]);
      expect(c).toBe(130);
      // 泄漏根因回归：占位与清单必须被信号路径清理
      const left = fs.readdirSync(placeholder);
      expect(left.some(f => /^cpx-.*\.jsonl$/.test(f))).toBe(false);
      expect(left.some(f => /^cpx-.*\.sids$/.test(f))).toBe(false);
    } finally {
      spawnSync('pkill', ['-f', agentMarker]);
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  }, 60_000);
});
