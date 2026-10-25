import { requireAdmin } from '../../../utils/auth'
import { loadConfig } from '../../../utils/config'
import { clientServerPriorities, getGatewayClientById, listClientServerIds, setClientServerAccess, setClientServerPriorities, updateGatewayClient } from '../../../utils/db'
import { parseExistingIds, parseServerPriorities } from '../../../utils/gateway/access'
import { PRIORITIES, type ClientPriority } from '../../../utils/gateway/types'
import { clientViewPlain, prioritiesRecord } from '../../../utils/gateway/view'

export default defineEventHandler(async (event) => {
  if (loadConfig().auth.enabled) requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!getGatewayClientById(id)) throw createError({ statusCode: 404, statusMessage: 'client not found' })
  const body = await readBody<{ name?: string, priority?: string, debug?: boolean, enabled?: boolean, serversAll?: boolean, serverIds?: unknown, serverPriorities?: unknown }>(event)
  const patch: { name?: string, priority?: ClientPriority, debug?: boolean, enabled?: boolean } = {}
  if (body?.name !== undefined) {
    const name = body.name.trim()
    if (!name || name.length > 64) throw createError({ statusCode: 400, statusMessage: 'name is required (max 64 chars)' })
    patch.name = name
  }
  if (body?.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority as ClientPriority)) {
      throw createError({ statusCode: 400, statusMessage: 'priority must be high, normal or low' })
    }
    patch.priority = body.priority as ClientPriority
  }
  if (body?.debug !== undefined) patch.debug = body.debug === true
  if (body?.enabled !== undefined) patch.enabled = body.enabled === true
  updateGatewayClient(id, patch)
  if (body?.serversAll === true) {
    setClientServerAccess(id, true, [])
  } else if (body?.serversAll !== undefined || body?.serverIds !== undefined) {
    const ids = parseExistingIds(body?.serverIds, 'servers')
    if (!ids) throw createError({ statusCode: 400, statusMessage: 'serverIds must be a list of existing server ids' })
    setClientServerAccess(id, false, ids)
  }
  if (body?.serverPriorities !== undefined) {
    const tiers = parseServerPriorities(body.serverPriorities)
    if (!tiers) throw createError({ statusCode: 400, statusMessage: 'serverPriorities must map existing server ids to high, normal or low' })
    setClientServerPriorities(id, tiers)
  }
  return clientViewPlain(getGatewayClientById(id)!, listClientServerIds(id), prioritiesRecord(clientServerPriorities(id)))
})
