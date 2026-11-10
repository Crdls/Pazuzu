// Tests for the Playground's pure inference helpers: chat bodies, SSE
// parsing and median summaries.
// Run: node test/inference.test.mjs
import {
  buildChatBody, dataLinesOf, splitSseFrames, deltaTextOf, usageFromChunk,
  estimateTokens, median, tokPerSecOf, summarizeRuns
} from '../server/utils/inference.ts'

let failed = 0
function check (name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`)
  if (!cond) failed++
}

// ---------- chat request body ----------
const body = (over) => JSON.parse(buildChatBody({ prompt: 'hi', ...over }))
check('single-turn user prompt', body({}).messages.length === 1 && body({}).messages[0].role === 'user' && body({}).messages[0].content === 'hi')
check('stream + usage always requested', body({}).stream === true && body({}).stream_options.include_usage === true)
check('model omitted when null', !('model' in body({ model: null })) && body({ model: 'strata-7b' }).model === 'strata-7b')
check('temperature 0 is kept, not dropped', body({ temperature: 0 }).temperature === 0 && !('temperature' in body({ temperature: null })))
check('max_tokens omitted when null', !('max_tokens' in body({ maxTokens: null })) && body({ maxTokens: 128 }).max_tokens === 128)

// ---------- SSE frame parsing ----------
check('data lines joined, leading space stripped', dataLinesOf('data: one\ndata:two') === 'one\ntwo')
check('comment-only frame yields nothing', dataLinesOf(': ping') === null && dataLinesOf('event: foo') === null)
check('frames split on blank line, tail kept', (() => {
  const r = splitSseFrames('data: a\n\ndata: b\n\ndata: par')
  return r.frames.join(',') === 'a,b' && r.rest === 'data: par'
})())
check('CRLF frames parsed', splitSseFrames('data: a\r\n\r\ndata: b\r\n\r\n').frames.join(',') === 'a,b')
check('keep-alive comment between frames', splitSseFrames(': ping\n\ndata: a\n\n').frames.join(',') === 'a')
check('incomplete tail is not a frame', splitSseFrames('data: a\n').frames.length === 0)

// ---------- chunk payloads ----------
const chunk = (content, over = {}) => ({ choices: [{ delta: content === null ? {} : { content } }], ...over })
check('delta text extracted', deltaTextOf(chunk('tok')) === 'tok')
check('empty delta', deltaTextOf(chunk('')) === '' && deltaTextOf(chunk(null)) === '')
check('chunk without choices', deltaTextOf({ usage: { total_tokens: 1 } }) === '')
check('non-string content ignored', deltaTextOf(chunk({ weird: true })) === '')
check('null chunk safe', deltaTextOf(null) === '' && deltaTextOf('text') === '')
check('array payload parses to no text', deltaTextOf(JSON.parse('[1,2]')) === '' && usageFromChunk(JSON.parse('[1,2]')) === null)

const usage = { prompt_tokens: 7, completion_tokens: 21 }
check('usage read from final chunk', usageFromChunk({ choices: [], usage }).gen === 21 && usageFromChunk({ choices: [], usage }).prompt === 7)
check('all-zero usage means none', usageFromChunk({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }) === null)
check('missing usage', usageFromChunk(chunk('x')) === null && usageFromChunk(null) === null)
check('estimate is chars/4', estimateTokens(8) === 2 && estimateTokens(0) === 0)

// ---------- stats ----------
check('median of odd run', median([30, 10, 20]) === 20)
check('median of even run averages the middle', median([10, 20, 30, 40]) === 25)
check('median of empty is null', median([]) === null)
check('tok/s over whole run', tokPerSecOf(50, 1000) === 50 && tokPerSecOf(50, 500) === 100)
check('tok/s undefined for zero duration', tokPerSecOf(10, 0) === null)

// ---------- summaries ----------
const r = (serverId, run, over = {}) => ({
  serverId, run, ok: true, ttftMs: 100, totalMs: 1000, tokens: 100, estimated: false, ...over
})
const s1 = r(1, 1, { ttftMs: 100, totalMs: 1000, tokens: 100 })
const s2 = r(1, 2, { ttftMs: 300, totalMs: 2000, tokens: 200 })
const s3 = r(1, 3, { ttftMs: 200, totalMs: 1500, tokens: 150, estimated: true })
const bad = r(2, 1, { ok: false, ttftMs: null, totalMs: 400, tokens: 0, error: 'HTTP 502' })
const ok2 = r(2, 2, { ttftMs: 40, totalMs: 800, tokens: 64 })
const sum = summarizeRuns([s2, s1, bad, s3, ok2])
check('one row per server, sorted by id', sum.length === 2 && sum[0].serverId === 1 && sum[1].serverId === 2)
check('medians over successful runs', sum[0].medTtftMs === 200 && sum[0].medTotalMs === 1500)
check('median tok/s is tokens/total per run', Math.abs(sum[0].medTokPerSec - 100) < 1e-9)
check('best/worst total span successful runs', sum[0].bestTotalMs === 1000 && sum[0].worstTotalMs === 2000)
check('errors counted, never averaged in', sum[1].ok === 1 && sum[1].errors === 1 && sum[1].medTotalMs === 800)
check('estimated runs flagged', sum[0].anyEstimated && !sum[1].anyEstimated)
const allBad = summarizeRuns([bad])
check('all-error server has no medians', allBad[0].medTtftMs === null && allBad[0].medTotalMs === null && allBad[0].bestTotalMs === null)
check('run missing ttft excluded from median', summarizeRuns([r(1, 1, { ttftMs: null }), r(1, 2, { ttftMs: 90 })])[0].medTtftMs === 90)

console.log(failed === 0 ? '\nAll checks passed' : `\n${failed} checks FAILED`)
process.exitCode = failed > 0 ? 1 : 0
