import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { loadConfig } from './config.ts'
import type { ClientPriority, GatewayMode } from './gateway/types.ts'

export type UserRole = 'admin' | 'user'

export interface ServerRow {
  id: number
  name: string
  url: string
  enabled: number
  created_at: number
  /** user who added the server; null for pre-roles rows and auth-disabled setups */
  created_by: number | null
  /** bearer token for /metrics; null when the Strata endpoint is open */
  api_key: string | null
  /** gateway routing state: route to it, finish existing only, stats only */
  gateway_mode: GatewayMode
  /** gateway concurrency cap; null = auto (engine live_slots, else config default) */
  gateway_capacity: number | null
}

export interface UserRow {
  id: number
  username: string
  pass_hash: string
  role: UserRole
  /** user signed up through GitLab OAuth */
  gitlab: number
  /** access frozen by an admin: cannot sign in, existing sessions die */
  disabled: number
  created_at: number
  last_login: number | null
  /** UI language code; null = follow browser detection */
  lang: string | null
}

export interface SessionUserRow {
  token_hash: string
  user_id: number
  expires_at: number
  username: string
  role: UserRole
  pass_hash: string
  disabled: number
  lang: string | null
}

export interface GatewayClientRow {
  id: number
  name: string
  /** sha256 hex of the bearer token; the raw value is never stored */
  token_hash: string
  /** non-secret label for the admin table */
  token_hint: string
  priority: ClientPriority
  /** expose X-Pazuzu-* debug headers on this client's responses */
  debug: number
  enabled: number
  /** 1 = every gateway server is reachable; 0 = only the gateway_client_servers pairs */
  servers_all: number
  created_at: number
  created_by: number | null
}

export interface Settings {
  scrapeIntervalS: number
  rollupIntervalS: number
  rawRetentionH: number
  hourlyRetentionD: number
}

export const SETTINGS_DEFAULTS: Settings = {
  scrapeIntervalS: 10,
  rollupIntervalS: 30,
  rawRetentionH: 48,
  hourlyRetentionD: 400
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS servers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL UNIQUE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_by INTEGER,
  api_key    TEXT
);
CREATE TABLE IF NOT EXISTS server_status (
  server_id INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  up        INTEGER NOT NULL,
  error     TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE,
  pass_hash  TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'admin',
  gitlab     INTEGER NOT NULL DEFAULT 0,
  disabled   INTEGER NOT NULL DEFAULT 0,
  lang       TEXT,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS samples (
  server_id INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  metric    TEXT NOT NULL,
  labels    TEXT NOT NULL DEFAULT '',
  value     REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_lookup ON samples (server_id, metric, ts);
CREATE TABLE IF NOT EXISTS rollup_hourly (
  server_id INTEGER NOT NULL,
  hour      INTEGER NOT NULL,
  metric    TEXT NOT NULL,
  labels    TEXT NOT NULL DEFAULT '',
  avg       REAL NOT NULL,
  max       REAL NOT NULL,
  min       REAL NOT NULL,
  n         INTEGER NOT NULL,
  PRIMARY KEY (server_id, hour, metric, labels)
);
CREATE TABLE IF NOT EXISTS rollup_daily (
  server_id INTEGER NOT NULL,
  day       INTEGER NOT NULL,
  metric    TEXT NOT NULL,
  labels    TEXT NOT NULL DEFAULT '',
  avg       REAL NOT NULL,
  max       REAL NOT NULL,
  min       REAL NOT NULL,
  n         INTEGER NOT NULL,
  PRIMARY KEY (server_id, day, metric, labels)
);
CREATE TABLE IF NOT EXISTS gateway_clients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  priority   TEXT NOT NULL DEFAULT 'normal',
  debug      INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_by INTEGER
);
CREATE TABLE IF NOT EXISTS gateway_client_ips (
  client_id  INTEGER NOT NULL,
  ip         TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, ip)
);
CREATE TABLE IF NOT EXISTS gateway_sessions (
  key_hash  TEXT PRIMARY KEY,
  server_id INTEGER NOT NULL,
  last_used INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gateway_usage (
  client_id     INTEGER NOT NULL,
  day           INTEGER NOT NULL,
  requests      INTEGER NOT NULL DEFAULT 0,
  ok            INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  gen_tokens    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, day)
);
CREATE TABLE IF NOT EXISTS gateway_client_servers (
  client_id INTEGER NOT NULL,
  server_id INTEGER NOT NULL,
  PRIMARY KEY (client_id, server_id)
);
CREATE INDEX IF NOT EXISTS idx_gcs_server ON gateway_client_servers (server_id);
`

let db: Database.Database | null = null

/** Add a column to an existing table (no migration system - keep this idempotent). */
function ensureColumn (db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}

export function useDb (): Database.Database {
  if (!db) {
    // config.json db.path (relative resolves from the project root);
    // applied at startup - restart after changing it
    const path = resolve(loadConfig().db.path)
    mkdirSync(dirname(path), { recursive: true })
    db = new Database(path)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.exec(SCHEMA)
    // upgrades for databases created before the column existed
    ensureColumn(db, 'servers', 'created_by', 'INTEGER')
    ensureColumn(db, 'servers', 'api_key', 'TEXT')
    ensureColumn(db, 'users', 'gitlab', 'INTEGER NOT NULL DEFAULT 0')
    ensureColumn(db, 'users', 'disabled', 'INTEGER NOT NULL DEFAULT 0')
    ensureColumn(db, 'servers', 'gateway_mode', "TEXT NOT NULL DEFAULT 'on'")
    ensureColumn(db, 'servers', 'gateway_capacity', 'INTEGER')
    ensureColumn(db, 'users', 'lang', 'TEXT')
    ensureColumn(db, 'gateway_clients', 'servers_all', 'INTEGER NOT NULL DEFAULT 1')
    // an empty pass_hash could only ever come from the GitLab OAuth sign-up
    db.prepare("UPDATE users SET gitlab = 1 WHERE pass_hash = '' AND gitlab = 0").run()
  }
  return db
}

export function getSettings (): Settings {
  const rows = useDb().prepare('SELECT key, value FROM settings').all() as Array<{ key: string, value: string }>
  const stored = Object.fromEntries(rows.map(r => [r.key, r.value]))
  return {
    scrapeIntervalS: Number(stored.scrape_interval_s ?? SETTINGS_DEFAULTS.scrapeIntervalS),
    rollupIntervalS: Number(stored.rollup_interval_s ?? SETTINGS_DEFAULTS.rollupIntervalS),
    rawRetentionH: Number(stored.raw_retention_h ?? SETTINGS_DEFAULTS.rawRetentionH),
    hourlyRetentionD: Number(stored.hourly_retention_d ?? SETTINGS_DEFAULTS.hourlyRetentionD)
  }
}

export function saveSettings (patch: Partial<Settings>): Settings {
  const stmt = useDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  const map: Record<keyof Settings, string> = {
    scrapeIntervalS: 'scrape_interval_s',
    rollupIntervalS: 'rollup_interval_s',
    rawRetentionH: 'raw_retention_h',
    hourlyRetentionD: 'hourly_retention_d'
  }
  for (const key of Object.keys(map) as Array<keyof Settings>) {
    if (patch[key] !== undefined) stmt.run(map[key], String(patch[key]))
  }
  return getSettings()
}

// ---------- users ----------

export function countUsers (): number {
  return (useDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
}

export function getUserById (id: number): UserRow | null {
  return useDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | null
}

export function getUserByUsername (username: string): UserRow | null {
  return useDb().prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | null
}

/** All users without the password hash, for the admin table. */
export function listUsers (): Array<Omit<UserRow, 'pass_hash'>> {
  return useDb()
    .prepare('SELECT id, username, role, gitlab, disabled, created_at, last_login FROM users ORDER BY username COLLATE NOCASE')
    .all() as Array<Omit<UserRow, 'pass_hash'>>
}

export function createUser (username: string, passHash: string, role: UserRole, gitlab: boolean): UserRow {
  const info = useDb()
    .prepare('INSERT INTO users (username, pass_hash, role, gitlab, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, passHash, role, gitlab ? 1 : 0, Date.now())
  return getUserById(Number(info.lastInsertRowid))!
}

export function updateUser (userId: number, patch: { role?: UserRole, disabled?: boolean, passHash?: string }): void {
  const sets: string[] = []
  const args: Array<string | number> = []
  if (patch.role !== undefined) { sets.push('role = ?'); args.push(patch.role) }
  if (patch.disabled !== undefined) { sets.push('disabled = ?'); args.push(patch.disabled ? 1 : 0) }
  if (patch.passHash !== undefined) { sets.push('pass_hash = ?'); args.push(patch.passHash) }
  if (sets.length === 0) return
  args.push(userId)
  useDb().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args)
}

export function deleteUser (userId: number): void {
  useDb().prepare('DELETE FROM users WHERE id = ?').run(userId)
}

/** Admins who can still sign in - there must always be at least one. */
export function countActiveAdmins (): number {
  return (useDb()
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")
    .get() as { n: number }).n
}

export function updatePassword (userId: number, passHash: string): void {
  useDb().prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(passHash, userId)
}

/** UI language of a user; null resets to browser detection. */
export function updateUserLang (userId: number, lang: string | null): void {
  useDb().prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, userId)
}

export function touchLastLogin (userId: number): void {
  useDb().prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), userId)
}

// ---------- sessions ----------

export function createSession (tokenHash: string, userId: number, expiresAt: number): void {
  useDb()
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(tokenHash, userId, Date.now(), expiresAt)
}

export function getSessionUser (tokenHash: string): SessionUserRow | null {
  return useDb()
    .prepare(`SELECT s.token_hash, s.user_id, s.expires_at, u.username, u.role, u.pass_hash, u.disabled, u.lang
              FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.token_hash = ?`)
    .get(tokenHash) as SessionUserRow | null
}

export function extendSession (tokenHash: string, expiresAt: number): void {
  useDb().prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(expiresAt, tokenHash)
}

export function deleteSession (tokenHash: string): void {
  useDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
}

/** Sign a user's sessions out; pass `exceptTokenHash` to keep the current one. */
export function deleteUserSessions (userId: number, exceptTokenHash: string | null = null): void {
  useDb()
    .prepare('DELETE FROM sessions WHERE user_id = ? AND (? IS NULL OR token_hash <> ?)')
    .run(userId, exceptTokenHash, exceptTokenHash)
}

export function purgeExpiredSessions (now: number): void {
  useDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
}

// ---------- gateway: clients ----------

export interface GatewayClientRowWithStats extends GatewayClientRow {
  requests_total: number
  errors_total: number
  tokens_total: number
  requests_today: number
}

const CLIENT_STATS = `SELECT c.*,
  COALESCE(SUM(u.requests), 0) AS requests_total,
  COALESCE(SUM(u.errors), 0) AS errors_total,
  COALESCE(SUM(u.prompt_tokens + u.gen_tokens), 0) AS tokens_total,
  COALESCE(SUM(CASE WHEN u.day = ? THEN u.requests ELSE 0 END), 0) AS requests_today
  FROM gateway_clients c LEFT JOIN gateway_usage u ON u.client_id = c.id
  GROUP BY c.id ORDER BY c.name COLLATE NOCASE`

/** All clients with usage totals; `today` is a UTC day boundary in ms. */
export function listGatewayClients (today: number): GatewayClientRowWithStats[] {
  return useDb().prepare(CLIENT_STATS).all(today) as GatewayClientRowWithStats[]
}

export function countGatewayClients (): number {
  return (useDb().prepare('SELECT COUNT(*) AS n FROM gateway_clients').get() as { n: number }).n
}

export function getGatewayClientById (id: number): GatewayClientRow | null {
  return useDb().prepare('SELECT * FROM gateway_clients WHERE id = ?').get(id) as GatewayClientRow | null
}

export function getGatewayClientByTokenHash (tokenHash: string): GatewayClientRow | null {
  return useDb().prepare('SELECT * FROM gateway_clients WHERE token_hash = ?').get(tokenHash) as GatewayClientRow | null
}

export function createGatewayClient (input: {
  name: string
  tokenHash: string
  tokenHint: string
  priority: ClientPriority
  debug: boolean
  createdBy: number | null
}): GatewayClientRow {
  const info = useDb()
    .prepare('INSERT INTO gateway_clients (name, token_hash, token_hint, priority, debug, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(input.name, input.tokenHash, input.tokenHint, input.priority, input.debug ? 1 : 0, Date.now(), input.createdBy)
  return getGatewayClientById(Number(info.lastInsertRowid))!
}

export function updateGatewayClient (id: number, patch: { name?: string, priority?: ClientPriority, debug?: boolean, enabled?: boolean }): void {
  const sets: string[] = []
  const args: Array<string | number> = []
  if (patch.name !== undefined) { sets.push('name = ?'); args.push(patch.name) }
  if (patch.priority !== undefined) { sets.push('priority = ?'); args.push(patch.priority) }
  if (patch.debug !== undefined) { sets.push('debug = ?'); args.push(patch.debug ? 1 : 0) }
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); args.push(patch.enabled ? 1 : 0) }
  if (sets.length === 0) return
  args.push(id)
  useDb().prepare(`UPDATE gateway_clients SET ${sets.join(', ')} WHERE id = ?`).run(...args)
}

export function setGatewayClientToken (id: number, tokenHash: string, tokenHint: string): void {
  useDb().prepare('UPDATE gateway_clients SET token_hash = ?, token_hint = ? WHERE id = ?').run(tokenHash, tokenHint, id)
}

/** Delete a client with its IP history, usage counters and server access. */
export function deleteGatewayClient (id: number): void {
  const db = useDb()
  db.transaction(() => {
    db.prepare('DELETE FROM gateway_client_ips WHERE client_id = ?').run(id)
    db.prepare('DELETE FROM gateway_usage WHERE client_id = ?').run(id)
    db.prepare('DELETE FROM gateway_client_servers WHERE client_id = ?').run(id)
    db.prepare('DELETE FROM gateway_clients WHERE id = ?').run(id)
  })()
}

export function listClientIps (clientId: number, limit: number): Array<{ ip: string, first_seen: number, last_seen: number, hits: number }> {
  return useDb()
    .prepare('SELECT ip, first_seen, last_seen, hits FROM gateway_client_ips WHERE client_id = ? ORDER BY last_seen DESC LIMIT ?')
    .all(clientId, limit) as Array<{ ip: string, first_seen: number, last_seen: number, hits: number }>
}

// ---------- gateway: client ⇄ server access ----------

/** Server ids explicitly granted to a client (only used when servers_all = 0). */
export function listClientServerIds (clientId: number): number[] {
  return (useDb()
    .prepare('SELECT server_id FROM gateway_client_servers WHERE client_id = ? ORDER BY server_id')
    .all(clientId) as Array<{ server_id: number }>).map(r => r.server_id)
}

/**
 * The router's view of a client's access: null = every server, otherwise the
 * explicitly granted ids (an empty set when the selection was emptied).
 */
export function allowedServerIds (clientId: number): Set<number> | null {
  const row = useDb().prepare('SELECT servers_all FROM gateway_clients WHERE id = ?').get(clientId) as { servers_all: number } | undefined
  if (!row || row.servers_all === 1) return null
  return new Set(listClientServerIds(clientId))
}

/** Client-side edit: either no restrictions or an explicit list of servers. */
export function setClientServerAccess (clientId: number, serversAll: boolean, serverIds: number[]): void {
  const db = useDb()
  db.transaction(() => {
    db.prepare('UPDATE gateway_clients SET servers_all = ? WHERE id = ?').run(serversAll ? 1 : 0, clientId)
    db.prepare('DELETE FROM gateway_client_servers WHERE client_id = ?').run(clientId)
    if (serversAll) return
    const ins = db.prepare('INSERT OR IGNORE INTO gateway_client_servers (client_id, server_id) VALUES (?, ?)')
    for (const serverId of new Set(serverIds)) ins.run(clientId, serverId)
  })()
}

/**
 * Server-side edit: the full set of clients allowed to route through this
 * server. Unchecking an unrestricted client flips it to an explicit selection
 * of the other current servers (future servers are then not granted
 * automatically); checking a restricted client just adds the pair.
 */
export function setServerClientAccess (serverId: number, clientIds: number[]): void {
  const db = useDb()
  const wanted = new Set(clientIds)
  const clients = db.prepare('SELECT id, servers_all FROM gateway_clients').all() as Array<{ id: number, servers_all: number }>
  const otherServers = (db.prepare('SELECT id FROM servers WHERE id <> ?').all(serverId) as Array<{ id: number }>).map(r => r.id)
  const hasPair = db.prepare('SELECT 1 FROM gateway_client_servers WHERE client_id = ? AND server_id = ?')
  const addPair = db.prepare('INSERT OR IGNORE INTO gateway_client_servers (client_id, server_id) VALUES (?, ?)')
  db.transaction(() => {
    for (const c of clients) {
      const allowed = c.servers_all === 1 || !!hasPair.get(c.id, serverId)
      if (wanted.has(c.id)) {
        if (!allowed) addPair.run(c.id, serverId)
        continue
      }
      if (!allowed) continue
      if (c.servers_all === 1) {
        db.prepare('UPDATE gateway_clients SET servers_all = 0 WHERE id = ?').run(c.id)
        for (const sid of otherServers) addPair.run(c.id, sid)
      } else {
        db.prepare('DELETE FROM gateway_client_servers WHERE client_id = ? AND server_id = ?').run(c.id, serverId)
      }
    }
  })()
}

// ---------- gateway: chat affinity ----------

export function getGatewaySessionServer (keyHash: string): number | null {
  const row = useDb().prepare('SELECT server_id FROM gateway_sessions WHERE key_hash = ?').get(keyHash) as { server_id: number } | null
  return row ? row.server_id : null
}

export function upsertGatewaySession (keyHash: string, serverId: number, ts: number): void {
  useDb()
    .prepare(`INSERT INTO gateway_sessions (key_hash, server_id, last_used) VALUES (?, ?, ?)
              ON CONFLICT(key_hash) DO UPDATE SET server_id = excluded.server_id, last_used = excluded.last_used`)
    .run(keyHash, serverId, ts)
}

export function purgeGatewaySessions (olderThanTs: number): void {
  useDb().prepare('DELETE FROM gateway_sessions WHERE last_used < ?').run(olderThanTs)
}

// ---------- gateway: stats flushing (batches from the in-memory aggregators) ----------

export interface IpFlushRow { clientId: number, ip: string, first: number, last: number, hits: number }

export function flushGatewayIpHits (rows: IpFlushRow[]): void {
  if (rows.length === 0) return
  const stmt = useDb().prepare(`INSERT INTO gateway_client_ips (client_id, ip, first_seen, last_seen, hits)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(client_id, ip) DO UPDATE SET
      first_seen = MIN(first_seen, excluded.first_seen),
      last_seen = MAX(last_seen, excluded.last_seen),
      hits = gateway_client_ips.hits + excluded.hits`)
  useDb().transaction(() => {
    for (const r of rows) stmt.run(r.clientId, r.ip, r.first, r.last, r.hits)
  })()
}

export interface UsageFlushRow {
  clientId: number
  day: number
  requests: number
  ok: number
  errors: number
  promptTokens: number
  genTokens: number
}

export function flushGatewayUsage (rows: UsageFlushRow[]): void {
  if (rows.length === 0) return
  const stmt = useDb().prepare(`INSERT INTO gateway_usage (client_id, day, requests, ok, errors, prompt_tokens, gen_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id, day) DO UPDATE SET
      requests = requests + excluded.requests,
      ok = ok + excluded.ok,
      errors = errors + excluded.errors,
      prompt_tokens = prompt_tokens + excluded.prompt_tokens,
      gen_tokens = gen_tokens + excluded.gen_tokens`)
  useDb().transaction(() => {
    for (const r of rows) stmt.run(r.clientId, r.day, r.requests, r.ok, r.errors, r.promptTokens, r.genTokens)
  })()
}
