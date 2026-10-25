import { requireAdmin } from '../utils/auth'
import { configPath, loadConfig, saveConfig, validateConfigInput } from '../utils/config'

// config.json writes are admin-only while auth is on; everything except the
// startup-only db.path takes effect immediately (saveConfig drops the cache)
export default defineEventHandler(async (event) => {
  if (loadConfig().auth.enabled) requireAdmin(event)
  const body = await readBody(event)
  const { errors, config } = validateConfigInput(body)
  if (errors.length > 0) {
    throw createError({ statusCode: 400, statusMessage: errors.join('; ') })
  }
  saveConfig(config)
  return { path: configPath(), exists: true, config: loadConfig() }
})
