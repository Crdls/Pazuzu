<script setup lang="ts">
import type { Locale } from '#i18n'
import type { ThemeMode } from '~/utils/theme'

interface Settings {
  scrapeIntervalS: number
  rollupIntervalS: number
  rawRetentionH: number
  hourlyRetentionD: number
}

const { data, refresh } = useFetch<Settings>('/api/settings', {
  // forward cookies on the SSR-side call so the auth middleware lets it through
  headers: useRequestHeaders(['cookie'])
})
const toast = useToast()
const { t, setLocale } = useI18n()
const { status, isAdmin } = useAuth()

const authed = computed(() => Boolean(status.value?.authEnabled && status.value?.user))
// background intervals are an admin concern while auth is on
const canEditIntervals = computed(() => !status.value?.authEnabled || isAdmin.value)
// GitLab sign-ins have no local password yet: the card turns into first-time setup
const hasPassword = computed(() => status.value?.user?.hasPassword !== false)

const form = reactive<Settings>({ scrapeIntervalS: 10, rollupIntervalS: 30, rawRetentionH: 48, hourlyRetentionD: 400 })
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

// language names are shown in their own language on purpose
const localeItems = computed(() => [
  { value: 'auto', label: t('settings.languageAuto') },
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Русский' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'zh', label: '中文' }
])
const langModel = ref<string>(status.value?.user?.lang ?? 'auto')

async function onLangChange (value: string | number | null) {
  const lang = value === 'auto' || value === null ? null : String(value)
  // with a session the choice goes to the user record; with auth off this
  // 401s and only the locale cookie changes (the pre-login behavior)
  if (status.value?.authEnabled && status.value.user) {
    try {
      await $fetch('/api/auth/lang', { method: 'PUT', body: { lang } })
      status.value.user.lang = lang
      toast.add({ title: t('settings.toastSaved'), color: 'success' })
    } catch (err: unknown) {
      toast.add({
        title: t('settings.toastSaveFailed'),
        description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
        color: 'error'
      })
      return
    }
  }
  if (lang) {
    await setLocale(lang as Locale)
    return
  }
  // auto: drop the cookie and reload so i18n re-detects the browser language
  if (import.meta.client) {
    document.cookie = 'pazuzu_locale=; path=/; max-age=0'
    location.reload()
  }
}

// theme colors: write straight into appConfig (the Nuxt UI colors plugin
// regenerates the CSS variables) and persist the choice in localStorage
const appConfig = useAppConfig()
const accentColor = computed({
  get: () => appConfig.ui.colors.primary,
  set: (value: string) => {
    appConfig.ui.colors.primary = value
    storeTheme()
  }
})
const neutralColor = computed({
  get: () => appConfig.ui.colors.neutral,
  set: (value: string) => {
    appConfig.ui.colors.neutral = value
    storeTheme()
  }
})

// the signature accent is sold as a pair: picking it also sets its palette
function selectAccent (value: string) {
  accentColor.value = value
  if (value === 'abyss') neutralColor.value = 'abyssrock'
}

// color scheme: standard = built-in defaults, custom = the pickers below
const scheme = ref<ThemeMode>('standard')
onMounted(() => {
  scheme.value = storedThemeMode()
})
const schemeItems = computed(() => [
  { label: t('settings.colorSchemeStandard'), value: 'standard' },
  { label: t('settings.colorSchemeCustom'), value: 'custom' }
])
function selectScheme (mode: string) {
  scheme.value = mode as ThemeMode
  setThemeMode(mode as ThemeMode)
}

// version and self-update: anyone can check, applying is admin-only while auth is on
const { status: upd, refresh: refreshUpdate, checkNow } = useUpdate()
const canApply = computed(() =>
  (!status.value?.authEnabled || isAdmin.value) &&
  Boolean(upd.value?.currentSha) && Boolean(upd.value?.updateAvailable) &&
  !upd.value?.dev && !upd.value?.applying
)
const updateChecking = ref(false)
const applyOpen = ref(false)
const restarting = ref(false)
// only surface a failed autoupdate run; a successful one is visible in the version itself
const failedUpdate = computed(() => (upd.value?.lastUpdate && !upd.value.lastUpdate.ok ? upd.value.lastUpdate : null))

function fmtTime (ms: number) {
  return new Date(ms).toLocaleString()
}

async function checkUpdate () {
  if (updateChecking.value) return
  updateChecking.value = true
  try {
    await checkNow()
  } catch (err: unknown) {
    toast.add({
      title: t('update.toastCheckFailed'),
      description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
      color: 'error'
    })
  } finally {
    updateChecking.value = false
  }
}

async function runUpdate () {
  const from = upd.value?.currentSha ?? ''
  const startedAt = Date.now()
  applyOpen.value = false
  try {
    await $fetch('/api/update/apply', { method: 'POST' })
  } catch (err: unknown) {
    toast.add({
      title: t('update.toastApplyFailed'),
      description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
      color: 'error'
    })
    return
  }
  // the server exits for the rebuild - poll until the new build answers
  restarting.value = true
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    try {
      const st = await $fetch<{
        currentSha: string | null
        lastUpdate: { startedAt: number, ok: boolean, step: string | null } | null
      }>('/api/update/status')
      if (st.currentSha && st.currentSha !== from) {
        toast.add({ title: t('update.backOnline', { version: shortVersion(st.currentSha) }), color: 'success' })
        setTimeout(() => location.reload(), 1200)
        return
      }
      // the same build came back: the updater finished but gave up on a step
      if (st.lastUpdate && st.lastUpdate.startedAt >= startedAt - 60_000 && !st.lastUpdate.ok) {
        restarting.value = false
        toast.add({ title: t('update.lastFailed', { step: st.lastUpdate.step ?? '?' }), color: 'error' })
        await refreshUpdate()
        return
      }
    } catch { /* still restarting */ }
  }
  restarting.value = false
  toast.add({ title: t('update.restartTimeout'), color: 'error' })
}
</script>

<template>
  <div class="max-w-2xl">
    <div class="mb-5">
      <h1 class="text-xl font-semibold">{{ t('settings.title') }}</h1>
      <p v-if="canEditIntervals" class="text-sm text-muted mt-0.5">{{ t('settings.description') }}</p>
    </div>

    <UCard variant="soft" class="bg-elevated/30">
      <h2 class="text-base font-semibold mb-1">{{ t('settings.appearance') }}</h2>
      <p class="text-sm text-muted mb-4">{{ t('settings.appearanceHelp') }}</p>
      <div class="space-y-5">
        <UFormField :label="t('settings.colorMode')">
          <UColorModeSelect class="w-48" :aria-label="t('settings.appearance')" />
        </UFormField>

        <UFormField :label="t('settings.language')" :help="t('settings.languageHelp')">
          <USelect v-model="langModel" :items="localeItems" class="w-48" :aria-label="t('settings.language')" @update:model-value="onLangChange" />
        </UFormField>

        <UFormField :label="t('settings.colorScheme')" :help="t('settings.colorSchemeHelp')">
          <USelect :model-value="scheme" :items="schemeItems" class="w-48" :aria-label="t('settings.colorScheme')" @update:model-value="selectScheme" />
        </UFormField>

        <template v-if="scheme === 'custom'">
          <UFormField :label="t('settings.accentColor')">
            <div class="flex flex-wrap gap-2.5">
              <button
                v-for="s in primarySwatches"
                :key="s.value"
                type="button"
                class="size-6 rounded-full transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-primary"
                :class="[s.class, accentColor === s.value ? 'ring-2 ring-offset-2 ring-offset-elevated ring-primary' : '']"
                :aria-label="t(`settings.themeColor.${s.value}`)"
                :aria-pressed="accentColor === s.value"
                @click="selectAccent(s.value)"
              />
            </div>
          </UFormField>

          <UFormField :label="t('settings.neutralPalette')">
            <div class="flex flex-wrap gap-2.5">
              <button
                v-for="s in neutralSwatches"
                :key="s.value"
                type="button"
                class="size-6 rounded-full transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-primary"
                :class="[s.class, neutralColor === s.value ? 'ring-2 ring-offset-2 ring-offset-elevated ring-primary' : '']"
                :aria-label="t(`settings.themeColor.${s.value}`)"
                :aria-pressed="neutralColor === s.value"
                @click="neutralColor = s.value"
              />
            </div>
          </UFormField>
        </template>
      </div>
    </UCard>

    <UCard v-if="canEditIntervals" variant="soft" class="mt-6 bg-elevated/30">
      <form class="space-y-5" @submit.prevent="save">
        <UFormField :label="t('settings.scrape')" :help="t('settings.scrapeHelp')">
          <UInputNumber v-model="form.scrapeIntervalS" :min="2" :max="600" :step="1" class="w-40" />
        </UFormField>

        <UFormField :label="t('settings.rollup')" :help="t('settings.rollupHelp')">
          <UInputNumber v-model="form.rollupIntervalS" :min="5" :max="3600" :step="5" class="w-40" />
        </UFormField>

        <UFormField :label="t('settings.rawRetention')" :help="t('settings.rawRetentionHelp')">
          <UInputNumber v-model="form.rawRetentionH" :min="1" :max="720" :step="1" class="w-40" />
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

    <UCard v-if="authed" variant="soft" class="mt-6 bg-elevated/30">
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

    <UCard variant="soft" class="mt-6 bg-elevated/30">
      <h2 class="text-base font-semibold mb-1">{{ t('update.title') }}</h2>
      <p class="text-sm text-muted mb-4">{{ t('update.description') }}</p>

      <div class="space-y-3">
        <div class="flex flex-wrap items-center gap-2 text-sm font-mono">
          <span class="text-muted">{{ upd?.branch ?? '?' }} · {{ shortVersion(upd?.currentSha) }}</span>
          <UIcon name="i-lucide-arrow-right" class="size-3.5 text-dimmed" />
          <span :class="upd?.updateAvailable ? 'text-warning font-semibold' : 'text-muted'">
            {{ upd?.latestSha ? shortVersion(upd.latestSha) : '…' }}
          </span>
          <UBadge v-if="upd && !upd.currentSha" color="neutral" variant="subtle" :label="t('update.notGit')" />
          <UBadge v-else-if="upd?.updateAvailable" color="warning" variant="subtle" :label="t('update.updateAvailable')" />
          <UBadge v-else-if="upd?.error" color="error" variant="subtle" :label="t('update.checkFailed')" />
          <UBadge v-else-if="upd?.checkedAt" color="success" variant="subtle" :label="t('update.upToDate')" />
        </div>

        <p class="text-xs text-dimmed">
          <span v-if="upd?.checkedAt">{{ t('update.checkedAt', { time: fmtTime(upd.checkedAt) }) }}</span>
          <span v-else>{{ t('update.neverChecked') }}</span>
          <a
            v-if="upd?.compareUrl"
            :href="upd.compareUrl"
            target="_blank"
            rel="noopener"
            class="ml-2 text-primary hover:underline"
          >{{ t('update.compare') }}</a>
        </p>

        <p v-if="upd && !upd.currentSha" class="text-xs text-dimmed">{{ t('update.notGit') }}</p>
        <p v-else-if="upd?.dev" class="text-xs text-dimmed">{{ t('update.devMode') }}</p>
        <p v-if="failedUpdate" class="text-xs text-error">
          {{ t('update.lastFailed', { step: failedUpdate.step ?? '?' }) }}
        </p>

        <div class="flex items-center gap-2 pt-1">
          <UButton
            v-if="upd?.currentSha"
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-refresh-cw"
            :loading="updateChecking || upd?.checking"
            :disabled="upd?.applying"
            @click="checkUpdate"
          >
            {{ t('update.check') }}
          </UButton>
          <UButton v-if="canApply" size="sm" icon="i-lucide-download" @click="applyOpen = true">
            {{ t('update.apply') }}
          </UButton>
          <span v-if="restarting" class="text-xs text-muted inline-flex items-center gap-1.5">
            <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
            {{ t('update.restarting') }}
          </span>
        </div>
      </div>
    </UCard>

    <!-- update confirm: the server pulls, rebuilds and restarts itself -->
    <UModal v-model:open="applyOpen" :title="t('update.applyTitle')">
      <template #body>
        <p class="text-sm">{{ t('update.applyText') }}</p>
        <div class="flex justify-end gap-2 pt-4">
          <UButton color="neutral" variant="ghost" @click="applyOpen = false">
            {{ t('common.cancel') }}
          </UButton>
          <UButton @click="runUpdate">
            {{ t('update.applyConfirm') }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
