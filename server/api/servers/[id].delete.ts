import { useDb } from '../../utils/db'
import { broadcast } from '../../utils/scrape'
import { forgetServerState } from '../../utils/runtime'
import { assertCanManageServer } from '../../utils/auth'

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  const db = useDb()
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as { created_by: number | null } | undefined
  if (!server) {
    throw createError({ statusCode: 404, statusMessage: 'server not found' })
  }
  assertCanManageServer(event, server)
  const tx = db.transaction((serverId: number) => {
    db.prepare('DELETE FROM servers WHERE id = ?').run(serverId)
    db.prepare('DELETE FROM samples WHERE server_id = ?').run(serverId)
    db.prepare('DELETE FROM rollup_hourly WHERE server_id = ?').run(serverId)
    db.prepare('DELETE FROM rollup_daily WHERE server_id = ?').run(serverId)
    db.prepare('DELETE FROM server_status WHERE server_id = ?').run(serverId)
    db.prepare('DELETE FROM gateway_client_servers WHERE server_id = ?').run(serverId)
    db.prepare('DELETE FROM gateway_client_priorities WHERE server_id = ?').run(serverId)
  })
  tx(id)
  forgetServerState(id)
  broadcast({ type: 'removed', serverId: id })
  return { ok: true }
})
