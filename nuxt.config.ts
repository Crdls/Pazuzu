export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@nuxtjs/i18n'],
  css: ['~/assets/css/main.css'],
  devServer: {
    port: 3333
  },
  nitro: {
    // native module must not be bundled
    external: ['better-sqlite3'],
    experimental: {
      // enable WebSocket route wiring in the node server (/_ws)
      websocket: true
    },
    // workaround for nuxt#36467 (Windows): force-inline the Nuxt renderer,
    // otherwise Nitro externals matching fails on backslash paths -> SSR 500
    externals: {
      inline: [/[\\/]node_modules[\\/]nuxt[\\/]dist[\\/]/]
    }
  },
  ui: {
    // system fonts, no network fetch at build time
    fonts: false
  },
  i18n: {
    strategy: 'no_prefix',
    defaultLocale: 'en',
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'pazuzu_locale',
      fallbackLocale: 'en'
    },
    locales: [
      { code: 'en', language: 'en-US', file: 'en.json', name: 'English' },
      { code: 'ru', language: 'ru-RU', file: 'ru.json', name: 'Русский' },
      { code: 'de', language: 'de-DE', file: 'de.json', name: 'Deutsch' },
      { code: 'es', language: 'es-ES', file: 'es.json', name: 'Español' },
      { code: 'fr', language: 'fr-FR', file: 'fr.json', name: 'Français' },
      { code: 'zh', language: 'zh-CN', file: 'zh.json', name: '中文' }
    ]
  },
  devtools: { enabled: false },
  typescript: { strict: true },
  compatibilityDate: '2026-10-09'
})
