import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runtime } from './runtime.ts'

/**
 * System-level settings kept in `config.json` next to the project root —
 * unlike the scrape settings in the DB these are edited by admins only:
 * the Settings page reads and writes them through `/api/config`, whose only
 * writer is `saveConfig` below (hand-editing the file stays supported).
 * `db.path` still applies only when the DB opens at startup.
 * This file is reachable from bare Node (via db.ts), keep relative imports
 * with explicit `.ts` extensions.
 */
export interface GitlabAuth {
  enabled: boolean
  /** base URL of the GitLab server without a trailing slash, e.g. http://gitlab.lan */
  baseUrl: string
  clientId: string
  clientSecret: string
  /** OAuth callback override; empty = derived from the incoming request.
   * Must be the full callback URL, e.g. http://host:3003/api/auth/gitlab/callback */
  redirectUri: string
  /** GitLab groups whose members may sign in (subgroups inherit); empty = any user */
  allowedGroups: string[]
  /** PEM file with the internal CA that signs the GitLab certificate;
   * relative paths resolve from the project root; empty = system CAs only */
  caCert: string
  /** skip TLS certificate verification for GitLab requests (trusted LAN only) */
  insecureTls: boolean
}

export interface GatewayConfig {
  /** master switch for the /v1 load-balancing proxy (off by default) */
  enabled: boolean
  /** how long a request may wait in the priority queue before a 429 */
  queueTimeoutS: number
  /** global queue depth; arrivals beyond it are 429-ed immediately */
  queueMax: number
  /** per-client queue depth; protects the queue from one chatty client */
  queueMaxPerClient: number
  /** chat -> server affinity mappings idle longer than this are dropped */
  sessionIdleMin: number
  /** per-server concurrency when gateway_capacity is unset and no live_slots */
  defaultCapacity: number
  /** how long a server that errored on a live request is skipped by routing */
  ejectionS: number
}

export interface AppConfig {
  db: {
    /** SQLite file; relative paths resolve from the project root (cwd) */
    path: string
  }
  auth: {
    enabled: boolean
    gitlab: GitlabAuth
  }
  gateway: GatewayConfig
}

export const GATEWAY_DEFAULTS: GatewayConfig = {
  enabled: false,
  queueTimeoutS: 60,
  queueMax: 200,
  queueMaxPerClient: 20,
  sessionIdleMin: 60,
  defaultCapacity: 32,
  ejectionS: 30
}

/** ranges of the numeric gateway knobs, shared by file parsing and UI validation */
const GATEWAY_LIMITS: Record<Exclude<keyof GatewayConfig, 'enabled'>, [number, number]> = {
  queueTimeoutS: [1, 3600],
  queueMax: [1, 10000],
  queueMaxPerClient: [1, 1000],
  sessionIdleMin: [1, 43200],
  defaultCapacity: [1, 4096],
  ejectionS: [1, 3600]
}

export const CONFIG_DEFAULTS: AppConfig = {
  db: { path: 'data/data.db' },
  auth: {
    enabled: false,
    gitlab: { enabled: false, baseUrl: '', clientId: '', clientSecret: '', redirectUri: '', allowedGroups: [], caCert: '', insecureTls: false }
  },
  gateway: GATEWAY_DEFAULTS
}

export function configPath (): string {
  return process.env.PAZUZU_CONFIG || resolve(process.cwd(), 'config.json')
}

function str (raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

function parseGitlab (raw: unknown): GitlabAuth {
  const g = raw as Record<string, unknown> | undefined
  return {
    enabled: g?.enabled === true,
    baseUrl: str(g?.baseUrl).replace(/\/+$/, ''),
    clientId: str(g?.clientId),
    clientSecret: str(g?.clientSecret),
    redirectUri: str(g?.redirectUri),
    allowedGroups: Array.isArray(g?.allowedGroups)
      ? (g.allowedGroups as unknown[]).map(str).filter(s => s !== '')
      : [],
    caCert: str(g?.caCert),
    insecureTls: g?.insecureTls === true
  }
}

/** GitLab sign-in actually usable: auth on + gitlab on + all required fields set. */
export function isGitlabReady (cfg: AppConfig): boolean {
  const g = cfg.auth.gitlab
  return cfg.auth.enabled && g.enabled && g.baseUrl !== '' && g.clientId !== '' && g.clientSecret !== ''
}

/** config numbers are best-effort: anything invalid or out of range -> default */
function numRange (raw: unknown, def: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def
  const n = Math.round(raw)
  return n < min || n > max ? def : n
}

function parseGateway (raw: unknown): GatewayConfig {
  const g = raw as Record<string, unknown> | undefined
  const gw = { enabled: g?.enabled === true } as GatewayConfig
  for (const key of Object.keys(GATEWAY_LIMITS) as Array<keyof typeof GATEWAY_LIMITS>) {
    const [min, max] = GATEWAY_LIMITS[key]!
    gw[key] = numRange(g?.[key], GATEWAY_DEFAULTS[key], min, max)
  }
  return gw
}

export function parseConfig (text: string | null): AppConfig {
  if (!text) return CONFIG_DEFAULTS
  try {
    const raw = JSON.parse(text) as { db?: { path?: unknown }, auth?: { enabled?: unknown, gitlab?: unknown }, gateway?: unknown }
    const path = typeof raw?.db?.path === 'string' && raw.db.path.trim() ? raw.db.path.trim() : CONFIG_DEFAULTS.db.path
    return {
      db: { path },
      auth: { enabled: raw?.auth?.enabled === true, gitlab: parseGitlab(raw?.auth?.gitlab) },
      gateway: parseGateway(raw?.gateway)
    }
  } catch (err) {
    console.error('[pazuzu] could not parse config.json, using defaults:', err)
    return CONFIG_DEFAULTS
  }
}

/**
 * Read `config.json` from the project root. The file is optional — when it is
 * missing or invalid we fall back to the defaults. The cached value is
 * reloaded whenever the file mtime changes, so `auth.enabled` edits apply
 * without a restart (`db.path` is applied only when the DB opens at startup).
 */
export function loadConfig (): AppConfig {
  const rt = runtime()
  let mtime = 0
  try {
    mtime = statSync(configPath()).mtimeMs
  } catch { /* no config file */ }
  const cache = rt.config
  if (!cache || cache.mtime !== mtime) {
    let text: string | null = null
    if (mtime > 0) {
      try {
        text = readFileSync(configPath(), 'utf8')
      } catch (err) {
        console.error('[pazuzu] could not read config.json, using defaults:', err)
      }
    }
    const value = parseConfig(text)
    if (value.auth.gitlab.enabled && value.auth.gitlab.insecureTls) {
      console.warn('[pazuzu] GitLab TLS certificate verification is disabled (auth.gitlab.insecureTls)')
    }
    rt.config = { mtime, value }
  }
  return rt.config.value
}

/** Raw text of the current config file; null when it is absent or unreadable. */
export function readConfigText (): string | null {
  try {
    return readFileSync(configPath(), 'utf8')
  } catch {
    return null
  }
}

function valStr (raw: unknown, key: string, errors: string[]): string {
  if (typeof raw !== 'string') {
    errors.push(`${key}: string expected`)
    return ''
  }
  return raw.trim()
}

function valBool (raw: unknown, key: string, errors: string[]): boolean {
  if (typeof raw !== 'boolean') {
    errors.push(`${key}: true or false expected`)
    return false
  }
  return raw
}

export interface ConfigValidation {
  errors: string[]
  /** normalized config, only meaningful when `errors` is empty */
  config: AppConfig
}

/**
 * Strict counterpart of parseConfig for the admin UI form: instead of
 * silently falling back to defaults, every bad value is reported in errors.
 */
export function validateConfigInput (body: unknown): ConfigValidation {
  const errors: string[] = []
  const src = (body ?? {}) as Record<string, unknown>
  const dbRaw = (src.db ?? {}) as Record<string, unknown>
  const authRaw = (src.auth ?? {}) as Record<string, unknown>
  const glRaw = (authRaw.gitlab ?? {}) as Record<string, unknown>
  const gwRaw = (src.gateway ?? {}) as Record<string, unknown>

  const dbPath = valStr(dbRaw.path, 'db.path', errors)
  if (dbPath === '') errors.push('db.path: cannot be empty')

  if (!Array.isArray(glRaw.allowedGroups)) errors.push('auth.gitlab.allowedGroups: array expected')
  const gitlab: GitlabAuth = {
    enabled: valBool(glRaw.enabled, 'auth.gitlab.enabled', errors),
    baseUrl: valStr(glRaw.baseUrl, 'auth.gitlab.baseUrl', errors).replace(/\/+$/, ''),
    clientId: valStr(glRaw.clientId, 'auth.gitlab.clientId', errors),
    clientSecret: valStr(glRaw.clientSecret, 'auth.gitlab.clientSecret', errors),
    redirectUri: valStr(glRaw.redirectUri, 'auth.gitlab.redirectUri', errors),
    allowedGroups: Array.isArray(glRaw.allowedGroups)
      ? (glRaw.allowedGroups as unknown[]).map(str).filter(s => s !== '')
      : [],
    caCert: valStr(glRaw.caCert, 'auth.gitlab.caCert', errors),
    insecureTls: valBool(glRaw.insecureTls, 'auth.gitlab.insecureTls', errors)
  }
  if (gitlab.enabled && (gitlab.baseUrl === '' || gitlab.clientId === '' || gitlab.clientSecret === '')) {
    errors.push('auth.gitlab: baseUrl, clientId and clientSecret are required when it is enabled')
  }

  const gateway = { enabled: valBool(gwRaw.enabled, 'gateway.enabled', errors) } as GatewayConfig
  for (const key of Object.keys(GATEWAY_LIMITS) as Array<keyof typeof GATEWAY_LIMITS>) {
    const [min, max] = GATEWAY_LIMITS[key]!
    const raw = gwRaw[key]
    const n = typeof raw === 'number' ? Math.round(raw) : NaN
    if (!Number.isFinite(n) || n < min || n > max) {
      errors.push(`gateway.${key}: whole number between ${min} and ${max} expected`)
      gateway[key] = GATEWAY_DEFAULTS[key]
    } else {
      gateway[key] = n
    }
  }

  return {
    errors,
    config: {
      db: { path: dbPath },
      auth: { enabled: valBool(authRaw.enabled, 'auth.enabled', errors), gitlab },
      gateway
    }
  }
}

/**
 * Serialize `cfg` onto the existing file text: the known fields are rewritten
 * from the form, keys this version of Pazuzu does not know about survive the
 * round trip. Unparsable existing text is replaced with a clean file.
 */
export function mergeConfigText (existing: string | null, cfg: AppConfig): string {
  let raw: Record<string, unknown> = {}
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>
    } catch { /* hand-broken file: write a clean one */ }
  }
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const db = { ...obj(raw.db), path: cfg.db.path }
  const gitlab = { ...obj(obj(raw.auth).gitlab), ...cfg.auth.gitlab }
  const auth = { ...obj(raw.auth), enabled: cfg.auth.enabled, gitlab }
  const gateway = { ...obj(raw.gateway), ...cfg.gateway }
  return JSON.stringify({ ...raw, db, auth, gateway }, null, 2) + '\n'
}

/**
 * Write config.json from the admin UI: atomic replace (tmp + rename),
 * unknown keys kept, and the mtime cache dropped so `loadConfig()` returns
 * the new values right away. Returns the freshly loaded config.
 */
export function saveConfig (cfg: AppConfig): AppConfig {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, mergeConfigText(readConfigText(), cfg))
  renameSync(tmp, path)
  runtime().config = undefined
  return loadConfig()
}
