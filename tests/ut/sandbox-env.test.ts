// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// E2E 沙箱「出口代理 env 剥净」的回归锁。历史 bug：sandbox.ts 注释承诺「NO_PROXY
// 同剥」，但 PROXY_ENV_KEYS 只列 HTTP(S)_PROXY / ALL_PROXY（大小写），漏了
// NO_PROXY / no_proxy——开发机残留的绕过清单会原样漏进子进程 env，让「本跳恒
// 直连 127.0.0.1 桩」的确定性承诺出现旁路。锁法：真实 createSandbox().env()
// 行为断言 NO_PROXY 不进子进程；旧实现（清单漏列）必红。
import { describe, it, expect, afterEach } from 'vitest';
import { createSandbox } from '../e2e/harness/sandbox';

const STASH = new Map<string, string | undefined>();

function setEnv(k: string, v: string): void {
  if (!STASH.has(k)) STASH.set(k, process.env[k]);
  process.env[k] = v;
}

afterEach(() => {
  for (const [k, v] of STASH) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  STASH.clear();
});

describe('sandbox env 出口代理剥离（含 NO_PROXY）', () => {
  it('NO_PROXY / no_proxy 与 HTTP(S)_PROXY 一样不进子进程 env', () => {
    setEnv('HTTP_PROXY', 'http://dev-proxy:8080');
    setEnv('NO_PROXY', 'localhost,.corp.example.com');
    setEnv('no_proxy', '127.0.0.1');
    const sandbox = createSandbox('cpx-sandbox-env-');
    try {
      const child = sandbox.env();
      expect(child).not.toHaveProperty('HTTP_PROXY');
      expect(child).not.toHaveProperty('NO_PROXY');
      expect(child).not.toHaveProperty('no_proxy');
    } finally {
      sandbox.cleanup();
    }
  });

  it('overrides 仍可显式注入 NO_PROXY（剥默认、不剥显式，契约不变）', () => {
    setEnv('NO_PROXY', 'dev-residual');
    const sandbox = createSandbox('cpx-sandbox-env-');
    try {
      const child = sandbox.env({ NO_PROXY: 'explicit' });
      expect(child.NO_PROXY).toBe('explicit');
    } finally {
      sandbox.cleanup();
    }
  });
});