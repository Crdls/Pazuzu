<script setup lang="ts">
import type { ChartSeries } from '../../components/MetricChart.vue'
import { seriesName } from '../../utils/format'

const route = useRoute()
const id = computed(() => Number(route.params.id))

const RANGES = [
  { label: '1h', ms: 3_600_000 },
  { label: '6h', ms: 6 * 3_600_000 },
  { label: '24h', ms: 24 * 3_600_000 },
  { label: '7d', ms: 7 * 86_400_000 },
  { label: '30d', ms: 30 * 86_400_000 }
]
const rangeIdx = ref(0)

const CHARTS: Array<{ titleKey: string, keys: string[], unit: string, scale?: number }> = [
  { titleKey: 'server.charts.gpuUtil', keys: ['strata:gpu_util'], unit: '%' },
  { titleKey: 'server.charts.gpuMemory', keys: ['derived:gpu_mem_pct'], unit: '%' },
  { titleKey: 'server.charts.gpuTemp', keys: ['strata:gpu_temp_celsius'], unit: '°C' },
  { titleKey: 'server.charts.gpuPower', keys: ['strata:gpu_power_watts'], unit: 'W' },
  { titleKey: 'server.charts.throughput', keys: ['strata:live_tok_s', 'derived:gen_tok_s', 'derived:prompt_tok_s'], unit: 'tok/s' },
  { titleKey: 'server.charts.requests', keys: ['vllm:num_requests_running', 'vllm:num_requests_waiting'], unit: '' },
  { titleKey: 'server.charts.reqRate', keys: ['derived:req_s'], unit: 'req/s' },
  { titleKey: 'server.charts.latency', keys: ['derived:ttft_avg_s', 'derived:itl_avg_s', 'derived:e2e_avg_s'], unit: 's' },
  { titleKey: 'server.charts.kvCache', keys: ['vllm:kv_cache_usage_perc'], unit: '%', scale: 100 },
  { titleKey: 'server.charts.hitRate', keys: ['strata:last_hit_rate'], unit: '%', scale: 100 },
  { titleKey: 'server.charts.hostLoad', keys: ['strata:cpu', 'derived:ram_pct'], unit: '%' },
  { titleKey: 'server.charts.engineBusy', keys: ['derived:decode_busy_pct', 'derived:prefill_busy_pct'], unit: '%' }
]

interface ChartState {
  title: string
  unit: string
  scale: number
  series: ChartSeries[]
  loading: boolean
}

const { t, te, locale } = useI18n()

const charts = ref<ChartState[]>(CHARTS.map(c => ({ title: t(c.titleKey), unit: c.unit, scale: c.scale ?? 1, series: [], loading: true })))

const { servers } = useLive()
const server = computed(() => servers.value.find(s => s.id === id.value) ?? null)

async function load () {
  const to = Date.now()
  const from = to - RANGES[rangeIdx.value]!.ms
  charts.value = await Promise.all(CHARTS.map(async (c) => {
    const perKey = await Promise.all(c.keys.map(async (key) => {
      try {
        const res = await $fetch<{ metric: string, label: string, series: Array<{ labels: string, points: Array<[number, number]> }> }>(
          '/api/range',
          { query: { serverId: id.value, metric: key, from, to } }
        )
        const label = te(`metric.${res.metric}`) ? t(`metric.${res.metric}`) : res.label
        const multi = res.series.length > 1
        return res.series.map(s => ({
          name: multi ? seriesName(label, s.labels) : label,
          points: s.points
        }))
      } catch {
        return [] as ChartSeries[]
      }
    }))
    return { title: t(c.titleKey), unit: c.unit, scale: c.scale ?? 1, series: perKey.flat(), loading: false }
  }))
}

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void load()
  timer = setInterval(load, 30_000)
})
watch([rangeIdx, locale], load)
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center justify-between gap-3 mb-5">
      <div class="flex items-center gap-3 min-w-0">
        <UButton to="/" color="neutral" variant="ghost" size="sm" icon="i-lucide-arrow-left" />
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h1 class="text-xl font-semibold truncate">
              {{ server?.name ?? `Server #${id}` }}
            </h1>
            <StateBadge v-if="server" :server="server" />
          </div>
          <div class="text-xs text-muted truncate">{{ server?.url }}</div>
        </div>
      </div>
      <div class="flex items-center gap-1 rounded-lg border border-default p-1">
        <UButton
          v-for="(r, i) in RANGES"
          :key="r.label"
          size="xs"
          :variant="rangeIdx === i ? 'solid' : 'ghost'"
          :color="rangeIdx === i ? 'primary' : 'neutral'"
          @click="rangeIdx = i"
        >
          {{ r.label }}
        </UButton>
      </div>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <ClientOnly v-for="chart in charts" :key="chart.title">
        <MetricChart
          :title="chart.title"
          :series="chart.series"
          :unit="chart.unit"
          :scale="chart.scale"
        />
        <template #fallback>
          <UCard variant="soft" class="bg-elevated/30">
            <div class="h-48 flex items-center justify-center text-sm text-muted">
              {{ chart.title }}
            </div>
          </UCard>
        </template>
      </ClientOnly>
    </div>
  </div>
</template>
