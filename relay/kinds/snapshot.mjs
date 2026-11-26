/**
 * `snapshot` — uplink (OPERATIONS.md §4.3).
 *
 * The task package carries `payload/files/` (a plain file tree). Depending on
 * the target the relay either initialises a new history (empty repo / new
 * branch, orphan commit) or clones the branch shallowly and commits on top.
 * `options.mode` is `mirror` (replace the tree) or `overlay` (add/overwrite).
 *
 * Deterministic commit: author, committer, message and date all come from the
 * manifest (`author`, `options.created_at`, `options.message`), never from the
 * wall clock — replaying an identical snapshot yields the identical commit SHA.
 */

import fs from 'node:fs'
import path from 'node:path'
import { RelayError } from '../log.mjs'
import * as git from '../git.mjs'

export const name = 'snapshot'

function shortRef(ref) {
  return String(ref).replace(/^refs\/heads\//, '')
}

/** Recursively copy regular files/directories; symlinks are never followed. */
function copyTree(sourceDir, destDir, stats) {
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name)
    const to = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      copyTree(from, to, stats)
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to)
      stats.bytes += fs.statSync(to).size
      stats.files += 1
    }
    // symlinks / sockets / devices are intentionally skipped (D5: never run
    // target content, never let a snapshot smuggle a link out of the tree).
  }
}

function clearWorktree(workDir) {
  for (const entry of fs.readdirSync(workDir)) {
    if (entry === '.git') continue
    fs.rmSync(path.join(workDir, entry), { recursive: true, force: true })
  }
}

function normalizeDate(value) {
  if (typeof value !== 'string' || value.length === 0) return '1970-01-01T00:00:00Z'
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return '1970-01-01T00:00:00Z'
  return new Date(time).toISOString()
}

export async function run(ctx) {
  const manifest = ctx.manifest
  const log = ctx.log
  const targetRef = manifest.target.ref
  const branch = shortRef(targetRef)
  const options = manifest.options || {}
  const mode = options.mode === 'overlay' ? 'overlay' : 'mirror'
  const filesDir = path.join(ctx.pkgDir, 'payload', 'files')
  if (!fs.existsSync(filesDir) || !fs.statSync(filesDir).isDirectory()) {
    throw new RelayError('package_corrupt', 'task package has no payload/files/ directory')
  }

  const credential = ctx.credential()
  const configArgs = git.credentialConfig(manifest.target.url, credential)
  const work = path.join(ctx.workDir, 'work')

  // Decide between "new history" and "commit on top" without guessing: an
  // empty repo and a missing branch both yield no ref from ls-remote, and both
  // want an orphan commit (publishing to a fresh gh-pages-style branch).
  const remoteTip = await git.lsRemoteRef(manifest.target.url, targetRef, { configArgs })
  let basedOnExisting = false
  if (remoteTip) {
    await git.cloneShallow(manifest.target.url, targetRef, work, { configArgs })
    basedOnExisting = true
  } else {
    log.detail('target ref does not exist yet: creating an orphan branch')
    await git.initWorktree(work)
    await git.checkoutOrphan(work, branch)
    await git.remoteAdd(work, 'origin', manifest.target.url)
  }

  const stats = { files: 0, bytes: 0 }
  if (mode === 'mirror') clearWorktree(work)
  copyTree(filesDir, work, stats)
  await git.addAll(work)

  const head = basedOnExisting ? await git.tryRevParse(work, 'HEAD') : null
  let sha
  const hasChanges = await git.hasStagedChanges(work)
  if (!head) {
    // First commit of a new history: allow an empty tree so the branch exists
    // even when the snapshot has zero files.
    await git.commitDeterministic(work, commitMessage(manifest), {
      author: manifest.author,
      date: normalizeDate(options.created_at),
      allowEmpty: true
    })
    sha = await git.revParse(work, 'HEAD')
  } else if (hasChanges) {
    await git.commitDeterministic(work, commitMessage(manifest), {
      author: manifest.author,
      date: normalizeDate(options.created_at)
    })
    sha = await git.revParse(work, 'HEAD')
  } else {
    // Identical snapshot: keep the existing commit (same SHA, no duplicate).
    sha = head
  }

  await git.pushRef(work, 'origin', 'HEAD', targetRef, {
    leaseBase: options.force === true ? manifest.base || remoteTip : null,
    force: options.force === true && !(manifest.base || remoteTip),
    configArgs
  })

  return { sha, bytes: stats.bytes }
}

function commitMessage(manifest) {
  const message = manifest.options?.message
  return typeof message === 'string' && message.length > 0 ? message : 'snapshot'
}
