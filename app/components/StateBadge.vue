<script setup lang="ts">
import type { LiveServer } from '../plugins/live'
import { fmtNum } from '../utils/format'

const props = defineProps<{ server: LiveServer }>()
const { t } = useI18n()

// linear status plate: icon, stage name and speed on one line - a borderless
// tinted background says which stage it is; it stretches to the height of the
// server-name button next to it
const THEME: Record<string, { label: string, icon: string, cls: string }> = {
  unloaded: { label: 'state.unloaded', icon: 'i-lucide-circle-dashed', cls: 'text-muted bg-elevated' },
  idle: { label: 'state.idle', icon: 'i-lucide-pause', cls: 'text-info bg-info/10' },
  reading: { label: 'state.reading', icon: 'i-lucide-download', cls: 'text-warning bg-warning/10' },
  generating: { label: 'state.generating', icon: 'i-lucide-zap', cls: 'text-success bg-success/10' }
}
const DISABLED = { label: 'state.disabled', icon: 'i-lucide-ban', cls: 'text-muted bg-elevated' }
const DOWN = { label: 'state.down', icon: 'i-lucide-plug-zap', cls: 'text-error bg-error/10' }

const stateKey = computed(() => {
  const snap = props.server.snapshot
  if (!snap || !snap.up) return null
  const entries = snap.metrics['strata:live_state'] ?? []
  const active = entries.find(([, v]) => v === 1)
  return active ? parseState(active[0]) : null
})

function parseState (labels: string): string {
  const m = /(?:^|,)state=([^,]+)/.exec(labels)
  return m?.[1] ?? ''
}

const plate = computed(() => {
  if (!props.server.enabled) return DISABLED
  return stateKey.value ? THEME[stateKey.value] ?? DOWN : DOWN
})

// same stage rule as the stat plates: prefill rate while reading,
// generation rate otherwise; null when the engine gives no reading
const speed = computed(() => {
  const metrics = props.server.snapshot?.up ? props.server.snapshot.metrics : null
  if (!metrics) return null
  const key = stateKey.value === 'reading' ? 'strata:live_prefill_tok_s_mean' : 'strata:live_tok_s'
  const v = metrics[key]?.[0]?.[1]
  return v === undefined ? null : fmtNum(v)
})
</script>

<template>
  <div class="rounded-md px-2.5 py-1.5 flex items-center gap-2 min-w-0 h-full" :class="plate.cls">
    <UIcon :name="plate.icon" class="size-4 shrink-0" />
    <span class="text-[10px] uppercase tracking-wide truncate">{{ t(plate.label) }}</span>
    <span v-if="speed !== null" class="ml-auto text-lg font-semibold tabular-nums whitespace-nowrap">{{ speed }}<span class="text-sm font-normal opacity-70">&nbsp;tok/s</span></span>
  </div>
</template>
