// Tests for gateway client ⇄ server access: the explicit lists, the router's
// allowed-set view, the server-side flip of unrestricted clients and cascades.
// Run: node test/client-access.test.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  allowedServerIds, createGatewayClient, deleteGatewayClient, listClientServerIds,
  setClientServerAccess, setServerClientAccess, useDb
} from '../server/utils/db.ts'
import { parseExistingIds } from '../server/utils/gateway/access.ts'

let failed = 0
function check (name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`)
  if (!cond) failed++
}

// an isolated database - the first useDb() call below reads this config
const dir = mkdtempSync(join(tmpdir(), 'pazuzu-access-test-'))
process.env.PAZUZU_CONFIG = join(dir, 'config.json')
writeFileSync(process.env.PAZUZU_CONFIG, JSON.stringify({ db: { path: join(dir, 'access.db') } }))

const db = useDb()
const addServer = (name) => Number(db
  .prepare('INSERT INTO servers (name, url, created_at) VALUES (?, ?, ?)')
  .run(name, `http://${name}.test/`, Date.now()).lastInsertRowid)
const addClient = (name) => createGatewayClient({
  name, tokenHash: `hash-${name}`, tokenHint: 'msk_xxx', priority: 'normal', debug: false, createdBy: null
})

const s1 = addServer('s1')
const s2 = addServer('s2')
const s3 = addServer('s3')
const a = addClient('a')
const b = addClient('b')

check('new clients reach every server', allowedServerIds(a.id) === null)

setClientServerAccess(a.id, false, [s1])
check('explicit selection restricts the client', JSON.stringify([...allowedServerIds(a.id)]) === JSON.stringify([s1]))
check('unchecking everything leaves no server', (() => { setClientServerAccess(a.id, false, []); return allowedServerIds(a.id)?.size === 0 })())
setClientServerAccess(a.id, true, [])
check('back to all clears the stored pairs', allowedServerIds(a.id) === null && listClientServerIds(a.id).length === 0)

// server side: clearing the selection revokes s2 from everyone - a (restricted
// to s1) loses nothing, unrestricted b flips to an explicit selection of the
// other current servers
setClientServerAccess(a.id, false, [s1])
setServerClientAccess(s2, [])
check('restricted client is not granted by omission', allowedServerIds(a.id).has(s1) && !allowedServerIds(a.id).has(s2))
const bAllowed = allowedServerIds(b.id)
check('unrestricted client flips to the complement', bAllowed !== null && bAllowed.has(s1) && bAllowed.has(s3) && !bAllowed.has(s2))

setServerClientAccess(s2, [a.id, b.id])
check('checking a restricted client adds the pair', allowedServerIds(a.id).has(s2) && allowedServerIds(b.id).has(s2))
check('re-saving the same selection changes nothing', (() => {
  const before = JSON.stringify([allowedServerIds(a.id), allowedServerIds(b.id)])
  setServerClientAccess(s2, [a.id, b.id])
  return JSON.stringify([allowedServerIds(a.id), allowedServerIds(b.id)]) === before
})())

// deleting a client or a server drops the pairs (the server cascade lives in
// the DELETE route, here the client-side one from deleteGatewayClient)
const doomed = addClient('doomed')
setClientServerAccess(doomed.id, false, [s1])
deleteGatewayClient(doomed.id)
check('client delete drops the pairs', (db.prepare('SELECT COUNT(*) AS n FROM gateway_client_servers WHERE client_id = ?').get(doomed.id)).n === 0)

// ---------- access list validation ----------
check('parseExistingIds rejects non-arrays', parseExistingIds('x', 'servers') === null)
check('parseExistingIds rejects non-integers', parseExistingIds([1.5], 'servers') === null)
check('parseExistingIds rejects unknown ids', parseExistingIds([s1, 999_999], 'servers') === null)
check('parseExistingIds allows the empty list', JSON.stringify(parseExistingIds([], 'servers')) === '[]')
check('parseExistingIds sorts and dedupes', JSON.stringify(parseExistingIds([s3, s1, s3], 'servers')) === JSON.stringify([s1, s3]))
// the doomed client released id 3, so server id s3 cannot resolve there
check('parseExistingIds validates against the given table', parseExistingIds([b.id], 'gateway_clients') !== null && parseExistingIds([s3], 'gateway_clients') === null)

db.close()
rmSync(dir, { recursive: true, force: true, maxRetries: 3 })

console.log(failed === 0 ? '\nAll checks passed' : `\n${failed} checks FAILED`)
process.exitCode = failed > 0 ? 1 : 0
