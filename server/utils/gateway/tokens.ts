import { randomBytes } from 'node:crypto'

/**
 * Gateway client API-key primitives. Only the sha256 hash of a token is
 * stored (with `hashToken` from ./credentials.ts — one sha256 helper per app);
 * the raw value is shown once at creation/rotation. Self-contained
 * (node:crypto only) so it is reachable from bare Node tests.
 */

export const TOKEN_PREFIX = 'pzz_'

/** `pzz_` + 32 hex chars (~128 bits of entropy). */
export function generateClientToken (): string {
  return TOKEN_PREFIX + randomBytes(16).toString('hex')
}

/** Short, non-secret label shown in the admin table (prefix + last 4). */
export function tokenHint (token: string): string {
  if (token.length <= 12) return token
  return `${token.slice(0, TOKEN_PREFIX.length + 4)}…${token.slice(-4)}`
}

/**
 * A client may paste their own secret. Enforce a sane shape so keys stay
 * usable in an `Authorization: Bearer` header and are unlikely to collide
 * with generated ones. Returns the trimmed token, or null if invalid.
 */
export function normalizeCustomToken (raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const token = raw.trim()
  if (token.length < 16 || token.length > 256) return null
  // visible ASCII without spaces (header-safe)
  if (!/^[\x21-\x7e]+$/.test(token)) return null
  return token
}

/** Extract a bearer token from an `Authorization` header value. */
export function bearerFrom (header: string | null | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1]!.trim() : null
}
