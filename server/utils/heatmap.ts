/**
 * Heatmap query core: one value per (server, time bucket) for the load
 * heatmap. Pure and reachable from bare Node (test/heatmap.test.mjs), so the
 * tier choice and the aggregation are checkable without Nitro.
 *
 * Cells are built in two steps: the label series of a metric are collapsed
 * inside a bucket first, then the metric's `agg` collapses the series into the
 * cell. The bucket is read from the cheapest storage tier that still holds it
 * finely enough (see HEATMAP_PERIODS), which is what keeps a period over all
 * servers a few hundred rows instead of a full day of raw samples per server.
 */
import { useDb, type ServerRow } from './db.ts'
import { runtime } from './runtime.ts'
import { HEATMAP_METRICS, metricDef } from './metrics.ts'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

export type HeatmapSource = 'raw' | 'hourly' | 'daily'

export interface HeatmapPeriod {
  span: number
  /** width of one heatmap cell */
  bucket: number
  /** storage tier the cells are read from */
  source: HeatmapSource
}

/**
 * Periods as offered in the UI. Only sub-hour cells need raw samples: hour-
 * wide cells come from `rollup_hourly`, which `runRollups` recomputes from raw
 * every cycle for the last 3 h, so it also holds the current partial hour
 * (about one scrape cycle behind) — a 24 h view would otherwise scan a full
 * day of ~10 s samples per server, the samples tier being un-thinned by age.
 */
export const HEATMAP_PERIODS: Record<string, HeatmapPeriod> = {
  '1h': { span: HOUR, bucket: 2 * MIN, source: 'raw' },
  '3h': { span: 3 * HOUR, bucket: 10 * MIN, source: 'raw' },
  '12h': { span: 12 * HOUR, bucket: 30 * MIN, source: 'raw' },
  '24h': { span: 24 * HOUR, bucket: HOUR, source: 'hourly' },
  '7d': { span: 7 * DAY, bucket: HOUR, source: 'hourly' },
  '30d': { span: 30 * DAY, bucket: 6 * HOUR, source: 'hourly' },
  '1y': { span: 365 * DAY, bucket: DAY, source: 'daily' }
}

export const DEFAULT_PERIOD = '24h'
export const DEFAULT_METRIC = 'strata:gpu_util'

/** a heatmap query slower than this gets a line in the server log */
const SLOW_MS = 200

/** the live trailing bucket moves, so a payload is only served this long */
const CACHE_MAX_MS = 30_000

const AGG_FN: Record<string, string> = { avg: 'AVG', sum: 'SUM', max: 'MAX' }

interface Tier {
  table: string
  ts: string
  /** one stored row of a label series, as an SQL expression */
  value: string
}

const TIERS: Record<HeatmapSource, Tier> = {
  raw: { table: 'samples', ts: 'ts', value: 'AVG(value)' },
  // an hour row already averages its raw rows: weight by their count, so cells
  // wider than an hour are not skewed by hours with a different scrape cadence
  hourly: { table: 'rollup_hourly', ts: 'hour', value: 'SUM(avg * n) / SUM(n)' },
  daily: { table: 'rollup_daily', ts: 'day', value: 'SUM(avg * n) / SUM(n)' }
}

export interface HeatmapRow {
  serverId: number
  name: string
  /** one entry per bucket, null where the server has no data for it */
  values: Array<number | null>
}

export interface HeatmapPayload {
  metric: string
  metricLabel: string
  unit: string
  scale: number
  period: string
  bucketMs: number
  buckets: number[]
  rows: HeatmapRow[]
  /** tier the cells came from; `raw` also when only some servers fell back */
  source: HeatmapSource
  /** true when at least one server had no rows in the period's tier */
  fallback: boolean
  availableMetrics: Array<{ value: string, label: string, unit: string }>
}

/** does this tier hold anything for that server and window? */
function tierHasRows (db: ReturnType<typeof useDb>, tier: HeatmapSource, sid: number, metric: string, from: number): boolean {
  const t = TIERS[tier]
  const row = db.prepare(
    `SELECT EXISTS (SELECT 1 FROM ${t.table} WHERE server_id = @sid AND metric = @metric AND ${t.ts} >= @from) AS n`
  ).get({ sid, metric, from }) as { n: number }
  return row.n === 1
}

/**
 * Buckets + one row per server. A server whose tier is still empty (added
 * moments ago, or rollups that have not run yet on a fresh database) is read
 * from raw samples instead, so the heatmap never renders a blank row for data
 * that is stored.
 */
export function buildHeatmap (
  db: ReturnType<typeof useDb>,
  opts: { metric: string, period: HeatmapPeriod, now: number, servers: ServerRow[] }
): { buckets: number[], rows: HeatmapRow[], source: HeatmapSource, fallback: boolean } {
  const { metric, period, now, servers } = opts
  const from = Math.floor((now - period.span) / period.bucket) * period.bucket

  const buckets: number[] = []
  for (let t = from; t <= now; t += period.bucket) buckets.push(t)

  const agg = AGG_FN[metricDef(metric).agg] ?? 'AVG'
  const cellSql = (src: Tier) => `
    SELECT t, ${agg}(s) AS v FROM (
      SELECT CAST(${src.ts} / @bucket AS INTEGER) * @bucket AS t, labels, ${src.value} AS s
      FROM ${src.table}
      WHERE server_id = @sid AND metric = @metric AND ${src.ts} >= @from
      GROUP BY t, labels
    )
    GROUP BY t`
  const stmts = new Map<HeatmapSource, ReturnType<typeof db.prepare>>()
  const stmtFor = (tier: HeatmapSource) => {
    let stmt = stmts.get(tier)
    if (!stmt) {
      stmt = db.prepare(cellSql(TIERS[tier]))
      stmts.set(tier, stmt)
    }
    return stmt
  }

  const started = Date.now()
  let fallback = false
  const rows = servers.map((server) => {
    let tier = period.source
    if (tier !== 'raw' && !tierHasRows(db, tier, server.id, metric, from)) {
      tier = 'raw'
      fallback = true
    }
    const byBucket = new Map<number, number>(
      (stmtFor(tier).all({ sid: server.id, metric, from, bucket: period.bucket }) as Array<{ t: number, v: number }>)
        .map(r => [r.t, r.v])
    )
    return {
      serverId: server.id,
      name: server.name,
      values: buckets.map(t => byBucket.get(t) ?? null)
    }
  })

  const ms = Date.now() - started
  if (ms > SLOW_MS) {
    const cells = buckets.length * servers.length
    console.warn(`[pazuzu] heatmap query took ${ms} ms (metric ${metric}, bucket ${period.bucket / 1000} s,` +
      ` tier ${period.source}${fallback ? ' + raw fallback' : ''}, ${servers.length} servers, ${cells} cells)`)
  }

  return { buckets, rows, source: fallback ? 'raw' : period.source, fallback }
}

export interface HeatmapCacheEntry {
  /** window start the payload was built for: the next bucket invalidates it */
  from: number
  /** the server set it covers: adding or removing a server invalidates it */
  serverKey: string
  /** payloads are served until then; the trailing bucket holds live data */
  expiresAt: number
  payload: HeatmapPayload
}

/**
 * The whole API payload for one period/metric, served from a short-lived
 * per-process cache: the heatmap re-renders on every visit and on every flip
 * between period and metric, and better-sqlite3 would run the aggregation
 * synchronously (blocking scrapes and WebSocket traffic) for each of them.
 * Keys are period x metric, so the map stays tiny and needs no pruning.
 */
export function heatmapPayload (db: ReturnType<typeof useDb>, opts: { period: string, metric: string, now?: number }): HeatmapPayload {
  const periodKey = HEATMAP_PERIODS[opts.period] ? opts.period : DEFAULT_PERIOD
  const period = HEATMAP_PERIODS[periodKey]!
  const metric = opts.metric || DEFAULT_METRIC
  const now = opts.now ?? Date.now()

  const servers = db.prepare('SELECT * FROM servers ORDER BY name COLLATE NOCASE').all() as ServerRow[]
  const from = Math.floor((now - period.span) / period.bucket) * period.bucket
  const serverKey = servers.map(s => s.id).join(',')

  const cache = runtime().heatmap!.cache
  const key = `${periodKey}|${metric}`
  const hit = cache.get(key)
  if (hit && hit.from === from && hit.serverKey === serverKey && now < hit.expiresAt) return hit.payload

  const grid = buildHeatmap(db, { metric, period, now, servers })
  const def = metricDef(metric)
  const payload: HeatmapPayload = {
    metric,
    metricLabel: def.label,
    unit: def.unit,
    scale: def.scale ?? 1,
    period: periodKey,
    bucketMs: period.bucket,
    buckets: grid.buckets,
    rows: grid.rows,
    source: grid.source,
    fallback: grid.fallback,
    availableMetrics: HEATMAP_METRICS.map(k => ({ value: k, label: metricDef(k).label, unit: metricDef(k).unit }))
  }
  cache.set(key, { from, serverKey, expiresAt: now + Math.min(period.bucket / 2, CACHE_MAX_MS), payload })
  return payload
}
