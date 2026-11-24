/**
 * `doctor` — the relay self-check kind (BUILD.md §2, RELAY.md §7).
 *
 * No target repository is touched. The result package carries
 * `payload/doctor.json`: relay/schema versions, runtime versions, and one check
 * row per prerequisite. The APP reads it to decide "该替身能不能干活".
 */

import fs from 'node:fs'
import path from 'node:path'
import { MANIFEST_SCHEMA, RELAY_VERSION } from '../version.mjs'
import { openSealedText } from '../crypto.mjs'
import { tarVersion } from '../archive.mjs'
import { RelayError } from '../log.mjs'
import * as git from '../git.mjs'

export const name = 'doctor'

function nodeMajor(version) {
  const match = String(version || '').match(/^v?(\d+)/)
  return match ? Number(match[1]) : 0
}

export async function run(ctx) {
  const manifest = ctx.manifest
  const checks = []

  const nodeVersion = process.versions.node
  checks.push({
    name: 'node',
    ok: nodeMajor(nodeVersion) >= 20,
    detail: nodeVersion
  })

  let gitVersionText = null
  try {
    gitVersionText = await git.gitVersion()
    checks.push({ name: 'git', ok: true, detail: gitVersionText })
  } catch {
    checks.push({ name: 'git', ok: false, detail: 'git is not available' })
  }

  let tarVersionText = null
  try {
    tarVersionText = await tarVersion()
    checks.push({ name: 'tar', ok: true, detail: tarVersionText })
  } catch {
    checks.push({ name: 'tar', ok: false, detail: 'tar is not available' })
  }

  let keyOk = false
  try {
    if (typeof manifest.od?.token === 'string' && manifest.od.token.length > 0) {
      const plaintext = openSealedText(ctx.keyBase64, manifest.od.token)
      ctx.log.addSecret(plaintext)
      keyOk = true
      checks.push({ name: 'yic_key', ok: true, detail: 'sealed token opened' })
    } else {
      checks.push({ name: 'yic_key', ok: false, detail: 'manifest has no sealed token' })
    }
  } catch (error) {
    checks.push({ name: 'yic_key', ok: false, detail: `sealed token could not be opened (${error?.errorClass || 'internal'})` })
  }

  const schemaOk = manifest.schema === MANIFEST_SCHEMA
  checks.push({
    name: 'schema',
    ok: schemaOk,
    detail: `manifest schema ${String(manifest.schema)} (supported ${MANIFEST_SCHEMA})`
  })

  const report = {
    relay_version: RELAY_VERSION,
    manifest_schema: MANIFEST_SCHEMA,
    node: nodeVersion,
    git: gitVersionText,
    checks
  }
  const reportPath = path.join(ctx.payloadDir, 'doctor.json')
  fs.mkdirSync(ctx.payloadDir, { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (!keyOk) throw new RelayError('internal', 'YIC_KEY could not open the sealed token')
  // `ok` only gates the status.json flag; the report itself always travels in
  // the package so the APP can show which check failed.
  return { sha: null, bytes: fs.statSync(reportPath).size, ok: checks.every((check) => check.ok) }
}
