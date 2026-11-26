/**
 * `export` — downlink (OPERATIONS.md §4.4).
 *
 * Clone bare, then `git archive --format=tar <ref>` into the result package as
 * `payload/files.tar`. The APP unpacks that tar; no `.git` ever travels.
 */

import fs from 'node:fs'
import path from 'node:path'
import { RelayError } from '../log.mjs'
import * as git from '../git.mjs'

export const name = 'export'

export async function run(ctx) {
  const manifest = ctx.manifest
  const credential = ctx.credential()
  const configArgs = git.credentialConfig(manifest.target.url, credential)
  const work = path.join(ctx.workDir, 'work.git')

  await git.cloneBare(manifest.target.url, work, { configArgs })
  const targetRef = manifest.target.ref
  if (!(await git.catFileExists(work, targetRef))) {
    throw new RelayError('target_not_found', 'target ref does not exist on the remote')
  }
  const sha = await git.revParse(work, targetRef)
  const filesTar = path.join(ctx.payloadDir, 'files.tar')
  await git.archiveTar(work, targetRef, filesTar)

  return { sha, bytes: fs.statSync(filesTar).size }
}
