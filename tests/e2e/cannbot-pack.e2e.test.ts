// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cannbot 品牌变体发布链路 IT：pack-cannbot.mjs 打包 → 解包 → 品牌切换断言 +
// 格式契约保留断言 + 品牌泄漏哨兵（源码品牌字面量漂移会让打包期 minHits 先炸，
// 这里兜底扫产物，双保险）。cpx 无构建步骤（源码直发），静态断言即运行时断言。
// 源码仓即 context 主体，变体只翻品牌面。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.mdx', '.py',
  '.css', '.scss', '.html', '.txt', '.sh', '.yml', '.yaml', '.sql',
  '.prisma', '.xml', '.svg', '.example',
])

let extracted = ''
let tmpRoot = ''

function read(rel: string): string {
  return fs.readFileSync(path.join(extracted, rel), 'utf8')
}

// context 主品牌字面量，cannbot 变体产物里禁止出现（品牌泄漏）。
// 裸小写 "context-insight" 不在列——文档层的包名引用由 MD 规则翻转，
// wire 契约（x_lake / framework 值）不受影响。
const FORBIDDEN: string[] = [
  'Context-Insight',
  'contextBay',
  '.context-insight',
  'CONTEXT_',
  'context-cpx',
  'context-insight :',
  'context-insight UI',
]

function scanForbidden(root: string, forbidden: string[]): string[] {
  const leaks: string[] = []
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules') continue
      const full = path.join(dir, name)
      if (fs.statSync(full).isDirectory()) { walk(full); continue }
      if (!TEXT_EXTS.has(path.extname(name))) continue
      const text = fs.readFileSync(full, 'utf8')
      for (const bad of forbidden) {
        if (text.includes(bad)) leaks.push(`${path.relative(root, full)}: ${bad}`)
      }
    }
  }
  walk(root)
  return leaks
}

describe('cannbot 品牌变体打包（pack-cannbot.mjs）', () => {
  beforeAll(() => {
    const r = spawnSync(process.execPath, ['scripts/pack-cannbot.mjs'], {
      cwd: PKG_DIR, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
    })
    expect(r.status, `pack-cannbot.mjs 失败:\n${r.stderr}`).toBe(0)

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cbot-cpx-'))
    const tgz = fs.readdirSync(path.join(PKG_DIR, '.cannbot-pack')).find((f) => f.endsWith('.tgz'))
    expect(tgz, '产物 tgz 缺失').toBeTruthy()
    expect(tgz!.startsWith('cannbot-proxy-')).toBe(true)
    const t = spawnSync('tar', ['-xzf', path.join(PKG_DIR, '.cannbot-pack', tgz!), '-C', tmpRoot], {
      encoding: 'utf8', timeout: 60_000,
    })
    expect(t.status, t.stderr).toBe(0)
    extracted = path.join(tmpRoot, 'package')
  }, 180_000)

  afterAll(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* tmp 目录留置无害 */ }
  })

  it('package.json：包名 cannbot-proxy / bin 保持 cpx / 描述切换', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.name).toBe('cannbot-proxy')
    expect(pkg.bin).toEqual({ cpx: './bin/cpx.mjs' })
    expect(pkg.description).toContain('CANNBot-Insight')
  })

  it('捕获与缓存目录默认值翻转（与 cannbot-insight 数据目录配对）', () => {
    expect(read('src/writer.ts')).toContain("'.cannbot-insight'")
    expect(read('src/cli/cpx-cli.ts')).toContain("'.cannbot-insight'")
    expect(read('src/cli/cpx-complete.ts')).toContain("'.cannbot-insight'")
  })

  it('品牌泄漏哨兵：显示名 / Bay 名 / 数据目录 / env 前缀 / 包名自指零残留', () => {
    const leaks = scanForbidden(extracted, FORBIDDEN)
    expect(leaks, `品牌泄漏:\n${leaks.join('\n')}`).toEqual([])
  })

  it('格式契约保留：x_lake 命名空间 / cannbot agent 族 / env·目录品牌还原', () => {
    // wire 契约与 agent 能力面：变体不翻
    expect(read('src/claude-emitter.ts')).toContain('x_lake')
    expect(read('src/opencode-emitter.ts')).toContain("framework: 'cannbot'")
    expect(read('src/opencode-emitter.ts')).toContain("marker: 'cannbot-proxy'")
    // 品牌面还原：老用户的 env / 目录习惯延续
    expect(read('src/writer.ts')).toContain('CANNBOT_PROXY_DIR')
  })
})
