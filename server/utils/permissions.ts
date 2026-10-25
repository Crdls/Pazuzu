/**
 * Pure authorization rules — no imports, reachable from bare Node like
 * credentials.ts so tests can drive them directly (see test/auth.test.mjs).
 */

export interface Actor {
  /** signed-in user id, undefined while auth is disabled */
  userId?: number
  /** effective role ('superadmin' | 'admin' | 'user'), undefined while auth is disabled */
  userRole?: string
}

const ROLE_RANK: Record<string, number> = { user: 0, admin: 1, superadmin: 2 }

/** Rank of a role for comparisons; unknown roles rank as plain users. */
export function roleRank (role: string | null | undefined): number {
  return role ? ROLE_RANK[role] ?? 0 : -1
}

/**
 * Session masking (view-as): the mask can only lower the real role, never
 * raise it; anything but 'user'/'admin' or a non-lowering value falls back
 * to the real role.
 */
const VALID_VIEW_AS = new Set(['user', 'admin'])

export function effectiveRole (realRole: string, viewAs: string | null | undefined): string {
  if (!viewAs || !VALID_VIEW_AS.has(viewAs)) return realRole
  return roleRank(viewAs) < roleRank(realRole) ? viewAs : realRole
}

/**
 * May a signed-in user whose real role is `realRole` mask their session as
 * `viewAs` (null = drop the mask)? Superadmins view as admin or user,
 * admins only as user; plain users cannot mask at all.
 */
export function canViewAs (realRole: string | undefined, viewAs: string | null): boolean {
  if (roleRank(realRole) < roleRank('admin')) return false
  if (viewAs === null) return true
  if (realRole === 'superadmin') return viewAs === 'admin' || viewAs === 'user'
  return viewAs === 'user'
}

/**
 * Who may edit/delete a server: while auth is off everybody; otherwise the
 * creator or an admin (admins and superadmins count). Servers with an unknown
 * author are admin-only.
 */
export function canManageServer (authEnabled: boolean, actor: Actor, server: { created_by: number | null }): boolean {
  if (!authEnabled) return true
  if (roleRank(actor.userRole) >= roleRank('admin')) return true
  return server.created_by != null && server.created_by === actor.userId
}

/**
 * May an actor (effective role) change a user account: admins manage users
 * and other admins; superadmin accounts are editable by superadmins only.
 */
export function canEditAccount (actorRole: string | undefined, targetRole: string): boolean {
  if (actorRole === 'superadmin') return true
  return roleRank(actorRole) >= roleRank('admin') && roleRank(targetRole) <= roleRank('admin')
}

/**
 * May an actor (effective role) assign a role: granting or revoking the
 * superadmin role is reserved to superadmins.
 */
export function canAssignRole (actorRole: string | undefined, targetRole: string): boolean {
  if (targetRole === 'superadmin') return actorRole === 'superadmin'
  return roleRank(actorRole) >= roleRank('admin')
}

// True when the patch strips an active `pool` member: a role change that
// leaves the pool (admins leave it only by demoting to user, superadmins by
// any change) or a freeze. Deleting a user is treated as disabling them:
// pass `{ disabled: true }` as the patch.
function demotesActiveFrom (
  pool: 'admin' | 'superadmin',
  target: { role: string, disabled: number | boolean },
  patch: { role?: string, disabled?: boolean }
): boolean {
  if (target.role !== pool || Boolean(target.disabled)) return false
  if (patch.disabled === true) return true
  return patch.role !== undefined && (pool === 'admin' ? patch.role === 'user' : patch.role !== 'superadmin')
}

/**
 * True when this edit would strip an active admin. Admins manage each other,
 * so the caller must refuse such edits while no active admin or superadmin
 * remains (see countActiveAdmins in db.ts, which counts both roles).
 */
export function demotesActiveAdmin (
  target: { role: string, disabled: number | boolean },
  patch: { role?: string, disabled?: boolean }
): boolean {
  return demotesActiveFrom('admin', target, patch)
}

/**
 * True when this edit would strip an active superadmin — the only account
 * that can grant the role, so the caller must refuse it while no other
 * active superadmin exists (see countActiveSuperadmins in db.ts).
 */
export function demotesActiveSuperadmin (
  target: { role: string, disabled: number | boolean },
  patch: { role?: string, disabled?: boolean }
): boolean {
  return demotesActiveFrom('superadmin', target, patch)
}
