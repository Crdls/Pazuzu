import { useDb } from '../utils/db'
import { DEFAULT_METRIC, heatmapPayload } from '../utils/heatmap'

export default defineEventHandler((event) => {
  const q = getQuery(event)
  const period = typeof q.period === 'string' ? q.period : ''
  const metric = typeof q.metric === 'string' && q.metric ? q.metric : DEFAULT_METRIC
  // window, tier choice, aggregation and the short-lived cache: server/utils/heatmap.ts
  return heatmapPayload(useDb(), { period, metric })
})
