<script setup lang="ts">
import type { HistoryEntry, RunState, RunStatus, ServerState } from '../composables/playground'
import { MODEL_AUTO, usePlayground } from '../composables/playground'

interface ServerOption {
  id: number
  name: string
  url: string
  enabled: boolean
  up: boolean | null
}

const { t } = useI18n()

const { data: serverOptions } = useFetch<ServerOption[]>('/api/servers', {
  // forward cookies on the SSR-side call so the auth middleware lets it through
  headers: useRequestHeaders(['cookie'])
})

// all run state lives in the shared composable: navigating away does not
// abort the batch, and the form/batch/history survive a reload
const pg = usePlayground()
const { form, batch, summary, history, running, models, tick } = pg
const historyOpen = ref(false)
onMounted(() => pg.restore())

function selectAllServers () {
  form.value.serverIds = (serverOptions.value ?? []).map(s => s.id)
}

// keep the selection in list order, so "first server" is stable for /v1/models
function toggleServer (id: number, on: boolean) {
  const set = new Set(form.value.serverIds)
  if (on) set.add(id)
  else set.delete(id)
  form.value.serverIds = (serverOptions.value ?? []).filter(s => set.has(s.id)).map(s => s.id)
}

const modelItems = computed(() => [
  { label: t('playground.modelAuto'), value: MODEL_AUTO },
  ...models.value.map(m => ({ label: m, value: m }))
])

const reasoningItems = computed(() => [
  { label: t('playground.reasonAuto'), value: 'auto' },
  { label: t('playground.reasonLow'), value: 'low' },
  { label: t('playground.reasonMedium'), value: 'medium' },
  { label: t('playground.reasonHigh'), value: 'high' }
])

function startRun () {
  void pg.start((serverOptions.value ?? []).filter(s => form.value.serverIds.includes(s.id)))
}

function applyHistoryEntry (h: HistoryEntry) {
  pg.applyEntry(h)
  historyOpen.value = false
}

function historyNames (h: HistoryEntry): string {
  const byId = new Map((serverOptions.value ?? []).map(s => [s.id, s.name]))
  return h.serverIds.map(id => byId.get(id) ?? `#${id}`).join(', ')
}

function historyModel (h: HistoryEntry): string {
  return h.model === MODEL_AUTO ? t('playground.modelAuto') : h.model
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
/** Tokens so far: the estimate covers the reasoning channel too. */
function estTokens (r: RunState): number {
  return Math.round((r.text.length + (r.reasoning?.length ?? 0)) / 4)
}
/** Live tok/s: tokens over the time since the first streamed token (thinking
 *  included) - TTFT belongs to "total", counting it in crushes the rate. */
function liveRate (r: RunState): number | null {
  void tick.value
  const firstMs = r.firstMs ?? r.ttftMs
  if (r.startedAt == null || firstMs == null) return null // nothing generated yet
  const wall = r.totalMs ?? Date.now() - r.startedAt
  const decodeMs = wall - firstMs
  const tokens = r.tokens ?? estTokens(r)
  if (decodeMs < 50 || !tokens) return null
  return (tokens / decodeMs) * 1000
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
/** A run streaming thoughts but no answer token yet is thinking, not silent. */
function statusKey (r: RunState): string {
  if (r.status === 'running' && r.ttftMs == null && (r.reasoning?.length ?? 0) > 0) return 'playground.thinking'
  return runStatusKeys[r.status]
}
function runStatusColor (s: RunStatus): 'success' | 'error' | 'primary' | 'neutral' {
  return s === 'done' ? 'success' : s === 'error' ? 'error' : s === 'running' ? 'primary' : 'neutral'
}
/** Flat log of every run that has started, newest server order kept. */
const runLog = computed(() => (batch.value?.servers ?? []).flatMap(st =>
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
        <UFormField>
          <template #label>
            <span class="flex items-center gap-1.5">
              {{ t('playground.prompt') }}
              <UPopover v-if="history.length" v-model:open="historyOpen">
                <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-history">
                  {{ t('playground.history') }}
                </UButton>
                <template #content>
                  <div class="w-96 max-h-80 overflow-y-auto">
                    <div
                      v-for="h in history"
                      :key="h.id"
                      class="group flex items-start gap-1 px-3 py-2 border-b border-default/50 last:border-0 hover:bg-elevated/50 cursor-pointer"
                      @click="applyHistoryEntry(h)"
                    >
                      <div class="min-w-0 flex-1">
                        <div class="text-[13px] leading-5 line-clamp-2">{{ h.prompt }}</div>
                        <div class="text-[11px] text-dimmed truncate">
                          {{ new Date(h.ts).toLocaleString() }} · {{ historyNames(h) }} ·
                          {{ t('playground.hRuns', { n: h.runs }) }} · {{ historyModel(h) }}
                        </div>
                      </div>
                      <UButton
                        size="xs"
                        color="neutral"
                        variant="ghost"
                        icon="i-lucide-x"
                        class="opacity-0 group-hover:opacity-100 shrink-0"
                        :aria-label="t('playground.historyClear')"
                        @click.stop="pg.removeEntry(h.id)"
                      />
                    </div>
                    <div class="p-2 text-center border-t border-default">
                      <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-trash-2" @click="pg.clearHistory(); historyOpen = false">
                        {{ t('playground.historyClear') }}
                      </UButton>
                    </div>
                  </div>
                </template>
              </UPopover>
            </span>
          </template>
          <UTextarea
            v-model="form.prompt"
            :rows="4"
            :placeholder="t('playground.promptPlaceholder')"
            :disabled="running"
            class="w-full"
          />
        </UFormField>

        <UFormField :label="t('playground.servers')">
          <div v-if="!serverOptions?.length" class="text-sm text-muted">{{ t('playground.serversEmpty') }}</div>
          <template v-else>
            <div class="flex items-center gap-2 mb-1.5">
              <UButton size="xs" color="neutral" variant="outline" :disabled="running" @click="selectAllServers">
                {{ t('common.selectAll') }}
              </UButton>
              <UButton size="xs" color="neutral" variant="outline" :disabled="running" @click="form.serverIds = []">
                {{ t('common.selectNone') }}
              </UButton>
            </div>
            <div class="max-h-44 overflow-y-auto rounded-md border border-default divide-y divide-default">
              <div v-for="s in serverOptions" :key="s.id" class="flex items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-elevated/50">
                <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <UCheckbox
                    :model-value="form.serverIds.includes(s.id)"
                    :disabled="running"
                    @update:model-value="toggleServer(s.id, $event as boolean)"
                  />
                  <span class="truncate">{{ s.name }}</span>
                </label>
                <span class="size-1.5 rounded-full shrink-0" :class="s.up === false ? 'bg-error' : 'bg-success'" />
              </div>
            </div>
          </template>
        </UFormField>

        <div class="flex flex-wrap items-end gap-x-4 gap-y-2">
          <UFormField :label="t('playground.runs')">
            <UInputNumber v-model="form.runs" :min="1" :max="10" :step="1" :disabled="running" class="w-24" />
          </UFormField>
          <UFormField :label="t('playground.temperature')">
            <UInputNumber v-model="form.temperature" :min="0" :max="2" :step="0.1" :disabled="running" class="w-28" />
          </UFormField>
          <UFormField :label="t('playground.maxTokens')">
            <UInputNumber v-model="form.maxTokens" :min="1" :max="16384" :step="1" :disabled="running" class="w-28" />
          </UFormField>
          <UFormField :label="t('playground.model')">
            <USelect v-model="form.model" :items="modelItems" :disabled="running" class="w-56" />
          </UFormField>
          <UFormField :label="t('playground.reasoning')">
            <USelect v-model="form.reasoning" :items="reasoningItems" :disabled="running" class="w-40" />
          </UFormField>
          <div class="ml-auto flex items-center gap-2">
            <UButton
              v-if="!running"
              icon="i-lucide-play"
              :disabled="!form.prompt.trim() || !form.serverIds.length"
              @click="startRun"
            >
              {{ t('playground.run') }}
            </UButton>
            <UButton v-else color="error" icon="i-lucide-square" @click="pg.stop()">
              {{ t('playground.stop') }}
            </UButton>
          </div>
        </div>
      </div>
    </UCard>

    <!-- live columns: one per server in the batch -->
    <div v-if="batch" class="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3 mb-5">
      <div v-for="st in batch.servers" :key="st.serverId" class="rounded-lg bg-elevated/50 p-3 space-y-2 min-w-0">
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
              ≈{{ activeRun(st).tokens ?? estTokens(activeRun(st)) }} {{ t('playground.tokens') }}
            </UBadge>
          </UTooltip>
          <UTooltip v-else :text="t('playground.tokens')">
            <UBadge color="neutral" variant="subtle" size="sm" class="tabular-nums">
              {{ activeRun(st).tokens ?? '—' }} {{ t('playground.tokens') }}
            </UBadge>
          </UTooltip>
        </div>

        <!-- the thinking channel of reasoning models: what the long TTFT spent doing -->
        <div v-if="activeRun(st).reasoning" class="rounded-md bg-elevated/60 p-2 space-y-1">
          <div class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-dimmed">
            <UIcon name="i-lucide-brain" class="size-3" />
            {{ t('playground.thoughts') }}
          </div>
          <div class="text-xs leading-4 font-mono whitespace-pre-wrap break-words text-muted max-h-40 overflow-y-auto">{{ activeRun(st).reasoning }}</div>
        </div>

        <div class="text-[13px] leading-5 font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
          <span v-if="activeRun(st).text">{{ activeRun(st).text }}</span>
          <span v-else-if="activeRun(st).error" class="text-error text-xs">{{ activeRun(st).error }}</span>
          <span v-else class="text-dimmed text-xs">{{ t(statusKey(activeRun(st))) }}</span>
        </div>

        <div class="flex flex-wrap gap-1">
          <UTooltip
            v-for="r in st.runs"
            :key="r.run"
            :text="`#${r.run} · ${t(statusKey(r))} · ${t('playground.ttft')} ${fmtMs(r.ttftMs)} · ${fmtMs(r.totalMs ?? liveTotalMs(r))} · ${fmtRate(liveRate(r))} ${t('playground.tokPerSec')}`"
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
                {{ t(statusKey(r)) }}
              </UBadge>
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">{{ fmtMs(r.ttftMs) }}</td>
            <td class="py-2 pr-3 text-right tabular-nums">{{ fmtMs(r.totalMs ?? liveTotalMs(r)) }}</td>
            <td class="py-2 pr-3 text-right tabular-nums">
              <span :title="r.estimated ? t('playground.tokensEstimate') : undefined">
                {{ r.estimated ? '≈' : '' }}{{ r.tokens ?? estTokens(r) }}
              </span>
            </td>
            <td class="py-2 font-medium text-right tabular-nums">{{ fmtRate(liveRate(r)) }}</td>
          </tr>
        </tbody>
      </table>
    </UCard>

    <div v-if="!batch" class="py-12 text-center text-sm text-muted">
      <AbyssEyes class="size-9 mx-auto mb-2" />
      <div>{{ t('playground.emptyHint') }}</div>
    </div>
  </div>
</template>
