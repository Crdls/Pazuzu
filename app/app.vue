<script setup lang="ts">
import { de, en, es, fr, ru, zh_cn } from '@nuxt/ui/locale'

useHead({
  titleTemplate: (title?: string | null) => (title ? `${title} · Pazuzu` : 'Pazuzu'),
  link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }]
})

// keep Nuxt UI internal strings (modal close, select, input number, ...)
// in sync with the selected app locale
const { locale } = useI18n()
const uiLocales: Record<string, typeof en> = { en, ru, de, es, fr, zh: zh_cn }
const uiLocale = computed(() => uiLocales[locale.value] ?? en)
</script>

<template>
  <UApp :locale="uiLocale">
    <NuxtLayout>
      <!-- fade class pair lives in assets/css/main.css -->
      <NuxtPage :page-transition="{ name: 'fade' }" />
    </NuxtLayout>
  </UApp>
</template>
