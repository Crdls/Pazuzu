/**
 * Process-wide runtime state. Stored on globalThis so that Nitro dev HMR
 * reloads of plugins/utils do not duplicate timers or lose state.
 */
import type { AppConfig } from './config'

export interface Snapshot {
  serverId: number
  ts: number
  up: boolean
  error?: string
  /** metric key -> list of [normalized labels, value] */
  metrics: Record<string, Array<[string, number]>>
}

interface Runtime {
  /** `${serverId}|${metric}|${labels}` -> last value (for counter deltas) */
  prev: Map<string, number>
  /** serverId -> last successful scrape ts (ms) */
  prevTs: Map<number, number>
  /** serverId -> last snapshot */
  snapshots: Map<number, Snapshot>
  scrapeTimer?: ReturnType<typeof setTimeout>
  rollupTimer?: ReturnType<typeof setTimeout>
  scraping: boolean
  /** parsed config.json + file mtime, reloaded when mtime changes */
  config?: { mtime: number, value: AppConfig }
  /** login throttle: key (ip) -> consecutive failures */
  authFails: Map<string, { fails: number, last: number }>
  /** pending GitLab OAuth state nonce -> expiry ts (ms) */
  gitlabStates: Map<string, number>
  /** gateway/limiter state, lazily created by gateway/state.ts */
  gateway?: GatewayRuntime
  /** version check/update state, see server/utils/update.ts */
  update?: UpdateRuntime
}

/** Outcome of one autoupdate run, written by scripts/autoupdate.mjs. */
export interface LastUpdateResult {
  startedAt: number
  finishedAt: number
  ok: boolean
  /** failed command (e.g. `git pull`) when ok is false */
  step: string | null
  error: string | null
}

/** Process-wide update-check state (see server/utils/update.ts). */
export interface UpdateRuntime {
  /** commit of the running checkout; null when git/the checkout is missing */
  currentSha: string | null
  /** commit time of the running checkout (ms) for the version label */
  commitTs: number | null
  /** checked-out branch (null while detached or without git) */
  branch: string | null
  /** https URL of the origin remote; null when it is not GitHub */
  repoUrl: string | null
  /** branch head on origin from the last successful check */
  latestSha: string | null
  checkedAt: number | null
  checking: boolean
  error: string | null
  /** an update was kicked off and this process is about to exit */
  applying: boolean
  /** result of the last autoupdate run (data/last-update.json) */
  lastUpdate: LastUpdateResult | null
  checkTimer?: ReturnType<typeof setTimeout>
}

/** Process-wide gateway state (see server/utils/gateway/state.ts). */
export interface GatewayRuntime {
  /** serverId -> requests forwarded and not finished yet */
  inflight: Map<number, number>
  /** serverId -> routing is skipped until this ts (ejected on live errors) */
  ejectedUntil: Map<number, number>
  /** requests waiting for headroom, ordered by arrival; scheduled on dispatch */
  queue: Array<import('./gateway/queue.ts').QueueEntry>
  /** next queue task sequence number */
  queueSeq: number
  /** round-robin fairness: clientId -> times dispatched from the queue */
  served: Map<number, number>
  /** sessionKeyHash -> affinity cache (DB is the source; `written` = last DB touch) */
  affinity: Map<string, { serverId: number, lastUsed: number, written: number }>
  /** `${clientId}|${ip}` -> aggregated hits between DB flushes */
  ipAgg: Map<string, { clientId: number, ip: string, first: number, last: number, hits: number }>
  /** `${clientId}|${day}` -> counters aggregated between DB flushes */
  usageAgg: Map<string, { clientId: number, day: number, requests: number, ok: number, errors: number, promptTokens: number, genTokens: number }>
  loopTimer?: ReturnType<typeof setTimeout>
}

const g = globalThis as typeof globalThis & { __pazuzu?: Runtime }

export function runtime (): Runtime {
  if (!g.__pazuzu) {
    g.__pazuzu = {
      prev: new Map(),
      prevTs: new Map(),
      snapshots: new Map(),
      scraping: false,
      authFails: new Map(),
      gitlabStates: new Map()
    }
  }
  const rt = g.__pazuzu
  // a global created by an older module version (dev HMR) may miss newer fields
  if (!rt.authFails) rt.authFails = new Map()
  if (!rt.gitlabStates) rt.gitlabStates = new Map()
  if (!rt.gateway) {
    rt.gateway = {
      inflight: new Map(),
      ejectedUntil: new Map(),
      queue: [],
      queueSeq: 0,
      served: new Map(),
      affinity: new Map(),
      ipAgg: new Map(),
      usageAgg: new Map()
    }
  }
  if (!rt.update) {
    rt.update = {
      currentSha: null,
      commitTs: null,
      branch: null,
      repoUrl: null,
      latestSha: null,
      checkedAt: null,
      checking: false,
      error: null,
      applying: false,
      lastUpdate: null
    }
  }
  return rt
}

/** Lazily-initialised gateway/limiter state (kept on globalThis for HMR). */
export function gatewayRuntime (): GatewayRuntime {
  return runtime().gateway!
}

export function forgetServerState (serverId: number) {
  const rt = runtime()
  rt.snapshots.delete(serverId)
  rt.prevTs.delete(serverId)
  if (rt.gateway) {
    rt.gateway.inflight.delete(serverId)
    rt.gateway.ejectedUntil.delete(serverId)
  }
  for (const key of rt.prev.keys()) {
    if (key.startsWith(`${serverId}|`)) rt.prev.delete(key)
  }
}
