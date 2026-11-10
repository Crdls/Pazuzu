<script setup lang="ts">
interface ServerOption {
  id: number
  name: string
  url: string
  enabled: boolean
  up: boolean | null
}

type RunStatus = 'queued' | 'running' | 'done' | 'error' | 'aborted' | 'skipped'

interface RunState {
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

interface ServerState {
  serverId: number
  name: string
  runs: RunState[]
}

interface SummaryRow {
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

const { t } = useI18n()
const toast = useToast()

const { data: serverOptions } = useFetch<ServerOption[]>('/api/servers', {
  // forward cookies on the SSR-side call so the auth middleware lets it through
  headers: useRequestHeaders(['cookie'])
})

const prompt = ref('')
const selected = ref<number[]>([])
const runs = ref(1)
const temperature = ref<number | null>(0.7)
const maxTokens = ref<number | null>(256)
// Reka refuses an empty SelectItem value, so "Auto" rides on a sentinel
const MODEL_AUTO = '__auto__'
const model = ref(MODEL_AUTO)
const models = ref<string[]>([])

const running = ref(false)
const results = ref<ServerState[]>([])
const summary = ref<SummaryRow[] | null>(null)
let abort: AbortController | null = null

// slow ticker: repaints the live total/tok/s badges while a run streams
const tick = ref(0)
let ticker: ReturnType<typeof setInterval> | undefined
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
  abort?.abort()
})

function toggleServer (id: number) {
  if (running.value) return
  selected.value = selected.value.includes(id)
    ? selected.value.filter(x => x !== id)
    : [...selected.value, id]
}

// the model list comes from the first selected engine - engines usually
// serve exactly one model, so the same id is right for all of them
async function loadModels () {
  const first = selected.value[0]
  models.value = []
  if (first == null) return
  try {
    models.value = (await $fetch<{ models: string[] }>('/api/inference/models', { query: { id: first } })).models
  } catch { /* auto mode still works: many engines accept a missing model */ }
}
watch(() => selected.value[0], () => { void loadModels() })

const modelItems = computed(() => [
  { label: t('playground.modelAuto'), value: MODEL_AUTO },
  ...models.value.map(m => ({ label: m, value: m }))
])

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

async function start () {
  if (running.value || !prompt.value.trim() || !selected.value.length) return
  const servers = (serverOptions.value ?? []).filter(s => selected.value.includes(s.id))
  results.value = servers.map(s => ({
    serverId: s.id,
    name: s.name,
    runs: Array.from({ length: runs.value }, (_, i) => newRun(i + 1))
  }))
  summary.value = null
  running.value = true
  if (ticker) clearInterval(ticker)
  ticker = setInterval(() => { tick.value++ }, 250)
  abort = new AbortController()
  try {
    const res = await fetch('/api/inference/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverIds: servers.map(s => s.id),
        prompt: prompt.value.trim(),
        runs: runs.value,
        ...(model.value !== MODEL_AUTO ? { model: model.value } : {}),
        ...(typeof temperature.value === 'number' ? { temperature: temperature.value } : {}),
        ...(typeof maxTokens.value === 'number' ? { maxTokens: maxTokens.value } : {})
      }),
      signal: abort.signal
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
    for (const st of results.value) {
      for (const r of st.runs) {
        // a batch that ended mid-flight: the stream is over, these runs are dead
        if (r.status === 'running') r.status = 'aborted'
        else if (r.status === 'queued') r.status = 'skipped'
      }
    }
    abort = null
  }
}

function stop () {
  abort?.abort()
}

function dispatchFrame (frame: string) {
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue // keep-alive comments carry no payload
    let ev: Record<string, unknown>
    try { ev = JSON.parse(line.slice(5)) } catch { continue }
    applyEvent(ev)
  }
}

function runOf (serverId: number, run: number): RunState | undefined {
  return results.value.find(s => s.serverId === serverId)?.runs.find(r => r.run === run)
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
      }
      break
    case 'error':
      if (run) {
        run.status = 'error'
        run.error = String(ev.error ?? 'error')
        run.finishedAt = Date.now()
      }
      break
    case 'summary': {
      const names = new Map(results.value.map(s => [s.serverId, s.name]))
      summary.value = (ev.servers as Omit<SummaryRow, 'name'>[]).map(row => ({
        ...row,
        name: names.get(row.serverId) ?? String(row.serverId)
      }))
      break
    }
  }
}

// ---------- display helpers ----------
function fmtMs (ms: number | null | undefined): string {
  if (ms == null) return '—'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}
function fmtRate (v: number | null): string {
  return v == null ? '—' : v.toFixed(1)
}
/** The run a column should show: the live one, else the last that started. */
function activeRun (st: ServerState): RunState {
  return st.runs.find(r => r.status === 'running')
    ?? [...st.runs].reverse().find(r => r.status !== 'queued')
    ?? st.runs[0]!
}
/** Elapsed time of a streaming run (the ticker re-renders it). */
function liveTotalMs (r: RunState): number | null {
  void tick.value
  if (r.startedAt == null) return null
  return (r.finishedAt ?? Date.now()) - r.startedAt
}
/** Live tok/s: engine usage when known, else the chars/4 estimate so far. */
function liveRate (r: RunState): number | null {
  const total = r.totalMs ?? liveTotalMs(r)
  const tokens = r.tokens ?? Math.round(r.text.length / 4)
  if (!total || !tokens) return null
  return (tokens / total) * 1000
}
function finishedCount (st: ServerState): number {
  return st.runs.filter(r => r.status !== 'queued' && r.status !== 'running').length
}
function columnIcon (st: ServerState): { icon: string, cls: string } {
  const s = activeRun(st).status
  if (s === 'running') return { icon: 'i-lucide-loader-circle', cls: 'text-primary animate-spin' }
  if (s === 'done') return { icon: 'i-lucide-circle-check', cls: 'text-success' }
  if (s === 'error') return { icon: 'i-lucide-circle-x', cls: 'text-error' }
  if (s === 'aborted' || s === 'skipped') return { icon: 'i-lucide-circle-slash', cls: 'text-muted' }
  return { icon: 'i-lucide-circle', cls: 'text-dimmed' }
}
const runStatusKeys: Record<RunStatus, string> = {
  queued: 'playground.queued',
  running: 'playground.generating',
  done: 'playground.done',
  error: 'playground.error',
  aborted: 'playground.aborted',
  skipped: 'playground.skipped'
}
function runStatusColor (s: RunStatus): 'success' | 'error' | 'primary' | 'neutral' {
  return s === 'done' ? 'success' : s === 'error' ? 'error' : s === 'running' ? 'primary' : 'neutral'
}
/** Flat log of every run that has started, newest server order kept. */
const runLog = computed(() => results.value.flatMap(st =>
  st.runs.filter(r => r.status !== 'queued' && r.status !== 'skipped').map(r => ({ server: st.name, r }))
))
</script>

<template>
  <div>
    <div class="mb-5">
      <h1 class="text-xl font-semibold">{{ t('playground.title') }}</h1>
      <p class="text-sm text-muted mt-0.5">{{ t('playground.subtitle') }}</p>
    </div>

    <UCard variant="soft" class="bg-elevated/30 mb-5">
      <div class="space-y-4">
        <UFormField :label="t('playground.prompt')">
          <UTextarea
            v-model="prompt"
            :rows="4"
            :placeholder="t('playground.promptPlaceholder')"
            :disabled="running"
            class="w-full"
          />
        </UFormField>

        <UFormField :label="t('playground.servers')">
          <div v-if="!serverOptions?.length" class="text-sm text-muted">{{ t('playground.serversEmpty') }}</div>
          <div v-else class="flex flex-wrap gap-1.5">
            <button
              v-for="s in serverOptions"
              :key="s.id"
              type="button"
              class="flex items-center gap-1.5 rounded-full border border-default px-2.5 py-1 text-sm transition-colors disabled:opacity-50"
              :class="selected.includes(s.id) ? 'bg-primary/10 border-primary/50 text-default' : 'text-muted hover:bg-elevated'"
              :disabled="running"
              @click="toggleServer(s.id)"
            >
              <span class="size-1.5 rounded-full shrink-0" :class="s.up === false ? 'bg-error' : 'bg-success'" />
              <span class="truncate max-w-40">{{ s.name }}</span>
            </button>
          </div>
        </UFormField>

        <div class="flex flex-wrap items-end gap-x-4 gap-y-2">
          <UFormField :label="t('playground.runs')">
            <UInputNumber v-model="runs" :min="1" :max="10" :step="1" :disabled="running" class="w-24" />
          </UFormField>
          <UFormField :label="t('playground.temperature')">
            <UInputNumber v-model="temperature" :min="0" :max="2" :step="0.1" :disabled="running" class="w-28" />
          </UFormField>
          <UFormField :label="t('playground.maxTokens')">
            <UInputNumber v-model="maxTokens" :min="1" :max="16384" :step="1" :disabled="running" class="w-28" />
          </UFormField>
          <UFormField :label="t('playground.model')" :help="t('playground.modelHelp')">
            <USelect v-model="model" :items="modelItems" :disabled="running" class="w-56" />
          </UFormField>
          <div class="ml-auto flex items-center gap-2">
            <UButton
              v-if="!running"
              icon="i-lucide-play"
              :disabled="!prompt.trim() || !selected.length"
              @click="start"
            >
              {{ t('playground.run') }}
            </UButton>
            <UButton v-else color="error" icon="i-lucide-square" @click="stop">
              {{ t('playground.stop') }}
            </UButton>
          </div>
        </div>
      </div>
    </UCard>

    <!-- live columns: one per server in the batch -->
    <div v-if="results.length" class="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3 mb-5">
      <div v-for="st in results" :key="st.serverId" class="rounded-lg bg-elevated/50 p-3 space-y-2 min-w-0">
        <div class="flex items-center gap-1.5 min-w-0">
          <UIcon :name="columnIcon(st).icon" class="size-4 shrink-0" :class="columnIcon(st).cls" />
          <span class="truncate font-semibold text-sm">{{ st.name }}</span>
          <span class="ml-auto text-[11px] tabular-nums text-muted shrink-0">
            {{ finishedCount(st) }}/{{ st.runs.length }}
          </span>
        </div>

        <div v-if="activeRun(st).startedAt" class="flex flex-wrap gap-1">
          <UBadge color="neutral" variant="subtle" size="sm" class="tabular-nums">
            {{ t('playground.ttft') }} {{ fmtMs(activeRun(st).ttftMs) }}
          </UBadge>
          <UBadge color="neutral" variant="subtle" size="sm" class="tabular-nums">
            {{ t('playground.total') }} {{ fmtMs(activeRun(st).totalMs ?? liveTotalMs(activeRun(st))) }}
          </UBadge>
          <UBadge color="neutral" variant="subtle" size="sm" class="tabular-nums">
            {{ t('playground.tokPerSec') }} {{ fmtRate(liveRate(activeRun(st))) }}
          </UBadge>
          <UTooltip v-if="activeRun(st).status === 'running' || activeRun(st).estimated" :text="t('playground.tokensEstimate')">
            <UBadge color="neutral" variant="subtle" size="sm" class="tabular-nums">
              ≈{{ activeRun(st).tokens ?? Math.round(activeRun(st).text.length / 4) }} {{ t('playground.tokens') }}
            </UBadge>
          </UTooltip>
          <UTooltip v-else :text="t('playground.tokens')">
            <UBadge color="neutral" variant="subtle" size="sm" class="tabular-nums">
              {{ activeRun(st).tokens ?? '—' }} {{ t('playground.tokens') }}
            </UBadge>
          </UTooltip>
        </div>

        <div class="text-[13px] leading-5 font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
          <span v-if="activeRun(st).text">{{ activeRun(st).text }}</span>
          <span v-else-if="activeRun(st).error" class="text-error text-xs">{{ activeRun(st).error }}</span>
          <span v-else class="text-dimmed text-xs">{{ t(runStatusKeys[activeRun(st).status]) }}</span>
        </div>

        <div class="flex flex-wrap gap-1">
          <UTooltip
            v-for="r in st.runs"
            :key="r.run"
            :text="`#${r.run} · ${t(runStatusKeys[r.status])} · ${t('playground.ttft')} ${fmtMs(r.ttftMs)} · ${fmtMs(r.totalMs ?? liveTotalMs(r))} · ${fmtRate(liveRate(r))} ${t('playground.tokPerSec')}`"
          >
            <span
              class="inline-flex items-center justify-center size-5 rounded text-[10px] tabular-nums cursor-default"
              :class="{
                'bg-success/15 text-success': r.status === 'done',
                'bg-error/15 text-error': r.status === 'error',
                'bg-primary/15 text-primary': r.status === 'running',
                'bg-elevated text-dimmed': r.status === 'queued' || r.status === 'aborted' || r.status === 'skipped'
              }"
            >{{ r.run }}</span>
          </UTooltip>
        </div>
      </div>
    </div>

    <template v-if="summary">
      <UCard variant="soft" class="bg-elevated/30 mb-5">
        <div class="text-xs uppercase tracking-wide text-muted mb-2">{{ t('playground.summaryTitle') }}</div>
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs uppercase tracking-wide text-muted border-b border-default">
              <th class="py-2 pr-3 font-medium">{{ t('playground.server') }}</th>
              <th class="py-2 pr-3 font-medium text-right">{{ t('playground.okCol') }}</th>
              <th class="py-2 pr-3 font-medium text-right">{{ t('playground.errorsCol') }}</th>
              <th class="py-2 pr-3 font-medium text-right">{{ t('playground.medianTtft') }}</th>
              <th class="py-2 pr-3 font-medium text-right">{{ t('playground.medianTotal') }}</th>
              <th class="py-2 pr-3 font-medium text-right">{{ t('playground.medianRate') }}</th>
              <th class="py-2 pr-3 font-medium text-right">{{ t('playground.bestTotal') }}</th>
              <th class="py-2 font-medium text-right">{{ t('playground.worstTotal') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in summary" :key="row.serverId" class="border-b border-default/50 last:border-0">
              <td class="py-2 pr-3 font-medium">
                {{ row.name }}
                <UTooltip v-if="row.anyEstimated" :text="t('playground.tokensEstimate')">
                  <span class="text-dimmed ml-1">≈</span>
                </UTooltip>
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ row.ok }}</td>
              <td class="py-2 pr-3 text-right tabular-nums" :class="row.errors ? 'text-error' : 'text-muted'">{{ row.errors }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ fmtMs(row.medTtftMs) }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ fmtMs(row.medTotalMs) }}</td>
              <td class="py-2 pr-3 text-right tabular-nums font-semibold">{{ fmtRate(row.medTokPerSec) }}</td>
              <td class="py-2 pr-3 text-right tabular-nums text-muted">{{ fmtMs(row.bestTotalMs) }}</td>
              <td class="py-2 pr-3 text-right tabular-nums text-muted">{{ fmtMs(row.worstTotalMs) }}</td>
            </tr>
          </tbody>
        </table>
      </UCard>
    </template>

    <UCard v-if="runLog.length" variant="soft" class="bg-elevated/30 mb-5">
      <div class="text-xs uppercase tracking-wide text-muted mb-2">{{ t('playground.runsTitle') }}</div>
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs uppercase tracking-wide text-muted border-b border-default">
            <th class="py-2 pr-3 font-medium">{{ t('playground.server') }}</th>
            <th class="py-2 pr-3 font-medium text-right">{{ t('playground.runNo') }}</th>
            <th class="py-2 pr-3 font-medium">{{ t('clients.status') }}</th>
            <th class="py-2 pr-3 font-medium text-right">{{ t('playground.ttft') }}</th>
            <th class="py-2 pr-3 font-medium text-right">{{ t('playground.total') }}</th>
            <th class="py-2 pr-3 font-medium text-right">{{ t('playground.tokens') }}</th>
            <th class="py-2 font-medium text-right">{{ t('playground.tokPerSec') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="{ server, r } in runLog" :key="`${server}-${r.run}`" class="border-b border-default/50 last:border-0">
            <td class="py-2 pr-3">{{ server }}</td>
            <td class="py-2 pr-3 text-right tabular-nums">{{ r.run }}</td>
            <td class="py-2 pr-3">
              <UBadge :color="runStatusColor(r.status)" variant="subtle" size="sm" :title="r.error ?? undefined">
                {{ t(runStatusKeys[r.status]) }}
              </UBadge>
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">{{ fmtMs(r.ttftMs) }}</td>
            <td class="py-2 pr-3 text-right tabular-nums">{{ fmtMs(r.totalMs ?? liveTotalMs(r)) }}</td>
            <td class="py-2 pr-3 text-right tabular-nums">
              <span :title="r.estimated ? t('playground.tokensEstimate') : undefined">
                {{ r.estimated ? '≈' : '' }}{{ r.tokens ?? Math.round(r.text.length / 4) }}
              </span>
            </td>
            <td class="py-2 font-medium text-right tabular-nums">{{ fmtRate(liveRate(r)) }}</td>
          </tr>
        </tbody>
      </table>
    </UCard>

    <div v-if="!results.length" class="py-12 text-center text-sm text-muted">
      <AbyssEyes class="size-9 mx-auto mb-2" />
      <div>{{ t('playground.emptyHint') }}</div>
    </div>
  </div>
</template>
