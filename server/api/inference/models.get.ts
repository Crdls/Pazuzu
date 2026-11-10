import { useDb, type ServerRow } from '../../utils/db'
import { upstreamUrl } from '../../utils/gateway/proxy'

/**
 * GET /api/inference/models?id=N — the engine's served model ids, so the
 * Playground can fill the `model` field (engines usually require it).
 */
export default defineEventHandler(async (event) => {
  const id = Number(getQuery(event)?.id ?? '')
  const server = useDb().prepare('SELECT * FROM servers WHERE id = ?').get(id) as ServerRow | undefined
  if (!server) throw createError({ statusCode: 404, statusMessage: 'server not found' })
  let res: Response
  try {
    res = await fetch(upstreamUrl(server, '/v1/models', ''), {
      headers: server.api_key ? { authorization: `Bearer ${server.api_key}` } : {},
      signal: AbortSignal.timeout(5000)
    })
  } catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: err instanceof Error ? `engine unreachable: ${err.message || err.name}` : 'engine unreachable'
    })
  }
  if (!res.ok) throw createError({ statusCode: 502, statusMessage: `engine answered HTTP ${res.status}` })
  const json = await res.json().catch(() => null) as { data?: unknown } | null
  const models = Array.isArray(json?.data)
    ? (json.data as unknown[]).map(m => (typeof m === 'object' && m !== null ? (m as { id?: unknown }).id : null))
      .filter((x): x is string => typeof x === 'string')
    : []
  return { models }
})
