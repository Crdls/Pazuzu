<script setup lang="ts">
import type { LiveServer } from '../plugins/live'
import { fmtBytes, fmtNum, parseLabelStr } from '../utils/format'

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
  const memPct = new Map(gpuSeries('derived:gpu_mem_pct').map(g => [g.gpu, g.value]))
  const memUsed = new Map(gpuSeries('strata:gpu_mem_used_bytes').map(g => [g.gpu, g.value]))
  const memTotal = new Map(gpuSeries('strata:gpu_mem_total_bytes').map(g => [g.gpu, g.value]))
  const temp = new Map(gpuSeries('strata:gpu_temp_celsius').map(g => [g.gpu, g.value]))
  const power = new Map(gpuSeries('strata:gpu_power_watts').map(g => [g.gpu, g.value]))
  return util.map(u => ({
    gpu: u.gpu,
    util: u.value,
    memPct: memPct.get(u.gpu) ?? null,
    memUsed: memUsed.get(u.gpu) ?? null,
    memTotal: memTotal.get(u.gpu) ?? null,
    temp: temp.get(u.gpu) ?? null,
    power: power.get(u.gpu) ?? null
  }))
})

const kvPct = computed(() => {
  const v = one('vllm:kv_cache_usage_perc')
  return v === null ? null : v * 100
})

const ramPct = computed(() => {
  const used = one('strata:ram_used_bytes')
  const total = one('strata:ram_total_bytes')
  return used !== null && total ? (used / total) * 100 : null
})

const lastScrape = computed(() => {
  const ts = snap.value?.ts
  return ts ? new Date(ts).toLocaleTimeString('en-GB') : 'never'
})
</script>

<template>
  <!-- filled, borderless card: a thin shade lighter than the page (dark) -->
  <UCard variant="soft" class="bg-elevated/30">
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <!-- name + address share one neutral button (the slot replaces
               UButton's label, so the two lines need their own container) -->
          <UButton :to="`/servers/${server.id}`" color="neutral" variant="soft" class="max-w-full">
            <span class="flex flex-col items-start min-w-0">
              <span class="font-semibold max-w-full truncate">{{ server.name }}</span>
              <span class="text-[11px] font-normal font-mono text-muted max-w-full truncate">{{ server.url }}</span>
            </span>
          </UButton>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <StateBadge :server="server" />
          <UTooltip v-if="snap?.error" :text="snap.error">
            <UIcon name="i-lucide-triangle-alert" class="size-4 text-error" />
          </UTooltip>
        </div>
      </div>
    </template>

    <div v-if="snap?.up" class="space-y-3">
      <!-- headline stats -->
      <div class="grid grid-cols-4 gap-2 text-center">
        <div>
          <div class="text-lg font-semibold tabular-nums">{{ fmtNum(one('strata:live_tok_s')) }}</div>
          <div class="text-[10px] uppercase tracking-wide text-muted">tok/s</div>
        </div>
        <div>
          <div class="text-lg font-semibold tabular-nums">{{ fmtNum(one('vllm:num_requests_running'), 0) }}</div>
          <div class="text-[10px] uppercase tracking-wide text-muted">{{ t('card.running') }}</div>
        </div>
        <div>
          <div class="text-lg font-semibold tabular-nums">{{ fmtNum(one('vllm:num_requests_waiting'), 0) }}</div>
          <div class="text-[10px] uppercase tracking-wide text-muted">{{ t('card.queued') }}</div>
        </div>
        <div>
          <div class="text-lg font-semibold tabular-nums">{{ fmtNum(kvPct, 0) }}%</div>
          <div class="text-[10px] uppercase tracking-wide text-muted">{{ t('card.kvCache') }}</div>
        </div>
      </div>

      <!-- per-GPU: roomy gaps - pairs kept tight, GPUs spaced apart -->
      <div class="space-y-4">
        <div v-for="g in gpus" :key="g.gpu" class="space-y-2">
          <GaugeBar
            :value="g.util"
            :label="`GPU ${g.gpu}`"
            :right="`${fmtNum(g.util, 0)}% · ${g.temp !== null ? `${fmtNum(g.temp, 0)}°C` : '—'} · ${g.power !== null ? `${fmtNum(g.power, 0)}W` : '—'}`"
          />
          <GaugeBar
            v-if="g.memPct !== null"
            :value="g.memPct"
            :label="`VRAM ${g.gpu}`"
            :right="`${fmtBytes(g.memUsed)} / ${fmtBytes(g.memTotal)}`"
          />
        </div>
      </div>

      <!-- host -->
      <div class="grid grid-cols-2 gap-3">
        <GaugeBar :value="one('strata:cpu')" :label="t('card.cpu')" :right="`${fmtNum(one('strata:cpu'), 0)}%`" />
        <GaugeBar :value="ramPct" :label="t('card.ram')" :right="`${fmtBytes(one('strata:ram_used_bytes'))}`" />
      </div>

      <div class="flex items-center justify-between pt-1 text-xs text-muted">
        <span>{{ t('card.hit', { v: fmtNum((one('strata:last_hit_rate') ?? 0) * 100, 0) }) }}</span>
        <span>{{ t('card.req', { n: fmtNum(one('vllm:request_success_total'), 0) }) }}</span>
        <span>{{ t('card.gen', { n: fmtNum(one('vllm:generation_tokens_total'), 0) }) }}</span>
        <span>{{ lastScrape }}</span>
      </div>
    </div>
    <div v-else class="py-6 text-center text-sm text-muted">
      <template v-if="!server.enabled">{{ t('card.disabled') }}</template>
      <template v-else>{{ snap?.error ?? t('card.waiting') }}</template>
    </div>
  </UCard>
</template>
