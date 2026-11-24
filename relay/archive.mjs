/**
 * tar packing/unpacking through the system archiver (IMPLEMENTATION.md P1).
 *
 * The runner ships GNU tar; Windows 10+ ships bsdtar. Both accept exactly the
 * two forms used here:
 *   tar -cf <archive> -C <dir> .
 *   tar -xf <archive> -C <dir>
 *
 * Zero dependencies: no npm tar library, no zip (RELAY.md §1 allows tar once the
 * two sides agree; protocol.ts fixes the member layout).
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { RelayError } from './log.mjs'

function runTar(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'tar',
      args,
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env } },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new RelayError('internal', `tar failed (${typeof error.code === 'number' ? error.code : 'spawn'})`, {
              stderr: String(stderr || ''),
              cause: error
            })
          )
          return
        }
        resolve(String(stdout || ''))
      }
    )
  })
}

/** Pack `entries` (relative to `cwd`) into `archivePath`. */
export async function createTar(archivePath, cwd, entries = ['.']) {
  const list = Array.isArray(entries) && entries.length > 0 ? entries : ['.']
  fs.mkdirSync(cwd, { recursive: true })
  await runTar(['-cf', archivePath, '-C', cwd, ...list])
  return archivePath
}

/** Extract `archivePath` into `destDir` (created if needed). */
export async function extractTar(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  await runTar(['-xf', archivePath, '-C', destDir])
  return destDir
}

/** List member names (diagnostics/tests only). */
export async function listTar(archivePath) {
  const out = await runTar(['-tf', archivePath])
  return out.split(/\r?\n/).filter((line) => line.length > 0)
}

/** First line of `tar --version`; throws when tar is unusable. */
export async function tarVersion() {
  const out = await runTar(['--version'])
  const first = out.split(/\r?\n/).find((line) => line.trim().length > 0)
  return (first || '').trim()
}
