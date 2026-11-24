/**
 * Thin, hardened wrapper around the system `git` (RELAY.md §1/§4, D5).
 *
 * Rules enforced here for every invocation:
 *  - no interactive prompts (`GIT_TERMINAL_PROMPT=0`, no credential helpers),
 *  - no target-repo hooks (`core.hooksPath` points at an empty directory),
 *  - target credentials travel as a per-command `http.extraheader`, never inside
 *    the remote URL, remote config or process arguments that git echoes back,
 *  - captured stderr/stdout is scrubbed of URL userinfo and Authorization
 *    header values before it can reach a log or a result package.
 *
 * The wrapper is intentionally dumb: callers decide depth, refspecs and
 * leases. That keeps the four kind implementations readable.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redact } from './log.mjs'

const GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_PAGER: 'cat',
  PAGER: 'cat'
})

let hooksDir = null

/** Empty hooks directory: relay must never execute target-repo hooks. */
function emptyHooksDir() {
  if (!hooksDir) {
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yichuan-relay-hooks-'))
    process.on('exit', () => {
      try {
        fs.rmSync(hooksDir, { recursive: true, force: true })
      } catch {
        // best effort
      }
    })
  }
  return hooksDir
}

function baseConfig() {
  return [
    '-c',
    `core.hooksPath=${emptyHooksDir()}`,
    '-c',
    'credential.helper=',
    // Never rewrite file content: relays must move bytes, not line endings
    // (git-archive applies core.autocrlf when the runner has it enabled).
    '-c',
    'core.autocrlf=false'
  ]
}

/** Scrub anything that could carry a secret out of git output. */
export function sanitize(text) {
  return redact(text, [])
}

function runGit(args, options = {}) {
  const configArgs = Array.isArray(options.configArgs) ? options.configArgs : []
  const fullArgs = [...baseConfig(), ...configArgs, ...args]
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      fullArgs,
      {
        cwd: options.cwd,
        env: { ...process.env, ...GIT_ENV, ...(options.env || {}) },
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        timeout: Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 0
      },
      (error, stdout, stderr) => {
        const out = String(stdout || '')
        const err = sanitize(String(stderr || ''))
        if (error) {
          const failure = new Error(`git ${args[0] || ''} failed`.trim())
          failure.name = 'GitCommandError'
          failure.exitCode = typeof error.code === 'number' ? error.code : null
          failure.stderr = err
          failure.stdout = sanitize(out)
          failure.gitCommand = args[0] || null
          if (error.signal) failure.signal = error.signal
          reject(failure)
          return
        }
        resolve({ stdout: out, stderr: err })
      }
    )
  })
}

/**
 * Per-command credentials for HTTP(S) remotes.
 *
 * GitHub accepts `x-access-token:<PAT>` as HTTP Basic credentials. Injecting
 * them as an extra header keeps the canonical remote URL (manifest.target.url)
 * untouched — which matters for stderr hygiene and for tests that rewrite
 * `url.<base>.insteadOf` to a local bare repository.
 */
export function credentialConfig(url, credential) {
  if (typeof credential !== 'string' || credential.length === 0) return []
  if (!/^https?:\/\//i.test(String(url))) return []
  const basic = Buffer.from(`x-access-token:${credential}`, 'utf8').toString('base64')
  return ['-c', `http.extraheader=Authorization: Basic ${basic}`]
}

/** Run an explicit git command (advanced callers: commit, rev-parse, ...). */
export async function exec(args, options = {}) {
  const result = await runGit(args, options)
  return result.stdout
}

async function execAllowFailure(args, options = {}) {
  try {
    const result = await runGit(args, options)
    return { code: 0, ...result }
  } catch (error) {
    if (error && error.name === 'GitCommandError') {
      return { code: error.exitCode === null ? 1 : error.exitCode, stdout: error.stdout || '', stderr: error.stderr || '' }
    }
    throw error
  }
}

export async function gitVersion() {
  const out = await exec(['--version'])
  return out.trim()
}

export async function initBare(dir) {
  await exec(['init', '-q', '--bare', dir])
}

export async function initWorktree(dir) {
  await exec(['init', '-q', dir])
}

export async function remoteAdd(cwd, name, url) {
  await exec(['remote', 'add', name, url], { cwd })
}

export async function remoteSetUrl(cwd, name, url) {
  await exec(['remote', 'set-url', name, url], { cwd })
}

export async function cloneBare(url, dest, options = {}) {
  await exec(['clone', '--bare', '--no-tags', '-q', url, dest], {
    cwd: options.cwd,
    configArgs: options.configArgs
  })
}

export async function cloneShallow(url, ref, dest, options = {}) {
  const branch = String(ref).replace(/^refs\/heads\//, '')
  await exec(['clone', '--depth=1', '--branch', branch, '--no-tags', '-q', url, dest], {
    cwd: options.cwd,
    configArgs: options.configArgs
  })
}

/**
 * Fetch `refspec` from a remote. `depth` requests a shallow history hint;
 * `unshallow` deepens a repository that was previously fetched shallow
 * (P7 fallback). The two are mutually exclusive.
 */
export async function fetchRef(cwd, remote, refspec, options = {}) {
  const args = ['fetch', '--no-tags', '--no-write-fetch-head']
  if (options.unshallow) args.push('--unshallow')
  else if (Number.isInteger(options.depth) && options.depth > 0) args.push(`--depth=${options.depth}`)
  args.push(remote, refspec)
  await exec(args, { cwd, configArgs: options.configArgs })
}

/** RELAY.md §4.1 step 4: shallow-fetch the base commit (`--depth=<depth>`). */
export async function fetchDepth(cwd, remote, refspec, depth, options = {}) {
  return fetchRef(cwd, remote, refspec, { ...options, depth })
}

/** Fallback for P7: deepen a shallow fetch, or do a plain full fetch. */
export async function fetchFull(cwd, remote, refspec, options = {}) {
  return fetchRef(cwd, remote, refspec, { ...options, depth: null })
}

export async function fetchBundle(cwd, bundlePath, srcRef, destRef = 'refs/yic/push') {
  await exec(['fetch', '--no-tags', bundlePath, `+${srcRef}:${destRef}`], { cwd })
}

/** Parse `git bundle list-heads <file>` into [{sha, ref}]. */
export async function bundleListHeads(bundlePath) {
  const out = await exec(['bundle', 'list-heads', bundlePath])
  const heads = []
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{40,64})\s+(\S+)\s*$/)
    if (match) heads.push({ sha: match[1].toLowerCase(), ref: match[2] })
  }
  return heads
}

export async function bundleCreate(bundlePath, cwd, refs, options = {}) {
  const list = Array.isArray(refs) ? refs : [refs]
  const args = ['bundle', 'create', bundlePath]
  if (typeof options.base === 'string' && options.base.length > 0) args.push(`^${options.base}`)
  args.push(...list)
  await exec(args, { cwd })
}

/**
 * Push `src` to `dest`.
 * `leaseBase` → `--force-with-lease=<dest>:<base>` (safe force);
 * `force` without a base → `--force`; neither → plain fast-forward push.
 */
export async function pushRef(cwd, remote, src, dest, options = {}) {
  const args = ['push']
  if (typeof options.leaseBase === 'string' && options.leaseBase.length > 0) {
    args.push(`--force-with-lease=${dest}:${options.leaseBase}`)
  } else if (options.force === true) {
    args.push('--force')
  }
  args.push(remote, `${src}:${dest}`)
  await exec(args, { cwd, configArgs: options.configArgs })
}

/**
 * RELAY.md §4.1 step 6: push with `--force-with-lease=<ref>:<base>`.
 * `leaseBase` is the APP-known remote sha; when it is empty this degrades to a
 * plain (or forced) push, because there is no expectation to protect.
 */
export async function pushWithLease(cwd, remote, src, dest, leaseBase, options = {}) {
  return pushRef(cwd, remote, src, dest, { ...options, leaseBase })
}

export async function revParse(cwd, rev) {
  const out = await exec(['rev-parse', '--verify', `${rev}^{commit}`], { cwd })
  return out.trim()
}

export async function tryRevParse(cwd, rev) {
  const result = await execAllowFailure(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd })
  if (result.code !== 0) return null
  const sha = result.stdout.trim()
  return sha.length > 0 ? sha : null
}

export async function catFileExists(cwd, rev) {
  if (typeof rev !== 'string' || rev.length === 0) return false
  const result = await execAllowFailure(['cat-file', '-e', `${rev}^{commit}`], { cwd })
  return result.code === 0
}

export async function isShallow(cwd) {
  const out = await exec(['rev-parse', '--is-shallow-repository'], { cwd })
  return out.trim() === 'true'
}

/** True when the index differs from HEAD (i.e. there is something to commit). */
export async function hasStagedChanges(cwd) {
  const result = await execAllowFailure(['diff', '--cached', '--quiet', '--ignore-submodules'], { cwd })
  return result.code !== 0
}

export async function addAll(cwd) {
  await exec(['add', '-A', '--', '.'], { cwd })
}

export async function checkoutOrphan(cwd, branch) {
  await exec(['checkout', '-q', '--orphan', branch], { cwd })
}

/**
 * Deterministic commit for snapshot publishing (RELAY.md §4.3):
 * author/committer and both dates come from the manifest, never from now().
 */
export async function commitDeterministic(cwd, message, options = {}) {
  const author = options.author && typeof options.author.name === 'string' && typeof options.author.email === 'string'
    ? options.author
    : { name: 'yichuan', email: 'yichuan@users.noreply.github.com' }
  const date = options.date || '1970-01-01T00:00:00Z'
  const args = ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', message]
  if (options.allowEmpty) args.push('--allow-empty')
  await exec(args, {
    cwd,
    env: {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_DATE: date,
      // Dates are absolute; pin TZ anyway so the commit object cannot depend on
      // the runner's local timezone.
      TZ: 'UTC'
    }
  })
}

/** Write a tar of `ref` from a (possibly bare) repository. */
export async function archiveTar(cwd, ref, outPath) {
  await exec(['archive', '--format=tar', ref, '-o', outPath], { cwd })
}

/**
 * Resolve `ref` on a remote without cloning.
 * Returns the sha, or null when the remote exists but has no such branch
 * (empty repository or a branch that has never been pushed).
 */
export async function lsRemoteRef(url, ref, options = {}) {
  const out = await exec(['ls-remote', '--heads', url, ref], { configArgs: options.configArgs })
  const wanted = String(ref)
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{40,64})\s+(.+?)\s*$/)
    if (match && match[2] === wanted) return match[1].toLowerCase()
  }
  return null
}
