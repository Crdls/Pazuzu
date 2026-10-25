import { requireSuperadmin } from '../utils/auth'
import { configPath, loadConfig, readConfigText } from '../utils/config'

// config.json is superadmin-only while auth is on (auth off = trusted LAN as before)
export default defineEventHandler((event) => {
  if (loadConfig().auth.enabled) requireSuperadmin(event)
  return { path: configPath(), exists: readConfigText() !== null, config: loadConfig() }
})
