/**
 * Relay template version.
 *
 * Kept in a dedicated zero-dependency module so the APP can reason about the
 * deployed template without importing the runner (`core/protocol.ts` mirrors
 * these two integers, and the e2e test keeps them honest).
 */

/** Version of this relay template. Bump when runner behaviour changes. */
export const RELAY_VERSION = 2

/** Highest manifest schema this relay understands (RELAY.md §3/§9). */
export const MANIFEST_SCHEMA = 1
