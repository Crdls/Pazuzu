// Smoke test for the auth helpers (hashes, cookie parsing, validation).
// Run: node test/auth.test.mjs
import {
  cookieValue, hashPassword, hashToken, isPasswordValid, normalizeUsername, verifyPassword
} from '../server/utils/credentials.ts'
import {
  authorizeUrl, isGroupAllowed, newOAuthState, pathsFromGroupsResponse, tokenFromResponse, usernameFromUserResponse
} from '../server/utils/gitlab.ts'
import {
  canManageServer, demotesActiveAdmin
} from '../server/utils/permissions.ts'

let failed = 0
function check (name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`)
  if (!cond) failed++
}

const password = 'супер-пароль123'
const hash = await hashPassword(password)
check('hash has scrypt prefix with params', hash.startsWith('scrypt$32768$8$1$'))
check('verify correct password', await verifyPassword(password, hash))
check('reject wrong password', !(await verifyPassword('супер-пароль12', hash)))
check('salted: same password hashes differently', (await hashPassword('same-pass-123')) !== (await hashPassword('same-pass-123')))

const parts = hash.split('$')
const tampered = ['scrypt', '1024', parts[2], parts[3], parts[4], parts[5]].join('$')
check('reject tampered params', !(await verifyPassword(password, tampered)))
check('reject tampered hash bytes', !(await verifyPassword(password, `${hash.slice(0, -4)}AAAA`)))
check('reject malformed hash', !(await verifyPassword('whatever', 'bcrypt$1$2$3$4$5')))

check('hashToken is sha256 hex', /^[0-9a-f]{64}$/.test(hashToken('token')))
check('hashToken differs per input', hashToken('a') !== hashToken('b'))

check('cookieValue finds among others', cookieValue('a=1; pazuzu_session=abc.def-12; b=2', 'pazuzu_session') === 'abc.def-12')
check('cookieValue missing name', cookieValue('a=1', 'pazuzu_session') === null)
check('cookieValue missing header', cookieValue(null, 'pazuzu_session') === null)
check('cookieValue decodes percent-escapes', cookieValue('x=%61%62%63', 'x') === 'abc')
check('cookieValue empty value is null', cookieValue('x=', 'x') === null)

check('normalizeUsername trims', normalizeUsername('  root  ') === 'root')
check('normalizeUsername rejects empty', normalizeUsername('   ') === null)
check('normalizeUsername rejects long', normalizeUsername('x'.repeat(65)) === null)
check('normalizeUsername rejects non-string', normalizeUsername(42) === null)
check('isPasswordValid bounds', isPasswordValid('12345678') && !isPasswordValid('1234567') && !isPasswordValid('x'.repeat(1025)) && !isPasswordValid(42))

const gl = { enabled: true, baseUrl: 'http://gitlab.lan', clientId: 'cid', clientSecret: 'sec', redirectUri: '', allowedGroups: [] }
const state = newOAuthState()
check('oauth state looks random and url-safe', /^[A-Za-z0-9_-]{30,}$/.test(state) && state !== newOAuthState())
const authUrl = new URL(authorizeUrl(gl, 'http://mon:3003/api/auth/gitlab/callback', state))
check('authorizeUrl targets the gitlab server', authUrl.origin === 'http://gitlab.lan' && authUrl.pathname === '/oauth/authorize')
check('authorizeUrl carries oauth params', authUrl.searchParams.get('client_id') === 'cid' && authUrl.searchParams.get('response_type') === 'code' && authUrl.searchParams.get('state') === state && authUrl.searchParams.get('scope') === 'read_user' && authUrl.searchParams.get('redirect_uri') === 'http://mon:3003/api/auth/gitlab/callback')

check('tokenFromResponse reads access_token', tokenFromResponse('{"access_token":"tok-1","token_type":"bearer"}') === 'tok-1')
check('tokenFromResponse rejects garbage and empties', tokenFromResponse('nope') === null && tokenFromResponse('{"error":"x"}') === null)
check('usernameFromUserResponse reads username', usernameFromUserResponse('{"username":"iva"}') === 'iva')
check('usernameFromUserResponse rejects garbage', usernameFromUserResponse('<html>') === null)
check('pathsFromGroupsResponse lowercases paths', JSON.stringify(pathsFromGroupsResponse('[{"full_path":"Ops/Api"},{"full_path":"Dev"}]')) === '["ops/api","dev"]')
check('pathsFromGroupsResponse rejects non-list', pathsFromGroupsResponse('{"a":1}').length === 0)

check('isGroupAllowed matches exact group', isGroupAllowed(['ops'], ['ops', 'dev']))
check('isGroupAllowed inherits from subgroup', isGroupAllowed(['ops'], ['ops/api']))
check('isGroupAllowed is case-insensitive', isGroupAllowed(['Ops'], ['ops']))
check('isGroupAllowed rejects outsiders', !isGroupAllowed(['ops'], ['dev']) && !isGroupAllowed(['ops'], ['opos']) && !isGroupAllowed(['ops'], []))

check('canManageServer: auth off means everybody', canManageServer(false, {}, { created_by: 7 }))
check('canManageServer: admin manages any server', canManageServer(true, { userId: 1, userRole: 'admin' }, { created_by: 9 }))
check('canManageServer: creator manages own server', canManageServer(true, { userId: 5, userRole: 'user' }, { created_by: 5 }))
check('canManageServer: outsider user denied', !canManageServer(true, { userId: 5, userRole: 'user' }, { created_by: 6 }))
check('canManageServer: unknown author is admin-only', !canManageServer(true, { userId: 5, userRole: 'user' }, { created_by: null }))

const activeAdmin = { role: 'admin', disabled: 0 }
check('demotesActiveAdmin: demote counts', demotesActiveAdmin(activeAdmin, { role: 'user' }))
check('demotesActiveAdmin: freeze counts', demotesActiveAdmin(activeAdmin, { disabled: true }))
check('demotesActiveAdmin: delete treated as freeze', demotesActiveAdmin(activeAdmin, { disabled: true }))
check('demotesActiveAdmin: rename/password does not demote', !demotesActiveAdmin(activeAdmin, {}))
check('demotesActiveAdmin: plain user is fine', !demotesActiveAdmin({ role: 'user', disabled: 0 }, { disabled: true }))
check('demotesActiveAdmin: already frozen admin is fine', !demotesActiveAdmin({ role: 'admin', disabled: 1 }, { role: 'user' }))

console.log(failed === 0 ? '\nAll checks passed' : `\n${failed} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
