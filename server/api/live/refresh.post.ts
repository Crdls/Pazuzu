import { scrapeAll } from '../../utils/scrape'

/** Kick an immediate scrape cycle (dashboard "refresh" button); snapshots
 *  reach the UI through the usual WS broadcast. */
export default defineEventHandler(async () => {
  await scrapeAll()
  return { ok: true }
})
