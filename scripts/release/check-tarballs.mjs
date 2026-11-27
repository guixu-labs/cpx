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
const artifactDir = path.resolve(root, process.argv[2] ?? 'release-artifacts')
const sourcePkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const expectedRepo = 'github.com/guixu-labs/cpx'

const packages = [
  {
    name: 'context-cpx',
    bins: { cpx: './bin/cpx.mjs' },
    required: [
      'package/bin/cpx.mjs',
      'package/src/cli/cpx-cli.ts',
      'package/src/server.ts',
      'package/src/version.ts',
      'package/scripts/postinstall.mjs',
      'package/LICENSE',
      'package/CHANGELOG.md',
    ],
  },
  {
    name: 'cannbot-proxy',
    bins: { cpx: './bin/cpx.mjs' },
    required: [
      'package/bin/cpx.mjs',
      'package/src/cli/cpx-cli.ts',
      'package/src/server.ts',
      'package/src/version.ts',
      'package/scripts/postinstall.mjs',
      'package/LICENSE',
      'package/CHANGELOG.md',
    ],
  },
]

const forbidden = [
  { label: 'tests', re: /(^|\/)tests\// },
  { label: 'node_modules', re: /(^|\/)node_modules\// },
  { label: 'environment file', re: /(^|\/)\.env(?:$|\.)/ },
  { label: 'release artifacts', re: /(^|\/)release-artifacts\// },
  { label: 'cannbot staging', re: /(^|\/)\.cannbot-pack\// },
  { label: 'GitHub metadata', re: /(^|\/)\.github\// },
  { label: 'release scripts', re: /(^|\/)scripts\/release\// },
  { label: 'pack-cannbot script', re: /(^|\/)scripts\/pack-cannbot\.mjs$/ },
  { label: 'repo test runner', re: /(^|\/)scripts\/run-tests\.sh$/ },
  { label: 'repo wrapper', re: /(^|\/)cpx-cli$/ },
  { label: 'installer', re: /(^|\/)install\.sh$/ },
  { label: 'lockfile', re: /(^|\/)package-lock\.json$/ },
]

function artifactFor(name) {
  const matches = fs.readdirSync(artifactDir)
    .filter((file) => file === `${name}-${sourcePkg.version}.tgz`)
  if (matches.length !== 1) throw new Error(`expected one ${name} artifact, found ${matches.length}`)
  return path.join(artifactDir, matches[0])
}

function tarList(file) {
  const result = spawnSync('tar', ['-tzf', file], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`tar -tzf failed for ${file}: ${result.stderr}`)
  return result.stdout.split('\n').filter(Boolean)
}

function tarFile(file, entry) {
  const result = spawnSync('tar', ['-xOf', file, entry], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`tar -xOf failed for ${file}:${entry}: ${result.stderr}`)
  return result.stdout
}

const errors = []
let expectedVersion = null

for (const spec of packages) {
  const artifact = artifactFor(spec.name)
  const files = tarList(artifact)
  for (const rule of forbidden) {
    const leaked = files.filter((file) => rule.re.test(file))
    if (leaked.length > 0) errors.push(`${spec.name}: ${rule.label} leaked: ${leaked.join(', ')}`)
  }
  for (const required of spec.required) {
    if (!files.includes(required)) errors.push(`${spec.name}: missing ${required}`)
  }

  let manifest
  try {
    manifest = JSON.parse(tarFile(artifact, 'package/package.json'))
  } catch (error) {
    errors.push(`${spec.name}: unreadable package.json: ${error instanceof Error ? error.message : error}`)
    continue
  }

  if (manifest.name !== spec.name) errors.push(`${spec.name}: package name is ${manifest.name}`)
  if (manifest.version !== sourcePkg.version) {
    errors.push(`${spec.name}: version ${manifest.version} != source ${sourcePkg.version}`)
  }
  if (expectedVersion === null) expectedVersion = manifest.version
  if (manifest.version !== expectedVersion) errors.push(`${spec.name}: version ${manifest.version} != ${expectedVersion}`)
  if (manifest.private !== undefined) errors.push(`${spec.name}: private must be absent`)
  if (manifest.engines?.node !== sourcePkg.engines?.node) errors.push(`${spec.name}: engines.node mismatch`)
  if (manifest.scripts?.postinstall !== 'node scripts/postinstall.mjs') {
    errors.push(`${spec.name}: postinstall script mismatch`)
  }
  const actualBins = manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)
    ? manifest.bin
    : {}
  const expectedBinEntries = Object.entries(spec.bins)
  if (Object.keys(actualBins).length !== expectedBinEntries.length ||
      !expectedBinEntries.every(([name, target]) => actualBins[name] === target)) {
    errors.push(`${spec.name}: bin mismatch: ${JSON.stringify(manifest.bin)}`)
  }
  if (!String(manifest.repository?.url ?? '').includes(expectedRepo)) {
    errors.push(`${spec.name}: repository does not reference ${expectedRepo}`)
  }
  if (manifest.homepage !== sourcePkg.homepage) errors.push(`${spec.name}: homepage mismatch`)
  if (manifest.bugs?.url !== sourcePkg.bugs?.url) errors.push(`${spec.name}: bugs.url mismatch`)
  if (manifest.publishConfig?.access !== 'public') errors.push(`${spec.name}: publishConfig.access must be public`)

  console.log(`[release-check] ${spec.name}@${manifest.version}: ${files.length} files`)
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[release-check] ${error}`)
  process.exit(1)
}
