import { authStatus, hashPassword, isPasswordValid, normalizeUsername, startSession } from '../../utils/auth'
import { loadConfig } from '../../utils/config'
import { countUsers, createUser, getUserByUsername } from '../../utils/db'

// first-run window: creates the very first account; only possible while
// auth is enabled and the users table is empty
export default defineEventHandler(async (event) => {
  if (!loadConfig().auth.enabled) throw createError({ statusCode: 403, statusMessage: 'Auth is disabled' })
  if (countUsers() > 0) throw createError({ statusCode: 409, statusMessage: 'Setup already completed' })
  const body = await readBody<{ username?: string, password?: string }>(event)
  const username = normalizeUsername(body?.username)
  if (!username) throw createError({ statusCode: 400, statusMessage: 'username must be 1-64 characters' })
  if (!isPasswordValid(body?.password)) throw createError({ statusCode: 400, statusMessage: 'password must be 8-1024 characters' })
  if (getUserByUsername(username)) throw createError({ statusCode: 409, statusMessage: 'Setup already completed' })
  // the first account owns the top role: it is the only one that can hand it out
  const user = createUser(username, await hashPassword(body.password), 'superadmin', false)
  startSession(event, user.id)
  return authStatus(event, { id: user.id, username: user.username, role: user.role, realRole: user.role, hasPassword: true, lang: null })
})
