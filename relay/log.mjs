/**
 * Restricted logging (OPERATIONS.md §8, DESIGN.md §7.3).
 *
 * Actions logs are public when the relay repo is public, so stdout may only
 * carry: task id, kind, byte counts, elapsed time and the error class.
 * Everything else — paths, URLs, commit messages, credentials and even sealed
 * blobs — must never reach the log.
 *
 * Detailed diagnostics go into `log.txt` inside the downlink result package,
 * which only the APP downloads.
 *
 * This module also owns the relay's own error type and the classifier that maps
 * an arbitrary failure (usually a git stderr) onto OPERATIONS.md §7's nine classes.
 */

import { RELAY_VERSION } from './version.mjs'

/** The nine OPERATIONS.md §7 classes a relay may report (app/src/core/types.ts). */
export const RELAY_ERROR_CLASSES = Object.freeze([
  'auth',
  'target_not_found',
  'non_fast_forward',
  'package_corrupt',
  'od_error',
  'unsupported_schema',
  'unsupported_kind',
  'timeout',
  'internal'
])

/** stdout events. Adding a name here changes what Actions logs may show. */
const EVENT_NAMES = new Set(['start', 'done', 'fail', 'upload', 'depth_fallback', 'cleanup'])

const TXN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const KIND_RE = /^[a-z][a-z0-9_-]*$/

/**
 * A relay failure carrying one of the nine classes.
 * `detail`/`stderr` are for the result package, never for stdout.
 */
export class RelayError extends Error {
  constructor(errorClass, message, options = {}) {
    super(message)
    this.name = 'RelayError'
    this.errorClass = RELAY_ERROR_CLASSES.includes(errorClass) ? errorClass : 'internal'
    if (options.detail !== undefined) this.detail = options.detail
    if (options.stderr !== undefined) this.stderr = options.stderr
    if (options.cause !== undefined) this.cause = options.cause
  }
}

export function isRelayError(value) {
  return value instanceof RelayError
}

/**
 * Replace secrets and URL userinfo with `[redacted]`.
 * Used for everything that leaves the process or lands in the result package.
 */
export function redact(text, secrets = []) {
  let out = typeof text === 'string' ? text : String(text ?? '')
  const list = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4))]
  // Longest first so a secret containing another secret is fully removed.
  list.sort((a, b) => b.length - a.length)
  for (const secret of list) {
    out = out.split(secret).join('[redacted]')
  }
  // `https://x-access-token:<token>@github.com/...` — strip the userinfo even
  // when we were not handed the token itself.
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+@/g, '$1[redacted]@')
  // Defensive: never echo an Authorization header value (git can print the
  // command's config on some failures).
  out = out.replace(
    /((?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:basic|bearer|token)\s+)[A-Za-z0-9+/=._~-]+/gi,
    '$1[redacted]'
  )
  return out
}

/** Merge the text of an unknown thrown value into one diagnostic string. */
export function errorText(error) {
  if (error === null || error === undefined) return ''
  const parts = []
  if (typeof error.stderr === 'string' && error.stderr) parts.push(error.stderr)
  if (typeof error.detail === 'string' && error.detail) parts.push(error.detail)
  if (error instanceof Error) parts.push(error.message)
  else parts.push(String(error))
  return parts.filter(Boolean).join('\n')
}

/**
 * Map any thrown value onto one of the nine relay classes (OPERATIONS.md §7).
 * `RelayError.errorClass` wins; otherwise git/Graph stderr is pattern matched.
 */
export function classifyError(error) {
  if (error && RELAY_ERROR_CLASSES.includes(error.errorClass)) return error.errorClass
  const text = errorText(error).toLowerCase()
  if (!text) return 'internal'

  // A push rejected because the remote moved first. Checked before the generic
  // "failed to push some refs" line, which also appears for auth failures.
  if (/non[- ]?fast[- ]?forward|stale info|fetch first|updates were rejected/.test(text)) {
    return 'non_fast_forward'
  }
  if (
    /authentication failed|could not read (username|password)|terminal prompts disabled|invalid (username|password)|bad credentials|support for password authentication was removed|permission denied|access denied|not authorized|unauthorized|http 40[13]|status 40[13]/.test(
      text
    )
  ) {
    return 'auth'
  }
  if (
    /repository .*not found|not appear to be a git repository|could not read from remote repository|remote branch .* not found|couldn't find remote ref|not a valid object name|unknown revision|invalid ref|no such remote ref/.test(
      text
    )
  ) {
    return 'target_not_found'
  }
  if (/failed to push some refs|\[rejected\]|remote rejected|pre-receive hook declined|protected branch/.test(text)) {
    return 'non_fast_forward'
  }
  if (/timed? ?out|timeout|etimedout/.test(text)) return 'timeout'
  if (
    /package.*(corrupt|mismatch)|sha256 mismatch|hash mismatch|checksum|bad object|early eof|unexpected end of file|index-pack failed|corrupt/.test(
      text
    )
  ) {
    return 'package_corrupt'
  }
  return 'internal'
}

function safeTxn(txn) {
  const value = typeof txn === 'string' ? txn : ''
  return TXN_RE.test(value) ? value : 'unknown'
}

function safeKind(kind) {
  const value = typeof kind === 'string' ? kind : ''
  return KIND_RE.test(value) && value.length <= 32 ? value : 'unknown'
}

/**
 * Create the process logger.
 *
 * `event()` writes one restricted line to stdout and mirrors it into log.txt.
 * `detail()` only writes to log.txt (redacted), which is where diagnostics go.
 */
export function createLogger({ txn, kind, secrets = [] } = {}) {
  const txnValue = safeTxn(txn)
  const kindValue = safeKind(kind)
  const secretSet = new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4))
  const lines = []
  const startedAt = Date.now()

  function addSecret(value) {
    if (typeof value === 'string' && value.length >= 4) secretSet.add(value)
  }

  function redactWith(text) {
    return redact(text, [...secretSet])
  }

  function event(name, fields = {}) {
    const safeName = EVENT_NAMES.has(name) ? name : 'event'
    let line = `yic txn=${txnValue} kind=${kindValue} event=${safeName}`
    if (Number.isFinite(fields.bytes)) line += ` bytes=${Math.trunc(fields.bytes)}`
    const ms = fields.ms === undefined ? undefined : fields.ms
    if (Number.isFinite(ms)) line += ` ms=${Math.max(0, Math.trunc(ms))}`
    if (fields.error_class) {
      const cls = RELAY_ERROR_CLASSES.includes(fields.error_class) ? fields.error_class : 'internal'
      line += ` error_class=${cls}`
    }
    // HTTP status is safe (no URL/path/token) and is the only practical way to
    // diagnose an od_error whose result package could not be uploaded.
    if (Number.isInteger(fields.status)) line += ` status=${Math.trunc(fields.status)}`
    process.stdout.write(`${line}\n`)
    lines.push(`${new Date().toISOString()} ${line}`)
    return line
  }

  function detail(text) {
    const value = redactWith(typeof text === 'string' ? text : String(text ?? ''))
    for (const line of value.split(/\r?\n/)) lines.push(line)
  }

  function text() {
    const header = `relay_version=${RELAY_VERSION} txn=${txnValue} kind=${kindValue}`
    return `${[header, ...lines].join('\n')}\n`
  }

  function elapsedMs() {
    return Date.now() - startedAt
  }

  return {
    txn: txnValue,
    kind: kindValue,
    event,
    detail,
    text,
    elapsedMs,
    addSecret,
    redact: redactWith
  }
}
