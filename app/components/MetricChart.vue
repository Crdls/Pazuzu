<script setup lang="ts">
import { fmtNum } from '../utils/format'

export interface ChartSeries {
  name: string
  points: Array<[number, number]>
}

const props = withDefaults(defineProps<{
  title: string
  series: ChartSeries[]
  unit?: string
  /** multiply values before plotting (e.g. 0..1 ratio -> %) */
  scale?: number
  height?: number
}>(), { unit: '', scale: 1, height: 190 })

const { t } = useI18n()

// series palette: bioluminescent inks that glow on the Abyss dark background
const COLORS = ['#33b9c9', '#fbbf24', '#f472b6', '#a3e635', '#fb7185', '#a78bfa', '#34d399', '#60a5fa']

const el = ref<HTMLDivElement>()
const hasData = computed(() => props.series.some(s => s.points.length > 0))

let chart: import('uplot').default | null = null
let uPlotCtor: import('uplot').defaultCtor | null = null
let resizeObserver: ResizeObserver | null = null
let fullRange: { min: number, max: number } | null = null

async function ensureLib () {
  if (!uPlotCtor) {
    const mod = await import('uplot')
    uPlotCtor = mod.default
    await import('uplot/dist/uPlot.min.css')
  }
  return uPlotCtor
}

async function build () {
  if (!el.value || !hasData.value) return
  const U = await ensureLib()
  if (!el.value) return
  chart?.destroy()
  chart = null

  const series = props.series
    .map(s => ({
      name: s.name,
      points: s.points.map(([t, v]) => [t, v * props.scale] as [number, number])
    }))
    .filter(s => s.points.length > 0)
  if (!series.length) return

  const tsSet = new Set<number>()
  for (const s of series) for (const [t] of s.points) tsSet.add(t)
  const ts = [...tsSet].sort((a, b) => a - b)
  const tsIndex = new Map(ts.map((t, i) => [t, i]))
  const data: Array<Array<number | null>> = [ts as unknown as Array<number | null>]
  for (const s of series) {
    const col: Array<number | null> = new Array(ts.length).fill(null)
    for (const [t, v] of s.points) col[tsIndex.get(t)!] = v
    data.push(col)
  }

  fullRange = { min: ts[0]!, max: ts[ts.length - 1]! }
  const span = fullRange.max - fullRange.min
  const unit = props.unit

  chart = new U({
    width: el.value.clientWidth || 400,
    height: props.height,
    padding: [8, 12, 4, 2],
    scales: {
      x: { time: true },
      y: props.unit === '%' ? { min: 0, max: 100 } : { auto: true }
    },
    series: [
      { label: 'time' },
      ...series.map((s, i) => ({
        label: s.name,
        stroke: COLORS[i % COLORS.length],
        width: 1.5,
        points: { show: false }
      }))
    ],
    axes: [
      {
        size: 40,
        stroke: 'rgba(128,128,128,.75)',
        grid: { stroke: 'rgba(128,128,128,.12)', width: 1 },
        ticks: { stroke: 'rgba(128,128,128,.2)', width: 1 },
        font: '10px ui-sans-serif, system-ui',
        values: (_u: unknown, vals: number[]) => vals.map(v => span > 2 * 86_400_000
          ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })
          : new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))
      },
      {
        size: 46,
        stroke: 'rgba(128,128,128,.75)',
        grid: { stroke: 'rgba(128,128,128,.12)', width: 1 },
        ticks: { show: false },
        font: '10px ui-sans-serif, system-ui',
        values: (_u: unknown, vals: number[]) => vals.map(v => `${fmtNum(v)}${unit ? ` ${unit}` : ''}`)
      }
    ],
    legend: { show: series.length > 1 },
    cursor: {
      drag: { x: true, y: false, setScale: true },
      points: { show: false }
    }
  } as import('uplot').Options, data, el.value)
}

function resetZoom () {
  if (chart && fullRange) chart.setScale('x', { ...fullRange })
}

onMounted(() => {
  void build()
  resizeObserver = new ResizeObserver(() => {
    if (chart && el.value) chart.setSize({ width: el.value.clientWidth })
  })
  if (el.value) resizeObserver.observe(el.value)
})

watch(() => [props.series, props.unit, props.scale], () => {
  void build()
}, { deep: true })

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  chart?.destroy()
  chart = null
})
</script>

<template>
  <UCard variant="soft" class="bg-elevated/30">
    <template #header>
      <div class="flex items-baseline justify-between gap-2">
        <h3 class="text-sm font-semibold">{{ title }}</h3>
        <span class="text-[10px] text-muted">{{ t('server.zoomHint') }}</span>
      </div>
    </template>
    <div class="relative">
      <div ref="el" @dblclick="resetZoom" />
      <div v-if="!hasData" class="absolute inset-0 flex items-center justify-center text-sm text-muted">
        {{ t('server.noData') }}
      </div>
    </div>
  </UCard>
</template>
