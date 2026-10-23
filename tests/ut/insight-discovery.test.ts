// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details.
// You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 发现契约（多人服务器）：env → 用户级端口登记 → 21025 兜底。
// 登记文件持久保留是设计决策（防「实例未运行」窗口期回落 21025 跨用户
// 导入污染），回归锁见 docs/design/multi-user/design.md §二。
// env 手动保存/还原而非 vi.stubEnv：锚定用 `??`，空串不是 null 会被当成
// 显式设置，必须真删除（undefined）才能测回落路径。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInsightBase, DEFAULT_INSIGHT_PORT } from '../../src/cli/insight-discovery';

const ENV_KEYS = ['HOME', 'CONTEXT_CPX_INSIGHT_BASE', 'CONTEXT_PROXY_DIR', 'CONTEXT_INSIGHT_HOME'] as const;
const SAVED: Record<string, string | undefined> = {};
let home: string;

function writeRegistry(content: string): void {
  const dir = path.join(home, '.context-insight');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'insight-port'), content);
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k];
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-insight-discovery-'));
  process.env.HOME = home;
  delete process.env.CONTEXT_CPX_INSIGHT_BASE;
  delete process.env.CONTEXT_PROXY_DIR;
  delete process.env.CONTEXT_INSIGHT_HOME;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('resolveInsightBase 发现契约', () => {
  it('env 显式指定最高优先（登记文件存在也不生效）', () => {
    writeRegistry('29999\n');
    process.env.CONTEXT_CPX_INSIGHT_BASE = 'http://127.0.0.1:9999';
    expect(resolveInsightBase()).toBe('http://127.0.0.1:9999');
  });

  it('登记文件命中：无 env 时用登记端口', () => {
    writeRegistry('21226\n');
    expect(resolveInsightBase()).toBe('http://localhost:21226');
  });

  it('登记目录锚定 CONTEXT_PROXY_DIR（与其父目录同源）', () => {
    const custom = path.join(home, 'custom-capture-root', 'proxy');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(path.dirname(custom), 'insight-port'), '23000\n');
    process.env.CONTEXT_PROXY_DIR = custom;
    expect(resolveInsightBase()).toBe('http://localhost:23000');
  });

  it('登记目录跟随 CONTEXT_INSIGHT_HOME（无 CONTEXT_PROXY_DIR 时）', () => {
    const dataDir = path.join(home, 'relocated-data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'insight-port'), '24000\n');
    process.env.CONTEXT_INSIGHT_HOME = dataDir;
    expect(resolveInsightBase()).toBe('http://localhost:24000');
  });

  it('CONTEXT_PROXY_DIR 优先于 CONTEXT_INSIGHT_HOME', () => {
    const dataDir = path.join(home, 'relocated-data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'insight-port'), '24000\n');
    process.env.CONTEXT_INSIGHT_HOME = dataDir;
    const custom = path.join(home, 'custom-capture-root', 'proxy');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(path.dirname(custom), 'insight-port'), '23000\n');
    process.env.CONTEXT_PROXY_DIR = custom;
    expect(resolveInsightBase()).toBe('http://localhost:23000');
  });

  it('登记文件损坏（非数字/越界/空）→ 回落默认端口，不抛', () => {
    for (const bad of ['abc\n', '0\n', '-1\n', '65536\n', '', '  \n']) {
      writeRegistry(bad);
      expect(resolveInsightBase(), `registry=${JSON.stringify(bad)}`).toBe(
        `http://localhost:${DEFAULT_INSIGHT_PORT}`,
      );
    }
  });

  it('无登记文件 → 默认 21025', () => {
    expect(resolveInsightBase()).toBe(`http://localhost:${DEFAULT_INSIGHT_PORT}`);
  });
});
