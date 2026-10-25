// Tests for the multi-resolution thinning ladder: exact per-window averages,
// series isolation (no "foreign neighbours"), fresh rows untouched, idempotent
// replay, and that runRollups still rolls up and expires hours afterwards.
// Run: node test/thin.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDb } from '../server/utils/db.ts'
import { runRollups, runThinning, THIN_TIERS } from '../server/utils/rollup.ts'

let failed = 0
function check (name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`)
  if (!cond) failed++
}

// an isolated database - the first useDb() call below reads this config
const dir = mkdtempSync(join(tmpdir(), 'pazuzu-thin-test-'))
process.env.PAZUZU_CONFIG = join(dir, 'config.json')
writeFileSync(process.env.PAZUZU_CONFIG, JSON.stringify({ db: { path: join(dir, 'thin.db') } }))

const db = useDb()
const MIN = 60_000
const HOUR = 3_600_000
const now = Math.floor(Date.now() / 10_000) * 10_000

check('tiers get older and coarser', THIN_TIERS.every((t, i) => i === 0 || (t.ageH > THIN_TIERS[i - 1].ageH && t.stepS > THIN_TIERS[i - 1].stepS)))
check('first tier is older than the 3 h hourly recompute window', THIN_TIERS[0].ageH > 3)

// value ranges per series are far apart, so any cross-series mixing is visible
const SERIES = [
  { sid: 1, metric: 'strata:gpu_util', labels: 'gpu=0', base: 10 },
  { sid: 1, metric: 'strata:gpu_util', labels: 'gpu=1', base: 1000 },
  { sid: 1, metric: 'derived:gen_tok_s', labels: '', base: 5000 },
  { sid: 2, metric: 'strata:gpu_util', labels: 'gpu=0', base: 90_000 }
]
const val = (s, ts) => s.base + (Math.floor(ts / 1000) % 7)

const insert = db.prepare('INSERT INTO samples (server_id, ts, metric, labels, value) VALUES (?, ?, ?, ?, ?)')
const inputs = []
function fill (fromAgeH, toAgeH, stepMs) {
  for (let t = now - fromAgeH * HOUR; t < now - toAgeH * HOUR; t += stepMs) {
    const ts = Math.floor(t / stepMs) * stepMs
    for (const s of SERIES) {
      const v = val(s, ts)
      insert.run(s.sid, ts, s.metric, s.labels, v)
      inputs.push({ s, ts, v })
    }
  }
}

fill(30, 20, 10_000) // territory of tier 0 (1 min after a day)
fill(80, 73, 10_000) // territory of tier 1 (10 min after 3 days)

const freshInputs = inputs.filter(i => i.ts >= Math.floor((now - 24 * HOUR - MIN) / MIN) * MIN).length

const removed = runThinning(now, true)
check('thinning reports net row removals', removed > 0)

// tier boundaries: only windows lying entirely older than the tier age fold
const t0 = Math.floor((now - THIN_TIERS[0].ageH * HOUR - THIN_TIERS[0].stepS * 1000) / (THIN_TIERS[0].stepS * 1000)) * THIN_TIERS[0].stepS * 1000
const t1 = Math.floor((now - THIN_TIERS[1].ageH * HOUR - THIN_TIERS[1].stepS * 1000) / (THIN_TIERS[1].stepS * 1000)) * THIN_TIERS[1].stepS * 1000

const rows = db.prepare('SELECT server_id, metric, labels, ts, value FROM samples').all()

/** every stored row in [loTs, hiTs) equals the average of its input window */
function matchTier (stepMs, loTs, hiTs, label) {
  const exp = new Map()
  for (const { s, ts, v } of inputs) {
    if (ts < loTs || ts >= hiTs) continue
    const key = `${s.sid}|${s.metric}|${s.labels}|${Math.floor(ts / stepMs) * stepMs}`
    ;(exp.get(key) ?? exp.set(key, []).get(key)).push(v)
  }
  let ok = true
  let seen = 0
  for (const r of rows) {
    if (r.ts < loTs || r.ts >= hiTs) continue
    seen++
    const key = `${r.server_id}|${r.metric}|${r.labels}|${r.ts}`
    const e = exp.get(key)
    if (!e) { ok = false; console.error(`  ${label}: unexpected row ${key} = ${r.value}`); continue }
    const avg = e.reduce((a, b) => a + b, 0) / e.length
    if (Math.abs(r.value - avg) > 1e-9) { ok = false; console.error(`  ${label}: mismatch ${key}: ${r.value} != ${avg}`) }
    exp.delete(key)
  }
  check(`${label}: stored rows are exactly the window averages`, ok && seen > 0)
  check(`${label}: no input window was lost`, exp.size === 0)
}

// tier 0 averages the raw inputs directly, so exactness holds everywhere in its band
matchTier(MIN, t1, t0, 'tier 0 (1 min)')
// tier 1 averages tier-0 averages: exact where the cadence is even, hence the
// interior bounds away from the seeded band edges
matchTier(600_000, Math.floor((now - 79 * HOUR) / 600_000) * 600_000, t1, 'tier 1 (10 min)')

check('fresh rows were not touched', rows.filter(r => r.ts >= t0).length === freshInputs)
check('thinned rows sit on window boundaries', rows.every(r => r.ts >= t0 || r.ts % MIN === 0))
check('thinning collapsed more than it wrote', rows.length < inputs.length)

const snapshot = () => JSON.stringify(
  db.prepare('SELECT server_id sid, metric m, labels l, ts, value v FROM samples ORDER BY sid, m, l, ts').all()
)
const before = snapshot()
check('replay removes nothing', runThinning(now, true) === 0)
check('replay leaves the data intact', snapshot() === before)

// rollups and hourly retention keep working next to thinned samples
fill(2, 0.5, 10_000)
db.prepare('INSERT INTO rollup_hourly (server_id, hour, metric, labels, avg, max, min, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  .run(1, Math.floor((now - 410 * 24 * HOUR) / HOUR) * HOUR, 'strata:gpu_util', 'gpu=0', 1, 1, 1, 1)
runRollups()
check('recent hours are rolled up', (db.prepare('SELECT COUNT(*) AS n FROM rollup_hourly WHERE hour >= ?').get(now - 3 * HOUR).n) > 0)
check('hours older than the retention expire', (db.prepare('SELECT COUNT(*) AS n FROM rollup_hourly WHERE hour < ?').get(now - 400 * 24 * HOUR).n) === 0)

console.log(failed === 0 ? '\nAll checks passed' : `\n${failed} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
