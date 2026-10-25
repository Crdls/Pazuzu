import { hashPassword, isPasswordValid, requireAdmin } from '../../utils/auth'
import {
  countActiveAdmins, countActiveSuperadmins, deleteUserSessions, getUserById, updateUser, type UserRole
} from '../../utils/db'
import { canAssignRole, canEditAccount, demotesActiveAdmin, demotesActiveSuperadmin } from '../../utils/permissions'

// admin edit: role, freeze/unfreeze, assign a new password (the old one is
// not required); a reassigned password signs the user's other sessions out.
// Admins manage users and admins; superadmins (and the role itself) are
// reserved to superadmins.
export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  const target = getUserById(id)
  if (!target) throw createError({ statusCode: 404, statusMessage: 'user not found' })

  const body = await readBody<{ role?: string, disabled?: boolean, password?: string }>(event)
  if (body?.role !== undefined && body.role !== 'superadmin' && body.role !== 'admin' && body.role !== 'user') {
    throw createError({ statusCode: 400, statusMessage: "role must be 'superadmin', 'admin' or 'user'" })
  }
  const actorRole = event.context.userRole as string | undefined
  if (!canEditAccount(actorRole, target.role)) {
    throw createError({ statusCode: 403, statusMessage: 'only a superadmin can change a superadmin account' })
  }
  const patch: { role?: UserRole, disabled?: boolean, passHash?: string } = {
    role: body?.role as UserRole | undefined,
    disabled: typeof body?.disabled === 'boolean' ? body.disabled : undefined
  }
  if (patch.role !== undefined && !canAssignRole(actorRole, patch.role)) {
    throw createError({ statusCode: 403, statusMessage: 'only a superadmin can grant or revoke the superadmin role' })
  }
  if (id === event.context.userId && ((patch.role !== undefined && patch.role !== target.role) || patch.disabled === true)) {
    throw createError({ statusCode: 400, statusMessage: 'you cannot change your own role or freeze yourself' })
  }
  if (demotesActiveSuperadmin(target, patch) && countActiveSuperadmins() <= 1) {
    throw createError({ statusCode: 409, statusMessage: 'this is the last active superadmin' })
  }
  if (demotesActiveAdmin(target, patch) && countActiveAdmins() <= 1) {
    throw createError({ statusCode: 409, statusMessage: 'this is the last active admin' })
  }
  if (body?.password) {
    if (!isPasswordValid(body.password)) throw createError({ statusCode: 400, statusMessage: 'password must be 8-1024 characters' })
    patch.passHash = await hashPassword(body.password)
  }

  updateUser(id, patch)
  if (patch.passHash) deleteUserSessions(id, event.context.sessionTokenHash as string | undefined ?? null)
  const { pass_hash: _passHash, ...safe } = getUserById(id)!
  return safe
})
