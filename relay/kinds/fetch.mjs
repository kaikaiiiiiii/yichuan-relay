/**
 * `fetch` — downlink (RELAY.md §4.2).
 *
 * No task package: everything arrives in the manifest. The relay clones the
 * target bare (runner bandwidth is the cheap side), cuts an incremental or full
 * bundle and lets `main.mjs` wrap it into the result package.
 */

import fs from 'node:fs'
import path from 'node:path'
import { RelayError } from '../log.mjs'
import * as git from '../git.mjs'

export const name = 'fetch'

function wantedRefs(manifest) {
  const refs = Array.isArray(manifest.options?.refs)
    ? manifest.options.refs.filter((ref) => typeof ref === 'string' && ref.startsWith('refs/'))
    : []
  if (refs.length > 0) return refs
  return [manifest.target.ref]
}

function isEmptyBundleError(error) {
  const text = `${error?.stderr || ''} ${error?.message || ''}`
  return /refusing to create empty bundle|empty bundle/i.test(text)
}

export async function run(ctx) {
  const manifest = ctx.manifest
  const credential = ctx.credential()
  const configArgs = git.credentialConfig(manifest.target.url, credential)
  const work = path.join(ctx.workDir, 'work.git')

  await git.cloneBare(manifest.target.url, work, { configArgs })

  const refs = wantedRefs(manifest)
  for (const ref of refs) {
    if (!(await git.catFileExists(work, ref))) {
      throw new RelayError('target_not_found', 'target ref does not exist on the remote')
    }
  }
  const tip = await git.revParse(work, manifest.target.ref)
  const base = typeof manifest.base === 'string' && manifest.base.length > 0 ? manifest.base : null
  const basePresent = base ? await git.catFileExists(work, base) : false
  const bundlePath = path.join(ctx.payloadDir, 'bundle.bundle')

  let incremental = basePresent && base !== tip
  if (incremental) {
    try {
      await git.bundleCreate(bundlePath, work, refs, { base })
    } catch (error) {
      if (!isEmptyBundleError(error)) throw error
      incremental = false
    }
  }
  if (!incremental) {
    // No usable base: full bundle (D9). Also the correct fallback when the
    // incremental range would have been an empty bundle.
    await git.bundleCreate(bundlePath, work, refs, {})
  }

  return { sha: tip, bytes: fs.statSync(bundlePath).size }
}
