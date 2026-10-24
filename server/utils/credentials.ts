import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * Self-contained auth primitives (password hashes, session tokens, cookie
 * parsing) — no imports from other utils on purpose so that plain Node
 * scripts and tests can import this file directly (see test/auth.test.mjs,
 * scripts/reset-password.mjs). DB/session glue lives in ./auth.ts.
 */

export const SESSION_COOKIE = 'pazuzu_session'
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 }

// ---------- passwords (node:crypto scrypt, no extra deps) ----------

function scryptAsync (password: string, salt: Buffer, keylen: number, opts: { N: number, r: number, p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // the derived key needs 128*N*r bytes of memory; give scrypt headroom so
    // it never fails with ENOMEM on small devices
    scrypt(password, salt, keylen, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, dk) => err ? reject(err) : resolve(dk))
  })
}

/** Format: `scrypt$N$r$p$salt_b64url$hash_b64url` — params travel with the hash. */
export async function hashPassword (password: string): Promise<string> {
  const salt = randomBytes(16)
  const dk = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${dk.toString('base64url')}`
}

export async function verifyPassword (password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string]
  const N = Number(n)
  const rr = Number(r)
  const pp = Number(p)
  const salt = Buffer.from(saltB64, 'base64url')
  const expected = Buffer.from(hashB64, 'base64url')
  if (!Number.isInteger(N) || !Number.isInteger(rr) || !Number.isInteger(pp) || salt.length === 0 || expected.length === 0) return false
  try {
    const dk = await scryptAsync(password, salt, expected.length, { N, r: rr, p: pp })
    return dk.length === expected.length && timingSafeEqual(dk, expected)
  } catch {
    return false
  }
}

export function isPasswordValid (raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length >= 8 && raw.length <= 1024
}

export function normalizeUsername (raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  return name.length >= 1 && name.length <= 64 ? name : null
}

// ---------- session tokens ----------

export function createSessionToken (): string {
  return randomBytes(32).toString('base64url')
}

/** Only the hash of the token is stored, the raw value lives in the cookie. */
export function hashToken (token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Cookie parsing for the WebSocket upgrade, which bypasses h3 handlers. */
export function cookieValue (header: string | null | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim()
      if (!value) return null
      try {
        return decodeURIComponent(value)
      } catch {
        return value
      }
    }
  }
  return null
}
