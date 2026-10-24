<script setup lang="ts">
const { servers, ready } = useLive()
const { t } = useI18n()
const { status, isAdmin } = useAuth()
// the quick-add row replaces the old page title; visibility mirrors the sidebar
const showClients = computed(() => !status.value?.authEnabled || isAdmin.value)
const showUsers = computed(() => Boolean(status.value?.authEnabled && isAdmin.value))
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

    <div v-else class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <ServerCard v-for="server in servers" :key="server.id" :server="server" />
    </div>
  </div>
</template>
