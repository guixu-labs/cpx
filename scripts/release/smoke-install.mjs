// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const artifactDir = path.resolve(root, process.argv[2] ?? 'release-artifacts')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const packages = ['context-cpx', 'cannbot-proxy']

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 300_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}\n${detail}`)
  }
  return result
}

function smoke(name) {
  const artifact = path.join(artifactDir, `${name}-${pkg.version}.tgz`)
  if (!fs.existsSync(artifact)) throw new Error(`missing artifact: ${artifact}`)

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-smoke-`))
  const prefix = path.join(temp, 'prefix')
  const home = path.join(temp, 'home')
  const cache = path.join(temp, 'npm-cache')
  fs.mkdirSync(prefix, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cache, { recursive: true })

  const env = {
    ...process.env,
    HOME: home,
    SHELL: '/bin/bash',
    npm_config_audit: 'false',
    npm_config_cache: cache,
    npm_config_fund: 'false',
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_update_notifier: 'false',
    CONTEXT_NO_BROWSER: '1',
  }

  try {
    run('npm', ['install', '--global', '--prefix', prefix, artifact, '--no-audit', '--no-fund', '--no-package-lock', '--prefer-offline'], { cwd: temp, env })
    const executable = path.join(prefix, 'bin', process.platform === 'win32' ? 'cpx.cmd' : 'cpx')
    const output = run(executable, ['--version'], { cwd: temp, env, timeout: 60_000 }).stdout.trim()
    if (!output.includes(`cpx v${pkg.version}`)) {
      throw new Error(`cpx --version output ${JSON.stringify(output)} must contain cpx v${pkg.version}`)
    }
    console.log(`[release-smoke] ${name}@${pkg.version}: cpx OK`)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

for (const name of packages) smoke(name)
