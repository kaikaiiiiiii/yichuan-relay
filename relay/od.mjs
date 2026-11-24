/**
 * OneDrive / Microsoft Graph AppFolder access (RELAY.md §1, D12, D13).
 *
 * The relay never uses rclone or any npm Graph SDK: two operations are enough —
 * an upload session with fixed chunks, and a ranged download that can resume.
 *
 * Path syntax (all relative to the AppFolder root):
 *   item    /me/drive/special/approot:/in/<txn>.tar:
 *   content .../in/<txn>.tar:/content
 *   upload  .../in/<txn>.tar:/createUploadSession
 *   folder  .../in:/children   (root: /me/drive/special/approot/children)
 *
 * The upload-session PUT URL is pre-authenticated and must not carry the
 * Authorization header; every other request does. Failures are reported as
 * `od_error` (RELAY.md §7) and never include the token or a full URL.
 */

import fs from 'node:fs'
import path from 'node:path'
import { RelayError } from './log.mjs'

export const DEFAULT_GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

/** Graph requires upload chunks to be multiples of 320 KiB. */
export const UPLOAD_CHUNK_BYTES = 320 * 1024 * 10 // 3.2 MiB
/** Range download segment size (also a multiple of 320 KiB). */
export const DOWNLOAD_CHUNK_BYTES = 320 * 1024 * 8 // 2.5 MiB
/** Small results (doctor/status) go through a plain PUT, avoiding sessions. */
export const SIMPLE_UPLOAD_BYTES = 1024 * 1024

/** Resolve the Graph base URL; `KG_GRAPH_BASE` exists for the e2e fake Graph. */
export function graphBase(env = process.env) {
  const raw = typeof env?.KG_GRAPH_BASE === 'string' && env.KG_GRAPH_BASE.trim().length > 0
    ? env.KG_GRAPH_BASE.trim()
    : DEFAULT_GRAPH_BASE
  return raw.replace(/\/+$/, '')
}

function encodePath(relPath) {
  const parts = String(relPath).split('/').filter((part) => part.length > 0)
  return parts.map((part) => encodeURIComponent(part)).join('/')
}

function posixDirname(relPath) {
  const parts = String(relPath).split('/').filter((part) => part.length > 0)
  parts.pop()
  return parts.join('/')
}

function odError(message, extra = {}) {
  return new RelayError('od_error', message, extra)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function openSource(source) {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source)
    return {
      size: buffer.length,
      read: async (offset, length) => buffer.subarray(offset, offset + length),
      close: () => {}
    }
  }
  if (typeof source === 'string') {
    const info = fs.statSync(source)
    const fd = fs.openSync(source, 'r')
    return {
      size: info.size,
      read: async (offset, length) => {
        const buffer = Buffer.allocUnsafe(length)
        const read = fs.readSync(fd, buffer, 0, length, offset)
        return buffer.subarray(0, read)
      },
      close: () => fs.closeSync(fd)
    }
  }
  throw new RelayError('internal', 'unsupported upload source')
}

/**
 * Create a Graph client bound to one short-lived access token.
 * `fetchImpl` is injectable so tests can stay offline without npm mocks.
 */
export function createOdClient({ token, graphBase: base = graphBase(), fetchImpl = globalThis.fetch } = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new RelayError('internal', 'OneDrive token is missing')
  }
  if (typeof fetchImpl !== 'function') {
    throw new RelayError('internal', 'fetch is unavailable')
  }
  const root = `${base.replace(/\/+$/, '')}/me/drive/special/approot`
  const authHeaders = Object.freeze({ authorization: `Bearer ${token}` })

  function fileUrl(relPath) {
    return `${root}:/${encodePath(relPath)}:`
  }

  function contentUrl(relPath) {
    return `${fileUrl(relPath)}/content`
  }

  async function request(url, init) {
    let response
    try {
      response = await fetchImpl(url, init)
    } catch (error) {
      throw odError('graph request failed', { cause: error })
    }
    if (!response.ok) {
      throw odError(`graph request failed (${response.status})`, { status: response.status })
    }
    return response
  }

  async function stat(relPath) {
    const response = await fetchImpl(fileUrl(relPath), { headers: authHeaders })
    if (response.status === 404) return null
    if (!response.ok) throw odError(`graph stat failed (${response.status})`, { status: response.status })
    const item = await response.json()
    return {
      id: typeof item.id === 'string' ? item.id : null,
      name: typeof item.name === 'string' ? item.name : null,
      size: typeof item.size === 'number' ? item.size : null,
      folder: Boolean(item.folder),
      file: Boolean(item.file)
    }
  }

  async function createFolder(parentDir, name) {
    // A direct POST /children can answer 400/invalidRequest for AppFolder on
    // personal OneDrive. A plain PUT into `<dir>/<name>/.yichuan-folder` makes
    // Graph create the parent folder; delete the marker afterwards.
    const next = parentDir ? `${parentDir}/${name}` : name
    const marker = `${next}/.yichuan-folder`
    const response = await fetchImpl(contentUrl(marker), {
      method: 'PUT',
      headers: { ...authHeaders, 'content-type': 'application/octet-stream', 'content-length': '0' },
      body: Buffer.alloc(0)
    })
    if (!response.ok) throw odError(`graph folder create failed (${response.status})`, { status: response.status })
    try {
      await fetchImpl(fileUrl(marker), { method: 'DELETE', headers: authHeaders })
    } catch {
      // The folder exists; a leftover marker is harmless.
    }
  }

  /** Create `in/`, `out/` (or any nested relative folder), idempotently. */
  async function ensureFolder(relDir) {
    const parts = String(relDir || '').split('/').filter((part) => part.length > 0)
    let prefix = ''
    for (const part of parts) {
      const next = prefix ? `${prefix}/${part}` : part
      const existing = await stat(next)
      if (existing) {
        if (!existing.folder) throw odError('graph path is not a folder')
      } else {
        await createFolder(prefix, part)
      }
      prefix = next
    }
  }

  /**
   * Upload a Buffer or a local file through an upload session.
   * Chunks are `chunkSize` bytes (default 3.2 MiB, a multiple of 320 KiB).
   */
  async function uploadFile(relPath, source, options = {}) {
    const chunkSize = Number.isInteger(options.chunkSize) && options.chunkSize > 0 ? options.chunkSize : UPLOAD_CHUNK_BYTES
    const handle = openSource(source)
    try {
      await ensureFolder(posixDirname(relPath))
      if (handle.size <= SIMPLE_UPLOAD_BYTES) {
        // A freshly created folder may take a moment to become visible to the
        // upload endpoint; retry a 404 once before failing. Plain PUT is also
        // the reliable path for the small result/status packages.
        const body = handle.size === 0 ? Buffer.alloc(0) : await handle.read(0, handle.size)
        let response = null
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          response = await fetchImpl(contentUrl(relPath), {
            method: 'PUT',
            headers: { ...authHeaders, 'content-length': String(body.length) },
            body
          })
          if (response.status !== 404 || attempt === 2) break
          await sleep(500)
        }
        if (!response || !response.ok) {
          throw odError(`graph upload failed (${response?.status ?? 'no response'})`, {
            ...(response ? { status: response.status } : {})
          })
        }
        return { bytes: handle.size }
      }
      const sessionResponse = await request(`${fileUrl(relPath)}/createUploadSession`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } })
      })
      const session = await sessionResponse.json()
      const uploadUrl = session && typeof session.uploadUrl === 'string' ? session.uploadUrl : ''
      if (!uploadUrl) throw odError('graph upload session has no uploadUrl')

      let offset = 0
      while (offset < handle.size) {
        const end = Math.min(offset + chunkSize, handle.size) - 1
        const chunk = await handle.read(offset, end - offset + 1)
        // NB: the upload URL is pre-authenticated — no Authorization here.
        const response = await fetchImpl(uploadUrl, {
          method: 'PUT',
          headers: {
            'content-length': String(chunk.length),
            'content-range': `bytes ${offset}-${end}/${handle.size}`
          },
          body: chunk
        })
        if (!(response.status === 200 || response.status === 201 || response.status === 202)) {
          throw odError(`graph chunk upload failed (${response.status})`, { status: response.status })
        }
        offset = end + 1
      }
      return { bytes: handle.size }
    } finally {
      handle.close()
    }
  }

  /**
   * Download an item with Range segments, retrying each segment independently.
   * The final byte count is checked against the stat size.
   */
  async function downloadToFile(relPath, destPath, options = {}) {
    const chunkSize = Number.isInteger(options.chunkSize) && options.chunkSize > 0 ? options.chunkSize : DOWNLOAD_CHUNK_BYTES
    const attempts = Number.isInteger(options.retries) && options.retries > 0 ? options.retries : 3
    const info = await stat(relPath)
    if (!info) throw odError('download item not found')
    const total = typeof info.size === 'number' ? info.size : 0
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const fd = fs.openSync(destPath, 'w')
    try {
      if (total === 0) return { bytes: 0 }
      let offset = 0
      while (offset < total) {
        const end = Math.min(offset + chunkSize, total) - 1
        const expected = end - offset + 1
        let written = false
        let lastError = null
        for (let attempt = 1; attempt <= attempts && !written; attempt += 1) {
          try {
            const response = await fetchImpl(contentUrl(relPath), {
              headers: { ...authHeaders, range: `bytes=${offset}-${end}` }
            })
            if (response.status === 416) throw odError('graph range not satisfiable')
            if (!response.ok) throw odError(`graph download failed (${response.status})`, { status: response.status })
            const body = Buffer.from(await response.arrayBuffer())
            if (response.status === 200) {
              if (offset !== 0 || body.length !== total) throw odError('graph ignored range request')
              fs.writeSync(fd, body, 0, body.length)
              offset = total
              written = true
            } else {
              if (body.length !== expected) throw odError('graph short range response')
              fs.writeSync(fd, body, 0, body.length)
              offset = end + 1
              written = true
            }
          } catch (error) {
            lastError = error
            if (attempt < attempts) await sleep(100 * attempt)
          }
        }
        if (!written) throw lastError || odError('graph range download failed')
      }
    } finally {
      fs.closeSync(fd)
    }
    const actual = fs.statSync(destPath).size
    if (actual !== total) throw odError('downloaded size mismatch')
    return { bytes: total }
  }

  /** Small-item download (full GET); used by diagnostics, not big packages. */
  async function downloadToBuffer(relPath) {
    const response = await request(contentUrl(relPath), { headers: authHeaders })
    const body = Buffer.from(await response.arrayBuffer())
    const info = await stat(relPath)
    if (info && typeof info.size === 'number' && body.length !== info.size) {
      throw odError('downloaded size mismatch')
    }
    return body
  }

  /** Idempotent delete: 404 counts as success (D50 cleanup). */
  async function deleteItem(relPath) {
    const response = await fetchImpl(fileUrl(relPath), { method: 'DELETE', headers: authHeaders })
    if (response.ok || response.status === 404) return true
    throw odError(`graph delete failed (${response.status})`, { status: response.status })
  }

  return {
    stat,
    ensureFolder,
    uploadFile,
    downloadToFile,
    downloadToBuffer,
    deleteItem,
    fileUrl,
    contentUrl
  }
}
