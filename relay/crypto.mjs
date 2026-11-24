/**
 * YIC_KEY unsealing (RELAY.md §5, protocol.ts §"sealed envelope").
 *
 * Envelope: base64(nonce[12] || ciphertext || tag[16]) with
 * ChaCha20-Poly1305 (Node's built-in cipher, i.e. RFC 8439 AEAD).
 * YIC_KEY is 32 bytes, base64 encoded, and never leaves the process.
 *
 * `openSealed` is deliberately strict: a wrong key or a tampered tag must fail
 * the authentication check (the caller maps that to `internal` — a mismatch
 * between APP and relay configuration, not a user-facing auth bug).
 */

import { createDecipheriv } from 'node:crypto'
import { RelayError } from './log.mjs'

export const SEAL_ALGORITHM = 'chacha20-poly1305'
export const SEAL_NONCE_BYTES = 12
export const SEAL_TAG_BYTES = 16
export const RELAY_KEY_BYTES = 32

/** Decode and validate YIC_KEY. Throws `internal` when malformed/missing. */
export function decodeKey(keyBase64) {
  if (typeof keyBase64 !== 'string' || keyBase64.length === 0) {
    throw new RelayError('internal', 'YIC_KEY is missing')
  }
  const key = Buffer.from(keyBase64, 'base64')
  if (key.length !== RELAY_KEY_BYTES) {
    throw new RelayError('internal', 'YIC_KEY must decode to 32 bytes')
  }
  return key
}

/** Decode a sealed envelope's base64 into {nonce, ciphertext, tag}. */
export function splitSealed(sealedBase64) {
  if (typeof sealedBase64 !== 'string' || sealedBase64.length === 0) {
    throw new RelayError('internal', 'sealed payload is missing')
  }
  const sealed = Buffer.from(sealedBase64, 'base64')
  if (sealed.length < SEAL_NONCE_BYTES + SEAL_TAG_BYTES) {
    throw new RelayError('internal', 'sealed payload is too short')
  }
  return {
    nonce: sealed.subarray(0, SEAL_NONCE_BYTES),
    ciphertext: sealed.subarray(SEAL_NONCE_BYTES, sealed.length - SEAL_TAG_BYTES),
    tag: sealed.subarray(sealed.length - SEAL_TAG_BYTES)
  }
}

/** Unseal one value. Returns the plaintext Buffer (never logged). */
export function openSealed(keyBase64, sealedBase64) {
  const key = decodeKey(keyBase64)
  const { nonce, ciphertext, tag } = splitSealed(sealedBase64)
  try {
    const decipher = createDecipheriv(SEAL_ALGORITHM, key, nonce, { authTagLength: SEAL_TAG_BYTES })
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (error) {
    throw new RelayError('internal', 'sealed payload could not be opened', { cause: error })
  }
}

/** Unseal one value as UTF-8 text. */
export function openSealedText(keyBase64, sealedBase64) {
  return openSealed(keyBase64, sealedBase64).toString('utf8')
}

/** Unseal one value as JSON. */
export function openSealedJson(keyBase64, sealedBase64) {
  const text = openSealedText(keyBase64, sealedBase64)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new RelayError('internal', 'sealed payload is not valid JSON', { cause: error })
  }
}

/**
 * Turn a decrypted secret payload into the usable secret string.
 *
 * The relay treats the sealed payload as the raw secret (a PAT or a Graph
 * access token). It also accepts a JSON envelope so the APP may seal
 * `{"token": "..."}` without breaking the wire format; both shapes are
 * protocol-compatible because the plaintext is opaque to this file.
 */
export function secretFromPlaintext(plaintext) {
  const text = typeof plaintext === 'string' ? plaintext : plaintext.toString('utf8')
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const value = JSON.parse(trimmed)
      if (value && typeof value === 'object') {
        for (const key of ['token', 'access_token', 'accessToken', 'pat', 'credential', 'value', 'secret']) {
          if (typeof value[key] === 'string' && value[key].length > 0) return value[key]
        }
      }
    } catch {
      // fall through: treat the payload as a raw secret
    }
  }
  return trimmed
}
