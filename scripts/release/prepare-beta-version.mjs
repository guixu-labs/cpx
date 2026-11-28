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

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const root = path.resolve(readArg('--root') ?? defaultRoot)
const packagePath = path.join(root, 'package.json')
const packageLockPath = path.join(root, 'package-lock.json')
const versionPath = path.join(root, 'src/version.ts')
const packageNames = ['context-cpx', 'cannbot-proxy']
const registry = 'https://registry.npmjs.org/'

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function usage() {
  console.error('Usage: node scripts/release/prepare-beta-version.mjs [--version X.Y.Z-beta.yyyyMMdd.run.attempt] [--root DIR] [--print]')
}

if (process.argv.includes('--help')) {
  usage()
  process.exit(0)
}

const explicitVersion = readArg('--version')
const printOnly = process.argv.includes('--print')
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))

function fail(message) {
  throw new Error(message)
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (!match) fail(`invalid package version: ${version}`)
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? '',
  }
}

function compareCore(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1
  }
  return 0
}

function npmDistTags(name) {
  const result = spawnSync('npm', ['view', name, 'dist-tags', '--json', '--registry', registry], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    fail(`cannot resolve npm dist-tags for ${name}: ${result.error?.message ?? result.stderr ?? result.stdout}`)
  }
  return JSON.parse(result.stdout)
}

function nextBetaVersion(packageVersion) {
  const packageParsed = parseVersion(packageVersion)
  const candidates = Object.values(npmDistTags(packageNames[0]))
  for (const name of packageNames.slice(1)) candidates.push(...Object.values(npmDistTags(name)))
  const parsedCandidates = candidates.map(parseVersion)
  const highestCore = parsedCandidates
    .map((candidate) => candidate.core)
    .sort(compareCore)
    .at(-1)
  const stableAtHighestCore = parsedCandidates.some(
    (candidate) => compareCore(candidate.core, highestCore) === 0 && !candidate.prerelease,
  )
  const packageAhead = compareCore(packageParsed.core, highestCore) > 0
  const [major, minor, patch] = packageAhead
    ? packageParsed.core
    : stableAtHighestCore
      ? [highestCore[0], highestCore[1], highestCore[2] + 1]
      : highestCore
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const run = process.env.GITHUB_RUN_NUMBER || String(Date.now())
  const attempt = process.env.GITHUB_RUN_ATTEMPT || '1'
  return `${major}.${minor}.${patch}-beta.${date}.${run}.${attempt}`
}

const version = explicitVersion ?? nextBetaVersion(pkg.version)
const parsed = parseVersion(version)
if (!parsed.prerelease.startsWith('beta.')) {
  fail(`beta version must contain a beta prerelease suffix: ${version}`)
}

if (!printOnly) {
  pkg.version = version
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)

  if (fs.existsSync(packageLockPath)) {
    const lock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'))
    lock.version = version
    if (lock.packages?.['']) lock.packages[''].version = version
    fs.writeFileSync(packageLockPath, `${JSON.stringify(lock, null, 2)}\n`)
  }

  const source = fs.readFileSync(versionPath, 'utf8')
  const updated = source.replace(/export const VERSION = "[^"]+"/, `export const VERSION = "${version}"`)
  if (updated === source) fail('could not update VERSION in src/version.ts')
  fs.writeFileSync(versionPath, updated)
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
}

console.log(version)
