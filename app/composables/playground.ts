import { clipText, pushHistory } from '~~/server/utils/inference'

/**
 * Shared state of the inference Playground - the useLive() pattern one level
 * down: the batch and its SSE reader live outside the page component, so
 * navigating to another page and back does not abort the run or lose the
 * answers. Everything is mirrored to localStorage (form, last batch, request
 * history), so a reload restores it all as well; a batch that was mid-flight
 * when the page died comes back marked as aborted.
 */

export const MODEL_AUTO = '__auto__'

const STORAGE_KEY = 'pazuzu_playground'
const TEXT_CAP = 8000
const HISTORY_LIMIT = 50
const PERSIST_DEBOUNCE_MS = 400
const TICK_MS = 250

export type RunStatus = 'queued' | 'running' | 'done' | 'error' | 'aborted' | 'skipped'

export interface RunState {
  run: number
  status: RunStatus
  text: string
  ttftMs: number | null
  totalMs: number | null
  tokens: number | null
  estimated: boolean
  error: string | null
  startedAt: number | null
  finishedAt: number | null
}

export interface ServerState {
  serverId: number
  name: string
  runs: RunState[]
}

export interface Batch {
  startedAt: number
  finishedAt: number | null
  servers: ServerState[]
}

export interface SummaryRow {
  serverId: number
  name: string
  ok: number
  errors: number
  medTtftMs: number | null
  medTotalMs: number | null
  medTokPerSec: number | null
  bestTotalMs: number | null
  worstTotalMs: number | null
  anyEstimated: boolean
}

export interface FormState {
  prompt: string
  serverIds: number[]
  runs: number
  temperature: number | null
  maxTokens: number | null
  model: string
}

export interface HistoryEntry {
  id: string
  ts: number
  prompt: string
  serverIds: number[]
  runs: number
  temperature: number | null
  maxTokens: number | null
  model: string
}

// one-per-tab singletons: the reader loop and its timers must outlive the page
let abort: AbortController | null = null
let ticker: ReturnType<typeof setInterval> | undefined
let persistTimer: ReturnType<typeof setTimeout> | undefined
let restored = false
let pageHideBound = false

/** History-entry id. crypto.randomUUID exists only in secure contexts, but
 *  Pazuzu is routinely served over plain http on the LAN - fall back to
 *  getRandomValues (available everywhere) and then to Math.random. */
function newId (): string {
  const c = globalThis.crypto as (Crypto & { randomUUID?: () => string }) | undefined
  if (c?.randomUUID) return c.randomUUID()
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(16))
    b[6] = (b[6]! & 0x0f) | 0x40
    b[8] = (b[8]! & 0x3f) | 0x80
    const hex = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function usePlayground () {
  const { t } = useI18n()
  const toast = useToast()

  const form = useState<FormState>('playground-form', () => ({
    prompt: '', serverIds: [], runs: 1, temperature: 0.7, maxTokens: 256, model: MODEL_AUTO
  }))
  const batch = useState<Batch | null>('playground-batch', () => null)
  const summary = useState<SummaryRow[] | null>('playground-summary', () => null)
  const history = useState<HistoryEntry[]>('playground-history', () => [])
  const running = useState<boolean>('playground-running', () => false)
  const models = useState<string[]>('playground-models', () => [])
  const tick = useState<number>('playground-tick', () => 0)

  // ---------- localStorage mirror ----------
  function serializeBatch (b: Batch | null): Batch | null {
    if (!b) return null
    return { ...b, servers: b.servers.map(s => ({ ...s, runs: s.runs.map(r => ({ ...r, text: clipText(r.text, TEXT_CAP) })) })) }
  }

  function persist () {
    if (!import.meta.client) return
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = undefined }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        form: form.value, batch: serializeBatch(batch.value), summary: summary.value, history: history.value
      }))
    } catch { /* private mode / quota exceeded - the page works without memory */ }
  }

  function persistSoon () {
    if (!import.meta.client || persistTimer) return
    persistTimer = setTimeout(persist, PERSIST_DEBOUNCE_MS)
  }

  /** Fill everything from the last visit. Only the first call per load acts:
   *  on a navigation back the shared state is newer than the saved snapshot. */
  function restore () {
    if (!import.meta.client || restored) return
    restored = true
    if (!pageHideBound) {
      pageHideBound = true
      window.addEventListener('pagehide', () => persist())
    }
    let saved: { form?: Partial<FormState>, batch?: Batch | null, summary?: SummaryRow[] | null, history?: HistoryEntry[] } | null = null
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) saved = JSON.parse(raw)
    } catch { return }
    if (!saved || typeof saved !== 'object') return
    if (saved.form) form.value = { ...form.value, ...saved.form }
    if (Array.isArray(saved.history)) history.value = saved.history
    if (Array.isArray(saved.summary)) summary.value = saved.summary
    if (saved.batch && Array.isArray(saved.batch.servers)) {
      // the reload killed the SSE connection: what still looked live did not finish
      for (const st of saved.batch.servers) {
        for (const r of st.runs ?? []) {
          if (r.status === 'running') r.status = 'aborted'
          else if (r.status === 'queued') r.status = 'skipped'
        }
      }
      saved.batch.finishedAt = saved.batch.finishedAt ?? Date.now()
      batch.value = saved.batch
    }
  }

  watch(form, persistSoon, { deep: true })

  // ---------- model list of the first selected engine ----------
  async function loadModels () {
    const first = form.value.serverIds[0]
    models.value = []
    if (first == null) return
    try {
      models.value = (await $fetch<{ models: string[] }>('/api/inference/models', { query: { id: first } })).models
    } catch { /* auto mode still works: many engines accept a missing model */ }
  }
  watch(() => form.value.serverIds[0], () => { void loadModels() })

  // ---------- running a batch ----------
  function newRun (run: number): RunState {
    return {
      run,
      status: 'queued',
      text: '',
      ttftMs: null,
      totalMs: null,
      tokens: null,
      estimated: false,
      error: null,
      startedAt: null,
      finishedAt: null
    }
  }

  // JSON keeps the history key unambiguous: prompts contain any plain separator
  function historyKey (h: HistoryEntry): string {
    return JSON.stringify([h.prompt, h.model, h.runs, h.temperature, h.maxTokens, [...h.serverIds].sort((a, b) => a - b)])
  }

  function runOf (serverId: number, run: number): RunState | undefined {
    return batch.value?.servers.find(s => s.serverId === serverId)?.runs.find(r => r.run === run)
  }

  function applyEvent (ev: Record<string, unknown>) {
    const run = ev.type === 'summary' || ev.type === 'end' ? undefined : runOf(Number(ev.serverId), Number(ev.run))
    switch (ev.type) {
      case 'start':
        if (run) { run.status = 'running'; run.startedAt = Date.now() }
        break
      case 'firstToken':
        if (run) run.ttftMs = Number(ev.ttftMs)
        break
      case 'delta':
        if (run) run.text += String(ev.text ?? '')
        break
      case 'done':
        if (run) {
          run.status = 'done'
          run.totalMs = Number(ev.totalMs)
          run.tokens = Number(ev.tokens)
          run.estimated = Boolean(ev.estimated)
          run.finishedAt = Date.now()
          persistSoon()
        }
        break
      case 'error':
        if (run) {
          run.status = 'error'
          run.error = String(ev.error ?? 'error')
          run.finishedAt = Date.now()
          persistSoon()
        }
        break
      case 'summary': {
        const names = new Map((batch.value?.servers ?? []).map(s => [s.serverId, s.name]))
        summary.value = (ev.servers as Omit<SummaryRow, 'name'>[]).map(row => ({
          ...row,
          name: names.get(row.serverId) ?? String(row.serverId)
        }))
        persistSoon()
        break
      }
    }
  }

  function dispatchFrame (frame: string) {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue // keep-alive comments carry no payload
      let ev: Record<string, unknown>
      try { ev = JSON.parse(line.slice(5)) } catch { continue }
      applyEvent(ev)
    }
  }

  /** @param picked the chosen servers with display names (the page knows them) */
  async function start (picked: { id: number, name: string }[]) {
    if (running.value || !form.value.prompt.trim() || !picked.length) return
    const prompt = form.value.prompt.trim()
    const body = {
      serverIds: picked.map(s => s.id),
      prompt,
      runs: form.value.runs,
      ...(form.value.model !== MODEL_AUTO ? { model: form.value.model } : {}),
      ...(typeof form.value.temperature === 'number' ? { temperature: form.value.temperature } : {}),
      ...(typeof form.value.maxTokens === 'number' ? { maxTokens: form.value.maxTokens } : {})
    }
    batch.value = {
      startedAt: Date.now(),
      finishedAt: null,
      servers: picked.map(p => ({ serverId: p.id, name: p.name, runs: Array.from({ length: form.value.runs }, (_, i) => newRun(i + 1)) }))
    }
    summary.value = null
    const entry: HistoryEntry = {
      id: newId(),
      ts: Date.now(),
      prompt,
      serverIds: [...form.value.serverIds],
      runs: form.value.runs,
      temperature: form.value.temperature,
      maxTokens: form.value.maxTokens,
      model: form.value.model
    }
    history.value = pushHistory(history.value, entry, historyKey, HISTORY_LIMIT)
    persist()
    running.value = true
    if (ticker) clearInterval(ticker)
    ticker = setInterval(() => { tick.value++ }, TICK_MS)
    abort = new AbortController()
    const ac = abort
    try {
      const res = await fetch('/api/inference/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal
      })
      if (!res.ok) {
        let message = `HTTP ${res.status}`
        try { message = (await res.json() as { statusMessage?: string })?.statusMessage ?? message } catch { /* keep the status */ }
        toast.add({ title: t('playground.toastRunFailed'), description: message, color: 'error' })
        return
      }
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut = buffer.indexOf('\n\n')
        while (cut >= 0) {
          dispatchFrame(buffer.slice(0, cut))
          buffer = buffer.slice(cut + 2)
          cut = buffer.indexOf('\n\n')
        }
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        toast.add({ title: t('playground.toastRunFailed'), description: (err as Error)?.message ?? String(err), color: 'error' })
      }
    } finally {
      running.value = false
      if (ticker) { clearInterval(ticker); ticker = undefined }
      if (batch.value) {
        for (const st of batch.value.servers) {
          for (const r of st.runs) {
            // a batch that ended mid-flight: the stream is over, these runs are dead
            if (r.status === 'running') r.status = 'aborted'
            else if (r.status === 'queued') r.status = 'skipped'
          }
        }
        batch.value.finishedAt = Date.now()
      }
      abort = null
      persist()
    }
  }

  function stop () {
    abort?.abort()
  }

  // ---------- history actions ----------
  function applyEntry (h: HistoryEntry) {
    form.value = {
      prompt: h.prompt,
      serverIds: [...h.serverIds],
      runs: h.runs,
      temperature: h.temperature,
      maxTokens: h.maxTokens,
      model: h.model
    }
  }

  function removeEntry (id: string) {
    history.value = history.value.filter(h => h.id !== id)
    persist()
  }

  function clearHistory () {
    history.value = []
    persist()
  }

  return { form, batch, summary, history, running, models, tick, restore, start, stop, applyEntry, removeEntry, clearHistory, MODEL_AUTO }
}
