import { SESSION_COOKIE, setSessionCookie, verifySessionToken } from '../utils/auth'
import { loadConfig } from '../utils/config'

// Auth is opt-in (config.json). This is the real gate for data: every /api
// route requires a valid session cookie except the auth bootstrap endpoints.
// Pages are gated client/SSR-side by app/middleware/auth.global.ts; /_ws
// checks the cookie in its own upgrade handler because middleware does not
// run for WS upgrades.
const OPEN_AUTH_PATHS = new Set([
  '/api/auth/status', '/api/auth/login', '/api/auth/setup', '/api/auth/logout',
  '/api/auth/gitlab/start', '/api/auth/gitlab/callback'
])

export default defineEventHandler((event) => {
  if (!loadConfig().auth.enabled) return
  const path = getRequestURL(event).pathname
  if (!path.startsWith('/api/')) return
  const token = getCookie(event, SESSION_COOKIE)
  const session = verifySessionToken(token)
  if (session) {
    if (session.refreshed && token) setSessionCookie(event, token)
    event.context.userId = session.user.id
    event.context.username = session.user.username
    // effective role (view-as mask applied) — every gate below reads this one
    event.context.userRole = session.user.role
    event.context.userRealRole = session.user.realRole
    event.context.sessionTokenHash = session.tokenHash
  }
  if (!OPEN_AUTH_PATHS.has(path) && !session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
})
