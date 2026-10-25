// One-shot database prune: deletes the legacy 10-second histogram *_bucket
// rows (the scraper has since stored buckets only once a minute), then runs a
// full cleanup: rollups, every thin tier caught up, VACUUM - the same thing
// the Settings -> System "Clean up now" button does.
//
//   node scripts/prune.mjs
//
// Prefer running it with the Pazuzu server stopped: VACUUM on a live database
// works, but it competes with the WAL. Requires Node >= 22.22 / 24.15
// (imports the server TypeScript helpers directly, same as the tests).
import { useDb } from '../server/utils/db.ts'
import { cleanupNow } from '../server/utils/rollup.ts'

// LIKE with an escaped underscore - otherwise `_` would match any character
const BUCKET_LIKE = '%!_bucket'

function main () {
  const db = useDb()
  let dropped = 0
  for (const table of ['samples', 'rollup_hourly', 'rollup_daily']) {
    dropped += db.prepare(`DELETE FROM ${table} WHERE metric LIKE ? ESCAPE '!'`).run(BUCKET_LIKE).changes
  }
  console.log(`dropped ${dropped.toLocaleString('en-US')} legacy *_bucket rows`)

  const report = cleanupNow()
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
  console.log(`thinning removed ${report.rowsRemoved.toLocaleString('en-US')} more rows`)
  console.log(`database file: ${mb(report.bytesBefore)} MB -> ${mb(report.bytesAfter)} MB`)
}

main()
