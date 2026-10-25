import { requireAdmin } from '../utils/auth'
import { loadConfig } from '../utils/config'
import { saveSettings, type Settings } from '../utils/db'
import { scheduleRollups, scheduleScrape } from '../utils/scheduler'

const LIMITS: Record<keyof Settings, [number, number]> = {
  scrapeIntervalS: [2, 600],
  rollupIntervalS: [5, 3600],
  hourlyRetentionD: [7, 3650]
}

// scheduling knobs are admin-only while auth is on (auth off = trusted LAN as before)
export default defineEventHandler(async (event) => {
  if (loadConfig().auth.enabled) requireAdmin(event)
  const body = await readBody<Partial<Settings>>(event)
  const patch: Partial<Settings> = {}
  for (const key of Object.keys(LIMITS) as Array<keyof Settings>) {
    const raw = body?.[key]
    if (raw === undefined || raw === null) continue
    const value = Number(raw)
    const [min, max] = LIMITS[key]!
    if (!Number.isFinite(value) || value < min || value > max) {
      throw createError({ statusCode: 400, statusMessage: `${key} must be between ${min} and ${max}` })
    }
    patch[key] = Math.round(value)
  }
  const settings = saveSettings(patch)
  scheduleScrape()
  scheduleRollups()
  return settings
})
