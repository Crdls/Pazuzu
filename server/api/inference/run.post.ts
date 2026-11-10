import { useDb, type ServerRow } from '../../utils/db'
import { upstreamUrl } from '../../utils/gateway/proxy'
import {
  buildChatBody, deltaTextOf, estimateTokens, reasoningTextOf, splitSseFrames, summarizeRuns, usageFromChunk,
  type RunOutcome
} from '../../utils/inference'

/**
 * POST /api/inference/run — the Playground's multiplexed test run.
 * Sends one prompt to several engines at once (runs sequential per server,
 * servers in parallel) and streams every answer plus its timings back as a
 * single SSE feed: {type: start|firstReasoning|reasoning|firstToken|delta|
 * done|error|summary|end}. Reasoning models stream their thinking into a
 * side channel (delta.reasoning_content) - it is relayed as its own events,
 * so "thinking" stays visible instead of looking like a dead pause.
 * Session-gated like the rest of /api; no role requirement beyond that.
 */

const RUN_TIMEOUT_MS = 120_000
const KEEPALIVE_MS = 10_000
const MAX_SERVERS = 16
const MAX_RUNS = 10
const MAX_PROMPT_CHARS = 100_000
const MAX_MODEL_CHARS = 300

interface RunRequestBody {
  serverIds?: unknown
  prompt?: unknown
  runs?: unknown
  model?: unknown
  temperature?: unknown
  maxTokens?: unknown
  reasoningEffort?: unknown
}

const REASONING_EFFORTS = ['none', 'low', 'medium', 'high']

function describeError (err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

function parseOptions (body: RunRequestBody | null): { ids: number[], prompt: string, runs: number, model: string | null, temperature: number | null, maxTokens: number | null, reasoningEffort: string | null } {
  const ids = Array.isArray(body?.serverIds)
    ? [...new Set(body!.serverIds as unknown[])]
      .filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0)
    : []
  if (!ids.length) throw createError({ statusCode: 400, statusMessage: 'serverIds is required' })
  if (ids.length > MAX_SERVERS) throw createError({ statusCode: 400, statusMessage: `at most ${MAX_SERVERS} servers per run` })

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) throw createError({ statusCode: 400, statusMessage: 'prompt is required' })
  if (prompt.length > MAX_PROMPT_CHARS) throw createError({ statusCode: 400, statusMessage: 'prompt is too long' })

  const runs = body?.runs === undefined || body.runs === null ? 1 : Number(body.runs)
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
    throw createError({ statusCode: 400, statusMessage: `runs must be 1-${MAX_RUNS}` })
  }

  const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim().slice(0, MAX_MODEL_CHARS) : null
  const temperature = typeof body?.temperature === 'number' && Number.isFinite(body.temperature)
    ? Math.min(Math.max(body.temperature, 0), 2)
    : null
  const maxTokens = body?.maxTokens === undefined || body.maxTokens === null ? null : Number(body.maxTokens)
  if (maxTokens !== null && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 16384)) {
    throw createError({ statusCode: 400, statusMessage: 'maxTokens must be 1-16384' })
  }
  const reasoningEffort = body?.reasoningEffort === undefined || body.reasoningEffort === null || body.reasoningEffort === '' ? null
    : String(body.reasoningEffort).trim().toLowerCase()
  if (reasoningEffort !== null && !REASONING_EFFORTS.includes(reasoningEffort)) {
    throw createError({ statusCode: 400, statusMessage: 'reasoningEffort must be none|low|medium|high' })
  }
  return { ids: ids as number[], prompt, runs, model, temperature, maxTokens, reasoningEffort }
}

/** One run against one engine; sends its own done/error event and returns the timing. */
async function runOnce (
  server: ServerRow,
  run: number,
  opts: { prompt: string, model: string | null, temperature: number | null, maxTokens: number | null, reasoningEffort: string | null },
  send: (obj: Record<string, unknown>) => void,
  signal: AbortSignal
): Promise<RunOutcome> {
  const base = { serverId: server.id, run }
  const t0 = Date.now()
  let ttftMs: number | null = null
  let firstMs: number | null = null
  let chars = 0
  let reasoningChars = 0
  let genTokens: number | null = null
  try {
    const res = await fetch(upstreamUrl(server, '/v1/chat/completions', ''), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(server.api_key ? { authorization: `Bearer ${server.api_key}` } : {})
      },
      body: buildChatBody(opts),
      signal: AbortSignal.any([signal, AbortSignal.timeout(RUN_TIMEOUT_MS)])
    })
    if (!res.ok || !res.body) {
      let snippet = ''
      try { snippet = (await res.text()).slice(0, 300) } catch { /* the status alone is enough */ }
      const error = `HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`
      if (!signal.aborted) send({ type: 'error', ...base, error })
      return { ...base, ok: false, error, ttftMs: null, firstMs: null, totalMs: Date.now() - t0, tokens: 0, estimated: false }
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const split = splitSseFrames(buffer)
      buffer = split.rest
      for (const data of split.frames) {
        if (data === '[DONE]') continue
        let chunk: unknown = null
        try { chunk = JSON.parse(data) } catch { continue } // engine chatter / invalid frame
        const usage = usageFromChunk(chunk)
        if (usage) genTokens = usage.gen
        const reasoning = reasoningTextOf(chunk)
        if (reasoning) {
          if (firstMs === null) {
            firstMs = Date.now() - t0
            send({ type: 'firstReasoning', ...base, ms: firstMs })
          }
          reasoningChars += reasoning.length
          send({ type: 'reasoning', ...base, text: reasoning })
        }
        const text = deltaTextOf(chunk)
        if (!text) continue
        if (ttftMs === null) {
          ttftMs = Date.now() - t0
          if (firstMs === null) firstMs = ttftMs
          send({ type: 'firstToken', ...base, ttftMs })
        }
        chars += text.length
        send({ type: 'delta', ...base, text })
      }
    }
    const totalMs = Date.now() - t0
    const tokens = genTokens ?? estimateTokens(chars + reasoningChars)
    const estimated = genTokens === null
    if (!signal.aborted) send({ type: 'done', ...base, ttftMs, firstMs, totalMs, tokens, estimated })
    return { ...base, ok: true, ttftMs, firstMs, totalMs, tokens, estimated }
  } catch (err) {
    const error = describeError(err)
    if (!signal.aborted) send({ type: 'error', ...base, error })
    return { ...base, ok: false, error, ttftMs, firstMs, totalMs: Date.now() - t0, tokens: 0, estimated: false }
  }
}

export default defineEventHandler(async (event) => {
  const body = await readBody<RunRequestBody>(event).catch(() => null)
  const opts = parseOptions(body)

  const db = useDb()
  const select = db.prepare('SELECT * FROM servers WHERE id = ?')
  const servers = opts.ids.map(id => select.get(id) as ServerRow | undefined)
  const missing = opts.ids.filter((_, i) => !servers[i])
  if (missing.length) throw createError({ statusCode: 404, statusMessage: `server not found: ${missing.join(', ')}` })

  // one controller for every upstream: when the page goes away, all engines
  // must stop generating right now (same pattern as the gateway route)
  const ac = new AbortController()
  let responseFinished = false
  event.node.res.once('finish', () => { responseFinished = true })
  event.node.res.once('close', () => { if (!responseFinished) ac.abort() })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start (controller) {
      const send = (obj: Record<string, unknown>) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)) } catch { /* closed */ }
      }
      const keepAlive = setInterval(() => {
        try { controller.enqueue(encoder.encode(': ping\n\n')) } catch { /* closed */ clearInterval(keepAlive) }
      }, KEEPALIVE_MS)
      keepAlive.unref?.()
      void (async () => {
        const outcomes: RunOutcome[] = []
        await Promise.all((servers as ServerRow[]).map(async server => {
          for (let run = 1; run <= opts.runs && !ac.signal.aborted; run++) {
            send({ type: 'start', serverId: server.id, run })
            const outcome = await runOnce(server, run, opts, send, ac.signal)
            outcomes.push(outcome)
            // an engine that refused the prompt will refuse it N times: stop
            // this server's sequence, the other servers keep running
            if (!outcome.ok && !ac.signal.aborted) break
          }
        }))
        clearInterval(keepAlive)
        if (!ac.signal.aborted) send({ type: 'summary', servers: summarizeRuns(outcomes) })
        send({ type: 'end' })
        try { controller.close() } catch { /* already closed */ }
      })()
    },
    cancel () {
      ac.abort()
    }
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no'
    }
  })
})
