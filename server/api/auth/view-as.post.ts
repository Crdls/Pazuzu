import { authStatus } from '../../utils/auth'
import { loadConfig } from '../../utils/config'
import { setSessionViewAs } from '../../utils/db'
import { canViewAs } from '../../utils/permissions'

// view-as masking for the current session only: admins hide as plain users,
// superadmins as admins or users (null drops the mask). The roles in the
// users table are untouched and the mask can never raise rights — checking
// happens against the real role, so a masked account can always come back
export default defineEventHandler(async (event) => {
  if (!loadConfig().auth.enabled) throw createError({ statusCode: 403, statusMessage: 'Auth is disabled' })
  if (!event.context.userId) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  const body = await readBody<{ role?: string | null }>(event)
  const viewAs = body?.role ?? null
  if (viewAs !== null && viewAs !== 'user' && viewAs !== 'admin') {
    throw createError({ statusCode: 400, statusMessage: "role must be 'user', 'admin' or null" })
  }
  if (!canViewAs(event.context.userRealRole as string | undefined, viewAs)) {
    throw createError({ statusCode: 403, statusMessage: 'Only admins can switch the view-as role' })
  }
  setSessionViewAs(event.context.sessionTokenHash as string, viewAs)
  return authStatus(event)
})
