import { runRollups } from '../utils/rollup'
import { scheduleRollups } from '../utils/scheduler'

export default defineNitroPlugin(() => {
  scheduleRollups()
  // one initial pass shortly after boot so the heatmap has data early
  setTimeout(() => {
    try {
      runRollups()
    } catch (err) {
      console.error('[pazuzu] initial rollup failed:', err)
    }
  }, 5000).unref?.()
})
