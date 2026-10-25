import { requireAdmin } from '../../../utils/auth'
import { loadConfig } from '../../../utils/config'
import { listGatewayClients, useDb } from '../../../utils/db'
import type { ClientPriority } from '../../../utils/gateway/types'
import { clientView } from '../../../utils/gateway/view'

const DAY = 86_400_000

// the client table for the admin UI (admin-only while auth is on)
export default defineEventHandler((event) => {
  if (loadConfig().auth.enabled) requireAdmin(event)
  const today = Math.floor(Date.now() / DAY) * DAY
  const byClient = new Map<number, number[]>()
  const pairs = useDb().prepare('SELECT client_id, server_id FROM gateway_client_servers').all() as Array<{ client_id: number, server_id: number }>
  for (const p of pairs) {
    const list = byClient.get(p.client_id)
    if (list) list.push(p.server_id)
    else byClient.set(p.client_id, [p.server_id])
  }
  const prioByClient = new Map<number, Record<number, ClientPriority>>()
  const prios = useDb().prepare('SELECT client_id, server_id, priority FROM gateway_client_priorities').all() as Array<{ client_id: number, server_id: number, priority: ClientPriority }>
  for (const p of prios) {
    const rec = prioByClient.get(p.client_id)
    if (rec) rec[p.server_id] = p.priority
    else prioByClient.set(p.client_id, { [p.server_id]: p.priority })
  }
  return listGatewayClients(today).map(c => clientView(
    c,
    c.servers_all === 1 ? [] : byClient.get(c.id) ?? [],
    prioByClient.get(c.id) ?? {}
  ))
})
