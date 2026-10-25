<script setup lang="ts">
// database maintenance: size and row counts plus the manual cleanup button
// (rollups + full thinning + VACUUM) - superadmin-only, like the config card
interface StorageStats {
  dbBytes: number
  freelistBytes: number
  samples: number
  hourly: number
  daily: number
  lastVacuumTs: number
}

interface CleanupReport {
  rowsRemoved: number
  bytesBefore: number
  bytesAfter: number
}

const { t } = useI18n()
const toast = useToast()
const { status, isSuperadmin } = useAuth()

const canManageStorage = computed(() => !status.value?.authEnabled || isSuperadmin.value)
// lazy: only those who can see the results pull the stats, so lower roles
// never fire a request that would only 403
const { data: stats, refresh } = useFetch<StorageStats>('/api/storage', { immediate: false })
if (canManageStorage.value) refresh()

function mb (bytes: number): string {
  return (bytes / 1024 / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })
}

function num (n: number): string {
  return n.toLocaleString('en-US')
}

const cleaning = ref(false)

async function clean () {
  cleaning.value = true
  try {
    const report = await $fetch<CleanupReport>('/api/storage/cleanup', { method: 'POST' })
    await refresh()
    toast.add({
      title: t('storage.toastCleaned'),
      description: t('storage.toastFreed', { mb: mb(Math.max(0, report.bytesBefore - report.bytesAfter)) }),
      color: 'success'
    })
  } catch (err: unknown) {
    toast.add({
      title: t('storage.toastCleanFailed'),
      description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
      color: 'error'
    })
  } finally {
    cleaning.value = false
  }
}
</script>

<template>
  <UCard v-if="canManageStorage" variant="soft" class="bg-elevated/30">
    <template #header>
      <h3 class="text-sm font-semibold">{{ t('storage.title') }}</h3>
      <p class="mt-1 text-xs text-muted">{{ t('storage.description') }}</p>
    </template>

    <dl class="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
      <div>
        <dt class="text-xs text-muted">{{ t('storage.dbSize') }}</dt>
        <dd class="font-medium">{{ stats ? `${mb(stats.dbBytes)} MB` : '—' }}</dd>
      </div>
      <div>
        <dt class="text-xs text-muted">{{ t('storage.samples') }}</dt>
        <dd class="font-medium">{{ stats ? num(stats.samples) : '—' }}</dd>
      </div>
      <div>
        <dt class="text-xs text-muted">{{ t('storage.hourly') }}</dt>
        <dd class="font-medium">{{ stats ? num(stats.hourly) : '—' }}</dd>
      </div>
      <div>
        <dt class="text-xs text-muted">{{ t('storage.daily') }}</dt>
        <dd class="font-medium">{{ stats ? num(stats.daily) : '—' }}</dd>
      </div>
      <div class="col-span-2">
        <dt class="text-xs text-muted">{{ t('storage.lastVacuum') }}</dt>
        <dd class="font-medium">
          <span v-if="stats && stats.lastVacuumTs > 0">{{ new Date(stats.lastVacuumTs).toLocaleString() }}</span>
          <span v-else>{{ t('storage.never') }}</span>
        </dd>
      </div>
    </dl>

    <div class="mt-5 flex flex-wrap items-center justify-between gap-3">
      <p class="max-w-md text-xs text-muted">{{ t('storage.cleanHelp') }}</p>
      <UButton color="neutral" variant="outline" :loading="cleaning" @click="clean">
        {{ t('storage.clean') }}
      </UButton>
    </div>
  </UCard>
</template>
