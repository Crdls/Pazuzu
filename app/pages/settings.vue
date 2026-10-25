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

// config.json (system configuration): admin-only card, values apply on save
interface ConfigFile {
  path: string
  exists: boolean
  config: {
    db: { path: string }
    auth: {
      enabled: boolean
      gitlab: {
        enabled: boolean
        baseUrl: string
        clientId: string
        clientSecret: string
        redirectUri: string
        allowedGroups: string[]
        caCert: string
        insecureTls: boolean
      }
    }
    gateway: {
      enabled: boolean
      queueTimeoutS: number
      queueMax: number
      queueMaxPerClient: number
      sessionIdleMin: number
      defaultCapacity: number
      ejectionS: number
    }
  }
}

const canEditConfig = computed(() => !status.value?.authEnabled || isAdmin.value)
// lazy: admins (or anyone while auth is off) pull the file client-side, so
// non-admin users never fire a request that would only 403
const { data: cfgFile, refresh: refreshCfg } = useFetch<ConfigFile>('/api/config', { immediate: false })
if (canEditConfig.value) refreshCfg()

const cfg = reactive({
  dbPath: '',
  authEnabled: false,
  gitlab: { enabled: false, baseUrl: '', clientId: '', clientSecret: '', redirectUri: '', groups: '', caCert: '', insecureTls: false },
  gw: { enabled: false, queueTimeoutS: 60, queueMax: 200, queueMaxPerClient: 20, sessionIdleMin: 60, defaultCapacity: 32, ejectionS: 30 }
})
watch(cfgFile, (f) => {
  if (!f) return
  const gl = f.config.auth.gitlab
  cfg.dbPath = f.config.db.path
  cfg.authEnabled = f.config.auth.enabled
  Object.assign(cfg.gitlab, {
    enabled: gl.enabled,
    baseUrl: gl.baseUrl,
    clientId: gl.clientId,
    clientSecret: gl.clientSecret,
    redirectUri: gl.redirectUri,
    caCert: gl.caCert,
    insecureTls: gl.insecureTls,
    groups: gl.allowedGroups.join(', ')
  })
  Object.assign(cfg.gw, f.config.gateway)
})

const cfgSaving = ref(false)

async function saveCfg () {
  cfgSaving.value = true
  try {
    await $fetch('/api/config', {
      method: 'PUT',
      body: {
        db: { path: cfg.dbPath },
        auth: {
          enabled: cfg.authEnabled,
          gitlab: {
            enabled: cfg.gitlab.enabled,
            baseUrl: cfg.gitlab.baseUrl,
            clientId: cfg.gitlab.clientId,
            clientSecret: cfg.gitlab.clientSecret,
            redirectUri: cfg.gitlab.redirectUri,
            allowedGroups: cfg.gitlab.groups.split(',').map(s => s.trim()).filter(s => s !== ''),
            caCert: cfg.gitlab.caCert,
            insecureTls: cfg.gitlab.insecureTls
          }
        },
        gateway: { ...cfg.gw }
      }
    })
    await refreshCfg()
    toast.add({ title: t('settings.toastSaved'), description: t('config.toastApplied'), color: 'success' })
  } catch (err: unknown) {
    toast.add({
      title: t('settings.toastSaveFailed'),
      description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
      color: 'error'
    })
  } finally {
    cfgSaving.value = false
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
// (canApply / restarting / applyUpdate live in the shared useUpdate composable)
const { status: upd, checkNow, canApply, restarting, applyUpdate } = useUpdate()
const updateChecking = ref(false)
const applyOpen = ref(false)
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

    <UCard v-if="canEditConfig && cfgFile" variant="soft" class="mt-6 bg-elevated/30">
      <div class="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 class="text-base font-semibold">{{ t('config.title') }}</h2>
        <span class="font-mono text-xs text-dimmed">
          {{ cfgFile.path }}
          <span v-if="!cfgFile.exists">· {{ t('config.fileMissing') }}</span>
        </span>
      </div>
      <p class="text-sm text-muted mb-4">{{ t('config.description') }}</p>

      <form class="space-y-5" @submit.prevent="saveCfg">
        <UFormField :label="t('config.dbPath')" :help="t('config.dbPathHelp')">
          <UInput v-model="cfg.dbPath" class="w-full max-w-md" :ui="{ base: 'font-mono' }" />
        </UFormField>

        <div>
          <h3 class="mb-3 text-sm font-semibold">{{ t('config.auth') }}</h3>
          <div class="space-y-5">
            <UFormField :label="t('config.authEnabled')" :help="t('config.authEnabledHelp')">
              <USwitch v-model="cfg.authEnabled" size="sm" />
            </UFormField>

            <UFormField :label="t('config.gitlabEnabled')" :help="t('config.gitlabHelp')">
              <USwitch v-model="cfg.gitlab.enabled" size="sm" />
            </UFormField>

            <UFormField :label="t('config.gitlabBaseUrl')">
              <UInput v-model="cfg.gitlab.baseUrl" placeholder="http://gitlab.lan" class="w-full max-w-md" />
            </UFormField>

            <UFormField :label="t('config.gitlabClientId')">
              <UInput v-model="cfg.gitlab.clientId" class="w-full max-w-md" />
            </UFormField>

            <UFormField :label="t('config.gitlabClientSecret')">
              <UInput v-model="cfg.gitlab.clientSecret" class="w-full max-w-md" />
            </UFormField>

            <UFormField :label="t('config.gitlabRedirect')" :help="t('config.gitlabRedirectHelp')">
              <UInput v-model="cfg.gitlab.redirectUri" placeholder="http://<host>:3003/api/auth/gitlab/callback" class="w-full max-w-md font-mono" />
            </UFormField>

            <UFormField :label="t('config.gitlabGroups')" :help="t('config.gitlabGroupsHelp')">
              <UInput v-model="cfg.gitlab.groups" placeholder="ops, sre" class="w-full max-w-md" />
            </UFormField>

            <UFormField :label="t('config.gitlabCaCert')" :help="t('config.gitlabCaHelp')">
              <UInput v-model="cfg.gitlab.caCert" class="w-full max-w-md font-mono" />
            </UFormField>

            <UFormField :label="t('config.gitlabInsecure')" :help="t('config.gitlabInsecureHelp')">
              <USwitch v-model="cfg.gitlab.insecureTls" size="sm" />
            </UFormField>
          </div>
        </div>

        <div>
          <h3 class="mb-3 text-sm font-semibold">{{ t('config.gateway') }}</h3>
          <div class="space-y-5">
            <UFormField :label="t('config.gatewayEnabled')" :help="t('config.gatewayHelp')">
              <USwitch v-model="cfg.gw.enabled" size="sm" />
            </UFormField>

            <UFormField :label="t('config.queueTimeout')" :help="t('config.queueTimeoutHelp')">
              <UInputNumber v-model="cfg.gw.queueTimeoutS" :min="1" :max="3600" :step="1" class="w-40" />
            </UFormField>

            <UFormField :label="t('config.queueMax')" :help="t('config.queueMaxHelp')">
              <UInputNumber v-model="cfg.gw.queueMax" :min="1" :max="10000" :step="1" class="w-40" />
            </UFormField>

            <UFormField :label="t('config.queueMaxPerClient')" :help="t('config.queueMaxPerClientHelp')">
              <UInputNumber v-model="cfg.gw.queueMaxPerClient" :min="1" :max="1000" :step="1" class="w-40" />
            </UFormField>

            <UFormField :label="t('config.sessionIdle')" :help="t('config.sessionIdleHelp')">
              <UInputNumber v-model="cfg.gw.sessionIdleMin" :min="1" :max="43200" :step="1" class="w-40" />
            </UFormField>

            <UFormField :label="t('config.defaultCapacity')" :help="t('config.defaultCapacityHelp')">
              <UInputNumber v-model="cfg.gw.defaultCapacity" :min="1" :max="4096" :step="1" class="w-40" />
            </UFormField>

            <UFormField :label="t('config.ejection')" :help="t('config.ejectionHelp')">
              <UInputNumber v-model="cfg.gw.ejectionS" :min="1" :max="3600" :step="1" class="w-40" />
            </UFormField>
          </div>
        </div>

        <div class="flex justify-end pt-2">
          <UButton type="submit" :loading="cfgSaving">
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
          <UButton @click="applyOpen = false; applyUpdate()">
            {{ t('update.applyConfirm') }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
