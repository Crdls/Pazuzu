/**
 * Gateway shared types. Pure module — no Nitro globals, no imports from other
 * utils — so bare Node tests can drive the routing/queue/session logic
 * directly (see test/gateway.test.mjs). Keep relative imports with `.ts`.
 */

export type ClientPriority = 'high' | 'normal' | 'low'
export const PRIORITIES: ClientPriority[] = ['high', 'normal', 'low']
export const DEFAULT_PRIORITY: ClientPriority = 'normal'

/** Routing preference tiers (client → server): lower rank is tried first. */
export const TIER_RANK: Record<ClientPriority, number> = { high: 0, normal: 1, low: 2 }

export type GatewayMode = 'on' | 'drain' | 'off'
export const GATEWAY_MODES: GatewayMode[] = ['on', 'drain', 'off']

/** A routing candidate as the scheduler sees it (snapshot of live load). */
export interface ServerLoad {
  id: number
  mode: GatewayMode
  /** max concurrent requests the gateway will let run on this engine */
  capacity: number
  /** requests the gateway currently has forwarded and not yet finished */
  inflight: number
  /** scraper says /metrics is reachable (soft gate; see isClosed) */
  up: boolean
  /** scrape-reported requests waiting inside the engine */
  upstreamWaiting: number
  /** scrape-reported KV cache usage, 0..1 */
  kvUsage: number
  /** while now < this, routing skips the server (transient error backoff) */
  ejectedUntil: number
}

/** Why routing refused to forward a fresh request onto a server. */
export function isAdmissible (s: ServerLoad, now: number): boolean {
  if (s.mode !== 'on') return false // drain/off: never take new work
  if (s.kvUsage >= 0.95) return false // engine about to thrash its KV cache
  if (!s.up && s.inflight === 0 && s.upstreamWaiting === 0) return false // down, nothing in flight
  return s.inflight < s.capacity && now >= s.ejectedUntil
}

/** Least-loaded server first: in-flight pressure, then KV usage, then id. */
export function loadScore (s: ServerLoad): number {
  return s.inflight + s.kvUsage * 0.5
}
