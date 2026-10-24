import {
  flushGatewayIpHits, flushGatewayUsage, getGatewaySessionServer, purgeGatewaySessions,
  upsertGatewaySession, useDb, type ServerRow
} from '../db.ts'
import { loadConfig } from '../config.ts'
import { gatewayRuntime, runtime } from '../runtime.ts'
import { allowedServerIds } from '../db.ts'
import { hasCapacity, pickServer } from './router.ts'
import { pickNext, type AgingMs, type QueueEntry } from './queue.ts'
import type { ServerLoad } from './types.ts'

/**
 * Gateway glue: live load of every engine, slot accounting, the priority
 * waiting room, affinity storage and the stats aggregators. All state lives
 * on globalThis (runtime.ts) so dev HMR cannot duplicate it.
 */

/** starvation guard from the design: treated one level up after these waits */
export const AGING: AgingMs = { lowToNormalMs: 30_000, normalToHighMs: 300_000 }

const DAY = 86_400_000
export const usageDay = (ts: number): number => Math.floor(ts / DAY) * DAY

/** Rejection reason when a queued request is cancelled (timeout/disconnect). */
export const QUEUE_CANCELLED = 'queue-cancelled'

function sumMetric (serverId: number, metric: string): number {
  const series = runtime().snapshots.get(serverId)?.metrics[metric]
  if (!series) return 0
  let sum = 0
  for (const [, value] of series) sum += value
  return sum
}

function maxMetric (serverId: number, metric: string): number {
  const series = runtime().snapshots.get(serverId)?.metrics[metric]
  if (!series) return 0
  let max = 0
  for (const [, value] of series) if (value > max) max = value
  return max
}

/** Concurrency cap: explicit column > engine batch slots > config default. */
export function effectiveCapacity (server: ServerRow): number {
  if (server.gateway_capacity != null && server.gateway_capacity > 0) return server.gateway_capacity
  const slots = runtime().snapshots.get(server.id)?.metrics['strata:live_slots']
  if (slots) {
    let sum = 0
    for (const [, value] of slots) sum += value
    if (sum >= 1) return Math.floor(sum)
  }
  return loadConfig().gateway.defaultCapacity
}

/** Live snapshot of every engine as the scheduler sees it. */
export function serverLoads (now: number): ServerLoad[] {
  const gw = gatewayRuntime()
  const servers = useDb().prepare('SELECT * FROM servers').all() as ServerRow[]
  return servers.map(s => ({
    id: s.id,
    mode: s.enabled === 1 ? s.gateway_mode : 'off', // monitoring off = stats only
    capacity: effectiveCapacity(s),
    inflight: gw.inflight.get(s.id) ?? 0,
    up: runtime().snapshots.get(s.id)?.up ?? false,
    upstreamWaiting: sumMetric(s.id, 'vllm:num_requests_waiting'),
    kvUsage: maxMetric(s.id, 'vllm:kv_cache_usage_perc'),
    ejectedUntil: gw.ejectedUntil.get(s.id) ?? 0
  }))
}

/** Loads narrowed to what one client may use; a null allowed set changes nothing. */
export function filterLoads (loads: ServerLoad[], allowed: Set<number> | null): ServerLoad[] {
  return allowed ? loads.filter(s => allowed.has(s.id)) : loads
}

/** Live load of the engines this client is allowed to route to. */
export function loadsForClient (loads: ServerLoad[], clientId: number): ServerLoad[] {
  return filterLoads(loads, allowedServerIds(clientId))
}

export function reserve (serverId: number): void {
  const gw = gatewayRuntime()
  gw.inflight.set(serverId, (gw.inflight.get(serverId) ?? 0) + 1)
}

export function release (serverId: number): void {
  const gw = gatewayRuntime()
  const n = (gw.inflight.get(serverId) ?? 1) - 1
  if (n > 0) gw.inflight.set(serverId, n)
  else gw.inflight.delete(serverId)
  dispatch() // a slot just opened — the waiting room may move
}

/** A live request hit a dead/erroring engine: skip it for a while. */
export function eject (serverId: number): void {
  const gw = gatewayRuntime()
  gw.ejectedUntil.set(serverId, Date.now() + loadConfig().gateway.ejectionS * 1000)
  dispatch() // the next candidate may be elsewhere
}

// ---------- affinity ----------

export function getAffinity (keyHash: string, now: number): number | null {
  const gw = gatewayRuntime()
  const idleMs = loadConfig().gateway.sessionIdleMin * 60_000
  const cached = gw.affinity.get(keyHash)
  if (cached) {
    if (now - cached.lastUsed > idleMs) {
      gw.affinity.delete(keyHash)
    } else {
      cached.lastUsed = now
      // slide the DB timestamp occasionally so a restart doesn't lose the chat
      if (now - cached.written > 60_000) {
        upsertGatewaySession(keyHash, cached.serverId, now)
        cached.written = now
      }
      return cached.serverId
    }
  }
  const serverId = getGatewaySessionServer(keyHash)
  if (serverId == null) return null
  const row = useDb().prepare('SELECT last_used FROM gateway_sessions WHERE key_hash = ?').get(keyHash) as { last_used: number } | null
  if (!row || now - row.last_used > idleMs) {
    useDb().prepare('DELETE FROM gateway_sessions WHERE key_hash = ?').run(keyHash)
    return null
  }
  gw.affinity.set(keyHash, { serverId, lastUsed: now, written: now })
  return serverId
}

export function setAffinity (keyHash: string, serverId: number, now: number): void {
  const gw = gatewayRuntime()
  gw.affinity.set(keyHash, { serverId, lastUsed: now, written: now })
  upsertGatewaySession(keyHash, serverId, now)
}

// ---------- waiting room ----------

/** Thrown (rejection) when the queue refuses a request outright. */
export class QueueFullError extends Error {
  constructor (reason: 'global' | 'client') {
    super(reason === 'global' ? 'gateway queue is full' : 'too many queued requests for this client')
    this.name = 'QueueFullError'
  }
}

/** True while at least one waiting request could still use one of its engines. */
function queueHasReachableWork (now: number): boolean {
  const gw = gatewayRuntime()
  const loads = serverLoads(now)
  return gw.queue.some(t => hasCapacity(loadsForClient(loads, t.clientId), now))
}

/**
 * The fast path: take a server right now, but only when nobody is waiting
 * for work this arrival could not take itself (queued requests have priority
 * over fresh arrivals — no queue-jumping within each client's reach).
 */
export function acquireNow (loads: ServerLoad[], preferredId: number | null, now: number): ReturnType<typeof pickServer> {
  const gw = gatewayRuntime()
  if (gw.queue.length > 0 && queueHasReachableWork(now)) return { serverId: null, affinity: false }
  const decision = pickServer(loads, preferredId, now)
  if (decision.serverId != null) reserve(decision.serverId)
  return decision
}

/** Park the request until `dispatch()` grants it a server; rejects on cancel. */
export function queueRequest (task: Omit<QueueEntry, 'seq' | 'resolve' | 'reject'>): { seq: number, promise: Promise<number> } {
  const gw = gatewayRuntime()
  const cfg = loadConfig().gateway
  let mine = 0
  for (const t of gw.queue) if (t.clientId === task.clientId) mine++
  if (gw.queue.length >= cfg.queueMax) return { seq: -1, promise: Promise.reject(new QueueFullError('global')) }
  if (mine >= cfg.queueMaxPerClient) return { seq: -1, promise: Promise.reject(new QueueFullError('client')) }
  const seq = gw.queueSeq++
  let resolveFn: (serverId: number) => void = () => {}
  let rejectFn: (err: unknown) => void = () => {}
  const promise = new Promise<number>((resolve, reject) => { resolveFn = resolve; rejectFn = reject })
  gw.queue.push({ ...task, seq, resolve: resolveFn, reject: rejectFn })
  dispatch()
  return { seq, promise }
}

export function cancelQueued (seq: number): void {
  const gw = gatewayRuntime()
  const i = gw.queue.findIndex(t => t.seq === seq)
  if (i < 0) return
  const [task] = gw.queue.splice(i, 1)
  task!.reject(QUEUE_CANCELLED)
}

/** Hand free slots to waiting tasks in scheduling order until one sticks. */
export function dispatch (): void {
  const gw = gatewayRuntime()
  for (;;) {
    if (gw.queue.length === 0) return
    const now = Date.now()
    const loads = serverLoads(now)
    // a task whose allowed engines are all saturated must not hold a lane
    // other clients could use: no-queue-jumping applies within each reach
    const movable = gw.queue.filter(t => hasCapacity(loadsForClient(loads, t.clientId), now))
    const pick = pickNext(movable, now, gw.served, AGING)
    if (!pick) return
    const task = movable[pick.index]!
    const decision = pickServer(loadsForClient(loads, task.clientId), task.preferredId, now)
    if (decision.serverId == null) return // the strict head cannot move — nobody jumps the lane
    gw.served.set(task.clientId, (gw.served.get(task.clientId) ?? 0) + 1)
    gw.queue.splice(gw.queue.indexOf(task), 1)
    if (task.keyHash) setAffinity(task.keyHash, decision.serverId, now)
    reserve(decision.serverId)
    task.resolve(decision.serverId)
  }
}

// ---------- stats aggregators ----------

export function recordIpHit (clientId: number, ip: string): void {
  const gw = gatewayRuntime()
  const now = Date.now()
  const key = `${clientId}|${ip}`
  const hit = gw.ipAgg.get(key)
  if (hit) { hit.last = now; hit.hits++ } else gw.ipAgg.set(key, { clientId, ip, first: now, last: now, hits: 1 })
  if (gw.ipAgg.size > 5000) flushIpAgg()
}

export function recordUsage (clientId: number, patch: { requests?: number, ok?: number, errors?: number, promptTokens?: number, genTokens?: number }): void {
  const gw = gatewayRuntime()
  const day = usageDay(Date.now())
  const key = `${clientId}|${day}`
  let row = gw.usageAgg.get(key)
  if (!row) {
    row = { clientId, day, requests: 0, ok: 0, errors: 0, promptTokens: 0, genTokens: 0 }
    gw.usageAgg.set(key, row)
  }
  row.requests += patch.requests ?? 0
  row.ok += patch.ok ?? 0
  row.errors += patch.errors ?? 0
  row.promptTokens += patch.promptTokens ?? 0
  row.genTokens += patch.genTokens ?? 0
}

// ---------- background loop ----------

function flushIpAgg (): void {
  const gw = gatewayRuntime()
  if (gw.ipAgg.size === 0) return
  const rows = [...gw.ipAgg.values()]
  gw.ipAgg.clear()
  flushGatewayIpHits(rows)
}

function flushUsageAgg (): void {
  const gw = gatewayRuntime()
  if (gw.usageAgg.size === 0) return
  const rows = [...gw.usageAgg.values()]
  gw.usageAgg.clear()
  flushGatewayUsage(rows)
}

/** One maintenance pass: dispatch, persist aggregators, expire affinity. */
export function gatewayTick (): void {
  dispatch()
  flushIpAgg()
  flushUsageAgg()
  const now = Date.now()
  const gw = gatewayRuntime()
  const idleMs = loadConfig().gateway.sessionIdleMin * 60_000
  for (const [key, v] of gw.affinity) if (now - v.lastUsed > idleMs) gw.affinity.delete(key)
  purgeGatewaySessions(now - idleMs)
}

function scheduleGatewayLoop (): void {
  const gw = gatewayRuntime()
  if (gw.loopTimer) clearTimeout(gw.loopTimer)
  gw.loopTimer = setTimeout(() => {
    try {
      gatewayTick()
    } catch (err) {
      console.error('[pazuzu] gateway tick failed:', err)
    }
    scheduleGatewayLoop()
  }, 5000)
  gw.loopTimer.unref?.()
}

/** Start the self-rescheduling 5 s loop (aging wake-up, flushes, purge). */
export function startGatewayLoop (): void {
  scheduleGatewayLoop()
}

// ---------- status ----------

export interface GatewayServerStatus {
  id: number
  name: string
  mode: ServerLoad['mode']
  capacity: number
  inflight: number
  up: boolean
  ejected: boolean
  upstreamWaiting: number
  kvUsage: number
}

export interface GatewayStatus {
  enabled: boolean
  clients: number
  activeClients: number
  queue: { total: number, high: number, normal: number, low: number }
  servers: GatewayServerStatus[]
}

/** Snapshot for the admin UI: queue lanes by base priority + per-server load. */
export function gatewayStatus (): GatewayStatus {
  const now = Date.now()
  const gw = gatewayRuntime()
  const cfg = loadConfig().gateway
  const loads = serverLoads(now)
  const names = new Map<number, string>(
    (useDb().prepare('SELECT id, name FROM servers').all() as Array<{ id: number, name: string }>)
      .map(r => [r.id, r.name])
  )
  const lanes = { total: gw.queue.length, high: 0, normal: 0, low: 0 }
  for (const t of gw.queue) lanes[t.priority]++
  const clientCounts = useDb()
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(enabled), 0) AS active FROM gateway_clients')
    .get() as { n: number, active: number }
  return {
    enabled: cfg.enabled,
    clients: clientCounts.n,
    activeClients: clientCounts.active,
    queue: lanes,
    servers: loads.map(s => ({
      id: s.id,
      name: names.get(s.id) ?? `#${s.id}`,
      mode: s.mode,
      capacity: s.capacity,
      inflight: s.inflight,
      up: s.up,
      ejected: now < s.ejectedUntil,
      upstreamWaiting: s.upstreamWaiting,
      kvUsage: s.kvUsage
    }))
  }
}
