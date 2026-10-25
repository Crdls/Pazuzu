<script setup lang="ts">
// GitLab sign-ins have no local password yet: the card turns into first-time setup
const { t } = useI18n()
const toast = useToast()
const { status } = useAuth()

const authed = computed(() => Boolean(status.value?.authEnabled && status.value?.user))
const hasPassword = computed(() => status.value?.user?.hasPassword !== false)

const pwd = reactive({ current: '', next: '', confirm: '' })
const pwdSaving = ref(false)
const pwdMismatch = computed(() => pwd.confirm.length > 0 && pwd.confirm !== pwd.next)

async function changePassword () {
  if (pwdSaving.value || pwdMismatch.value) return
  pwdSaving.value = true
  try {
    await $fetch('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: pwd.current, newPassword: pwd.next }
    })
    toast.add({ title: t('auth.toastPasswordChanged'), color: 'success' })
    pwd.current = ''
    pwd.next = ''
    pwd.confirm = ''
  } catch (err: unknown) {
    const e = err as { statusMessage?: string, statusCode?: number, status?: number }
    const code = e?.statusCode ?? e?.status
    toast.add({
      title: t('auth.toastPasswordFailed'),
      description: code === 401 ? t('auth.invalid') : e?.statusMessage ?? String(err),
      color: 'error'
    })
  } finally {
    pwdSaving.value = false
  }
}
</script>

<template>
  <UCard v-if="authed" variant="soft" class="bg-elevated/30">
    <h2 class="text-base font-semibold mb-1">{{ hasPassword ? t('auth.changePassword') : t('auth.setPassword') }}</h2>
    <p class="text-sm text-muted mb-4">{{ hasPassword ? t('auth.changePasswordHint') : t('auth.setPasswordHint') }}</p>
    <form class="space-y-5" @submit.prevent="changePassword">
      <UFormField v-if="hasPassword" :label="t('auth.currentPassword')">
        <UInput v-model="pwd.current" type="password" autocomplete="current-password" class="w-64" />
      </UFormField>

      <UFormField :label="t('auth.newPassword')" :help="t('auth.passwordHelp')">
        <UInput v-model="pwd.next" type="password" autocomplete="new-password" class="w-64" />
      </UFormField>

      <UFormField :label="t('auth.confirmNewPassword')">
        <UInput
          v-model="pwd.confirm"
          type="password"
          autocomplete="new-password"
          class="w-64"
          :color="pwdMismatch ? 'error' : undefined"
        />
        <p v-if="pwdMismatch" class="text-xs text-error mt-1">{{ t('auth.mismatch') }}</p>
      </UFormField>

      <div class="flex justify-end pt-2">
        <UButton type="submit" :loading="pwdSaving" :disabled="pwdMismatch">
          {{ hasPassword ? t('auth.changePassword') : t('auth.setPassword') }}
        </UButton>
      </div>
    </form>
  </UCard>
</template>
