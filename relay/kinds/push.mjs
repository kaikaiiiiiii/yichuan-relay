/**
 * `push` — uplink (RELAY.md §4.1, IMPLEMENTATION.md P7).
 *
 * Task package: `in/<txn>.tar` containing `manifest.json` + `payload/bundle.bundle`.
 * The bundle is an incremental range (`^base <ref>`) produced by the APP, so the
 * relay first has to shallow-fetch the base from the target, then apply the
 * bundle with `--force-with-lease=<ref>:<base>`.
 *
 * Success or failure: nothing is written to OneDrive (D60). The remote ref is
 * the result.
 */

import fs from 'node:fs'
import path from 'node:path'
import { RelayError } from '../log.mjs'
import * as git from '../git.mjs'

export const name = 'push'

function shortRef(ref) {
  return String(ref).replace(/^refs\/heads\//, '')
}

function pickBundleHead(heads, targetRef) {
  if (!Array.isArray(heads) || heads.length === 0) return null
  const exact = heads.find((head) => head.ref === targetRef)
  if (exact) return exact
  const branch = heads.find((head) => head.ref.startsWith('refs/heads/'))
  return branch || heads[0]
}

export async function run(ctx) {
  const manifest = ctx.manifest
  const log = ctx.log
  const targetRef = manifest.target.ref
  const base = typeof manifest.base === 'string' && manifest.base.length > 0 ? manifest.base : null
  const bundlePath = path.join(ctx.pkgDir, 'payload', 'bundle.bundle')
  if (!fs.existsSync(bundlePath)) {
    throw new RelayError('package_corrupt', 'task package has no payload/bundle.bundle')
  }
  const credential = ctx.credential()
  const configArgs = git.credentialConfig(manifest.target.url, credential)
  const work = path.join(ctx.workDir, 'work.git')

  await git.initBare(work)
  await git.remoteAdd(work, 'origin', manifest.target.url)

  let depthFallback = false
  if (base) {
    const depth = Number.isInteger(manifest.depth) && manifest.depth > 0 ? manifest.depth : null
    let baseReachable = false
    if (depth !== null) {
      try {
        await git.fetchDepth(work, 'origin', `+${targetRef}:refs/remotes/origin/${shortRef(targetRef)}`, depth, {
          configArgs
        })
        baseReachable = await git.catFileExists(work, base)
      } catch (error) {
        log.detail(`shallow fetch failed: ${error.message}`)
      }
      if (!baseReachable) depthFallback = true
    }
    if (!baseReachable) {
      if (depthFallback) log.event('depth_fallback')
      const shallow = await git.isShallow(work)
      await git.fetchRef(work, 'origin', `+${targetRef}:refs/remotes/origin/${shortRef(targetRef)}`, {
        unshallow: shallow,
        configArgs
      })
      if (!(await git.catFileExists(work, base))) {
        throw new RelayError('target_not_found', 'base commit is not reachable from the remote ref')
      }
    }
  } else {
    log.detail('no base: nothing to pre-fetch, relying on git reject rules')
  }

  const heads = await git.bundleListHeads(bundlePath)
  const head = pickBundleHead(heads, targetRef)
  if (!head) throw new RelayError('package_corrupt', 'task bundle contains no refs')
  await git.fetchBundle(work, bundlePath, head.ref, 'refs/yic/push')
  const tip = await git.revParse(work, 'refs/yic/push')

  await git.pushWithLease(work, 'origin', tip, targetRef, base, {
    force: manifest.options?.force === true,
    configArgs
  })

  return { sha: tip, bytes: fs.statSync(bundlePath).size }
}
