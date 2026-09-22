// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the License).
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// context 品牌变体发布链路 IT：pack-context.mjs 打包 → 解包 → 品牌切换断言 +
// 格式契约保留断言 + 品牌泄漏哨兵（源码品牌字面量漂移会让打包期 minHits 先炸，
// 这里兜底扫产物，双保险）。cpx 无构建步骤（源码直发），静态断言即运行时断言。

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

describe('context 品牌变体打包（pack-context.mjs）', () => {
  beforeAll(() => {
    const r = spawnSync(process.execPath, ['scripts/pack-context.mjs'], {
      cwd: PKG_DIR, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
    })
    expect(r.status, `pack-context.mjs 失败:\n${r.stderr}`).toBe(0)

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-cpx-'))
    const tgz = fs.readdirSync(path.join(PKG_DIR, '.context-pack')).find((f) => f.endsWith('.tgz'))
    expect(tgz, '产物 tgz 缺失').toBeTruthy()
    expect(tgz!.startsWith('context-cpx-')).toBe(true)
    const t = spawnSync('tar', ['-xzf', path.join(PKG_DIR, '.context-pack', tgz!), '-C', tmpRoot], {
      encoding: 'utf8', timeout: 60_000,
    })
    expect(t.status, t.stderr).toBe(0)
    extracted = path.join(tmpRoot, 'package')
  }, 180_000)

  afterAll(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* tmp 目录留置无害 */ }
  })

  it('package.json：包名 context-cpx / bin 保持 cpx / 描述切换', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.name).toBe('context-cpx')
    expect(pkg.bin).toEqual({ cpx: './bin/cpx.mjs' })
    expect(pkg.description).toContain('Context-Insight')
  })

  it('捕获与缓存目录默认值翻转（与 context-insight 数据目录配对）', () => {
    expect(read('src/writer.ts')).toContain("'.context-insight'")
    expect(read('src/cli/cpx-upload.ts')).toContain("'.context-insight'")
    expect(read('src/cannbay/remote.ts')).toContain("'.context-insight'")
  })

  it('品牌泄漏哨兵：显示名 / Bay 名（大小写两种形态）/ 数据目录路径零残留', () => {
    const leaks = scanForbidden(extracted, ['CANNBot-Insight', 'CANNbay', 'CANNBay', '[cbi]', '.cannbot-insight'])
    expect(leaks, `品牌泄漏:\n${leaks.join('\n')}`).toEqual([])
  })

  it('格式契约保留：x_cannbay 命名空间 / CANNBOT_PROXY_DIR 环境变量', () => {
    expect(read('src/claude-emitter.ts')).toContain('x_cannbay')
    expect(read('src/writer.ts')).toContain('CANNBOT_PROXY_DIR')
    expect(read('README.md')).toContain('CANNBAY2_LFS')
  })
})
