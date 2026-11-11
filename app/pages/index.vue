<script setup lang="ts">
import { fmtDate } from '../utils/format'

const { servers, ready, refresh } = useLive()
const { t } = useI18n()
const { status, isAdmin } = useAuth()
// the quick-add row replaces the old page title; visibility mirrors the sidebar
const showClients = computed(() => !status.value?.authEnabled || isAdmin.value)
const showUsers = computed(() => Boolean(status.value?.authEnabled && isAdmin.value))

// last successful scrape across all servers, shown in the header next to the
// manual refresh (`hh:mm:ss`, gaining a `dd.mm.yy` prefix once the data is
// older than 4 h or not from today)
const now = useNow()
const updatedLabel = computed(() => {
  let ts = 0
  for (const s of servers.value) {
    const snap = s.snapshot
    if (snap?.up && snap.ts && snap.ts > ts) ts = snap.ts
  }
  if (!ts) return null
  const time = new Date(ts).toLocaleTimeString('en-GB', { hour12: false })
  const stale = now.value - ts > 4 * 3600_000
  const otherDay = new Date(ts).toDateString() !== new Date(now.value).toDateString()
  return stale || otherDay ? `${fmtDate(ts)} ${time}` : time
})

const refreshing = ref(false)
async function refreshNow () {
  if (refreshing.value) return
  refreshing.value = true
  try {
    // kick an immediate scrape, then pull the fresh snapshots over HTTP - the
    // button must update the data even when the WS push is slow or blocked
    await $fetch('/api/live/refresh', { method: 'POST' })
    await refresh()
  } finally {
    refreshing.value = false
  }
}
</script>

<template>
  <div>
    <div class="flex items-center flex-wrap gap-2 mb-5">
      <UButton to="/servers?add=1" color="neutral" variant="outline" icon="i-lucide-plus" class="shrink-0">
        {{ t('common.addServer') }}
      </UButton>
      <UButton v-if="showClients" to="/clients?add=1" color="neutral" variant="outline" icon="i-lucide-plus" class="shrink-0">
        {{ t('clients.add') }}
      </UButton>
      <UButton v-if="showUsers" to="/users?add=1" color="neutral" variant="outline" icon="i-lucide-plus" class="shrink-0">
        {{ t('users.add') }}
      </UButton>
      <div class="ml-auto flex items-center gap-2 pl-2">
        <span v-if="updatedLabel" class="text-xs tabular-nums text-muted">{{ t('dashboard.updated', { v: updatedLabel }) }}</span>
        <UButton color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="refreshing" class="shrink-0" @click="refreshNow">
          {{ t('dashboard.refresh') }}
        </UButton>
      </div>
    </div>

    <div v-if="!ready" class="flex items-center justify-center py-20">
      <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-muted" />
    </div>

    <div v-else-if="servers.length === 0" class="flex flex-col items-center justify-center py-20 text-center">
      <AbyssEyes class="size-12 mb-4" />
      <h2 class="text-lg font-semibold mb-1">{{ t('dashboard.emptyTitle') }}</h2>
      <p class="text-sm text-muted mb-4 max-w-md">
        {{ t('dashboard.emptyText') }}
      </p>
      <UButton to="/servers?add=1" icon="i-lucide-plus">{{ t('dashboard.cta') }}</UButton>
    </div>

    <!-- two cards per row; three per row from 1500px up (scoped rule below:
         custom Tailwind breakpoints (`min-[Xpx]`, named theme ones) sort
         before `md:` in this dev bundle, so a utility class cannot win) -->
    <div v-else class="cards-grid grid gap-4 md:grid-cols-2">
      <ServerCard v-for="server in servers" :key="server.id" :server="server" />
    </div>
  </div>
</template>

<style scoped>
@media (min-width: 1500px) {
  .cards-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
