import { requireSuperadmin } from '../../utils/auth'
import { loadConfig } from '../../utils/config'
import { cleanupNow } from '../../utils/rollup'

// out-of-band cleanup (rollups + full thinning + VACUUM) is superadmin-only while auth is on
export default defineEventHandler((event) => {
  if (loadConfig().auth.enabled) requireSuperadmin(event)
  return cleanupNow()
})
