import { hashPassword, isPasswordValid, normalizeUsername, requireAdmin } from '../../utils/auth'
import { createUser, getUserById, getUserByUsername, type UserRole } from '../../utils/db'
import { canAssignRole } from '../../utils/permissions'

// admin-created login/password account (gitlab=0, active); role defaults to
// user, the password hash never leaves the db; only superadmins create superadmins
export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const body = await readBody<{ username?: string, password?: string, role?: string }>(event)
  const username = normalizeUsername(body?.username)
  if (!username) throw createError({ statusCode: 400, statusMessage: 'username must be 1-64 characters' })
  if (!isPasswordValid(body?.password)) throw createError({ statusCode: 400, statusMessage: 'password must be 8-1024 characters' })
  if (body?.role !== undefined && body.role !== 'superadmin' && body.role !== 'admin' && body.role !== 'user') {
    throw createError({ statusCode: 400, statusMessage: "role must be 'superadmin', 'admin' or 'user'" })
  }
  if (!canAssignRole(event.context.userRole as string | undefined, body?.role ?? 'user')) {
    throw createError({ statusCode: 403, statusMessage: 'only a superadmin can create a superadmin' })
  }
  if (getUserByUsername(username)) throw createError({ statusCode: 409, statusMessage: 'username is taken' })

  const user = createUser(username, await hashPassword(body.password), (body?.role ?? 'user') as UserRole, false)
  const { pass_hash: _passHash, ...safe } = getUserById(user.id)!
  return safe
})
