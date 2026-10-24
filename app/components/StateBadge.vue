<script setup lang="ts">
import type { LiveServer } from '../plugins/live'

const props = defineProps<{ server: LiveServer }>()
const { t } = useI18n()

const STATES: Record<string, { label: string, color: string, icon: string }> = {
  unloaded: { label: 'state.unloaded', color: 'neutral', icon: 'i-lucide-circle-dashed' },
  idle: { label: 'state.idle', color: 'info', icon: 'i-lucide-pause' },
  reading: { label: 'state.reading', color: 'warning', icon: 'i-lucide-download' },
  generating: { label: 'state.generating', color: 'success', icon: 'i-lucide-zap' }
}

const state = computed(() => {
  const snap = props.server.snapshot
  if (!snap || !snap.up) return null
  const entries = snap.metrics['strata:live_state'] ?? []
  const active = entries.find(([, v]) => v === 1)
  return active ? STATES[parseState(active[0])] ?? null : null
})

function parseState (labels: string): string {
  const m = /(?:^|,)state=([^,]+)/.exec(labels)
  return m?.[1] ?? ''
}
</script>

<template>
  <UBadge
    v-if="!server.enabled"
    color="neutral"
    variant="subtle"
    icon="i-lucide-ban"
    size="md"
  >
    {{ t('state.disabled') }}
  </UBadge>
  <UBadge
    v-else-if="state"
    :color="state.color as any"
    variant="subtle"
    :icon="state.icon"
    size="md"
  >
    {{ t(state.label) }}
  </UBadge>
  <UBadge
    v-else
    color="error"
    variant="subtle"
    icon="i-lucide-plug-zap"
    size="md"
  >
    {{ t('state.down') }}
  </UBadge>
</template>
