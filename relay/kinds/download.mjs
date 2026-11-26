/**
 * `download` — downlink, generic file fetch (D68).
 *
 * Fetches one absolute https URL on the runner and ships the bytes back as
 * `payload/file.bin`. Nothing here is GitHub- or avatar-specific: the avatar
 * cache is simply the first caller. The APP decides where the bytes land.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { RelayError } from '../log.mjs'

export const name = 'download'

/** 4 GiB: a real file-transfer ceiling, not a control-plane one. */
const MAX_BYTES = 4 * 1024 * 1024 * 1024
/**
 * Stall timeout, not a total budget: a 4 GiB file cannot finish inside a fixed
 * minute, so the clock resets whenever bytes arrive. No data for this long
 * means the transfer is dead.
 */
const STALL_TIMEOUT_MS = 60_000

function abortAfterSilence(controller) {
  let timer = null
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new Error('download stalled')), STALL_TIMEOUT_MS)
    timer.unref?.()
  }
  return {
    arm,
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

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

  const controller = new AbortController()
  const watchdog = abortAfterSilence(controller)
  const file = path.join(ctx.payloadDir, 'file.bin')

  let response
  try {
    watchdog.arm()
    response = await fetch(parsed.toString(), { redirect: 'follow', signal: controller.signal })
  } catch (error) {
    watchdog.stop()
    throw new RelayError('network', `download request failed: ${error?.message ?? 'unknown'}`)
  }
  if (!response.ok) {
    watchdog.stop()
    throw new RelayError('target_not_found', `download returned HTTP ${response.status}`)
  }

  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    watchdog.stop()
    throw new RelayError('internal', 'download is larger than the 4 GiB limit')
  }
  if (!response.body) {
    watchdog.stop()
    throw new RelayError('target_not_found', 'download returned an empty body')
  }

  let received = 0
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      if (received > MAX_BYTES) {
        callback(new RelayError('internal', 'download is larger than the 4 GiB limit'))
        return
      }
      watchdog.arm()
      callback(null, chunk)
    }
  })

  try {
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(file))
  } catch (error) {
    watchdog.stop()
    fs.rmSync(file, { force: true })
    if (error instanceof RelayError) throw error
    throw new RelayError('network', `download stream failed: ${error?.message ?? 'unknown'}`)
  }
  watchdog.stop()

  if (received === 0) {
    fs.rmSync(file, { force: true })
    throw new RelayError('target_not_found', 'download returned an empty body')
  }

  return { bytes: received }
}
