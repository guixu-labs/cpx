// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// opencode provider 发现（纯函数，路径注入可测）：cpx 捕获 opencode 会话的
// 前提是把用到的 provider baseURL 重定向到本机 proxy（OPENCODE_CONFIG_CONTENT，
// 进程级、tier 6）。provider 候选有四个来源：
//   ① 命令行 `-m <provider>/<model>`（精确，优先）
//   ② auth.json 的 provider keys（opencode 官方凭据存储）
//   ③ 用户全局配置（~/.config/opencode/opencode.json[c] 的 provider 段）
//   ④ 项目级配置（opencode.json[c] / .opencode/opencode.json[c]，cwd 向上到
//      git 根遍历——opencode 文档：先在 cwd 找，再向上到最近的 git 目录）
// ③④ 的自定义 provider（如私有 AI 网关）baseURL 就在配置本体里，此前只看 ①②
// → 自定义 provider 的 baseURL 从未被重定向 → 整个会话的 LLM 流量直连上游、
// proxy 颗粒无收（客户现场 ses_fa840cd30ffe：gateway/glm-5.3 走 volceapi 直连，
// cpx 捕获 0 字节；当时修复只覆盖了全局配置，漏了项目级配置）。
// 自定义 provider 的真实上游 baseURL 从配置本体读（不在 opencode 二进制里，
// binary strings 扫描必 miss）。
import fs from 'node:fs';
import path from 'node:path';

// JSONC 注释剥离（字符串感知）：opencode.jsonc 允许 // 行注释与 /* */ 块
// 注释，但配置值里的 URL（"https://…"）自带 `//` —— 裸正则替换会把 URL
// 腰斩。逐字符状态机：仅在双引号字符串外剥注释；处理 \" 转义。
export function stripJsoncComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        // 保留转义对（\" 等）——下一个字符原样带上
        if (i + 1 < text.length) { out += text[i + 1]; i++; }
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n'; // 保留换行（行号语义，错误信息可读）
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // 越过 '/'
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

// 解析单个 opencode 配置文件（.json 直读；.jsonc 剥注释）。失败返回 null。
function parseConfigFile(file: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(stripJsoncComments(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// auth.json 的 provider keys（opencode 官方凭据存储；值是凭据对象才算）。
export function readAuthProvidersFromFile(authJsonPath: string): string[] {
  try {
    const obj = JSON.parse(fs.readFileSync(authJsonPath, 'utf-8')) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return [];
    return Object.keys(obj).filter(k => obj[k] && typeof obj[k] === 'object');
  } catch {
    return [];
  }
}

// 用户 opencode 配置的自定义 provider：provider.<id>.options.baseURL →
// { id: baseURL }。cannbot（opencode 系 fork）双配置根都查，先 cannbot 后
// opencode（与 cannbotGatewayUpstream 的根序一致），同 id 首见即定（先到根
// 优先）。每根依次尝试 opencode.json / opencode.jsonc。
export function readCustomProvidersFromRoots(roots: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const root of roots) {
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      const cfg = parseConfigFile(path.join(root, name));
      if (!cfg) continue;
      const provider = cfg.provider;
      if (!provider || typeof provider !== 'object') continue;
      for (const [id, def] of Object.entries(provider as Record<string, unknown>)) {
        if (out[id]) continue; // 先到根优先
        if (!def || typeof def !== 'object') continue;
        const baseURL = (def as { options?: { baseURL?: unknown } }).options?.baseURL;
        if (typeof baseURL === 'string' && baseURL) out[id] = baseURL;
      }
      break; // 该根已解析成功（.json 优先于 .jsonc），不再试下一个文件名
    }
  }
  return out;
}

// `-m <provider>/<model>` 解析（opencode 模型格式）。命中则只覆盖该 provider
// （精确）；否则返回 null（调用方走 auth ∪ custom 全量）。
export function parseOpencodeProvider(agentArgs: string[]): string | null {
  for (let i = 0; i < agentArgs.length; i++) {
    if ((agentArgs[i] === '-m' || agentArgs[i] === '--model') && agentArgs[i + 1]) {
      const m = agentArgs[i + 1];
      const slash = m.indexOf('/');
      return slash > 0 ? m.slice(0, slash) : null;
    }
    const eq = agentArgs[i].match(/^-m=(.+)$/);
    if (eq) {
      const m = eq[1];
      const slash = m.indexOf('/');
      return slash > 0 ? m.slice(0, slash) : null;
    }
  }
  return null;
}

// 覆盖列表解析（纯）：-m 精确优先；否则 auth keys ∪ 自定义配置 keys
// （交互式 `cpx opencode` 不知道运行时会选哪个模型，全部可调用 provider
// 一并重定向——未用到的覆盖是死代码无副作用）。cannbot 恒含内建 cannbot
// provider（默认模型走它，二进制扫描 miss 由 cannbotGatewayUpstream 兜底）。
export function resolveProviderIds(opts: {
  profile: 'opencode' | 'cannbot';
  agentArgs: string[];
  authProviders: string[];
  customProviders: Record<string, string>;
}): string[] {
  const fromArg = parseOpencodeProvider(opts.agentArgs);
  if (fromArg) return [fromArg];
  const ids = [...new Set([...opts.authProviders, ...Object.keys(opts.customProviders)])];
  return opts.profile === 'cannbot' ? ['cannbot', ...ids] : ids;
}

// 项目级配置目录（opencode 文档 §Locations/Per project：先在 cwd 找
// opencode.json，再向上遍历到最近的 git 目录）。逐层产出 <dir> 与
// <dir>/.opencode 两个候选根；<dir>/.opencode/opencode.json[c] 是 CANN fork /
// 部分版本的项目配置位置（客户现场 huoshan-ai-gateway 只定义在项目级
// .opencode/opencode.json，全局配置扫不到 → 直连上游 0 捕获）。cwd 参数可注入
// （测试），缺省 process.cwd()。
export function opencodeProjectConfigRoots(cwd?: string): string[] {
  const roots: string[] = [];
  let dir = path.resolve(cwd ?? process.cwd());
  for (;;) {
    roots.push(dir, path.join(dir, '.opencode'));
    // opencode 以最近的 git 目录为项目根（.git 可能是目录或 worktree 文件）
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // 已到文件系统根
    dir = parent;
  }
  return roots;
}

// 配置根（XDG 感知，cannbot/opencode 双根——cannbot 是 opencode 系 fork，
// 两边都可能有自定义 provider 定义）。项目级配置优先（opencode 项目配置
// 优先级高于全局配置；readCustomProvidersFromRoots 先到根优先）。
export function opencodeConfigRoots(): string[] {
  const xdg = process.env.XDG_CONFIG_HOME;
  const home = xdg ? [xdg] : [path.join(process.env.HOME ?? '', '.config')];
  const roots: string[] = [...opencodeProjectConfigRoots()];
  for (const base of home) {
    roots.push(path.join(base, 'cannbot'), path.join(base, 'opencode'));
  }
  return roots;
}
