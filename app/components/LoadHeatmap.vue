<script setup lang="ts">
import { fmtDateTime, fmtNum } from '../utils/format'

export interface HeatmapRow {
  serverId: number
  name: string
  values: Array<number | null>
}

export interface HeatmapData {
  metric: string
  metricLabel: string
  unit: string
  scale: number
  period: string
  bucketMs: number
  buckets: number[]
  rows: HeatmapRow[]
  availableMetrics: Array<{ value: string, label: string, unit: string }>
}

const props = defineProps<{ data: HeatmapData }>()

const { t } = useI18n()

const maxValue = computed(() => {
  if (props.data.unit === '%') return 100
  let max = 0
  for (const row of props.data.rows) {
    for (const v of row.values) {
      if (v !== null && Number.isFinite(v)) max = Math.max(max, v * props.data.scale)
    }
  }
  return max > 0 ? max : 1
})

// sonar ramp: idle cold abyss teal -> coral-red heat, light enough to
// glow on the dark background without washing out on white
function heatColor (r: number): string {
  return `hsl(${Math.round(190 - 190 * r)} ${Math.round(70 + 8 * r)}% ${Math.round(48 + 6 * r)}%)`
}

function colorFor (v: number | null): string | undefined {
  if (v === null || !Number.isFinite(v)) return undefined
  const r = Math.min(1, Math.max(0, (v * props.data.scale) / maxValue.value))
  return heatColor(r)
}

const legendGradient = computed(() => {
  const stops = Array.from({ length: 11 }, (_, i) => `${heatColor(i / 10)} ${i * 10}%`)
  return `linear-gradient(to right, ${stops.join(', ')})`
})

const ticks = computed(() => {
  const buckets = props.data.buckets
  if (buckets.length <= 2) return buckets.map(t => ({ t, label: '' }))
  const count = Math.min(6, buckets.length)
  const out: Array<{ t: number, label: string }> = []
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i * (buckets.length - 1)) / (count - 1))
    out.push({ t: buckets[idx]!, label: '' })
  }
  return out
})

function tickLabel (t: number): string {
  if (props.data.bucketMs >= 86_400_000) {
    return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })
  }
  const d = new Date(t)
  const day = d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })
  return `${day} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

// tooltip
const tip = ref<{ show: boolean, x: number, y: number, name: string, time: string, value: string }>({
  show: false, x: 0, y: 0, name: '', time: '', value: ''
})

function showTip (ev: MouseEvent, row: HeatmapRow, bucket: number, v: number | null) {
  tip.value = {
    show: true,
    x: Math.min(ev.clientX + 12, window.innerWidth - 220),
    y: ev.clientY + 14,
    name: row.name,
    time: tickLabel(bucket),
    value: v === null ? t('heatmap.noData') : `${fmtNum(v * props.data.scale)} ${props.data.unit}`
  }
}

function hideTip () {
  tip.value.show = false
}
</script>

<template>
  <div>
    <div class="overflow-x-auto pb-2">
      <div class="min-w-[640px] space-y-1">
        <div v-for="row in data.rows" :key="row.serverId" class="flex items-center gap-2">
          <NuxtLink
            :to="`/servers/${row.serverId}`"
            class="w-40 shrink-0 truncate text-sm font-medium hover:text-primary"
          >
            {{ row.name }}
          </NuxtLink>
          <div
            class="flex-1 grid gap-px"
            :style="{ gridTemplateColumns: `repeat(${data.buckets.length}, minmax(3px, 1fr))` }"
          >
            <div
              v-for="(v, i) in row.values"
              :key="i"
              class="h-7 rounded-[2px] cursor-default"
              :style="{ background: colorFor(v) ?? 'var(--ui-bg-accented)' }"
              @mouseenter="showTip($event, row, data.buckets[i]!, v)"
              @mousemove="showTip($event, row, data.buckets[i]!, v)"
              @mouseleave="hideTip"
            />
          </div>
        </div>

        <div class="flex items-center gap-2 pt-1">
          <div class="w-40 shrink-0" />
          <div class="flex-1 flex justify-between text-[10px] text-muted tabular-nums">
            <span v-for="(tick, i) in ticks" :key="i">{{ tickLabel(tick.t) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="flex items-center gap-2 mt-2 text-xs text-muted">
      <span>0</span>
      <div class="h-2 w-40 rounded-full" :style="{ background: legendGradient }" />
      <span>{{ fmtNum(maxValue) }} {{ data.unit }}</span>
      <span class="ml-3 opacity-70">{{ t('heatmap.emptyCell') }}</span>
    </div>

    <Teleport to="body">
      <div
        v-if="tip.show"
        class="fixed z-50 pointer-events-none rounded-md border border-default bg-elevated px-3 py-2 text-xs shadow-lg"
        :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
      >
        <div class="font-semibold">{{ tip.name }}</div>
        <div class="text-muted">{{ tip.time }}</div>
        <div class="tabular-nums">{{ data.metricLabel }}: <b>{{ tip.value }}</b></div>
      </div>
    </Teleport>
  </div>
</template>
