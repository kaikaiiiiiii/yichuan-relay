/**
 * `download` — downlink, generic file fetch (D68).
 *
 * Fetches one absolute https URL on the runner and ships the bytes back as
 * `payload/file.bin`. Nothing here is GitHub- or avatar-specific: the avatar
 * cache is simply the first caller. The APP decides where the bytes land.
 */

import fs from 'node:fs'
import path from 'node:path'
import { RelayError } from '../log.mjs'

export const name = 'download'

/** Hard ceilings: this is a control-plane fetch, not a file-transfer job. */
const MAX_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 30_000

export async function run(ctx) {
  const url = typeof ctx.manifest.options?.url === 'string' ? ctx.manifest.options.url : ''
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new RelayError('internal', 'download url is not a valid URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new RelayError('internal', 'download url must use https')
  }

  let response
  try {
    response = await fetch(parsed.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (error) {
    throw new RelayError('network', `download request failed: ${error?.message ?? 'unknown'}`)
  }
  if (!response.ok) {
    throw new RelayError('target_not_found', `download returned HTTP ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new RelayError('internal', 'download is larger than the 8 MiB limit')
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) {
    throw new RelayError('target_not_found', 'download returned an empty body')
  }
  if (bytes.length > MAX_BYTES) {
    throw new RelayError('internal', 'download is larger than the 8 MiB limit')
  }

  fs.writeFileSync(path.join(ctx.payloadDir, 'file.bin'), bytes)
  return { bytes: bytes.length }
}
