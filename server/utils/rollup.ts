import { getSettings, useDb } from './db.ts'
import { runtime } from './runtime.ts'

const HOUR = 3_600_000
const DAY = 86_400_000

/**
 * Multi-resolution ladder for raw samples: once a series is older than
 * `ageH` hours it is thinned to one row per `stepS`-second window holding the
 * average of the collapsed rows. The average is the one aggregate that
 * composes exactly across tiers (an average of window averages is again the
 * average of the raw rows as long as the scrape cadence is even); spikes are
 * not lost because `rollup_hourly` keeps max/min per hour.
 *
 * Fold windows are aligned to the epoch and only windows *entirely* older
 * than a tier boundary are folded, so a fold can never mix in rows of a
 * neighbouring series or eat samples that have not aged enough yet. Each
 * tier keeps a monotonic cursor in the settings table (`thin_cursor_N`), so
 * a window is folded exactly once per tier and a restart only re-walks the
 * already-thinned history idempotently. The hourly rollup recomputes the
 * last 3 hours from raw samples, far fresher than the first tier, so the
 * aggregates never see thinned data.
 */
export const THIN_TIERS: Array<{ ageH: number, stepS: number }> = [
  { ageH: 24, stepS: 60 }, // 1 day -> 1 min
  { ageH: 72, stepS: 600 }, // 3 days -> 10 min
  { ageH: 168, stepS: 3_600 }, // 1 week -> 1 h
  { ageH: 720, stepS: 10_800 }, // 1 month -> 3 h
  { ageH: 2_160, stepS: 43_200 }, // 3 months -> 12 h
  { ageH: 8_760, stepS: 86_400 } // 1 year -> 1 day
]

/** fold at most this much wall time per tier per cycle (only matters for catch-up) */
const TIER_CHUNK_MAX = 30 * DAY

export interface CleanupReport {
  /** net raw rows removed by full thinning */
  rowsRemoved: number
  bytesBefore: number
  bytesAfter: number
}

/**
 * Idempotent downsampling + retention + thinning + opportunistic compaction.
 * Safe to run at any frequency: recent hours are recomputed from raw samples,
 * recent days from hours.
 */
export function runRollups () {
  const db = useDb()
  const settings = getSettings()
  const now = Date.now()

  const fromHour = Math.floor((now - 3 * HOUR) / HOUR) * HOUR
  db.prepare(`
    INSERT INTO rollup_hourly (server_id, hour, metric, labels, avg, max, min, n)
    SELECT server_id, CAST(ts / @hour AS INTEGER) * @hour AS hour, metric, labels,
           AVG(value), MAX(value), MIN(value), COUNT(*)
    FROM samples
    WHERE ts >= @fromHour
    GROUP BY server_id, hour, metric, labels
    ON CONFLICT(server_id, hour, metric, labels) DO UPDATE SET
      avg = excluded.avg, max = excluded.max, min = excluded.min, n = excluded.n
  `).run({ hour: HOUR, fromHour })

  const fromDay = Math.floor((now - 3 * DAY) / DAY) * DAY
  db.prepare(`
    INSERT INTO rollup_daily (server_id, day, metric, labels, avg, max, min, n)
    SELECT server_id, CAST(hour / @day AS INTEGER) * @day AS day, metric, labels,
           SUM(avg * n) / SUM(n), MAX(max), MIN(min), SUM(n)
    FROM rollup_hourly
    WHERE hour >= @fromDay
    GROUP BY server_id, day, metric, labels
    ON CONFLICT(server_id, day, metric, labels) DO UPDATE SET
      avg = excluded.avg, max = excluded.max, min = excluded.min, n = excluded.n
  `).run({ day: DAY, fromDay })

  db.prepare('DELETE FROM rollup_hourly WHERE hour < ?').run(now - settings.hourlyRetentionD * DAY)
  db.prepare('DELETE FROM server_status WHERE ts < ?').run(now - settings.hourlyRetentionD * DAY)

  runThinning(now, false)
  maybeVacuum(now)
}

/**
 * Collapse each tier's newly aged slice to its step. `full` runs every tier
 * until caught up (manual cleanup); otherwise one bounded chunk per tier per
 * cycle. Returns the net number of raw rows removed.
 */
export function runThinning (now: number, full: boolean): number {
  const db = useDb()
  let removed = 0
  for (let i = 0; i < THIN_TIERS.length; i++) {
    for (;;) {
      const folded = foldChunk(db, i, now, full)
      if (folded === null) break
      removed += folded
      if (!full) break
    }
  }
  return removed
}

/** fold the next chunk of one tier; null when the tier is up to date */
function foldChunk (db: ReturnType<typeof useDb>, tierIndex: number, now: number, full: boolean): number | null {
  const tier = THIN_TIERS[tierIndex]!
  const step = tier.stepS * 1000
  // fold only windows that lie entirely older than the tier boundary
  const target = Math.floor((now - tier.ageH * HOUR - step) / step) * step
  const cursorKey = `thin_cursor_${tierIndex}`
  const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get(cursorKey) as { value: string } | undefined
  // first run ever: start from the oldest sample so existing history gets thinned too
  const cursor = stored ? Number(stored.value) : (db.prepare('SELECT MIN(ts) AS m FROM samples').get() as { m: number | null }).m ?? 0
  if (cursor >= target) return null

  const t0 = Math.floor(cursor / step) * step
  const chunkMax = Math.min(tier.stepS * 1000 * 2000, TIER_CHUNK_MAX)
  const t1 = full ? target : Math.min(target, t0 + chunkMax)

  const fold = db.transaction(() => {
    db.prepare('DROP TABLE IF EXISTS temp.thin_src').run()
    db.prepare(`
      CREATE TEMP TABLE thin_src AS
      SELECT server_id, CAST(ts / @step AS INTEGER) * @step AS ts, metric, labels, AVG(value) AS value
      FROM samples
      WHERE ts >= @t0 AND ts < @t1
      GROUP BY server_id, metric, labels, CAST(ts / @step AS INTEGER)
    `).run({ step, t0, t1 })
    const deleted = db.prepare('DELETE FROM samples WHERE ts >= @t0 AND ts < @t1').run({ t0, t1 }).changes
    const kept = db.prepare('INSERT INTO samples (server_id, ts, metric, labels, value) SELECT server_id, ts, metric, labels, value FROM thin_src').run().changes
    db.prepare('DROP TABLE thin_src').run()
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(cursorKey, String(t1))
    return deleted - kept
  })
  return fold()
}

/** hand the freed pages back to the disk - VACUUM is heavy, so at most daily */
function maybeVacuum (now: number) {
  const storage = runtime().storage!
  if (now - storage.lastVacuumTs < DAY) return
  const db = useDb()
  const freelist = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count
  const pages = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
  if (freelist < 20_000 || freelist * 10 < pages) return
  storage.lastVacuumTs = now
  try {
    db.prepare('VACUUM').run()
  } catch (err) {
    console.error('[pazuzu] auto-vacuum failed:', err)
  }
}

/** size and row-count numbers for the Settings storage card */
export function storageStats () {
  const db = useDb()
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
  const pages = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
  const freelist = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  return {
    dbBytes: pages * pageSize,
    freelistBytes: freelist * pageSize,
    samples: count('SELECT COUNT(*) AS n FROM samples'),
    hourly: count('SELECT COUNT(*) AS n FROM rollup_hourly'),
    daily: count('SELECT COUNT(*) AS n FROM rollup_daily'),
    lastVacuumTs: runtime().storage?.lastVacuumTs ?? 0
  }
}

/**
 * Manual out-of-band cleanup (superadmin button, scripts/prune.mjs):
 * rollups + retention, every thin tier caught up, then VACUUM unconditionally.
 */
export function cleanupNow (): CleanupReport {
  const bytesBefore = storageStats().dbBytes
  runRollups()
  const rowsRemoved = runThinning(Date.now(), true)
  const storage = runtime().storage!
  storage.lastVacuumTs = Date.now()
  useDb().prepare('VACUUM').run()
  useDb().prepare('PRAGMA wal_checkpoint(TRUNCATE)').run()
  return { rowsRemoved, bytesBefore, bytesAfter: storageStats().dbBytes }
}
