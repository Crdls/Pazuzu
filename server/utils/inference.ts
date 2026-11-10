import type { TokenUsage } from './gateway/proxy.ts'

/**
 * Pure helpers for the inference Playground: OpenAI chat-completion request
 * bodies, incremental SSE parsing, per-run timings and median summaries.
 * Reachable from bare Node (test/inference.test.mjs) — keep relative
 * imports explicit `.ts`.
 */

/** One run of one prompt on one server, as timed by the backend. */
export interface RunOutcome {
  serverId: number
  /** 1-based run index within the server's sequence */
  run: number
  ok: boolean
  /** ms until the first answer delta; null when none ever arrived */
  ttftMs: number | null
  /** ms until the first streamed token, reasoning included - the honest
   *  start of the decode window for thinking models */
  firstMs: number | null
  /** ms from request start to stream end */
  totalMs: number
  /** generated tokens (engine usage when reported, else chars/4 estimate) */
  tokens: number
  /** tokens came from the chars/4 fallback, not from the engine */
  estimated: boolean
  error?: string
}

/** Per-server median stats over the successful runs of a test batch. */
export interface ServerSummary {
  serverId: number
  ok: number
  errors: number
  medTtftMs: number | null
  medTotalMs: number | null
  medTokPerSec: number | null
  bestTotalMs: number | null
  worstTotalMs: number | null
  anyEstimated: boolean
}

export interface ChatRunOptions {
  model?: string | null
  prompt: string
  temperature?: number | null
  maxTokens?: number | null
  /** 'low' | 'medium' | 'high' - forwarded as OpenAI-style reasoning_effort */
  reasoningEffort?: string | null
}

/** OpenAI-shaped streaming chat body with usage reporting requested. */
export function buildChatBody (opts: ChatRunOptions): string {
  const body: Record<string, unknown> = {
    messages: [{ role: 'user', content: opts.prompt }],
    stream: true,
    stream_options: { include_usage: true }
  }
  if (opts.model) body.model = opts.model
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature
  if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort
  return JSON.stringify(body)
}

/** The joined `data:` payload of one SSE frame; null for comment-only frames. */
export function dataLinesOf (frame: string): string | null {
  const lines: string[] = []
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(':')) continue // comment / keep-alive ping
    if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''))
  }
  return lines.length ? lines.join('\n') : null
}

/**
 * Split buffered SSE text into complete frames (their `data:` payloads);
 * the unfinished tail is returned for the next chunk.
 */
export function splitSseFrames (buffer: string): { frames: string[], rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/)
  const rest = parts.pop() ?? ''
  const frames: string[] = []
  for (const part of parts) {
    const data = dataLinesOf(part)
    if (data !== null) frames.push(data)
  }
  return { frames, rest }
}

/** Text content of one chat-completion chunk ('' when the chunk carries none). */
export function deltaTextOf (chunk: unknown): string {
  if (typeof chunk !== 'object' || chunk === null) return ''
  const choices = (chunk as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const first = choices[0] as { delta?: unknown } | null
  const delta = first && typeof first === 'object' ? first.delta : null
  if (typeof delta !== 'object' || delta === null) return ''
  const content = (delta as { content?: unknown }).content
  return typeof content === 'string' ? content : ''
}

/** Reasoning ("thinking") text of one chunk - the side channel reasoning
 *  models stream before the answer (reasoning_content, older: reasoning). */
export function reasoningTextOf (chunk: unknown): string {
  if (typeof chunk !== 'object' || chunk === null) return ''
  const choices = (chunk as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const first = choices[0] as { delta?: unknown } | null
  const delta = first && typeof first === 'object' ? first.delta : null
  if (typeof delta !== 'object' || delta === null) return ''
  const d = delta as { reasoning_content?: unknown, reasoning?: unknown }
  if (typeof d.reasoning_content === 'string') return d.reasoning_content
  if (typeof d.reasoning === 'string') return d.reasoning
  return ''
}

/** `usage` of a parsed chunk (the final one carries it with include_usage). */
export function usageFromChunk (chunk: unknown): TokenUsage | null {
  if (typeof chunk !== 'object' || chunk === null) return null
  const usage = (chunk as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return null
  const u = usage as Record<string, unknown>
  const prompt = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0
  const gen = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0
  if (prompt === 0 && gen === 0) return null
  return { prompt, gen }
}

/** The gateway's standing stats-not-billing fallback for streamed text. */
export function estimateTokens (chars: number): number {
  return Math.round(chars / 4)
}

export function median (values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Generation tok/s: tokens over the time after the first token - TTFT is
 * prefill/queueing, counting it into the rate crushes slow engines to zero.
 * Falls back to the whole duration when the run never reported a TTFT.
 */
export function tokPerSecOf (tokens: number, totalMs: number, ttftMs: number | null = null): number | null {
  let decodeMs = totalMs - (ttftMs ?? 0)
  if (decodeMs < 50) decodeMs = totalMs // one-token runs: TTFT ~= total
  if (decodeMs <= 0) return null
  return (tokens / decodeMs) * 1000
}

/** Clip long streamed text for persistence: keeps head and tail around a marker. */
export function clipText (text: string, cap = 8000): string {
  if (text.length <= cap) return text
  const head = Math.floor(cap * 0.75)
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - (cap - head))}`
}

/**
 * Prepend a request to the Playground's history: an entry with the same key
 * (the same request) is re-added on top instead of duplicated; capped.
 */
export function pushHistory<T> (history: T[], entry: T, keyOf: (e: T) => string, limit = 50): T[] {
  const key = keyOf(entry)
  return [entry, ...history.filter(e => keyOf(e) !== key)].slice(0, limit)
}

/** Median stats per server; errors are counted, never averaged in. */
export function summarizeRuns (outcomes: RunOutcome[]): ServerSummary[] {
  const byServer = new Map<number, RunOutcome[]>()
  for (const o of outcomes) {
    const list = byServer.get(o.serverId)
    if (list) list.push(o)
    else byServer.set(o.serverId, [o])
  }
  const summaries: ServerSummary[] = []
  for (const [serverId, list] of [...byServer.entries()].sort((a, b) => a[0] - b[0])) {
    const okRuns = list.filter(o => o.ok)
    const totals = okRuns.map(o => o.totalMs)
    const rates = okRuns
      .map(o => tokPerSecOf(o.tokens, o.totalMs, o.firstMs ?? o.ttftMs))
      .filter((x): x is number => x != null)
    summaries.push({
      serverId,
      ok: okRuns.length,
      errors: list.length - okRuns.length,
      medTtftMs: median(okRuns.map(o => o.ttftMs).filter((x): x is number => x != null)),
      medTotalMs: median(totals),
      medTokPerSec: median(rates),
      bestTotalMs: totals.length ? Math.min(...totals) : null,
      worstTotalMs: totals.length ? Math.max(...totals) : null,
      anyEstimated: okRuns.some(o => o.estimated)
    })
  }
  return summaries
}
