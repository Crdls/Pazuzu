import { useDb } from '../utils/db'
import { scrapeAll, seedLastActivity } from '../utils/scrape'
import { scheduleScrape } from '../utils/scheduler'

export default defineNitroPlugin(() => {
  useDb() // ensure schema exists
  seedLastActivity() // fill last_seen/last_busy_ts from history (post-upgrade)
  scheduleScrape()
  void scrapeAll().catch(err => console.error('[pazuzu] initial scrape failed:', err))
})
