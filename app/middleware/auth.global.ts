import type { Locale } from '#i18n'
import { roleRank, useAuth } from '../composables/useAuth'

// auth is opt-in (config.json): with auth disabled this passes everything through
export default defineNuxtRouteMiddleware(async (to) => {
  const { load } = useAuth()
  // vue-i18n's useI18n() needs a component setup scope; the global composer
  // on the nuxt app works from route middleware (also during SSR)
  const i18n = useNuxtApp().$i18n
  const status = await load()
  // a language saved on the account wins over the locale cookie and the
  // browser; null (auto) leaves i18n detection alone
  const savedLang = status?.user?.lang ?? null
  if (savedLang && i18n.locale.value !== savedLang) await i18n.setLocale(savedLang as Locale)
  if (!status || !status.authEnabled) {
    if (to.path === '/login' || to.path === '/users') return navigateTo('/')
    return undefined
  }
  if (status.user) {
    if (to.path === '/login') return navigateTo('/')
    // the user table is admin-only (the API enforces it too)
    if (to.path === '/users' && roleRank(status.user.role) < roleRank('admin')) return navigateTo('/')
    return undefined
  }
  if (to.path !== '/login') return navigateTo('/login')
})
