import { getSettings } from './db'
import { runtime } from './runtime'
import { scrapeAll } from './scrape'
import { runRollups } from './rollup'

/**
 * Self-rescheduling loops: the next delay is read from settings every cycle,
 * so interval changes apply without a restart. `schedule*` is also called by
 * the settings API to reschedule immediately.
 */

export function scheduleScrape () {
  const rt = runtime()
  if (rt.scrapeTimer) clearTimeout(rt.scrapeTimer)
  const ms = Math.min(Math.max(getSettings().scrapeIntervalS, 2), 600) * 1000
  rt.scrapeTimer = setTimeout(async () => {
    try {
      await scrapeAll()
    } catch (err) {
      console.error('[pazuzu] scrape cycle failed:', err)
    }
    scheduleScrape()
  }, ms)
  rt.scrapeTimer.unref?.()
}

export function scheduleRollups () {
  const rt = runtime()
  if (rt.rollupTimer) clearTimeout(rt.rollupTimer)
  const ms = Math.min(Math.max(getSettings().rollupIntervalS, 5), 3600) * 1000
  rt.rollupTimer = setTimeout(() => {
    try {
      runRollups()
    } catch (err) {
      console.error('[pazuzu] rollup cycle failed:', err)
    }
    scheduleRollups()
  }, ms)
  rt.rollupTimer.unref?.()
}
