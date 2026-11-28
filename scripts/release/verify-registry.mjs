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
const requestedRegistry = readArg('--registry')
const registry = requestedRegistry ? `${requestedRegistry.replace(/\/+$/, '')}/` : 'https://registry.npmjs.org/'
const usage = 'Usage: node scripts/release/verify-registry.mjs --tag beta|latest|next|dev --version X.Y.Z [--wait-seconds N] [--poll-seconds N] [--registry URL]'

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv.includes('--help')) {
  console.error(usage)
  process.exit(0)
}

const tag = readArg('--tag')
const version = readArg('--version')
if (!tag || !version) {
  console.error(usage)
  process.exit(2)
}

const waitSeconds = Number(readArg('--wait-seconds') ?? '0')
const pollSeconds = Number(readArg('--poll-seconds') ?? '15')
if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || !Number.isFinite(pollSeconds) || pollSeconds <= 0) {
  console.error(usage)
  process.exit(2)
}

const packages = [
  { name: 'context-cpx', command: 'cpx' },
  { name: 'cannbot-proxy', command: 'cpx' },
]

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function fetchDistTags(name, timeoutMs) {
  const url = `${registry}-/package/${encodeURIComponent(name)}/dist-tags?t=${Date.now()}`
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    },
  })
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`)
  return response.json()
}

async function waitForTag(deadline) {
  let attempt = 0
  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(`registry tag ${tag} did not reach ${version} within ${waitSeconds}s`)
    }
    attempt += 1
    const states = {}
    const pending = []
    for (const spec of packages) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        states[spec.name] = states[spec.name] ?? '(deadline reached)'
        pending.push(spec.name)
        break
      }
      try {
        const distTags = await fetchDistTags(spec.name, Math.max(1, Math.min(30_000, remainingMs)))
        states[spec.name] = distTags[tag] ?? '(missing)'
        if (distTags[tag] !== version) pending.push(spec.name)
      } catch (error) {
        states[spec.name] = `error: ${error instanceof Error ? error.message : String(error)}`
        pending.push(spec.name)
      }
    }
    if (pending.length === 0) {
      console.log(`[registry-wait] ${tag} points to ${version} for ${packages.map((spec) => spec.name).join(', ')}`)
      return
    }

    const state = packages.map((spec) => `${spec.name}=${states[spec.name]}`).join(', ')
    console.log(`[registry-wait] attempt ${attempt}: ${state}`)
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw new Error(`registry tag ${tag} did not reach ${version} within ${waitSeconds}s: ${state}`)
    await sleep(Math.min(pollSeconds * 1000, remainingMs))
  }
}

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

function tryRun(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 300_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
}

function failureDetail(command, args, result) {
  const detail = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').trim()
  return `${command} ${args.join(' ')} failed with exit ${result.status ?? 'spawn-error'}${detail ? `\n${detail}` : ''}`
}

async function installWithRetry(spec, temp, prefix, env, deadline) {
  const args = ['install', '--global', '--prefix', prefix, `${spec.name}@${tag}`, '--no-audit', '--no-fund', '--no-package-lock', '--prefer-online']
  let attempt = 0
  while (true) {
    attempt += 1
    const remainingMs = deadline - Date.now()
    const timeout = waitSeconds > 0 ? Math.max(1, Math.min(300_000, remainingMs)) : 300_000
    const result = tryRun('npm', args, { cwd: temp, env, timeout })
    if (!result.error && result.status === 0) return

    const failure = failureDetail('npm', args, result)
    const retryBudget = deadline - Date.now()
    if (waitSeconds === 0 || retryBudget <= 0) throw new Error(failure)
    const delay = Math.min(pollSeconds * 1000, retryBudget)
    console.log(`[registry-install] attempt ${attempt}: ${spec.name}@${tag} not installable yet; retrying in ${Math.ceil(delay / 1000)}s`)
    await sleep(delay)
  }
}

const deadline = Date.now() + waitSeconds * 1000
if (waitSeconds > 0) await waitForTag(deadline)

for (const spec of packages) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `${spec.name}-registry-smoke-`))
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
    npm_config_prefer_online: 'true',
    npm_config_registry: registry,
    npm_config_update_notifier: 'false',
    CONTEXT_NO_BROWSER: '1',
  }

  try {
    await installWithRetry(spec, temp, prefix, env, deadline)
    const executable = path.join(prefix, 'bin', process.platform === 'win32' ? `${spec.command}.cmd` : spec.command)
    const output = run(executable, ['--version'], { cwd: temp, env, timeout: 60_000 }).stdout.trim()
    if (!output.includes(`cpx v${version}`)) {
      throw new Error(`${spec.command} --version output ${JSON.stringify(output)} must contain cpx v${version}`)
    }
    console.log(`[registry-smoke] ${spec.name}@${tag} (${version}): ${spec.command} OK`)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
