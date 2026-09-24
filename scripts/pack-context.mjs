// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// context 品牌变体打包（npm pack）：
//   node scripts/pack-context.mjs   →  .context-pack/context-cpx-<version>.tgz
//   发布：npm publish .context-pack/context-cpx-<version>.tgz
//
// 机制：单源码仓 + 打包期变换 —— `npm pack --dry-run` 取本包真实清单，复制到
// staging 后做精确字面量替换（规则表见下），staging 内 `npm pack`。源码仓零改动。
// bin 保持 `cpx`（中性名）：context-cpx 与 cannbot-proxy 提供同名命令，不能同机
// 共装——同一工具无需双装，代价可接受。
//
// 品牌边界：
//   翻转 —— 捕获/缓存目录默认值（~/.context-insight/proxy，与 context-insight
//           的数据目录配对，导入对话框默认路径才能命中）/ 状态标签 / 文档
//   保留 —— x_cannbay 命名空间（格式契约）/ CANNBOT_* 与 CANNBAY2_* 环境变量名 /
//           `cpx cannbot` 的 cannbot CLI 命令 / git 机器提交身份
//
// 每条规则带 minHits（防漂移哨兵）：源码重构后若必命中的规则命中 0 次，打包报错。
// tests/context-pack.test.ts 对产物做品牌泄漏扫描。

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STAGING = path.join(PKG_DIR, '.context-pack', 'pkg')
const OUT_DIR = path.join(PKG_DIR, '.context-pack')

// 不进 context 变体包：打包脚本自身（规则串自引用，会误触品牌泄漏哨兵）
const EXCLUDE = new Set(['scripts/pack-context.mjs'])

// 通用规则（全部文本文件；精确字符串替换，非正则）
const GLOBAL_RULES = [
  // 数据目录引号字面量（writer / cpx-cli / cpx-complete 三处真身）
  { find: "'.cannbot-insight'", replace: "'.context-insight'", minHits: 3 },
  { find: '~/.cannbot-insight', replace: '~/.context-insight', minHits: 3 },
  { find: 'cannbot-insight :', replace: 'context-insight :', minHits: 1 },
  { find: 'cannbot-insight UI', replace: 'context-insight UI', minHits: 1 },
  // Bay 显示名（命中即翻转，无最低命中要求）
  { find: 'CANNBay', replace: 'contextBay', minHits: 0 },
  { find: 'CANNbay', replace: 'contextBay', minHits: 0 },
]

// 文档规则（*.md：README / docs —— 面向 context-cpx 用户）
const MD_RULES = [
  { find: 'cannbot-proxy', replace: 'context-cpx', minHits: 1 },
  { find: 'cannbot-insight', replace: 'context-insight', minHits: 1 },
]

const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.mdx', '.py',
  '.css', '.scss', '.html', '.txt', '.sh', '.yml', '.yaml', '.sql',
  '.prisma', '.xml', '.svg', '.example',
])

function rewritePkgJson(pkg) {
  pkg.name = 'context-cpx'
  pkg.description = 'Generic agent<->model plaintext capture proxy for Context-Insight'
  pkg.keywords = ['cpx', 'context-cpx', 'context-insight', 'proxy', 'capture', 'llm', 'agent']
  return pkg
}

function packFileList() {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PKG_DIR, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error(`npm pack --dry-run 失败:\n${r.stderr}`)
  const parsed = JSON.parse(r.stdout)
  // npm ≥12 输出为按包名键的对象，旧版是数组（与 insight pack-context.mjs 同款归一化）
  const entry = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]]
  return entry.files.map((f) => f.path)
}

function copyTree(files) {
  fs.rmSync(path.join(PKG_DIR, '.context-pack'), { recursive: true, force: true })
  fs.mkdirSync(STAGING, { recursive: true })
  for (const rel of files) {
    if (EXCLUDE.has(rel)) continue
    // 防御：上次运行的 .context-pack 产物若混入清单，rm -rf 后源已不存在 —— 一律跳过
    if (rel === '.context-pack' || rel.startsWith('.context-pack/')) continue
    const src = path.join(PKG_DIR, rel)
    const dst = path.join(STAGING, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
}

function transformTree() {
  const hits = new Map()
  for (const rule of [...GLOBAL_RULES, ...MD_RULES]) hits.set(rule.find, 0)
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) { walk(full); continue }
      const rel = path.relative(STAGING, full)
      if (rel === 'package.json') continue
      if (!TEXT_EXTS.has(path.extname(name))) continue
      let text = fs.readFileSync(full, 'utf8')
      const rules = path.extname(name) === '.md' ? [...GLOBAL_RULES, ...MD_RULES] : GLOBAL_RULES
      for (const rule of rules) {
        const n = text.split(rule.find).length - 1
        if (n > 0) { text = text.split(rule.find).join(rule.replace); hits.set(rule.find, hits.get(rule.find) + n) }
      }
      if (text !== fs.readFileSync(full, 'utf8')) fs.writeFileSync(full, text)
    }
  }
  walk(STAGING)

  const pkgPath = path.join(STAGING, 'package.json')
  const pkg = rewritePkgJson(JSON.parse(fs.readFileSync(pkgPath, 'utf8')))
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

  for (const rule of [...GLOBAL_RULES, ...MD_RULES]) {
    if ((hits.get(rule.find) ?? 0) < rule.minHits) {
      throw new Error(
        `规则 "${rule.find}" 命中 ${hits.get(rule.find) ?? 0} 次 < 最低 ${rule.minHits} —— ` +
        '源码品牌字面量可能已漂移，请核对 scripts/pack-context.mjs 规则表',
      )
    }
  }
  return hits
}

function main() {
  const files = packFileList()
  copyTree(files)
  const hits = transformTree()

  const r = spawnSync('npm', ['pack', '--json', '--pack-destination', OUT_DIR], {
    cwd: STAGING, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error(`staging npm pack 失败:\n${r.stderr}`)
  // npm ≥12 输出为按包名键的对象，旧版是数组（与上方 packFileList 同款归一化）
  const packed = JSON.parse(r.stdout)
  const tgzName = (Array.isArray(packed) ? packed[0] : packed[Object.keys(packed)[0]]).filename

  console.log(`[pack-context] 规则命中统计：`)
  for (const [find, n] of hits) if (n > 0) console.log(`  ${n}×  ${find}`)
  console.log(`[pack-context] 产物：${path.join(OUT_DIR, tgzName)}`)
  console.log(`[pack-context] 发布：npm publish ${path.join(OUT_DIR, tgzName)}`)
}

main()
