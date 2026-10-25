import { useDb } from '../db.ts'
import { PRIORITIES, type ClientPriority } from './types.ts'

/**
 * Validation of the client ⇄ server access lists, shared by the gateway admin
 * routes. Reachable from bare Node tests.
 */

/**
 * A JSON array of existing row ids -> the deduplicated ascending list.
 * null when the value is malformed or any id does not exist.
 */
export function parseExistingIds (value: unknown, table: 'servers' | 'gateway_clients'): number[] | null {
  if (!Array.isArray(value)) return null
  const ids = new Set<number>()
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isInteger(v)) return null
    ids.add(v)
  }
  if (ids.size === 0) return []
  const marks = [...ids].map(() => '?').join(', ')
  const found = new Set((useDb()
    .prepare(`SELECT id FROM ${table} WHERE id IN (${marks})`)
    .all(...ids) as Array<{ id: number }>).map(r => r.id))
  for (const id of ids) if (!found.has(id)) return null
  return [...ids].sort((a, b) => a - b)
}

/**
 * A JSON object of `{ serverId: 'high'|'normal'|'low' }` (JSON object keys
 * arrive as strings) -> a Map keyed by numeric server id, only keeping the
 * non-'normal' tiers. null when the shape, an id (must be an existing server)
 * or a tier value is malformed.
 */
export function parseServerPriorities (value: unknown): Map<number, ClientPriority> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const map = new Map<number, ClientPriority>()
  const ids: number[] = []
  for (const [key, tier] of Object.entries(value as Record<string, unknown>)) {
    const id = Number(key)
    if (!Number.isInteger(id) || id <= 0) return null
    if (!PRIORITIES.includes(tier as ClientPriority)) return null
    ids.push(id)
    if (tier !== 'normal') map.set(id, tier as ClientPriority)
  }
  if (ids.length && parseExistingIds(ids, 'servers') === null) return null
  return map
}
