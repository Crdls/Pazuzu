import {
  createSessionToken, hashToken, SESSION_COOKIE, SESSION_TTL_MS
} from './credentials'
import {
  countUsers, createSession, deleteSession, deleteUserSessions, extendSession,
  getSessionUser, purgeExpiredSessions, type UserRole
} from './db'
import { loadConfig, isGitlabReady } from './config'
import { canManageServer, effectiveRole, roleRank, type Actor } from './permissions'
import { runtime } from './runtime'

// re-export the primitives so auth consumers do not need two imports
export { SESSION_COOKIE, SESSION_TTL_MS, hashPassword, hashToken, cookieValue, verifyPassword, isPasswordValid, normalizeUsername } from './credentials'

export interface AuthUser {
  id: number
  username: string
  /** effective role — the view-as mask applied, so gates see what the user sees */
  role: UserRole
  /** actual role from the users table, untouched by masking */
  realRole: UserRole
  /** false for GitLab-created users who have not set a local password yet */
  hasPassword: boolean
  /** UI language saved on the account; null = browser detection */
  lang: string | null
}

export interface VerifiedSession {
  user: AuthUser
  tokenHash: string
  /** expiry was slid — the cookie should be re-sent to refresh its Max-Age */
  refreshed: boolean
}

/** Validate a raw token, slide the expiry when less than half of it is left. */
export function verifySessionToken (token: string | null | undefined): VerifiedSession | null {
  if (!token) return null
  const tokenHash = hashToken(token)
  const row = getSessionUser(tokenHash)
  if (!row) return null
  const now = Date.now()
  if (row.expires_at <= now || row.disabled) {
    // expired, or an admin froze this user: drop the session on the spot
    deleteSession(tokenHash)
    return null
  }
  let refreshed = false
  if (row.expires_at - now < SESSION_TTL_MS / 2) {
    extendSession(tokenHash, now + SESSION_TTL_MS)
    refreshed = true
  }
  // opportunistic cleanup, cheap enough to run sporadically
  if (Math.random() < 0.02) purgeExpiredSessions(now)
  return {
    user: {
      id: row.user_id,
      username: row.username,
      role: effectiveRole(row.role, row.view_as) as UserRole,
      realRole: row.role,
      hasPassword: row.pass_hash !== '',
      lang: row.lang ?? null
    },
    tokenHash,
    refreshed
  }
}

/** Gate for admin-only API routes; superadmins pass too. */
export function requireAdmin (event: NitroEvent): void {
  if (roleRank(event.context.userRole) < roleRank('admin')) {
    throw createError({ statusCode: 403, statusMessage: 'Admin access required' })
  }
}

/** Gate for superadmin-only API routes (config.json and future hidden settings). */
export function requireSuperadmin (event: NitroEvent): void {
  if (event.context.userRole !== 'superadmin') {
    throw createError({ statusCode: 403, statusMessage: 'Superuser access required' })
  }
}

/** Only the creator or an admin may change a server (nobody checked while auth is off). */
export function assertCanManageServer (event: NitroEvent, server: { created_by: number | null }): void {
  const actor: Actor = { userId: event.context.userId, userRole: event.context.userRole }
  if (!canManageServer(loadConfig().auth.enabled, actor, server)) {
    throw createError({ statusCode: 403, statusMessage: 'Only the creator or an admin can change this server' })
  }
}

export function setSessionCookie (event: NitroEvent, token: string): void {
  setCookie(event, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000
  })
}

/** Create a session row and send the cookie. */
export function startSession (event: NitroEvent, userId: number): void {
  const token = createSessionToken()
  createSession(hashToken(token), userId, Date.now() + SESSION_TTL_MS)
  setSessionCookie(event, token)
}

export function endSession (event: NitroEvent): void {
  const token = getCookie(event, SESSION_COOKIE)
  if (token) deleteSession(hashToken(token))
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
}

/**
 * Public payload telling the frontend whether to show sign-in or setup.
 * `signedInAs` overrides the cookie lookup right after login/setup, when the
 * session cookie is only on the response, not yet on a request.
 */
export function authStatus (
  event: NitroEvent,
  signedInAs?: AuthUser | null
): { authEnabled: boolean, gitlabEnabled: boolean, hasUsers: boolean, user: AuthUser | null } {
  const cfg = loadConfig()
  const session = signedInAs ?? (cfg.auth.enabled ? verifySessionToken(getCookie(event, SESSION_COOKIE))?.user ?? null : null)
  return {
    authEnabled: cfg.auth.enabled,
    gitlabEnabled: isGitlabReady(cfg),
    hasUsers: countUsers() > 0,
    user: session ?? null
  }
}

// ---------- login throttle (slows down password guessing) ----------

const FAIL_FREE = 5
const FAIL_WINDOW_MS = 15 * 60 * 1000
const FAIL_MAX_DELAY_MS = 5000

export function recordLoginFailure (key: string): void {
  const fails = runtime().authFails
  const now = Date.now()
  const entry = fails.get(key)
  if (!entry || now - entry.last > FAIL_WINDOW_MS) fails.set(key, { fails: 1, last: now })
  else fails.set(key, { fails: entry.fails + 1, last: now })
  if (fails.size > 1000) {
    for (const [k, v] of fails) if (now - v.last > FAIL_WINDOW_MS) fails.delete(k)
  }
}

export function clearLoginFailures (key: string): void {
  runtime().authFails.delete(key)
}

/** Wait before answering when this key has failed too many logins recently. */
export async function throttleLogin (key: string): Promise<void> {
  const entry = runtime().authFails.get(key)
  if (!entry || entry.fails <= FAIL_FREE || Date.now() - entry.last > FAIL_WINDOW_MS) return
  const delay = Math.min(250 * 2 ** (entry.fails - FAIL_FREE - 1), FAIL_MAX_DELAY_MS)
  await new Promise(resolve => setTimeout(resolve, delay))
}
