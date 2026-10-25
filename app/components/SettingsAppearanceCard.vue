<script setup lang="ts">
import type { Locale } from '#i18n'
import type { ThemeMode } from '~/utils/theme'

const { t, setLocale } = useI18n()
const { status } = useAuth()
const toast = useToast()

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
</script>

<template>
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
</template>
