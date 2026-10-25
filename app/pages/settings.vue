<script setup lang="ts">
// Settings is split into role-aware tabs: personal prefs for everyone,
// data collection for admins, config.json for superadmins, updates for all;
// each card lives in its own Settings*Card component.
const { t } = useI18n()
const { status, isAdmin, isSuperadmin } = useAuth()

// background intervals are an admin concern while auth is on
const canEditIntervals = computed(() => !status.value?.authEnabled || isAdmin.value)
const canEditConfig = computed(() => !status.value?.authEnabled || isSuperadmin.value)

const tabs = computed(() => {
  const items = [{ label: t('settings.tabPersonal'), value: 'personal', slot: 'personal' }]
  if (canEditIntervals.value) items.push({ label: t('settings.tabData'), value: 'data', slot: 'data' })
  if (canEditConfig.value) items.push({ label: t('settings.tabSystem'), value: 'system', slot: 'system' })
  items.push({ label: t('settings.tabUpdate'), value: 'update', slot: 'update' })
  return items
})

// the active tab lives in the URL (?tab=system) so sections can be linked directly
const route = useRoute()
const router = useRouter()
const tab = ref(typeof route.query.tab === 'string' ? route.query.tab : 'personal')
watch(tab, (value) => {
  if (import.meta.server) return
  router.replace({ query: { ...route.query, tab: value === 'personal' ? undefined : value } })
})
// a link to a tab the current role cannot see falls back to the first one
watch(tabs, (items) => {
  if (!items.some(i => i.value === tab.value)) tab.value = items[0].value
}, { immediate: true })
</script>

<template>
  <div class="max-w-2xl">
    <div class="mb-5">
      <h1 class="text-xl font-semibold">{{ t('settings.title') }}</h1>
    </div>

    <UTabs v-model="tab" :items="tabs">
      <template #personal>
        <div class="space-y-6 pt-5">
          <SettingsAppearanceCard />
          <SettingsViewAsCard />
          <SettingsPasswordCard />
        </div>
      </template>

      <template #data>
        <div class="pt-5">
          <p class="text-sm text-muted mb-4">{{ t('settings.description') }}</p>
          <SettingsIntervalsCard />
        </div>
      </template>

      <template #system>
        <div class="pt-5 space-y-6">
          <SettingsConfigCard />
          <SettingsStorageCard />
        </div>
      </template>

      <template #update>
        <div class="pt-5">
          <SettingsUpdateCard />
        </div>
      </template>
    </UTabs>
  </div>
</template>
