#!/usr/bin/env node
/**
 * Relay entry point (OPERATIONS.md §2/§3, IMPLEMENTATION.md P4).
 *
 * One `workflow_dispatch` input carries the complete task manifest as JSON;
 * `YIC_KEY` is the relay repo's single long-lived secret. This file:
 *
 *  1. parses/validates YIC_TASK and rejects unknown schema/kind explicitly,
 *  2. unpacks the uplink task package when there is one (hash + inner manifest),
 *  3. dispatches to one of the five kinds,
 *  4. writes one downlink result package (`status.json` + `log.txt` + payload),
 *  5. keeps stdout restricted to txn/kind/bytes/elapsed/error_class.
 *
 * OD direction rule (D36/D60): uplink kinds never write OD (success or
 * failure); downlink kinds write exactly one result package, including their
 * failure path. A failed result-package upload means no package at all.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { MANIFEST_SCHEMA } from './version.mjs'
import { RelayError, classifyError, createLogger, redact } from './log.mjs'
import { createOdClient } from './od.mjs'
import { createTar, extractTar } from './archive.mjs'
import { openSealedText, secretFromPlaintext } from './crypto.mjs'

import * as pushKind from './kinds/push.mjs'
import * as fetchKind from './kinds/fetch.mjs'
import * as snapshotKind from './kinds/snapshot.mjs'
import * as exportKind from './kinds/export.mjs'
import * as doctorKind from './kinds/doctor.mjs'
import * as downloadKind from './kinds/download.mjs'

const KIND_MODULES = Object.freeze({
  push: pushKind,
  fetch: fetchKind,
  snapshot: snapshotKind,
  export: exportKind,
  doctor: doctorKind,
  download: downloadKind
})

export const UPLINK_KINDS = Object.freeze(new Set(['push', 'snapshot']))
export const DOWNLINK_KINDS = Object.freeze(new Set(['fetch', 'export', 'doctor', 'download']))
export const KNOWN_KINDS = Object.freeze(new Set([...UPLINK_KINDS, ...DOWNLINK_KINDS]))

const TXN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** OD paths are AppFolder-relative; never absolute, never traverse upward. */
export function isSafeRelativeOdPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) return false
  const parts = value.split('/')
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function isoNow() {
  return new Date().toISOString()
}

function assertTarget(manifest) {
  if (!isPlainObject(manifest.target)) return new RelayError('internal', 'task manifest has no target')
  if (typeof manifest.target.url !== 'string' || manifest.target.url.length === 0) {
    return new RelayError('internal', 'task manifest target has no url')
  }
  if (typeof manifest.target.ref !== 'string' || !manifest.target.ref.startsWith('refs/')) {
    return new RelayError('internal', 'task manifest target has no full ref')
  }
  return null
}

/**
 * Structural validation of one YIC_TASK manifest. Returns a RelayError or null.
 * Schema and kind are checked first so an out-of-date relay refuses cleanly
 * instead of half-running a task it does not understand (OPERATIONS.md §9).
 */
export function preflight(manifest) {
  if (!isPlainObject(manifest)) return new RelayError('internal', 'task manifest must be a JSON object')
  if (typeof manifest.schema !== 'number' || !Number.isInteger(manifest.schema)) {
    return new RelayError('internal', 'task manifest has no integer schema')
  }
  if (manifest.schema !== MANIFEST_SCHEMA) {
    return new RelayError('unsupported_schema', 'task manifest schema is not supported by this relay')
  }
  if (typeof manifest.txn !== 'string' || !TXN_RE.test(manifest.txn)) {
    return new RelayError('internal', 'task manifest has an invalid txn')
  }
  if (typeof manifest.kind !== 'string') return new RelayError('internal', 'task manifest has no kind')
  if (!KNOWN_KINDS.has(manifest.kind)) {
    return new RelayError('unsupported_kind', 'task kind is not supported by this relay')
  }
  if (!isPlainObject(manifest.od)) return new RelayError('internal', 'task manifest has no od section')
  if (typeof manifest.od.token !== 'string' || manifest.od.token.length === 0) {
    return new RelayError('internal', 'task manifest has no sealed OneDrive token')
  }
  if (manifest.credential !== null && manifest.credential !== undefined && typeof manifest.credential !== 'string') {
    return new RelayError('internal', 'task manifest credential must be sealed or null')
  }
  if (manifest.options !== undefined && manifest.options !== null && !isPlainObject(manifest.options)) {
    return new RelayError('internal', 'task manifest options must be an object')
  }
  if (manifest.base !== null && manifest.base !== undefined && typeof manifest.base !== 'string') {
    return new RelayError('internal', 'task manifest base must be a sha or null')
  }
  if (manifest.depth !== null && manifest.depth !== undefined) {
    if (!Number.isInteger(manifest.depth) || manifest.depth < 1) {
      return new RelayError('internal', 'task manifest depth must be a positive integer or null')
    }
  }

  if (UPLINK_KINDS.has(manifest.kind)) {
    const targetError = assertTarget(manifest)
    if (targetError) return targetError
    if (typeof manifest.od.in !== 'string' || !isSafeRelativeOdPath(manifest.od.in)) {
      return new RelayError('internal', 'task manifest has no valid od.in path')
    }
    if (manifest.od.in !== `in/${manifest.txn}.tar`) {
      return new RelayError('internal', 'task manifest od.in does not match the task id')
    }
    if (!isPlainObject(manifest.package)) {
      return new RelayError('internal', 'uplink task manifest has no package fingerprint')
    }
    if (typeof manifest.package.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(manifest.package.sha256)) {
      return new RelayError('internal', 'task manifest package.sha256 is invalid')
    }
    if (manifest.package.size !== undefined && manifest.package.size !== null) {
      if (typeof manifest.package.size !== 'number' || !Number.isFinite(manifest.package.size) || manifest.package.size < 0) {
        return new RelayError('internal', 'task manifest package.size is invalid')
      }
    }
  } else {
    if (typeof manifest.od.out !== 'string' || !isSafeRelativeOdPath(manifest.od.out)) {
      return new RelayError('internal', 'task manifest has no valid od.out path')
    }
    if (manifest.od.out !== `out/${manifest.txn}.tar`) {
      return new RelayError('internal', 'task manifest od.out does not match the task id')
    }
    if (manifest.kind !== 'doctor' && manifest.kind !== 'download') {
      const targetError = assertTarget(manifest)
      if (targetError) return targetError
    }
  }
  return null
}

function buildStatus({ manifest, ok, phase, error, sha = null, bytes = null, startedAt, redactor = (text) => redact(text, []) }) {
  const txn = typeof manifest?.txn === 'string' && manifest.txn.length > 0 ? manifest.txn : 'unknown'
  let message = null
  if (error) {
    const raw = [error?.message, error?.stderr].filter((part) => typeof part === 'string' && part.length > 0).join('\n')
    const firstLine = raw.split(/\r?\n/).find((line) => line.trim().length > 0) || 'relay failed'
    message = redactor(firstLine).slice(0, 1000)
  }
  return {
    txn,
    ok,
    phase,
    error_class: error ? classifyError(error) : null,
    message,
    sha: typeof sha === 'string' && sha.length > 0 ? sha : null,
    bytes: typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : null,
    started_at: startedAt,
    finished_at: isoNow()
  }
}

/** Write status.json + log.txt (+ payload/ when successful) into one tar. */
async function writeResultPackage({ dir, tarPath, status, log, payloadDir = null }) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'log.txt'), log.text(), 'utf8')
  if (payloadDir && fs.existsSync(payloadDir)) {
    fs.cpSync(payloadDir, path.join(dir, 'payload'), { recursive: true })
  }
  await createTar(tarPath, dir, ['.'])
  return tarPath
}

function makeOdFactory({ env, manifest, log }) {
  let client = null
  return function requireOd() {
    if (client) return client
    if (typeof env.YIC_KEY !== 'string' || env.YIC_KEY.length === 0) {
      throw new RelayError('internal', 'YIC_KEY is missing')
    }
    const plaintext = openSealedText(env.YIC_KEY, manifest.od.token)
    const token = secretFromPlaintext(plaintext)
    if (!token) throw new RelayError('internal', 'OneDrive token is empty')
    log.addSecret(plaintext)
    log.addSecret(token)
    client = createOdClient({ token })
    return client
  }
}

function makeCredentialFactory({ env, manifest, log }) {
  return function credential() {
    if (manifest.credential === null || manifest.credential === undefined) return null
    const plaintext = openSealedText(env.YIC_KEY, manifest.credential)
    const secret = secretFromPlaintext(plaintext)
    log.addSecret(plaintext)
    log.addSecret(secret)
    return secret
  }
}

async function verifyTaskPackage({ manifest, tarPath, log }) {
  const info = fs.statSync(tarPath)
  const fingerprint = manifest.package || {}
  if (typeof fingerprint.size === 'number' && fingerprint.size !== info.size) {
    throw new RelayError('package_corrupt', 'task package size does not match the manifest')
  }
  const actual = await sha256File(tarPath)
  if (actual.toLowerCase() !== String(fingerprint.sha256).toLowerCase()) {
    throw new RelayError('package_corrupt', 'task package sha256 does not match the manifest')
  }
  log.detail(`task package verified (${info.size} bytes)`)
}

function verifyInnerManifest({ manifest, pkgDir }) {
  const innerPath = path.join(pkgDir, 'manifest.json')
  if (!fs.existsSync(innerPath)) throw new RelayError('package_corrupt', 'task package has no manifest.json')
  let inner
  try {
    inner = JSON.parse(fs.readFileSync(innerPath, 'utf8'))
  } catch {
    throw new RelayError('package_corrupt', 'task package manifest.json is not valid JSON')
  }
  if (!isPlainObject(inner) || inner.txn !== manifest.txn || inner.kind !== manifest.kind) {
    throw new RelayError('package_corrupt', 'task package manifest does not match YIC_TASK')
  }
}

/**
 * Best-effort downlink error package: status.json + log.txt only.
 * Used for preflight rejections (unsupported schema/kind) and for failures
 * before the upload phase. Never touches OD for uplink kinds (D60).
 */
async function emitStatusPackage({ env, manifest, error, phase, startedAt, log }) {
  if (!isPlainObject(manifest) || !isPlainObject(manifest.od)) return false
  const outPath = manifest.od.out
  if (!isSafeRelativeOdPath(outPath) || !outPath.startsWith('out/')) return false
  if (typeof manifest.od.token !== 'string' || manifest.od.token.length === 0) return false
  if (typeof env.YIC_KEY !== 'string' || env.YIC_KEY.length === 0) return false

  let token
  try {
    const plaintext = openSealedText(env.YIC_KEY, manifest.od.token)
    log.addSecret(plaintext)
    token = secretFromPlaintext(plaintext)
    log.addSecret(token)
  } catch (openError) {
    log.detail(`cannot open sealed OneDrive token for the status package: ${openError?.message || openError}`)
    return false
  }
  if (!token) return false

  const tmpRoot = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'yic-status-'))
  try {
    const od = createOdClient({ token })
    const status = buildStatus({ manifest, ok: false, phase, error, startedAt, redactor: log.redact })
    const dir = path.join(tmpRoot, 'pkg')
    const tarPath = path.join(tmpRoot, 'status.tar')
    await writeResultPackage({ dir, tarPath, status, log })
    await od.uploadFile(outPath, tarPath)
    log.detail(`status package uploaded (${fs.statSync(tarPath).size} bytes)`)
    return true
  } catch (uploadError) {
    log.detail(`status package could not be delivered: ${uploadError?.message || uploadError}`)
    return false
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

/**
 * Run one task. Returns the process exit code (0 ok, 1 task failure,
 * 2 usage/input error). Never prints YIC_TASK, YIC_KEY or any secret.
 */
export async function main(env = process.env) {
  const rawTask = env.YIC_TASK
  if (typeof rawTask !== 'string' || rawTask.trim().length === 0) {
    process.stderr.write("relay: YIC_TASK is required (it carries the workflow_dispatch input 'task')\n")
    return 2
  }
  let manifest
  try {
    manifest = JSON.parse(rawTask)
  } catch {
    process.stderr.write('relay: YIC_TASK is not valid JSON\n')
    return 2
  }
  if (!isPlainObject(manifest)) {
    process.stderr.write('relay: YIC_TASK must be a JSON object\n')
    return 2
  }

  const kindValue = typeof manifest.kind === 'string' ? manifest.kind : 'unknown'
  const log = createLogger({ txn: manifest.txn, kind: kindValue, secrets: [env.YIC_KEY] })
  log.addSecret(env.YIC_KEY)
  if (isPlainObject(manifest.od)) log.addSecret(manifest.od.token)
  if (typeof manifest.credential === 'string') log.addSecret(manifest.credential)

  const uplinkKind = UPLINK_KINDS.has(kindValue)
  const startedAt = isoNow()
  log.event('start')

  let tmpRoot = null
  let phase = uplinkKind ? 'download' : 'exec'

  try {
    const preError = preflight(manifest)
    if (preError) {
      log.detail(`preflight rejected (${preError.errorClass}): ${preError.message}`)
      if (!uplinkKind) {
        await emitStatusPackage({ env, manifest, error: preError, phase: 'exec', startedAt, log })
      }
      log.event('fail', { error_class: preError.errorClass, ms: log.elapsedMs() })
      return 1
    }

    const requireOd = makeOdFactory({ env, manifest, log })
    const credential = makeCredentialFactory({ env, manifest, log })
    tmpRoot = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'yic-relay-'))
    const workDir = path.join(tmpRoot, 'work')
    const pkgDir = path.join(tmpRoot, 'pkg')
    const payloadDir = path.join(tmpRoot, 'payload')
    fs.mkdirSync(workDir, { recursive: true })

    const ctx = {
      manifest,
      keyBase64: env.YIC_KEY,
      log,
      workDir,
      pkgDir,
      payloadDir,
      credential,
      requireOd
    }

    if (uplinkKind) {
      phase = 'download'
      const od = requireOd()
      const taskTar = path.join(tmpRoot, 'task.tar')
      await od.downloadToFile(manifest.od.in, taskTar)
      await verifyTaskPackage({ manifest, tarPath: taskTar, log })
      fs.mkdirSync(pkgDir, { recursive: true })
      await extractTar(taskTar, pkgDir)
      verifyInnerManifest({ manifest, pkgDir })
      // D50: once taken and validated, the task package has served its purpose.
      try {
        await od.deleteItem(manifest.od.in)
        log.detail('task package removed from the AppFolder')
      } catch (cleanupError) {
        log.detail(`task package cleanup failed: ${cleanupError?.message || cleanupError}`)
      }
    } else {
      fs.mkdirSync(payloadDir, { recursive: true })
    }

    phase = 'exec'
    const result = await KIND_MODULES[kindValue].run(ctx)

    if (uplinkKind) {
      // Uplink: no OD write, no result package (D60). The remote ref is the answer.
      log.event('done', { bytes: result?.bytes, ms: log.elapsedMs() })
      return 0
    }

    const status = buildStatus({
      manifest,
      ok: result?.ok !== false,
      phase: 'done',
      error: null,
      sha: result?.sha,
      bytes: result?.bytes,
      startedAt,
      redactor: log.redact
    })
    const dir = path.join(tmpRoot, 'result-pkg')
    const tarPath = path.join(tmpRoot, 'result.tar')
    await writeResultPackage({ dir, tarPath, status, log, payloadDir })
    phase = 'upload'
    log.event('upload', { bytes: fs.statSync(tarPath).size })
    await requireOd().uploadFile(manifest.od.out, tarPath)
    log.event('done', { bytes: result?.bytes, ms: log.elapsedMs() })
    return 0
  } catch (error) {
    const errorClass = classifyError(error)
    log.detail(`failure (${errorClass}): ${error?.name || 'Error'}: ${error?.message || String(error)}`)
    if (error?.stderr) log.detail(`stderr:\n${error.stderr}`)
    if (!uplinkKind && phase !== 'upload') {
      await emitStatusPackage({ env, manifest, error, phase, startedAt, log })
    }
    const failure = { error_class: errorClass, ms: log.elapsedMs() }
    // Status codes are safe and make OD failures diagnosable without leaking
    // paths, URLs or tokens. Detailed messages stay in the result package.
    if (Number.isInteger(error?.status)) failure.status = error.status
    if (errorClass === 'od_error' && typeof error?.message === 'string') {
      failure.detail = error.message.slice(0, 120)
    }
    log.event('fail', failure)
    return 1
  } finally {
    if (tmpRoot) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true })
      } catch {
        // best effort: the runner is ephemeral anyway
      }
    }
  }
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1]
    return typeof entry === 'string' && path.resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch(() => {
      // Never dump internals: they could contain paths or manifests.
      process.stderr.write('relay: internal error\n')
      process.exitCode = 1
    })
}
