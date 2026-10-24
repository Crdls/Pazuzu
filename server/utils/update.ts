/**
 * Version check and self-update. The running build is a git checkout, so its
 * version is the current commit SHA. A periodic loop asks `origin` for the
 * branch head (`git ls-remote`, no GitHub API/rate-limit involved); applying
 * an update is manual-only and hands off to scripts/autoupdate.mjs, which
 * pulls, rebuilds and restarts this server after it exits.
 *
 * The parsing helpers are pure and bare-Node-testable (test/update.test.mjs),
 * so every relative import here keeps its explicit .ts extension.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { loadConfig } from './config.ts'
import { runtime, type LastUpdateResult, type UpdateRuntime } from './runtime.ts'

const execFileAsync = promisify(execFile)

const FIRST_CHECK_MS = 30_000
const CHECK_EVERY_MS = 6 * 60 * 60_000

const SHA_RE = /^[0-9a-f]{40}$/

// ---------- pure helpers ----------

export function isSha (value: string | null | undefined): value is string {
  return typeof value === 'string' && SHA_RE.test(value)
}

/** Short form for the UI; '' for anything that is not a full sha. */
export function shortSha (sha: string | null | undefined): string {
  return isSha(sha) ? sha.slice(0, 7) : ''
}

/** Branch head from `git ls-remote origin refs/heads/<branch>` output. */
export function parseLsRemote (stdout: string, branch: string): string | null {
  for (const line of stdout.split('\n')) {
    const [sha, ref] = line.trim().split('\t')
    if (ref === `refs/heads/${branch}` && isSha(sha)) return sha
  }
  return null
}

export function updateAvailable (currentSha: string | null, latestSha: string | null): boolean {
  return isSha(currentSha) && isSha(latestSha) && currentSha !== latestSha
}

/** Normalize a git remote URL to its https project page (GitHub only). */
export function parseRemoteUrl (url: string | null | undefined): string | null {
  if (!url) return null
  const m = url.trim().match(/^(?:(?:(?:https?:\/\/|git:\/\/|ssh:\/\/)[^@/]*@?|git@)github\.com[:/])(.+?)(?:\.git)?\/?$/)
  const project = m?.[1]
  if (!project || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(project)) return null
  return `https://github.com/${project}`
}

export function compareUrl (repoUrl: string | null, currentSha: string | null, latestSha: string | null): string | null {
  if (!repoUrl || !isSha(currentSha) || !isSha(latestSha) || currentSha === latestSha) return null
  return `${repoUrl}/compare/${currentSha}...${latestSha}`
}

// ---------- git plumbing ----------

/** Run git in the project root; null when git or the checkout is missing. */
async function git (...args: string []): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: process.cwd(), windowsHide: true })
    return stdout.trim()
  } catch {
    return null
  }
}

function updateState (): UpdateRuntime {
  return runtime().update!
}

function dataDir (): string {
  return dirname(resolve(loadConfig().db.path))
}

/** Log of update runs; the detached updater and the restarted server write here too. */
export function updateLogFile (): string {
  return join(dataDir(), 'update.log')
}

function readLastUpdate (): LastUpdateResult | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir(), 'last-update.json'), 'utf8')) as Partial<LastUpdateResult>
    if (typeof raw?.startedAt !== 'number' || typeof raw?.finishedAt !== 'number' || typeof raw?.ok !== 'boolean') return null
    return {
      startedAt: raw.startedAt,
      finishedAt: raw.finishedAt,
      ok: raw.ok,
      step: typeof raw.step === 'string' ? raw.step : null,
      error: typeof raw.error === 'string' ? raw.error : null
    }
  } catch {
    return null
  }
}

async function readLocalVersion (st: UpdateRuntime): Promise<void> {
  const head = await git('rev-parse', 'HEAD')
  st.currentSha = isSha(head) ? head : null
  if (!st.currentSha) {
    st.branch = null
    st.commitTs = null
    return
  }
  const ts = await git('log', '-1', '--format=%ct')
  st.commitTs = ts && /^\d+$/.test(ts) ? Number(ts) * 1000 : null
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD')
  // detached HEAD reports "HEAD" itself — there is no branch to compare then
  st.branch = branch && branch !== 'HEAD' ? branch : null
  const remote = await git('remote', 'get-url', 'origin')
  st.repoUrl = remote ? parseRemoteUrl(remote) : null
}

// ---------- check loop ----------

export async function checkForUpdate (): Promise<UpdateRuntime> {
  const st = updateState()
  if (st.checking) return st
  st.checking = true
  try {
    if (!st.currentSha || !st.branch) await readLocalVersion(st)
    if (!st.branch) {
      st.error = 'not a git checkout with a tracked branch'
    } else {
      const out = await git('ls-remote', 'origin', `refs/heads/${st.branch}`)
      const sha = out === null ? null : parseLsRemote(out, st.branch)
      if (sha) {
        st.latestSha = sha
        st.error = null
      } else {
        st.error = out === null ? 'git ls-remote failed' : `branch ${st.branch} not found on origin`
        console.warn('[pazuzu] update check failed:', st.error)
      }
    }
  } finally {
    st.checkedAt = Date.now()
    st.checking = false
  }
  return st
}

function scheduleNextCheck (delayMs: number): void {
  const st = updateState()
  if (st.checkTimer) clearTimeout(st.checkTimer)
  st.checkTimer = setTimeout(() => {
    void checkForUpdate().finally(() => scheduleNextCheck(CHECK_EVERY_MS))
  }, delayMs)
  st.checkTimer.unref?.()
}

/** Called by server/plugins/update-check.ts on every boot/dev HMR reload. */
export async function initUpdate (): Promise<void> {
  const st = updateState()
  st.lastUpdate = readLastUpdate()
  await readLocalVersion(st)
  scheduleNextCheck(FIRST_CHECK_MS)
}

// ---------- apply ----------

/**
 * Spawn the detached updater and exit; it restarts the server afterwards.
 * Manual-only on purpose — the server never restarts by itself. Disabled in
 * dev mode (there is no .output to rebuild and the checkout is a workspace).
 */
export async function applyUpdate (): Promise<void> {
  const st = updateState()
  if (import.meta.dev) {
    throw createError({ statusCode: 400, statusMessage: 'Dev mode: apply updates by hand (update.sh / update.bat)' })
  }
  if (st.applying) throw createError({ statusCode: 409, statusMessage: 'An update is already running' })
  if (!st.currentSha) await readLocalVersion(st)
  if (!st.currentSha) throw createError({ statusCode: 400, statusMessage: 'Not a git checkout - cannot update' })
  const root = process.cwd()
  const script = join(root, 'scripts', 'autoupdate.mjs')
  if (!existsSync(script)) throw createError({ statusCode: 500, statusMessage: 'scripts/autoupdate.mjs is missing' })
  mkdirSync(dataDir(), { recursive: true })
  const log = openSync(updateLogFile(), 'a')
  // detached so it outlives this process; its console (and the restarted
  // server's) goes to data/update.log
  const child = spawn(process.execPath, [script, String(process.pid)], {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true
  })
  child.unref()
  st.applying = true
  // let the HTTP response flush, then leave - the updater waits for us to die
  setTimeout(() => process.exit(0), 500)
}

// ---------- API payload ----------

export function updateStatusPayload () {
  const st = updateState()
  return {
    currentSha: st.currentSha,
    commitTs: st.commitTs,
    branch: st.branch,
    latestSha: st.latestSha,
    updateAvailable: updateAvailable(st.currentSha, st.latestSha),
    compareUrl: compareUrl(st.repoUrl, st.currentSha, st.latestSha),
    checkedAt: st.checkedAt,
    checking: st.checking,
    error: st.error,
    dev: Boolean(import.meta.dev),
    applying: st.applying,
    lastUpdate: st.lastUpdate
  }
}
