import type { GatewayClientRow, GatewayClientRowWithStats } from '../db.ts'
import type { ClientPriority } from './types.ts'

/**
 * API view for gateway clients — the token hash never leaves the server,
 * only the non-secret hint. Also where the create/rotate response shape
 * (raw token, shown once) is defined.
 */

export interface GatewayClientView {
  id: number
  name: string
  tokenHint: string
  priority: string
  debug: boolean
  enabled: boolean
  /** true = every gateway server, false = only the ids listed in serverIds */
  serversAll: boolean
  serverIds: number[]
  /** serverId -> high/low preference tier; absent means normal */
  serverPriorities: Record<number, ClientPriority>
  createdAt: number
  requestsTotal: number
  errorsTotal: number
  tokensTotal: number
  requestsToday: number
}

export function clientView (
  c: GatewayClientRowWithStats, serverIds: number[], serverPriorities: Record<number, ClientPriority>
): GatewayClientView {
  return {
    id: c.id,
    name: c.name,
    tokenHint: c.token_hint,
    priority: c.priority,
    debug: c.debug === 1,
    enabled: c.enabled === 1,
    serversAll: c.servers_all === 1,
    serverIds,
    serverPriorities,
    createdAt: c.created_at,
    requestsTotal: c.requests_total,
    errorsTotal: c.errors_total,
    tokensTotal: c.tokens_total,
    requestsToday: c.requests_today
  }
}

export function clientViewPlain (
  c: GatewayClientRow, serverIds: number[], serverPriorities: Record<number, ClientPriority>
): Omit<GatewayClientView, 'requestsTotal' | 'errorsTotal' | 'tokensTotal' | 'requestsToday'> {
  return {
    id: c.id,
    name: c.name,
    tokenHint: c.token_hint,
    priority: c.priority,
    debug: c.debug === 1,
    enabled: c.enabled === 1,
    serversAll: c.servers_all === 1,
    serverIds,
    serverPriorities,
    createdAt: c.created_at
  }
}

/** JSON shape of the preference tiers sent back to the UI. */
export function prioritiesRecord (tiers: Map<number, ClientPriority>): Record<number, ClientPriority> {
  return Object.fromEntries(tiers) as Record<number, ClientPriority>
}
