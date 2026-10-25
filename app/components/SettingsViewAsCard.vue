<script setup lang="ts">
// view-as masking (per session): admins rehearse as plain users, superadmins
// as admins or users; gated on the real role so a masked admin can always
// come back, and the choice only ever lowers what the session can do
const { t } = useI18n()
const toast = useToast()
const { status, realIsAdmin, isMasked, switchViewAs } = useAuth()

const canChooseViewAs = computed(() =>
  Boolean(status.value?.authEnabled && status.value?.user) && (realIsAdmin.value || isMasked.value))
const viewAsChoice = ref<string>('self')
watch(status, (s) => {
  if (s?.user) viewAsChoice.value = s.user.role === s.user.realRole ? 'self' : s.user.role
}, { immediate: true })
const viewAsItems = computed(() => {
  const items: Array<{ value: string, label: string }> = [{ value: 'self', label: t('settings.viewAsNormal') }]
  if (status.value?.user?.realRole === 'superadmin') items.push({ value: 'admin', label: t('users.roleAdmin') })
  items.push({ value: 'user', label: t('users.roleUser') })
  return items
})

async function applyViewAs (value: string | number | null) {
  if (value === viewAsChoice.value) return
  const prev = viewAsChoice.value
  viewAsChoice.value = String(value)
  try {
    await switchViewAs(value === 'self' ? null : value as 'admin' | 'user')
  } catch (err: unknown) {
    viewAsChoice.value = prev
    toast.add({
      title: t('settings.toastSaveFailed'),
      description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
      color: 'error'
    })
  }
}
</script>

<template>
  <UCard v-if="canChooseViewAs" variant="soft" class="bg-elevated/30">
    <h2 class="text-base font-semibold mb-1">{{ t('settings.viewAsTitle') }}</h2>
    <p class="text-sm text-muted mb-4">{{ t('settings.viewAsHelp') }}</p>
    <UFormField :label="t('settings.viewAs')">
      <USelect :model-value="viewAsChoice" :items="viewAsItems" class="w-56" :aria-label="t('settings.viewAs')" @update:model-value="applyViewAs" />
    </UFormField>
  </UCard>
</template>
