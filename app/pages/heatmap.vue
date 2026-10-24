<script setup lang="ts">
import type { HeatmapData } from '../components/LoadHeatmap.vue'

const { t, te } = useI18n()

// view settings persist in cookies, so the saved period/metric is already
// used on the SSR render of the next visit
const YEAR = 60 * 60 * 24 * 365
const period = useCookie<string>('pazuzu_heatmap_period', {
  default: () => '24h',
  maxAge: YEAR
})
const metric = useCookie<string>('pazuzu_heatmap_metric', {
  default: () => 'strata:gpu_util',
  maxAge: YEAR
})

const { data, pending, error } = await useFetch<HeatmapData>('/api/heatmap', {
  query: { period, metric },
  watch: [period, metric],
  // forward cookies on the SSR-side call so the auth middleware lets it through
  headers: useRequestHeaders(['cookie'])
})

// the saved metric may no longer be in the catalog (e.g. after an update)
function validateMetric () {
  const available = data.value?.availableMetrics
  if (!available?.length || available.some(m => m.value === metric.value)) return
  const fallback = available.find(m => m.value === 'strata:gpu_util') ?? available[0]!
  metric.value = fallback.value
}
onMounted(validateMetric)
watch(data, validateMetric)

const periodItems = computed(() => [
  { label: t('heatmap.period1h'), value: '1h' },
  { label: t('heatmap.period3h'), value: '3h' },
  { label: t('heatmap.period12h'), value: '12h' },
  { label: t('heatmap.period24h'), value: '24h' },
  { label: t('heatmap.period7d'), value: '7d' },
  { label: t('heatmap.period30d'), value: '30d' },
  { label: t('heatmap.period1y'), value: '1y' }
])

const metricItems = computed(() =>
  (data.value?.availableMetrics ?? []).map(m => ({
    label: te(`metric.${m.value}`) ? t(`metric.${m.value}`) : (m.unit ? `${m.label} (${m.unit})` : m.label),
    value: m.value
  }))
)
</script>

<template>
  <div>
    <div class="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div>
        <h1 class="text-xl font-semibold">{{ t('heatmap.title') }}</h1>
        <p class="text-sm text-muted mt-0.5">
          {{ t('heatmap.subtitle') }}
        </p>
      </div>
      <div class="flex items-center gap-2">
        <USelect v-model="metric" :items="metricItems" class="w-56" size="sm" />
        <USelect v-model="period" :items="periodItems" class="w-40" size="sm" />
      </div>
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('heatmap.errorTitle')"
      :description="String(error.statusMessage ?? error)"
      class="mb-4"
    />

    <UCard variant="soft" class="bg-elevated/30">
      <div v-if="pending && !data" class="h-40 flex items-center justify-center">
        <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-muted" />
      </div>
      <LoadHeatmap v-else-if="data && data.rows.length" :data="data" />
      <div v-else class="py-12 text-center text-sm text-muted">
        {{ t('heatmap.empty') }}
      </div>
    </UCard>
  </div>
</template>
