// Tests for the gateway's pure core: tokens, session affinity keys,
// server routing and the priority queue with aging.
// Run: node test/gateway.test.mjs
import { generateClientToken, normalizeCustomToken, tokenHint, bearerFrom, TOKEN_PREFIX } from '../server/utils/gateway/tokens.ts'
import { deriveSessionKey } from '../server/utils/gateway/session.ts'
import { pickServer, hasCapacity } from '../server/utils/gateway/router.ts'
import { effectiveRank, pickNext } from '../server/utils/gateway/queue.ts'

let failed = 0
function check (name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`)
  if (!cond) failed++
}

// ---------- tokens ----------
check('generated token has the pzz_ prefix', generateClientToken().startsWith(TOKEN_PREFIX))
check('generated tokens are unique', generateClientToken() !== generateClientToken())
check('token hint is short and keeps head+tail', tokenHint('pzz_0123456789abcdef00').startsWith('pzz_0123') && tokenHint('pzz_0123456789abcdef00').endsWith('f00'))
check('custom token must be long enough', normalizeCustomToken('short') === null)
check('custom token rejects spaces', normalizeCustomToken('has space inside it') === null)
check('custom token trims', normalizeCustomToken('  secret-token-value-1  ') === 'secret-token-value-1')
check('bearerFrom parses Bearer header', bearerFrom('Bearer pzz_abc') === 'pzz_abc')
check('bearerFrom is case-insensitive', bearerFrom('bearer pzz_abc') === 'pzz_abc')
check('bearerFrom rejects other schemes', bearerFrom('Basic abc') === null)

// ---------- session keys ----------
const sys = { role: 'system', content: 'You are helpful.' }
const u1 = { role: 'user', content: 'hello there' }
const a1 = { role: 'assistant', content: 'hi! how can I help?' }
const u2 = { role: 'user', content: 'tell me more' }
const body = (...messages) => ({ model: 'strata', messages })

const keyA = deriveSessionKey(null, body(sys, u1))
check('prefix key derived from messages', typeof keyA === 'string' && keyA.length === 64)
check('prefix key stable while the chat grows', deriveSessionKey(null, body(sys, u1, a1, u2)) === keyA)
check('same opening, different later turns = same key (shared prefix is the point)', deriveSessionKey(null, body(sys, u1, a1)) === deriveSessionKey(null, body(sys, u1, { role: 'assistant', content: 'something else' }, u2)))
check('different first message changes the key', deriveSessionKey(null, body(sys, { role: 'user', content: 'other topic' })) !== keyA)
check('different system prompt changes the key', deriveSessionKey(null, body({ role: 'system', content: 'Other.' }, u1)) !== keyA)
check('header session wins over prefix', deriveSessionKey('chat-42', body(sys, u1)) !== keyA)
check('header key stable without messages', deriveSessionKey('chat-42', undefined) === deriveSessionKey('chat-42', null))
check('header key differs from another id', deriveSessionKey('chat-43', null) !== deriveSessionKey('chat-42', null))
check('no header and no messages yields no key', deriveSessionKey(null, []) === null && deriveSessionKey(null, body()) === null)
check('oversized header ignored (falls back)', deriveSessionKey('x'.repeat(300), body(sys, u1)) === keyA)
const partsKey = (content) => deriveSessionKey(null, body({ role: 'user', content }))
check('content parts hashed by text', partsKey([{ type: 'text', text: 'hello there' }]) === deriveSessionKey(null, body(u1)))
check('content part order matters', partsKey([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]) !== partsKey([{ type: 'text', text: 'b' }, { type: 'text', text: 'a' }]))

// ---------- routing ----------
const now = 1_000_000
const mk = (id, over = {}) => ({
  id, mode: 'on', capacity: 4, inflight: 0, up: true,
  upstreamWaiting: 0, kvUsage: 0, ejectedUntil: 0, ...over
})

check('least loaded wins', pickServer([mk(1, { inflight: 3 }), mk(2), mk(3, { inflight: 1 })], null, now).serverId === 2)
check('drain servers get no new work', pickServer([mk(1, { mode: 'drain' })], null, now).serverId === null)
check('off servers get no new work', pickServer([mk(1, { mode: 'off' })], null, now).serverId === null)
check('full servers wait', pickServer([mk(1, { inflight: 4, capacity: 4 })], null, now).serverId === null)
check('ejected servers skipped', pickServer([mk(1, { ejectedUntil: now + 1000 }), mk(2)], null, now).serverId === 2)
check('down+idle servers excluded', pickServer([mk(1, { up: false })], null, now).serverId === null)
check('down but serving still routed (metrics may lie)', pickServer([mk(1, { up: false, inflight: 1 }), mk(2, { inflight: 3 })], null, now).serverId === 1)
check('KV cache at the limit closes the gate', pickServer([mk(1, { kvUsage: 0.95 }), mk(2)], null, now).serverId === 2)

const preferredFirst = pickServer([mk(1, { inflight: 2 }), mk(2, { inflight: 0 })], 1, now)
check('affinity beats least-loaded while admitted', preferredFirst.serverId === 1 && preferredFirst.affinity)
const degraded = pickServer([mk(1, { inflight: 2 }), mk(2, { inflight: 0 })], 1, now - 1)
check('healthy preferred keeps even when busier', degraded.serverId === 1)
const fallback = pickServer([mk(1, { mode: 'drain', inflight: 2 }), mk(2, { inflight: 1 }), mk(3)], 1, now)
check('unavailable home falls back to least loaded', fallback.serverId === 3 && !fallback.affinity)
check('hasCapacity sees free engines', hasCapacity([mk(1, { inflight: 4 }), mk(2)], now))
check('hasCapacity false when all full', !hasCapacity([mk(1, { inflight: 4 }), mk(2, { inflight: 4 })], now))

// ---------- preference tiers (client → server) ----------
// 1 has more load than 2, but the client marked it as home (high)
const homeHigh = new Map([[1, 'high']])
check('home engine wins even when busier', pickServer([mk(1, { inflight: 3 }), mk(2)], null, now, homeHigh).serverId === 1)
check('home chosen over emptier normal engine', pickServer([mk(1, { inflight: 1 }), mk(2, { inflight: 0 })], null, now, homeHigh).serverId === 1)
// when the home engine cannot take work, degrade to the rest least-loaded
check('full home falls back to least loaded', pickServer([mk(1, { inflight: 4, capacity: 4 }), mk(2, { inflight: 2 }), mk(3)], null, now, homeHigh).serverId === 3)
check('drained home falls back to least loaded', pickServer([mk(1, { mode: 'drain' }), mk(2, { inflight: 2 }), mk(3)], null, now, homeHigh).serverId === 3)
check('ejected home falls back to least loaded', pickServer([mk(1, { ejectedUntil: now + 1000 }), mk(2), mk(3, { inflight: 1 })], null, now, homeHigh).serverId === 2)
// two homes balance least-loaded among themselves before touching normals
const twoHomes = new Map([[1, 'high'], [2, 'high']])
check('homes balance among themselves first', pickServer([mk(1, { inflight: 1 }), mk(2, { inflight: 2 }), mk(3)], null, now, twoHomes).serverId === 1)
check('least-loaded home wins when one is fuller', pickServer([mk(1, { inflight: 3 }), mk(2, { inflight: 1 }), mk(3)], null, now, twoHomes).serverId === 2)
// low is only reached when nothing else admits work
const oneLow = new Map([[3, 'low']])
check('low avoided while others admit', pickServer([mk(1), mk(2), mk(3)], null, now, oneLow).serverId === 1)
check('low used when it is the only option', pickServer([mk(1, { inflight: 4, capacity: 4 }), mk(3)], null, now, oneLow).serverId === 3)
// high beats low when both present; normal (absent) beats low too
check('high wins over low', pickServer([mk(1), mk(3)], null, now, new Map([[1, 'high'], [3, 'low']])).serverId === 1)
check('untouched normal beats explicit low', pickServer([mk(2), mk(3)], null, now, new Map([[3, 'low']])).serverId === 2)
// affinity still outranks preference; a full home falls to the next tier
const withTiers = new Map([[1, 'high'], [3, 'high']])
const aff = pickServer([mk(1, { inflight: 2 }), mk(2), mk(3, { inflight: 1 })], 2, now, withTiers)
check('chat affinity still outranks tiers', aff.serverId === 2 && aff.affinity)
const noMap = pickServer([mk(1, { inflight: 3 }), mk(2)], null, now)
check('missing tier map keeps least-loaded', noMap.serverId === 2)

// ---------- aging ----------
const aging = { lowToNormalMs: 30_000, normalToHighMs: 300_000 }
check('high is always rank 0', effectiveRank('high', 0, aging) === 0)
check('fresh low is rank 2', effectiveRank('low', 0, aging) === 2)
check('low promoted to normal after 30s', effectiveRank('low', 30_000, aging) === 1)
check('low just below threshold stays rank 2', effectiveRank('low', 29_999, aging) === 2)
check('normal promoted to high after 5m', effectiveRank('normal', 300_000, aging) === 0)
check('normal below threshold stays rank 1', effectiveRank('normal', 299_000, aging) === 1)
check('low reaches high after 30s+5m', effectiveRank('low', 330_000, aging) === 0)

// ---------- queue scheduling ----------
const t = (seq, clientId, priority, waitedMs) => ({ seq, clientId, priority, enqueuedAt: now - waitedMs })
const served = () => new Map()

check('empty queue picks nothing', pickNext([], now, served(), aging) === null)

let q = [t(3, 1, 'low', 0), t(1, 2, 'high', 0), t(2, 3, 'normal', 0)]
check('strict priority: high first', pickNext(q, now, served(), aging)?.index === 1)
q = [t(3, 1, 'low', 0), t(2, 3, 'normal', 0)]
check('normal before fresh low', pickNext(q, now, served(), aging)?.index === 1)

q = [t(1, 1, 'low', 31_000), t(2, 2, 'normal', 1_000)]
check('aged low competes with normal (rank 1 tie)', pickNext(q, now, served(), aging)?.rank === 1)
q = [t(1, 1, 'low', 60_000), t(2, 2, 'normal', 5_000)]
check('aged low is picked over fresh normal when normal already served', pickNext(q, now, new Map([[2, 3]]), aging)?.index === 0)
q = [t(1, 1, 'low', 340_000), t(2, 2, 'high', 0)]
check('starved low competes as high (older served first)', pickNext(q, now, served(), aging)?.index === 0)

// round-robin fairness inside one rank
q = [t(1, 7, 'normal', 5_000), t(2, 8, 'normal', 4_000), t(3, 7, 'normal', 3_000)]
let pick = pickNext(q, now, new Map([[7, 10]]), aging)
check('busy client does not starve a fresh one', pick?.index === 1)
pick = pickNext([t(1, 7, 'normal', 5_000), t(2, 8, 'normal', 5_000)], now, served(), aging)
check('equal service falls back to FIFO', pick?.index === 0)
pick = pickNext([t(2, 7, 'normal', 5_000), t(1, 7, 'normal', 5_000)], now, served(), aging)
check('same client: oldest seq first even if array order differs', pick?.index === 1)

console.log(failed === 0 ? '\nAll checks passed' : `\n${failed} checks FAILED`)
process.exitCode = failed > 0 ? 1 : 0
