// Tests for gateway client ⇄ server access: the explicit lists, the router's
// allowed-set view, the server-side flip of unrestricted clients and cascades.
// Run: node test/client-access.test.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  allowedServerIds, clientServerPriorities, createGatewayClient, deleteGatewayClient, listClientServerIds,
  setClientServerAccess, setClientServerPriorities, setServerClientAccess, useDb
} from '../server/utils/db.ts'
import { parseExistingIds, parseServerPriorities } from '../server/utils/gateway/access.ts'

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
  name, tokenHash: `hash-${name}`, tokenHint: 'pzz_xxx', priority: 'normal', debug: false, createdBy: null
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

// ---------- preference tiers ----------
const tiered = addClient('tiered')
check('fresh client has no tiers', clientServerPriorities(tiered.id).size === 0)
// tiers work regardless of access mode; set on an unrestricted client
setClientServerPriorities(tiered.id, new Map([[s1, 'high'], [s2, 'low']]))
const t1 = clientServerPriorities(tiered.id)
check('tiers round-trip', t1.get(s1) === 'high' && t1.get(s2) === 'low')
check('normal tier is stored as absent', (() => {
  setClientServerPriorities(tiered.id, new Map([[s1, 'high'], [s2, 'normal']]))
  const m = clientServerPriorities(tiered.id)
  return m.get(s1) === 'high' && !m.has(s2)
})())
check('replace drops the previous tiers', (() => {
  setClientServerPriorities(tiered.id, new Map([[s3, 'high']]))
  const m = clientServerPriorities(tiered.id)
  return m.size === 1 && m.get(s3) === 'high'
})())
check('empty tier map clears everything', (() => {
  setClientServerPriorities(tiered.id, new Map())
  return clientServerPriorities(tiered.id).size === 0
})())
// independent of access: a restricted client keeps its allowed set after tier edits
const aAllowedBefore = JSON.stringify([...allowedServerIds(a.id)].sort())
setClientServerPriorities(a.id, new Map([[s3, 'high']]))
check('tiers do not touch the allowed set', JSON.stringify([...allowedServerIds(a.id)].sort()) === aAllowedBefore && clientServerPriorities(a.id).get(s3) === 'high')
check('an unrestricted client can still hold tiers', (() => {
  setClientServerAccess(b.id, true, [])
  setClientServerPriorities(b.id, new Map([[s1, 'high']]))
  return allowedServerIds(b.id) === null && clientServerPriorities(b.id).get(s1) === 'high'
})())
// release the tiered client so the id assumptions below still hold
deleteGatewayClient(tiered.id)
check('client delete drops tiers too', (db.prepare('SELECT COUNT(*) AS n FROM gateway_client_priorities WHERE client_id = ?').get(tiered.id)).n === 0)

// ---------- tier validation ----------
check('parseServerPriorities rejects non-objects', parseServerPriorities('x') === null && parseServerPriorities([1]) === null)
check('parseServerPriorities rejects bad tiers', parseServerPriorities({ [s1]: 'urgent' }) === null)
check('parseServerPriorities rejects unknown servers', parseServerPriorities({ 999_999: 'high' }) === null)
check('parseServerPriorities rejects non-id keys', parseServerPriorities({ cat: 'high' }) === null)
check('parseServerPriorities drops normal as absent', (() => {
  const m = parseServerPriorities({ [s1]: 'high', [s2]: 'normal' })
  return m !== null && m.size === 1 && m.get(s1) === 'high'
})())
check('parseServerPriorities accepts the empty object', parseServerPriorities({}) !== null && parseServerPriorities({}).size === 0)

// deleting a client or a server drops the pairs (the server cascade lives in
// the DELETE route, here the client-side one from deleteGatewayClient)
const doomed = addClient('doomed')
setClientServerAccess(doomed.id, false, [s1])
setClientServerPriorities(doomed.id, new Map([[s1, 'high']]))
deleteGatewayClient(doomed.id)
check('client delete drops the pairs', (db.prepare('SELECT COUNT(*) AS n FROM gateway_client_servers WHERE client_id = ?').get(doomed.id)).n === 0)
check('client delete drops the tiers', (db.prepare('SELECT COUNT(*) AS n FROM gateway_client_priorities WHERE client_id = ?').get(doomed.id)).n === 0)

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
