<script setup lang="ts">
interface Settings {
  scrapeIntervalS: number
  rollupIntervalS: number
  hourlyRetentionD: number
}

const { t } = useI18n()
const toast = useToast()

const { data, refresh } = useFetch<Settings>('/api/settings', {
  // forward cookies on the SSR-side call so the auth middleware lets it through
  headers: useRequestHeaders(['cookie'])
})

const form = reactive<Settings>({ scrapeIntervalS: 10, rollupIntervalS: 30, hourlyRetentionD: 400 })
watchEffect(() => {
  if (data.value) Object.assign(form, data.value)
})

const saving = ref(false)

async function save () {
  saving.value = true
  try {
    await $fetch('/api/settings', { method: 'PUT', body: { ...form } })
    await refresh()
    toast.add({ title: t('settings.toastSaved'), description: t('settings.toastApplied'), color: 'success' })
  } catch (err: unknown) {
    toast.add({
      title: t('settings.toastSaveFailed'),
      description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UCard variant="soft" class="bg-elevated/30">
    <form class="space-y-5" @submit.prevent="save">
      <UFormField :label="t('settings.scrape')" :help="t('settings.scrapeHelp')">
        <UInputNumber v-model="form.scrapeIntervalS" :min="2" :max="600" :step="1" class="w-40" />
      </UFormField>

      <UFormField :label="t('settings.rollup')" :help="t('settings.rollupHelp')">
        <UInputNumber v-model="form.rollupIntervalS" :min="5" :max="3600" :step="5" class="w-40" />
      </UFormField>

      <UFormField :label="t('settings.hourlyRetention')" :help="t('settings.hourlyRetentionHelp')">
        <UInputNumber v-model="form.hourlyRetentionD" :min="7" :max="3650" :step="1" class="w-40" />
      </UFormField>

      <div class="flex justify-end pt-2">
        <UButton type="submit" :loading="saving">
          {{ t('common.save') }}
        </UButton>
      </div>
    </form>
  </UCard>
</template>
