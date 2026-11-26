// Tests for the heatmap query core: the storage tier each period reads, that
// hour-wide cells built from rollup_hourly equal the ones from raw samples,
// sample-count weighting inside a wide cell, the raw fallback for a server the
// rollups do not cover yet, bucket alignment, per-metric aggregation across
// label series, the response cache, and the indexes the tier scans rely on.
// Run: node test/heatmap.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDb } from '../server/utils/db.ts'
import { HEATMAP_PERIODS, buildHeatmap, heatmapPayload } from '../server/utils/heatmap.ts'

let failed = 0
function check (name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`)
  if (!cond) failed++
}

// an isolated database - the first useDb() call below reads this config
const dir = mkdtempSync(join(tmpdir(), 'pazuzu-heatmap-test-'))
process.env.PAZUZU_CONFIG = join(dir, 'config.json')
writeFileSync(process.env.PAZUZU_CONFIG, JSON.stringify({ db: { path: join(dir, 'heatmap.db') } }))

const db = useDb()
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const now = Math.floor(Date.now() / MIN) * MIN

const addServer = (name) => db.prepare('INSERT INTO servers (name, url, created_at) VALUES (?, ?, ?)')
  .run(name, `http://${name}:8000`, now).lastInsertRowid
const alpha = addServer('alpha')
const beta = addServer('beta')

// two label series per metric and server, with values far apart, so a wrong
// aggregation across series cannot pass as a right one
const METRICS = {
  'strata:gpu_util': (t, gpu) => (gpu === 0 ? 10 : 20) + (Math.floor(t / 1000) % 5),
  'strata:gpu_power_watts': (t, gpu) => (gpu === 0 ? 100 : 200) + (Math.floor(t / 1000) % 5),
  'strata:gpu_temp_celsius': (t, gpu) => (gpu === 0 ? 40 : 60) + (Math.floor(t / 1000) % 5)
}
const insert = db.prepare('INSERT INTO samples (server_id, ts, metric, labels, value) VALUES (?, ?, ?, ?, ?)')
db.transaction(() => {
  for (let t = now - 24 * HOUR; t < now; t += MIN) {
    for (const sid of [alpha, beta]) {
      for (const [metric, fn] of Object.entries(METRICS)) {
        for (const gpu of [0, 1]) insert.run(sid, t, metric, `gpu=${gpu}`, fn(t, gpu))
      }
    }
  }
})()

/** the aggregate runRollups writes for its 3 h window, here over the whole 24 h */
db.prepare(`
  INSERT INTO rollup_hourly (server_id, hour, metric, labels, avg, max, min, n)
  SELECT server_id, CAST(ts / @hour AS INTEGER) * @hour AS hour, metric, labels,
         AVG(value), MAX(value), MIN(value), COUNT(*)
  FROM samples
  WHERE ts >= @from
  GROUP BY server_id, hour, metric, labels
  ON CONFLICT(server_id, hour, metric, labels) DO UPDATE SET
    avg = excluded.avg, max = excluded.max, min = excluded.min, n = excluded.n
`).run({ hour: HOUR, from: now - 25 * HOUR })

const servers = db.prepare('SELECT * FROM servers ORDER BY name COLLATE NOCASE').all()
const cellsOf = (rows, sid) => rows.find(r => r.serverId === sid).values

const grid = buildHeatmap(db, { metric: 'strata:gpu_util', period: HEATMAP_PERIODS['24h'], now, servers })

check('the 24 h view reads the hourly tier', HEATMAP_PERIODS['24h'].source === 'hourly')
check('a server with rollups does not fall back to raw', !grid.fallback && grid.source === 'hourly')
check('buckets are bucket-aligned and cover the span', grid.buckets.length === 25 &&
  grid.buckets.every(t => t % HOUR === 0) &&
  grid.buckets[0] === Math.floor((now - 24 * HOUR) / HOUR) * HOUR &&
  grid.buckets.at(-1) <= now && now - grid.buckets.at(-1) < HOUR)
check('every server has one value per bucket', grid.rows.length === 2 &&
  grid.rows.every(r => r.values.length === grid.buckets.length))

const rawGrid = buildHeatmap(db, { metric: 'strata:gpu_util', period: { ...HEATMAP_PERIODS['24h'], source: 'raw' }, now, servers })
const worstDiff = Math.max(...rawGrid.rows.flatMap(row =>
  cellsOf(grid.rows, row.serverId).map((v, i) => Math.abs((v ?? 0) - (row.values[i] ?? 0)))))
check('hourly cells equal the raw cells of the same window', rawGrid.rows.length === grid.rows.length && worstDiff < 1e-9)
check('no cell of a busy server is empty', grid.rows.every(r => r.values.every(v => v !== null)))

// aggregation across the label series follows the metric definition
function expectedCell (metric, sid, from) {
  const perSeries = new Map()
  for (const r of db.prepare('SELECT labels, ts, value FROM samples WHERE server_id = ? AND metric = ? AND ts >= ? AND ts < ?')
    .all(sid, metric, from, from + HOUR)) {
    const list = perSeries.get(r.labels) ?? perSeries.set(r.labels, []).get(r.labels)
    list.push(r.value)
  }
  const series = [...perSeries.values()].map(v => v.reduce((a, b) => a + b, 0) / v.length)
  return metric === 'strata:gpu_power_watts' ? series.reduce((a, b) => a + b, 0)
    : metric === 'strata:gpu_temp_celsius' ? Math.max(...series)
    : series.reduce((a, b) => a + b, 0) / series.length
}
for (const metric of Object.keys(METRICS)) {
  const g = buildHeatmap(db, { metric, period: HEATMAP_PERIODS['24h'], now, servers })
  const first = Math.floor((now - 24 * HOUR) / HOUR) * HOUR
  const diffs = g.rows.map(row => Math.abs(cellsOf(g.rows, row.serverId)[0] - expectedCell(metric, row.serverId, first)))
  check(`${metric}: cells aggregate label series as the catalog says`, Math.max(...diffs) < 1e-9)
}

// a cell wider than an hour weights each hour by its sample count, so a single
// stray sample cannot outvote an hour of them (a metric nothing else stored)
const wideBucket = Math.floor((now - 10 * DAY) / HEATMAP_PERIODS['30d'].bucket) * HEATMAP_PERIODS['30d'].bucket
const put = db.prepare('INSERT INTO rollup_hourly (server_id, hour, metric, labels, avg, max, min, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
put.run(alpha, wideBucket, 'strata:live_tok_s', '', 100, 100, 100, 1)
put.run(alpha, wideBucket + HOUR, 'strata:live_tok_s', '', 0, 0, 0, 999)
const wide = buildHeatmap(db, { metric: 'strata:live_tok_s', period: HEATMAP_PERIODS['30d'], now, servers: [servers.find(s => s.id === alpha)] })
const wideCell = wide.rows[0].values.find((v, i) => wide.buckets[i] <= wideBucket && wideBucket < wide.buckets[i] + HEATMAP_PERIODS['30d'].bucket)
check('wide cells average hours weighted by their sample count', Math.abs(wideCell - 0.1) < 1e-9)
check('cells outside the stored range stay empty', wide.rows[0].values.filter(v => v === null).length === wide.buckets.length - 1)

// a server the rollups do not cover yet is still drawn, from raw samples
const gamma = addServer('gamma')
db.transaction(() => {
  for (let t = now - HOUR; t < now; t += MIN) insert.run(gamma, t, 'strata:cpu', '', 42)
})()
const cpu = heatmapPayload(db, { period: '24h', metric: 'strata:cpu', now })
check('a server without rollup rows falls back to raw samples', cpu.fallback &&
  cpu.rows.find(r => r.serverId === gamma).values.some(v => Math.abs(v - 42) < 1e-9))
check('a server with no data at all renders empty cells', cpu.rows.find(r => r.serverId === alpha).values.every(v => v === null))
check('the tier that answered is reported to the client', cpu.source === 'raw')

// one payload per window: the heatmap is requested on every visit and on every
// period/metric flip, and each miss aggregates synchronously in the API process
const cacheNow = Math.floor(now / (2 * MIN)) * (2 * MIN)
const firstCall = heatmapPayload(db, { period: '1h', metric: 'strata:gpu_util', now: cacheNow })
check('a repeat request inside the window is served from the cache',
  heatmapPayload(db, { period: '1h', metric: 'strata:gpu_util', now: cacheNow + 1000 }) === firstCall)
check('an expired window is recomputed',
  heatmapPayload(db, { period: '1h', metric: 'strata:gpu_util', now: cacheNow + 31_000 }) !== firstCall)
db.prepare('INSERT INTO servers (name, url, created_at) VALUES (?, ?, ?)').run('delta', 'http://delta:8000', now)
check('a changed server set is not served from the cache',
  heatmapPayload(db, { period: '1h', metric: 'strata:gpu_util', now: cacheNow }).rows.length === firstCall.rows.length + 1)
check('the payload carries the catalog and the display metadata', firstCall.metricLabel === 'GPU util' &&
  firstCall.availableMetrics.length > 0 && firstCall.bucketMs === HEATMAP_PERIODS['1h'].bucket)

// the rollup tiers are keyed by (server, time, metric), so a metric-range scan
// needs its own index or it reads every metric of the window
for (const [table, index] of [['rollup_hourly', 'idx_rollup_hourly_metric'], ['rollup_daily', 'idx_rollup_daily_metric']]) {
  check(`${table} has the heatmap index`, db.prepare(`PRAGMA index_list(${table})`).all().some(i => i.name === index))
}
const plan = db.prepare('EXPLAIN QUERY PLAN SELECT hour, labels, avg, n FROM rollup_hourly WHERE server_id = ? AND metric = ? AND hour >= ?')
  .all(alpha, 'strata:gpu_util', now - 24 * HOUR).map(r => r.detail).join(' | ')
check('the hourly scan uses the metric index', plan.includes('idx_rollup_hourly_metric') && !plan.includes('sqlite_autoindex'))

console.log(failed === 0 ? '\nAll checks passed' : `\n${failed} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
