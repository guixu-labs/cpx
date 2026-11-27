// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const outDir = path.resolve(root, process.argv[2] ?? 'release-artifacts')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', timeout: 300_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`)
}

fs.mkdirSync(outDir, { recursive: true })
for (const name of fs.readdirSync(outDir)) {
  if (name.endsWith('.tgz')) fs.rmSync(path.join(outDir, name))
}

run('npm', ['pack', '--pack-destination', outDir])
run(process.execPath, ['scripts/pack-cannbot.mjs'])

const source = path.join(root, '.cannbot-pack', `cannbot-proxy-${pkg.version}.tgz`)
const target = path.join(outDir, path.basename(source))
if (!fs.existsSync(source)) throw new Error(`missing cannbot artifact: ${source}`)
fs.copyFileSync(source, target)

for (const name of [`context-cpx-${pkg.version}.tgz`, `cannbot-proxy-${pkg.version}.tgz`]) {
  const artifact = path.join(outDir, name)
  if (!fs.existsSync(artifact)) throw new Error(`missing release artifact: ${artifact}`)
  console.log(`[release] ${artifact}`)
}
