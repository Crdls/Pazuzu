// Tests for the pure scraper-catalog helpers: histogram bucket detection,
// the once-a-minute bucket storage rule, and the load-detection predicate.
// Run: node test/metrics.test.mjs
import { hasLoad, isBucketSeries, storeBucketSeries } from '../server/utils/metrics.ts'

let failed = 0
function check (name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`)
  if (!cond) failed++
}

check('detects histogram buckets', isBucketSeries('vllm:time_to_first_token_seconds_bucket'))
check('sums are not buckets', !isBucketSeries('vllm:time_to_first_token_seconds_sum'))
check('counts are not buckets', !isBucketSeries('vllm:e2e_request_latency_seconds_count'))
check('derived series are not buckets', !isBucketSeries('derived:req_s'))

const m = 60_000
check('first scrape always stores buckets', storeBucketSeries(undefined, 10 * m + 5_000))
check('same minute does not store again', !storeBucketSeries(10 * m + 10_000, 10 * m + 20_000))
check('crossing the minute edge stores', storeBucketSeries(10 * m + 59_000, 11 * m + 1_000))
check('a gap of several minutes stores', storeBucketSeries(10 * m, 14 * m + 1))

const run = ['vllm:num_requests_running', '', 2]
const wait = ['vllm:num_requests_waiting', '', 0]
check('running requests mean load', hasLoad([run, wait]))
check('waiting requests mean load', hasLoad([['vllm:num_requests_running', '', 0], ['vllm:num_requests_waiting', '', 3]]))
check('idle gauges are no load', !hasLoad([wait, ['vllm:num_requests_running', '', 0]]))
check('other metrics are no load', !hasLoad([['strata:live_tok_s', '', 120], ['vllm:num_requests_running', '', 0]]))
check('empty scrape is no load', !hasLoad([]))

console.log(failed === 0 ? '\nAll checks passed' : `\n${failed} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
