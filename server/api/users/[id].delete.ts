import { requireAdmin } from '../../utils/auth'
import {
  countActiveAdmins, countActiveSuperadmins, deleteUser, deleteUserSessions, getUserById, useDb
} from '../../utils/db'
import { canEditAccount, demotesActiveAdmin, demotesActiveSuperadmin } from '../../utils/permissions'

// admin removes a user and all their sessions; servers they created keep
// running, their author just shows as unknown; superadmins are deletable by
// superadmins only
export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  const target = getUserById(id)
  if (!target) throw createError({ statusCode: 404, statusMessage: 'user not found' })
  if (id === event.context.userId) throw createError({ statusCode: 400, statusMessage: 'you cannot delete yourself' })
  if (!canEditAccount(event.context.userRole as string | undefined, target.role)) {
    throw createError({ statusCode: 403, statusMessage: 'only a superadmin can delete a superadmin' })
  }
  if (demotesActiveSuperadmin(target, { disabled: true }) && countActiveSuperadmins() <= 1) {
    throw createError({ statusCode: 409, statusMessage: 'this is the last active superadmin' })
  }
  if (demotesActiveAdmin(target, { disabled: true }) && countActiveAdmins() <= 1) {
    throw createError({ statusCode: 409, statusMessage: 'this is the last active admin' })
  }
  useDb().transaction((userId: number) => {
    deleteUserSessions(userId)
    deleteUser(userId)
  })(id)
  return { ok: true }
})
