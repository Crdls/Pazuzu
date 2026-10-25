import { requireSuperadmin } from '../utils/auth'
import { loadConfig } from '../utils/config'
import { storageStats } from '../utils/rollup'

// storage internals are superadmin-only while auth is on (auth off = trusted LAN as before)
export default defineEventHandler((event) => {
  if (loadConfig().auth.enabled) requireSuperadmin(event)
  return storageStats()
})
