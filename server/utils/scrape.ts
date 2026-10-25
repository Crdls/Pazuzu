import { normalizeLabels, parsePrometheus, type Sample } from './parse'
import { useDb, type ServerRow } from './db'
import { BUSY_PCT, COUNTER_RATES, HIST_WINDOW_AVG, isBucketSeries, storeBucketSeries } from './metrics'
import { runtime, type Snapshot } from './runtime'

/** Base URL -> metrics endpoint URL. */
export function metricsUrl (url: string): string {
  const u = url.trim().replace(/\/+$/, '')
  return u.endsWith('/metrics') ? u : `${u}/metrics`
}

/** Headers for /metrics requests; newer Strata behind a key need a bearer token. */
export function metricsHeaders (server: ServerRow): Record<string, string> {
  const headers: Record<string, string> = { accept: 'text/plain' }
  if (server.api_key) headers.authorization = `Bearer ${server.api_key}`
  return headers
}

export function validateBaseUrl (url: string): string {
  const u = url.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(u)
  } catch {
    throw new Error(`invalid URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must start with http:// or https://')
  }
  return u
}

/**
 * Turn parsed samples into rows to store: raw samples plus derived series
 * (counter rates, histogram window averages, memory percentages).
 * Also advances the per-series `prev` state used for deltas.
 */
function buildRows (serverId: number, now: number, samples: Sample[]): Array<[string, string, number]> {
  const rt = runtime()
  const prevScrapeTs = rt.prevTs.get(serverId)
  const dtS = prevScrapeTs ? (now - prevScrapeTs) / 1000 : 0

  // index current values for label joins
  const byKey = new Map<string, number>()
  for (const s of samples) byKey.set(`${s.metric}|${normalizeLabels(s.labels)}`, s.value)

  // capture previous values BEFORE overwriting them
  const prevVals = new Map<string, number | undefined>()
  for (const s of samples) {
    const key = `${serverId}|${s.metric}|${normalizeLabels(s.labels)}`
    prevVals.set(key, rt.prev.get(key))
    rt.prev.set(key, s.value)
  }

  const rows: Array<[string, string, number]> = []
  for (const s of samples) {
    const labels = normalizeLabels(s.labels)
    rows.push([s.metric, labels, s.value])

    const prev = prevVals.get(`${serverId}|${s.metric}|${labels}`)
    if (prev === undefined || dtS <= 0) continue
    const delta = s.value - prev
    if (delta < 0) continue // counter reset

    const rateOut = COUNTER_RATES[s.metric]
    if (rateOut) rows.push([rateOut, labels, delta / dtS])

    const busyOut = BUSY_PCT[s.metric]
    if (busyOut) rows.push([busyOut, labels, Math.min(100, (delta / dtS) * 100)])
  }

  // histogram window averages: Δsum / Δcount
  for (const h of HIST_WINDOW_AVG) {
    for (const s of samples) {
      if (s.metric !== h.sum) continue
      const labels = normalizeLabels(s.labels)
      const prevSum = prevVals.get(`${serverId}|${h.sum}|${labels}`)
      const prevCount = prevVals.get(`${serverId}|${h.count}|${labels}`)
      const count = byKey.get(`${h.count}|${labels}`)
      if (prevSum === undefined || prevCount === undefined || count === undefined) continue
      const dCount = count - prevCount
      const dSum = s.value - prevSum
      if (dCount > 0 && dSum >= 0) rows.push([h.out, labels, dSum / dCount])
    }
  }

  // memory percentages
  for (const s of samples) {
    if (s.metric === 'strata:gpu_mem_used_bytes') {
      const labels = normalizeLabels(s.labels)
      const total = byKey.get(`strata:gpu_mem_total_bytes|${labels}`)
      if (total && total > 0) rows.push(['derived:gpu_mem_pct', labels, (s.value / total) * 100])
    } else if (s.metric === 'strata:ram_used_bytes') {
      const labels = normalizeLabels(s.labels)
      const total = byKey.get(`strata:ram_total_bytes|${labels}`)
      if (total && total > 0) rows.push(['derived:ram_pct', labels, (s.value / total) * 100])
    }
  }

  return rows
}

function insertSamples (serverId: number, ts: number, rows: Array<[string, string, number]>, storeBuckets: boolean) {
  const db = useDb()
  const stmt = db.prepare('INSERT INTO samples (server_id, ts, metric, labels, value) VALUES (?, ?, ?, ?, ?)')
  db.transaction((list: Array<[string, string, number]>) => {
    for (const [metric, labels, value] of list) {
      if (!Number.isFinite(value)) continue
      // histogram buckets are only stored on the minute (the live snapshot keeps them all)
      if (!storeBuckets && isBucketSeries(metric)) continue
      stmt.run(serverId, ts, metric, labels, value)
    }
  })(rows)
}

function groupRows (rows: Array<[string, string, number]>): Record<string, Array<[string, number]>> {
  const out: Record<string, Array<[string, number]>> = {}
  for (const [metric, labels, value] of rows) {
    ;(out[metric] ??= []).push([labels, value])
  }
  return out
}

export async function scrapeServer (server: ServerRow): Promise<Snapshot> {
  const rt = runtime()
  const now = Date.now()
  let snapshot: Snapshot
  try {
    const res = await fetch(metricsUrl(server.url), {
      signal: AbortSignal.timeout(5000),
      headers: metricsHeaders(server)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    const { samples } = parsePrometheus(text)
    if (samples.length === 0) throw new Error('response contained no samples')
    const rows = buildRows(server.id, now, samples)
    insertSamples(server.id, now, rows, storeBucketSeries(rt.prevTs.get(server.id), now))
    rt.prevTs.set(server.id, now)
    snapshot = { serverId: server.id, ts: now, up: true, metrics: groupRows(rows) }
  } catch (err) {
    snapshot = {
      serverId: server.id,
      ts: now,
      up: false,
      error: err instanceof Error ? err.message : String(err),
      metrics: {}
    }
  }
  const prevSnap = rt.snapshots.get(server.id)
  rt.snapshots.set(server.id, snapshot)
  if (!prevSnap || prevSnap.up !== snapshot.up) {
    useDb()
      .prepare('INSERT INTO server_status (server_id, ts, up, error) VALUES (?, ?, ?, ?)')
      .run(server.id, now, snapshot.up ? 1 : 0, snapshot.error ?? null)
  }
  return snapshot
}

export function broadcast (msg: unknown) {
  try {
    useWebSocket().publish(msg)
  } catch {
    // websocket layer not ready yet - clients fall back to polling
  }
}

export async function scrapeAll () {
  const rt = runtime()
  if (rt.scraping) return
  rt.scraping = true
  try {
    const servers = useDb().prepare('SELECT * FROM servers WHERE enabled = 1').all() as ServerRow[]
    await Promise.all(
      servers.map(async (server) => {
        const snapshot = await scrapeServer(server)
        broadcast({ type: 'snapshot', snapshot })
      })
    )
  } finally {
    rt.scraping = false
  }
}
