import { requireAdmin } from '../../../utils/auth'
import { loadConfig } from '../../../utils/config'
import { createGatewayClient, getGatewayClientById, getGatewayClientByTokenHash, setClientServerAccess, setClientServerPriorities } from '../../../utils/db'
import { hashToken } from '../../../utils/credentials'
import { parseExistingIds, parseServerPriorities } from '../../../utils/gateway/access'
import { PRIORITIES, type ClientPriority } from '../../../utils/gateway/types'
import { generateClientToken, normalizeCustomToken, tokenHint } from '../../../utils/gateway/tokens'
import { clientViewPlain, prioritiesRecord } from '../../../utils/gateway/view'

// create a client; the raw token is returned exactly once, here
export default defineEventHandler(async (event) => {
  if (loadConfig().auth.enabled) requireAdmin(event)
  const body = await readBody<{ name?: string, priority?: string, debug?: boolean, token?: string, serversAll?: boolean, serverIds?: unknown, serverPriorities?: unknown }>(event)
  const name = body?.name?.trim()
  if (!name || name.length > 64) {
    throw createError({ statusCode: 400, statusMessage: 'name is required (max 64 chars)' })
  }
  const priority = body?.priority ?? 'normal'
  if (!PRIORITIES.includes(priority as ClientPriority)) {
    throw createError({ statusCode: 400, statusMessage: 'priority must be high, normal or low' })
  }
  // absent access fields = no server restrictions; an explicit list restricts the client
  let restricted: number[] | null = null
  if (body?.serversAll === false || body?.serverIds !== undefined) {
    restricted = parseExistingIds(body?.serverIds, 'servers')
    if (!restricted) {
      throw createError({ statusCode: 400, statusMessage: 'serverIds must be a list of existing server ids' })
    }
  }
  let token = generateClientToken()
  if (body?.token !== undefined && String(body.token).trim() !== '') {
    const custom = normalizeCustomToken(body.token)
    if (!custom) {
      throw createError({ statusCode: 400, statusMessage: 'a custom token must be 16–256 printable characters without spaces' })
    }
    token = custom
  }
  const tokenHash = hashToken(token)
  if (getGatewayClientByTokenHash(tokenHash)) {
    throw createError({ statusCode: 409, statusMessage: 'this token is already in use' })
  }
  // preference tiers are independent of access — settable in either mode
  let tiers: Map<number, ClientPriority> | null = null
  if (body?.serverPriorities !== undefined) {
    tiers = parseServerPriorities(body.serverPriorities)
    if (!tiers) {
      throw createError({ statusCode: 400, statusMessage: 'serverPriorities must map existing server ids to high, normal or low' })
    }
  }
  const client = createGatewayClient({
    name,
    tokenHash,
    tokenHint: tokenHint(token),
    priority: priority as ClientPriority,
    debug: body?.debug === true,
    createdBy: event.context.userId ?? null
  })
  if (restricted) setClientServerAccess(client.id, false, restricted)
  if (tiers) setClientServerPriorities(client.id, tiers)
  return { ...clientViewPlain(getGatewayClientById(client.id)!, restricted ?? [], prioritiesRecord(tiers ?? new Map())), token }
})
