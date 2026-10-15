// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// codex provider 隧道层单测：config.toml 解析（轻量 TOML 提取）、路径保真
// 隧道 base 计算、origin-only upstream 表、子进程 NO_PROXY 合并。真实
// config 形状取自网关场景（[model_providers.volcano]）。

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexProviderTable, tunnelBaseUrl, providerUpstreamOrigins } from '../../src/cli/codex-providers.ts';
import { loopbackNoProxy } from '../../src/cli/child-env.ts';

function withConfig(toml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-codex-cfg-'));
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, toml);
  return file;
}

describe('readCodexProviderTable：config.toml 解析', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('解析 [model_providers.*] 表（真实网关形状）；顶层键不参与隧道', () => {
    const file = withConfig(`
# 用户注释
model = "deepseek-v4-pro"
model_provider = "volcano"

[model_providers.volcano]
name = "Volcano Gateway"
base_url = "https://gw-example.apigateway-cn-beijing.example.com/v1"
env_key = "VOLCANO_API_KEY"
wire_api = "responses"
`);
    const table = readCodexProviderTable(file)!;
    expect(table.providers['volcano']).toEqual({
      baseUrl: 'https://gw-example.apigateway-cn-beijing.example.com/v1',
      wireApi: 'responses',
    });
  });

  it('顶层 openai_base_url 捕获（responses 协议真实上游依据）；节内同名键不串位', () => {
    const file = withConfig(`
openai_base_url = "https://relay.example.com/v1"

[model_providers.volcano]
base_url = "https://gw.example.com/v1"
openai_base_url = "https://section-scoped.example.com/v1"
`);
    const table = readCodexProviderTable(file)!;
    expect(table.openaiBaseUrl).toBe('https://relay.example.com/v1');
    expect(table.providers['volcano'].baseUrl).toBe('https://gw.example.com/v1');
  });

  it('顶层 openai_base_url 未设 → null（降级语义，不臆造端点）', () => {
    const file = withConfig(`
[model_providers.volcano]
base_url = "https://gw.example.com/v1"
`);
    expect(readCodexProviderTable(file)!.openaiBaseUrl).toBeNull();
  });

  it('多 provider 全部收齐；缺 base_url 的条目剔除并提示（不再静默零捕获）', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = withConfig(`
[model_providers.a]
name = "A"
env_key = "A_KEY"

[model_providers.b]
base_url = "https://b.example.com/api/v3"

[model_providers.c]
base_url = "https://c.example.com"
wire_api = "chat"
`);
    const table = readCodexProviderTable(file)!;
    expect(Object.keys(table.providers).sort()).toEqual(['b', 'c']);
    expect(table.providers['c'].wireApi).toBe('chat');
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain('codex provider "a"');
  });

  it('非空但不可解析的 base_url 同样剔除——tunnelIds 与 upstream 表保持一致（防坏路由）', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = withConfig(`
[model_providers.good]
base_url = "https://good.example.com/v1"

[model_providers.bad]
base_url = "::not-a-url::"
`);
    const table = readCodexProviderTable(file)!;
    expect(Object.keys(table.providers)).toEqual(['good']);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain('codex provider "bad"');
  });

  it('保留路径段 provider id（v1 / s）不隧道——与内置 /v1、/s 前缀解冲突', () => {
    const file = withConfig(`
[model_providers.v1]
base_url = "https://v1.example.com"

[model_providers.s]
base_url = "https://s.example.com"

[model_providers.normal]
base_url = "https://normal.example.com"
`);
    const table = readCodexProviderTable(file)!;
    expect(Object.keys(table.providers)).toEqual(['normal']);
  });

  it('节头带行尾注释（合法 TOML）不把后续键误归入上一个 section——误归类 = 隧道到无关主机', () => {
    const file = withConfig(`
[model_providers.a]
base_url = "https://a.example.com/v1"

[other.section] # 常见写法：节头行尾注释
base_url = "https://evil-wrong-host.example.com/v1"
`);
    const table = readCodexProviderTable(file)!;
    expect(table.providers['a']).toEqual({
      baseUrl: 'https://a.example.com/v1',
      wireApi: null,
    });
  });

  it('未识别的节头形态（未闭合括号）同样落哨兵，不继承上一节', () => {
    const file = withConfig(`
[model_providers.a]
base_url = "https://a.example.com/v1"

[weird unclosed
base_url = "https://evil-wrong-host.example.com/v1"
`);
    const table = readCodexProviderTable(file)!;
    expect(table.providers['a'].baseUrl).toBe('https://a.example.com/v1');
  });

  it('单引号 literal 字符串与值后行尾注释都是合法 TOML——正常解析', () => {
    const file = withConfig(`
[model_providers.a]
base_url = 'https://a.example.com/v1' # my gateway
wire_api = 'chat'
`);
    const table = readCodexProviderTable(file)!;
    expect(table.providers['a']).toEqual({
      baseUrl: 'https://a.example.com/v1',
      wireApi: 'chat',
    });
  });

  it('BOM 开头的文件可解析（部分 Windows 编辑器会写）', () => {
    const file = withConfig(`\uFEFF[model_providers.a]
base_url = "https://a.example.com/v1"
`);
    const table = readCodexProviderTable(file)!;
    expect(table.providers['a'].baseUrl).toBe('https://a.example.com/v1');
  });

  it('非裸 key 的 provider id（带 / 或引号）不能成为路径段——跳过', () => {
    const file = withConfig(`
[model_providers."odd/id"]
base_url = "https://odd.example.com"

[model_providers.normal]
base_url = "https://normal.example.com"
`);
    const table = readCodexProviderTable(file)!;
    expect(Object.keys(table.providers)).toEqual(['normal']);
  });

  it('其他 section 的同名键不误收；文件缺失/不存在 → null（走内置 openai 兜底）', () => {
    const file = withConfig(`
[mcp_servers.volcano]
base_url = "https://not-a-provider.example.com"

[projects."/some/path"]
model = "x"
`);
    const table = readCodexProviderTable(file)!;
    expect(table.providers).toEqual({});
    expect(readCodexProviderTable('/nonexistent/config.toml')).toBeNull();
  });
});

describe('tunnelBaseUrl：路径保真隧道', () => {
  it('保留原 base_url 的 path 部分（/v1 网关 → /<id>/v1）', () => {
    expect(tunnelBaseUrl('http://127.0.0.1:PORT', 'volcano', 'https://host.example.com/v1'))
      .toBe('http://127.0.0.1:PORT/volcano/v1');
  });

  it('深层 path 同样保真（/api/v3）；尾斜杠剥离；根 path 不加空段', () => {
    expect(tunnelBaseUrl('http://127.0.0.1:PORT', 'gw', 'https://h.example.com/api/v3/'))
      .toBe('http://127.0.0.1:PORT/gw/api/v3');
    expect(tunnelBaseUrl('http://127.0.0.1:PORT/', 'gw', 'https://h.example.com'))
      .toBe('http://127.0.0.1:PORT/gw');
  });

  it('畸形 base_url 退化为根隧道（不抛）', () => {
    expect(tunnelBaseUrl('http://127.0.0.1:PORT', 'gw', 'not-a-url'))
      .toBe('http://127.0.0.1:PORT/gw');
  });
});

describe('providerUpstreamOrigins：origin-only upstream 表', () => {
  it('只留 scheme+host+port（proxy 侧重新拼被剥的路径）；畸形项跳过', () => {
    const table = {
      openaiBaseUrl: null,
      providers: {
        volcano: { baseUrl: 'https://gw.example.com/v1', wireApi: 'responses' },
        other: { baseUrl: 'http://h2.example.com:8080/base', wireApi: null },
        bad: { baseUrl: '::not-a-url::', wireApi: null },
      },
    };
    expect(providerUpstreamOrigins(table)).toEqual({
      volcano: 'https://gw.example.com',
      other: 'http://h2.example.com:8080',
    });
  });
});

describe('loopbackNoProxy：子进程本地跳排除（agent→proxy 恒直连）', () => {
  it('无既有 NO_PROXY → 仅回环两项', () => {
    expect(loopbackNoProxy({})).toBe('localhost,127.0.0.1');
  });

  it('合并（不覆盖）用户既有排除；大小写两种键都认；去重去空白', () => {
    expect(loopbackNoProxy({ NO_PROXY: ' corp.example.com, 10.0.0.0/8 ' }))
      .toBe('localhost,127.0.0.1,corp.example.com,10.0.0.0/8');
    expect(loopbackNoProxy({ no_proxy: 'localhost' })).toBe('localhost,127.0.0.1');
  });

  it('NO_PROXY 与 no_proxy 同时存在且值不同 → 两边条目都并入（只读其一会静默丢另一方的排除项）', () => {
    expect(loopbackNoProxy({ NO_PROXY: 'a.example.com', no_proxy: 'b.example.com' }))
      .toBe('localhost,127.0.0.1,a.example.com,b.example.com');
  });

  it('去重按小写归一（localhost 与 LOCALHOST 不重复出现）', () => {
    expect(loopbackNoProxy({ NO_PROXY: 'LOCALHOST', no_proxy: 'localhost' }))
      .toBe('localhost,127.0.0.1');
  });
});
