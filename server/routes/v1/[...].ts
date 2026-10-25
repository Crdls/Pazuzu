import { loadConfig } from '../../utils/config'
import { allowedServerIds, clientServerPriorities, getGatewayClientByTokenHash, useDb, type ServerRow } from '../../utils/db'
import { hashToken } from '../../utils/credentials'
import { bearerFrom } from '../../utils/gateway/tokens'
import { deriveSessionKey, SESSION_HEADER } from '../../utils/gateway/session'
import { pickServer } from '../../utils/gateway/router'
import {
  acquireNow, cancelQueued, eject, filterLoads, getAffinity, QueueFullError, queueRequest,
  recordIpHit, recordUsage, release, reserve, serverLoads, setAffinity, QUEUE_CANCELLED
} from '../../utils/gateway/state'
import {
  clientResponseHeaders, CORS_PREFLIGHT_HEADERS, forwardRequest, sniffUsageStream,
  type UpstreamRequest
} from '../../utils/gateway/proxy'

/**
 * /v1/** — the load-balancing gateway. Clients hit Pazuzu with their
 * `pzz_` bearer token; the request is admitted by the priority waiting room,
 * routed by chat affinity → least-loaded engine, and streamed straight back.
 * Bypasses the cookie auth middleware (which only gates /api/*): access is
 * controlled by client API keys. OpenAI-shaped JSON errors throughout.
 */

const MAX_BODY_BYTES = 64 * 1024 * 1024

function jsonError (status: number, message: string, code: string, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: { message, type: 'pazuzu_error', code, param: null } }), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...extraHeaders }
  })
}

function clientIpFrom (event: NitroEvent): string {
  const xff = getHeader(event, 'x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]!.trim()
    if (first) return first
  }
  const socket = event.node.req.socket as { remoteAddress?: string } | undefined
  return (socket?.remoteAddress ?? 'unknown').replace(/^::ffff:/, '')
}

function describeError (err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function findServerRow (id: number): ServerRow | null {
  return useDb().prepare('SELECT * FROM servers WHERE id = ?').get(id) as ServerRow | null
}

export default defineEventHandler(async (event) => {
  const gwCfg = loadConfig().gateway
  if (!gwCfg.enabled) {
    return jsonError(503, 'The Pazuzu gateway is disabled (gateway.enabled in config.json)', 'gateway_disabled')
  }

  const method = getMethod(event)
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS })

  // ---------- client auth ----------
  const token = bearerFrom(getHeader(event, 'authorization'))
  if (!token) return jsonError(401, 'Missing API key: send "Authorization: Bearer pzz_..."', 'missing_api_key')
  const client = getGatewayClientByTokenHash(hashToken(token))
  if (!client) return jsonError(401, 'Invalid API key', 'invalid_api_key')
  if (!client.enabled) return jsonError(403, 'This API key has been disabled', 'key_disabled')

  const clientIp = clientIpFrom(event)
  recordIpHit(client.id, clientIp)
  // per-client server access: null = every server, else the explicitly granted ids
  const allowed = allowedServerIds(client.id)
  // per-client preference tiers: home engines are routed to first (works for
  // unrestricted clients too)
  const tiers = clientServerPriorities(client.id)

  // ---------- buffered body (session key + replayable forwarding) ----------
  const declaredLen = Number(getHeader(event, 'content-length') ?? '') || 0
  if (declaredLen > MAX_BODY_BYTES) return jsonError(413, 'Request body too large for the gateway', 'body_too_large')
  let rawBody: string | null = null
  let parsed: unknown = null
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      rawBody = (await readRawBody(event)) ?? ''
    } catch {
      return jsonError(400, 'Could not read the request body', 'body_read_failed')
    }
    if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return jsonError(413, 'Request body too large for the gateway', 'body_too_large')
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      parsed = null // leave invalid JSON to the engine's own validation
    }
  }

  // one abort controller covers queueing and upstream fetch: the engine must
  // free its slot the moment the client goes away
  const ac = new AbortController()
  let responseFinished = false
  event.node.res.once('finish', () => { responseFinished = true })
  event.node.res.once('close', () => { if (!responseFinished) ac.abort() })

  // ---------- routing: affinity → preference tier → least loaded → waiting room ----------
  const keyHash = deriveSessionKey(getHeader(event, SESSION_HEADER), parsed)
  const url = getRequestURL(event)
  const now = Date.now()
  const loads = filterLoads(serverLoads(now), allowed)
  if (!loads.some(s => s.mode === 'on' && (s.up || s.inflight > 0))) {
    return jsonError(503, 'No engine is online for routing (gateway)', 'no_upstream')
  }
  const preferred = keyHash ? getAffinity(keyHash, now) : null
  const decision = acquireNow(loads, preferred, now, tiers)
  let serverId = decision.serverId
  let waitedMs = 0

  if (serverId == null) {
    const enqueuedAt = Date.now()
    const { seq, promise } = queueRequest({
      clientId: client.id, priority: client.priority, enqueuedAt, keyHash, preferredId: preferred
    })
    const timer = setTimeout(() => cancelQueued(seq), gwCfg.queueTimeoutS * 1000)
    timer.unref?.()
    const onAbort = () => cancelQueued(seq)
    ac.signal.addEventListener('abort', onAbort)
    try {
      serverId = await promise
      waitedMs = Date.now() - enqueuedAt
    } catch (err) {
      if (err instanceof QueueFullError) return jsonError(429, err.message, 'queue_full', { 'retry-after': '5' })
      if (ac.signal.aborted) return jsonError(408, 'Client disconnected while waiting for a free engine', 'client_disconnected')
      return jsonError(429, `All engines are busy — the request waited ${gwCfg.queueTimeoutS}s in the priority queue`, 'queue_timeout', { 'retry-after': '10' })
    } finally {
      clearTimeout(timer)
      ac.signal.removeEventListener('abort', onAbort)
    }
  } else if (keyHash && !decision.affinity) {
    // fresh chat, or its home server went away: pin the chat to the new engine
    setAffinity(keyHash, serverId, now)
  }

  // one live slot is held from here on; release exactly when the response ends
  let reservation: number | null = serverId
  const releaseNow = () => {
    if (reservation == null) return
    release(reservation)
    reservation = null
  }
  event.node.res.once('close', releaseNow)

  // ---------- forward, with one retry on another engine before first byte ----------
  const upstream: UpstreamRequest = {
    method,
    path: url.pathname,
    query: url.search.replace(/^\?/, ''),
    headers: getRequestHeaders(event),
    body: rawBody
  }
  const failed = new Set<number>() // for debug headers: engines we bounced off
  let routed: ServerRow | null = null
  let res: Response | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const server = findServerRow(serverId!)
    if (!server) {
      return jsonError(503, 'The routed server no longer exists', 'no_upstream')
    }
    routed = server
    try {
      res = await forwardRequest(upstream, server, clientIp, ac.signal)
    } catch (err) {
      if (ac.signal.aborted) {
        return jsonError(499, 'Client disconnected', 'client_disconnected')
      }
      eject(server.id)
      releaseNow()
      const alt = pickServer(filterLoads(serverLoads(Date.now()), allowed).filter(s => s.id !== server.id), null, Date.now(), tiers).serverId
      if (attempt === 0 && alt != null) {
        failed.add(server.id)
        serverId = alt
        reserve(alt)
        reservation = alt
        continue
      }
      return jsonError(502, `Upstream engine failed: ${describeError(err)}`, 'upstream_unreachable')
    }
    if (res.status >= 500 && attempt === 0) {
      void res.body?.cancel().catch(() => {})
      eject(server.id)
      releaseNow()
      const alt = pickServer(filterLoads(serverLoads(Date.now()), allowed).filter(s => s.id !== server.id), null, Date.now(), tiers).serverId
      if (alt != null) {
        failed.add(server.id)
        serverId = alt
        reserve(alt)
        reservation = alt
        continue
      }
      // nowhere else to go: the 5xx stands
      break
    }
    break
  }

  // ---------- stream the answer back ----------
  const response = res!
  recordUsage(client.id, { requests: 1 })
  recordUsage(client.id, response.status < 400 ? { ok: 1 } : { errors: 1 })

  let body = response.body
  const wantsUsage = response.ok && (url.pathname.endsWith('/chat/completions') || url.pathname.endsWith('/completions'))
  if (body && wantsUsage) {
    // usage rides in the last SSE chunk when the client asked for it;
    // otherwise fall back to a chars/4 estimate — stats, not billing
    body = sniffUsageStream(body, (bytes, usage) => {
      if (usage) recordUsage(client.id, { promptTokens: usage.prompt, genTokens: usage.gen })
      else recordUsage(client.id, { genTokens: Math.round(bytes / 4) })
    })
  }

  const extra: Record<string, string> = {}
  if (client.debug) {
    extra['x-pazuzu-server'] = routed?.name ?? String(serverId)
    extra['x-pazuzu-queue-wait-ms'] = String(waitedMs)
    extra['x-pazuzu-retries'] = String(failed.size)
    if (keyHash) extra['x-pazuzu-session'] = keyHash.slice(0, 12)
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: clientResponseHeaders(response.headers, extra)
  })
})
