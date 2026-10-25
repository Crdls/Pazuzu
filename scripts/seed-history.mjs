// Retro-fills the database with synthetic history (sine curves) to exercise
// the multi-resolution thinning ladder on a realistic shape:
//
//   node scripts/seed-history.mjs
//
// Fills three series on every enabled server for the last ~4 months: 10 s
// samples for 2 days, 1 min up to a week, 10 min up to a month, 1 h up to
// 120 days. Then open Settings -> System -> "Clean up now" (or wait for the
// rollup loop) and check that: row counts drop tier by tier, the charts for
// 24h/7d/30d stay smooth, and each series keeps oscillating around its base
// (that is the thinning averaging the right neighbours).
//
// Safe to run while the server is up (WAL). Requires Node >= 22.22 / 24.15.
import { useDb } from '../server/utils/db.ts'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

// [newest age, oldest age, sample step] - densest first, bands never overlap
const BANDS = [
  [0, 2 * DAY, 10_000],
  [2 * DAY, 7 * DAY, MIN],
  [7 * DAY, 30 * DAY, 10 * MIN],
  [30 * DAY, 120 * DAY, HOUR]
]

const SERIES = [
  { metric: 'strata:gpu_util', labels: 'gpu=0', base: 55, amp: 30, period: DAY },
  { metric: 'derived:gen_tok_s', labels: '', base: 120, amp: 80, period: 6 * HOUR },
  { metric: 'strata:gpu_temp_celsius', labels: 'gpu=0', base: 62, amp: 9, period: 1.5 * DAY }
]

function main () {
  const db = useDb()
  const servers = db.prepare('SELECT id, name FROM servers WHERE enabled = 1').all()
  if (servers.length === 0) {
    console.error('no enabled servers to attach the synthetic series to')
    process.exitCode = 1
    return
  }

  const now = Date.now()
  const insert = db.prepare('INSERT INTO samples (server_id, ts, metric, labels, value) VALUES (?, ?, ?, ?, ?)')
  let total = 0
  db.transaction(() => {
    for (const server of servers) {
      for (const s of SERIES) {
        for (const [from, to, step] of BANDS) {
          for (let t = Math.floor((now - from) / step) * step; t > now - to; t -= step) {
            // slow sine + fast wobble so charts and averages look organic
            const value = s.base + s.amp * Math.sin((2 * Math.PI * t) / s.period) + (s.amp / 10) * Math.sin(t / 37_000)
            insert.run(server.id, t, s.metric, s.labels, value)
            total++
          }
        }
      }
    }
  })()

  console.log(`seeded ${total.toLocaleString('en-US')} rows on ${servers.length} server(s) covering ~120 days`)
  console.log('now run the Settings -> System cleanup (or wait for the rollup loop) and watch the tiers collapse')
}

main()
