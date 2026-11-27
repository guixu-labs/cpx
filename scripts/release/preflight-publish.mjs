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
const registry = 'https://registry.npmjs.org/'
const packageNames = ['context-cpx', 'cannbot-proxy']

function usage() {
  console.error('Usage: node scripts/release/preflight-publish.mjs --tag vX.Y.Z --confirm X.Y.Z [--mode dry-run|publish] [--dist-tag beta|latest]')
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv.includes('--help')) {
  usage()
  process.exit(0)
}

const tag = readArg('--tag')
const confirmVersion = readArg('--confirm')
const distTag = readArg('--dist-tag') ?? 'beta'
const mode = readArg('--mode') ?? 'dry-run'
if (!['beta', 'latest'].includes(distTag) || !['dry-run', 'publish'].includes(mode)) {
  usage()
  process.exit(2)
}
if (!tag || !confirmVersion) {
  usage()
  process.exit(2)
}

function fail(message) {
  throw new Error(message)
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    fail(`${command} ${args.join(' ')} failed with exit ${result.status}${detail ? `\n${detail}` : ''}`)
  }
  return result.stdout.trim()
}

function tryRun(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  })
}

function parseSemver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  }
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1
    if (right[index] === undefined) return 1
    const leftNumber = /^\d+$/.test(left[index])
    const rightNumber = /^\d+$/.test(right[index])
    if (leftNumber && rightNumber) {
      const diff = Number(left[index]) - Number(right[index])
      if (diff !== 0) return diff > 0 ? 1 : -1
      continue
    }
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1
  }
  return 0
}

function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) fail(`invalid semver comparison: ${left} vs ${right}`)
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

const sourcePackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const versionSource = fs.readFileSync(path.join(root, 'src/version.ts'), 'utf8')
const displayVersion = /export const VERSION = "([^"]+)"/.exec(versionSource)?.[1]
const version = sourcePackage.version

if (!parseSemver(version)) fail(`package.json version is not semver: ${version}`)
if (displayVersion !== version) fail(`version mismatch: package.json=${version} version.ts=${displayVersion ?? 'missing'}`)
if (tag !== `v${version}`) fail(`tag ${tag} does not match package version v${version}`)
if (confirmVersion !== version) fail(`confirm version ${confirmVersion} does not match package version ${version}`)

const head = run('git', ['rev-parse', 'HEAD'])
const tagCommit = run('git', ['rev-parse', `refs/tags/${tag}^{commit}`])
if (tagCommit !== head) fail(`tag ${tag} resolves to ${tagCommit}, but checked out HEAD is ${head}`)
const ancestor = tryRun('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'])
if (ancestor.status !== 0) fail(`tag ${tag} commit is not contained in origin/main`)

const errors = []
const states = {}
for (const name of packageNames) {
  const tagsResult = tryRun('npm', ['view', name, 'dist-tags', '--json', '--registry', registry])
  if (tagsResult.status !== 0) fail(`cannot read npm dist-tags for ${name}: ${tagsResult.stderr || tagsResult.stdout}`)
  const distTags = JSON.parse(tagsResult.stdout)
  const exactResult = tryRun('npm', ['view', `${name}@${version}`, 'version', '--json', '--registry', registry])
  const exactExists = exactResult.status === 0

  states[name] = {
    latest: distTags.latest ?? null,
    beta: distTags.beta ?? null,
    exactExists,
  }

  if (mode === 'publish') {
    if (exactExists) errors.push(`${name}@${version} already exists on npm`)
    if (distTags.latest && compareSemver(version, distTags.latest) <= 0) {
      errors.push(`${name} version ${version} is not newer than latest ${distTags.latest}`)
    }
    if (distTag === 'beta' && distTags.beta && compareSemver(version, distTags.beta) < 0) {
      errors.push(`${name} version ${version} is lower than beta ${distTags.beta}`)
    }
  }
}

for (const name of packageNames) {
  const state = states[name]
  console.log(`[release-preflight] ${name}: latest=${state.latest ?? '(none)'} beta=${state.beta ?? '(none)'} exact=${state.exactExists ? 'exists' : 'absent'}`)
}
if (mode === 'dry-run') {
  console.log('[release-preflight] dry-run: registry conflicts are reported but do not block')
} else if (errors.length > 0) {
  for (const error of errors) console.error(`[release-preflight] ${error}`)
  process.exit(1)
}
console.log(`[release-preflight] ${mode}: ${tag} / ${version} / ${distTag} OK`)
