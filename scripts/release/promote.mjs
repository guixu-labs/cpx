// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { spawnSync } from 'node:child_process'

const registry = 'https://registry.npmjs.org/'
const packageNames = ['context-cpx', 'cannbot-proxy']
const legacyTags = ['next', 'dev']

function usage() {
  console.error('Usage: node scripts/release/promote.mjs --version X.Y.Z --confirm X.Y.Z [--prune-legacy true|false]')
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv.includes('--help')) {
  usage()
  process.exit(0)
}

const version = readArg('--version')
const confirmVersion = readArg('--confirm')
const pruneLegacy = readArg('--prune-legacy') !== 'false'
if (!version || !confirmVersion || version !== confirmVersion) {
  usage()
  process.exit(2)
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`[release-promote] latest promotion requires a stable version: ${version}`)
  process.exit(2)
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    console.error(`[release-promote] ${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`)
    process.exit(1)
  }
  return result.stdout.trim()
}

function distTagsOf(name) {
  const output = run('npm', ['view', name, 'dist-tags', '--json', '--registry', registry])
  return JSON.parse(output)
}

const packageStates = packageNames.map((name) => {
  const tags = distTagsOf(name)
  const published = Object.entries(tags).some(([, value]) => value === version)
  return { name, tags, published }
})

const missing = packageStates.filter(({ published }) => !published)
if (missing.length > 0) {
  for (const { name } of missing) {
    console.error(`[release-promote] ${name}@${version} is not published yet (no dist-tag points at it)`)
  }
  process.exit(1)
}

for (const { name, tags } of packageStates) {
  if (tags.latest === version) {
    console.log(`[release-promote] ${name}: latest already points at ${version} (idempotent)`)
  } else {
    run('npm', ['dist-tag', 'add', `${name}@${version}`, 'latest', '--registry', registry])
    console.log(`[release-promote] ${name}: latest -> ${version}`)
  }
  if (pruneLegacy) {
    for (const legacy of legacyTags) {
      if (tags[legacy] !== undefined) {
        run('npm', ['dist-tag', 'rm', name, legacy, '--registry', registry])
        console.log(`[release-promote] ${name}: removed legacy dist-tag "${legacy}" (was ${tags[legacy]})`)
      }
    }
  }
}

console.log(`[release-promote] promote ${version} to latest OK`)
