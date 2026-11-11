<script setup lang="ts">
import type { LiveServer } from '../plugins/live'
import { fmtBytes, fmtNum, fmtStamp, kVal, parseLabelStr, relTime } from '../utils/format'

const props = defineProps<{ server: LiveServer }>()
const { t } = useI18n()

const snap = computed(() => props.server.snapshot)

function one (key: string): number | null {
  const entries = snap.value?.metrics[key]
  return entries?.length ? entries[0]![1] : null
}

function gpuSeries (key: string): Array<{ gpu: string, value: number }> {
  return (snap.value?.metrics[key] ?? [])
    .map(([labels, value]) => ({ gpu: parseLabelStr(labels).gpu ?? '?', value }))
    .sort((a, b) => a.gpu.localeCompare(b.gpu))
}

const gpus = computed(() => {
  const util = gpuSeries('strata:gpu_util')
  const memUsed = new Map(gpuSeries('strata:gpu_mem_used_bytes').map(g => [g.gpu, g.value]))
  const memTotal = new Map(gpuSeries('strata:gpu_mem_total_bytes').map(g => [g.gpu, g.value]))
  const temp = new Map(gpuSeries('strata:gpu_temp_celsius').map(g => [g.gpu, g.value]))
  const power = new Map(gpuSeries('strata:gpu_power_watts').map(g => [g.gpu, g.value]))
  return util.map(u => {
    const [memUsedS, memTotalS, memUnit] = memParts(memUsed.get(u.gpu) ?? null, memTotal.get(u.gpu) ?? null)
    return {
      gpu: u.gpu,
      util: u.value,
      memUsedS,
      memTotalS,
      memUnit,
      temp: temp.get(u.gpu) ?? null,
      power: power.get(u.gpu) ?? null
    }
  })
})

const kvPct = computed(() => {
  const v = one('vllm:kv_cache_usage_perc')
  return v === null ? null : v * 100
})

// KV cache capacity: the engine's context size in tokens; used comes from the
// running share over that capacity, both shown in K (e.g. `131/262K`)
const kvTotal = computed(() => one('strata:engine_max_context'))
const kvUsed = computed(() =>
  kvPct.value === null || kvTotal.value === null ? null : (kvPct.value / 100) * kvTotal.value
)

const ramParts = computed(() => memParts(one('strata:ram_used_bytes'), one('strata:ram_total_bytes')))

// requests plate: the engine's running requests, plus `+queued` (styled as a
// unit) while vllm reports anything waiting - the engine exposes no reliable
// total slot count, so no total is invented here
const reqParts = computed((): [string, string] => {
  const running = one('vllm:num_requests_running') ?? 0
  const queued = one('vllm:num_requests_waiting') ?? 0
  return [fmtNum(running, 0), queued > 0 ? fmtNum(queued, 0) : '']
})

// util tint carries over the thresholds the old gauge bars used
function utilClass (v: number | null): string {
  if (v === null) return 'text-muted'
  if (v < 60) return 'text-emerald-500'
  if (v < 85) return 'text-amber-500'
  return 'text-red-500'
}

/** used/total split for the memory chips: bare numbers plus the shared unit
 *  when both sides match (`['31.5', '32.0', 'GiB']`), full strings + no unit
 *  otherwise, so the chip can append the unit without being wrong */
function memParts (used: number | null, total: number | null): [string, string, string] {
  if (used === null || total === null || !Number.isFinite(used) || !Number.isFinite(total)) return ['—', '', '']
  const u = fmtBytes(used)
  const m = fmtBytes(total)
  if (u.endsWith(m.slice(m.indexOf(' ')))) {
    return [u.slice(0, u.lastIndexOf(' ')), m.slice(0, m.lastIndexOf(' ')), m.slice(m.indexOf(' ') + 1)]
  }
  return [u, m, '']
}

// when the engine (re)started - bounds the "total" counters in the info row
const startedLabel = computed(() => {
  const ts = snap.value?.engineStart
  return ts ? fmtStamp(ts) : null
})

// ticking clock so the "X ago" stamps stay fresh between scrapes
const now = useNow()
const rel = (ts: number) => relTime(ts, now.value, (k, p) => t(k, p ?? {}))
const lastReplyLabel = computed(() => {
  const ts = snap.value?.lastSeen
  return ts ? rel(ts) : t('card.neverReplied')
})
</script>

<template>
  <!-- filled, borderless card: a thin shade lighter than the page (dark); no
       header/footer sections - one compact body without dividers; the flex
       column keeps the info row pinned to the bottom edge, so it lines up
       across a grid row of uneven cards -->
  <UCard variant="soft" class="bg-elevated/30 flex flex-col" :ui="{ body: 'p-3 sm:p-4 flex-1 flex flex-col' }">
    <div>
      <!-- title row on the 12-column rhythm: the server button and the status
           plate split the row into two halves of six columns each; children
           stretch, so the plate matches the button's height -->
      <div class="grid grid-cols-2 gap-2 lg:grid-cols-12">
        <UButton :to="`/servers/${server.id}`" color="neutral" variant="soft" class="col-span-2 lg:col-span-6 min-w-0 justify-start text-left">
          <span class="flex flex-col items-start w-full min-w-0">
            <span class="font-semibold w-full truncate">{{ server.name }}</span>
            <span class="text-[11px] font-normal font-mono text-muted w-full truncate">{{ server.url }}</span>
          </span>
        </UButton>
        <div class="flex items-center gap-1.5 min-w-0 lg:col-span-6">
          <StateBadge :server="server" class="flex-1 min-w-0 self-stretch" />
          <UTooltip v-if="snap?.error" :text="snap.error">
            <UIcon name="i-lucide-triangle-alert" class="size-4 text-error shrink-0" />
          </UTooltip>
        </div>
      </div>

      <!-- one flat grid, twelve columns: the first row is CPU (2), memory
           RAM (4), KV cache (3) and requests (3) - the GPU rows below use the
           same 2-4-3-3 widths so VRAM sits under RAM (the stage speed lives
           in the state plate above); each GPU row's cells are util, vram,
           temp, power (util tinted). KV cache folds the percent into its
           label and shows used/total as `109K/262K` (the total in small).
           Plates are tinted boxes (5% of the base
           text color on the light theme, 3% on the dark one); label on top,
           value underneath, both centered; labels drop the number for a
           lone GPU -->
      <div v-if="snap?.up" class="mt-2 grid grid-cols-2 gap-1 lg:grid-cols-12">
        <div class="rounded-md bg-(--ui-text)/5 dark:bg-(--ui-text)/3 p-2 flex flex-col items-center gap-px text-center lg:col-span-2">
          <div class="text-[10px] uppercase tracking-wide text-muted">{{ t('card.cpu') }}</div>
          <div class="text-lg font-semibold tabular-nums">{{ fmtNum(one('strata:cpu'), 0) }}<span class="text-sm font-normal text-muted">&nbsp;%</span></div>
        </div>
        <div class="rounded-md bg-(--ui-text)/5 dark:bg-(--ui-text)/3 p-2 flex flex-col items-center gap-px text-center lg:col-span-4">
          <div class="text-[10px] uppercase tracking-wide text-muted">{{ t('card.ram') }}</div>
          <div class="text-lg font-semibold tabular-nums">
            {{ ramParts[0] }}<span v-if="ramParts[1]" class="text-sm font-normal text-muted">/{{ ramParts[1] }}</span><span v-if="ramParts[2]" class="text-sm font-normal text-muted">&nbsp;{{ ramParts[2] }}</span>
          </div>
        </div>
        <div class="rounded-md bg-(--ui-text)/5 dark:bg-(--ui-text)/3 p-2 flex flex-col items-center gap-px text-center lg:col-span-3">
          <div class="text-[10px] uppercase tracking-wide text-muted">{{ t('card.kvCache') }}&nbsp;{{ fmtNum(kvPct, 0) }}%</div>
          <div class="text-lg font-semibold tabular-nums"><template v-if="kvUsed !== null && kvTotal !== null">{{ kVal(kvUsed) }}K<span class="text-sm font-normal text-muted">/{{ kVal(kvTotal) }}K</span></template><template v-else>—</template></div>
        </div>
        <!-- running requests with "+queued" as a unit; the tooltip spells
             both numbers out - the engine has no trustworthy slot total -->
        <UTooltip :text="t('card.requestsHint')" class="lg:col-span-3">
          <div class="rounded-md bg-(--ui-text)/5 dark:bg-(--ui-text)/3 p-2 flex flex-col items-center gap-px text-center">
            <div class="text-[10px] uppercase tracking-wide text-muted">{{ t('card.requests') }}</div>
            <div class="text-lg font-semibold tabular-nums">{{ reqParts[0] }}<span v-if="reqParts[1]" class="text-sm font-normal text-muted">&nbsp;+{{ reqParts[1] }}</span></div>
          </div>
        </UTooltip>
        <!-- one GPU per full-width plate: its four cells (util, vram, temp,
             power) share one tinted background and repeat the 2-4-3-3 widths
             of the stats row (util tinted) -->
        <template v-for="(g, i) in gpus" :key="g.gpu">
          <div class="col-span-2 lg:col-span-12 grid grid-cols-2 gap-1 lg:grid-cols-12 rounded-md bg-(--ui-text)/5 dark:bg-(--ui-text)/3 px-0 py-2">
            <div class="flex flex-col items-center gap-px text-center lg:col-span-2">
              <div class="text-[10px] uppercase tracking-wide text-muted">{{ gpus.length === 1 ? 'GPU' : `GPU ${i + 1}` }}</div>
              <div class="text-lg font-semibold tabular-nums" :class="utilClass(g.util)">{{ fmtNum(g.util, 0) }}<span class="text-sm font-normal text-muted">&nbsp;%</span></div>
            </div>
            <div class="flex flex-col items-center gap-px text-center lg:col-span-4">
              <div class="text-[10px] uppercase tracking-wide text-muted">{{ gpus.length === 1 ? 'VRAM' : `VRAM ${i + 1}` }}</div>
              <div class="text-lg font-semibold tabular-nums">
                {{ g.memUsedS }}<span v-if="g.memTotalS" class="text-sm font-normal text-muted">/{{ g.memTotalS }}</span><span v-if="g.memUnit" class="text-sm font-normal text-muted">&nbsp;{{ g.memUnit }}</span>
              </div>
            </div>
            <div class="flex flex-col items-center gap-px text-center lg:col-span-3">
              <div class="text-[10px] uppercase tracking-wide text-muted">{{ t('card.temp') }}</div>
              <div class="text-lg font-semibold tabular-nums">{{ fmtNum(g.temp, 0) }}<span class="text-sm font-normal text-muted">&nbsp;°C</span></div>
            </div>
            <div class="flex flex-col items-center gap-px text-center lg:col-span-3">
              <div class="text-[10px] uppercase tracking-wide text-muted">{{ t('card.power') }}</div>
              <div class="text-lg font-semibold tabular-nums">{{ fmtNum(g.power, 0) }}<span class="text-sm font-normal text-muted">&nbsp;W</span></div>
            </div>
          </div>
        </template>
      </div>
      <div v-else class="mt-2 py-6 text-center text-sm text-muted">
        <template v-if="!server.enabled">{{ t('card.disabled') }}</template>
        <template v-else>{{ snap?.error ?? t('card.waiting') }}</template>
      </div>
    </div>

    <!-- info row, pinned to the bottom of the card -->
    <div v-if="snap?.up" class="mt-auto pt-2 flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted">
      <span v-if="snap.lastBusy">{{ t('card.load', { v: rel(snap.lastBusy) }) }}</span>
      <span v-else>{{ t('card.noLoad') }}</span>
      <span>{{ t('card.hit', { v: fmtNum((one('strata:last_hit_rate') ?? 0) * 100, 0) }) }}</span>
      <span>{{ t('card.total', { n: fmtNum(one('vllm:generation_tokens_total'), 0) }) }}</span>
      <span v-if="startedLabel">{{ t('card.up', { v: startedLabel }) }}</span>
    </div>
    <div v-else-if="snap" class="mt-auto pt-2 flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted">
      <span>{{ t('card.lastReply', { v: lastReplyLabel }) }}</span>
      <span v-if="snap.lastBusy">{{ t('card.load', { v: rel(snap.lastBusy) }) }}</span>
    </div>
  </UCard>
</template>
