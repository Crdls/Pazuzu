/**
 * Catalog of every metric Pazuzu knows about: how to label, display and
 * aggregate it. Metrics scraped from /metrics are stored verbatim; `derived:*`
 * series are computed by the scraper (rates, percentages, window averages).
 */

export type Agg = 'avg' | 'sum' | 'max'

export interface MetricDef {
  label: string
  unit: '%' | '°C' | 'W' | 'tok/s' | 'req/s' | 'B' | 's' | ''
  /** how to collapse multiple label series (e.g. per-GPU) into one heatmap cell */
  agg: Agg
  /** offer in the heatmap metric selector */
  heatmap?: boolean
  /** multiply by this for display (e.g. 0..1 ratio -> %) */
  scale?: number
}

export const METRICS: Record<string, MetricDef> = {
  // --- vllm:* (vLLM-compatible) ---
  'vllm:num_requests_running': { label: 'Running requests', unit: '', agg: 'sum' },
  'vllm:num_requests_waiting': { label: 'Queue', unit: '', agg: 'sum', heatmap: true },
  'vllm:kv_cache_usage_perc': { label: 'KV cache', unit: '%', agg: 'avg', heatmap: true, scale: 100 },
  'vllm:prompt_tokens_total': { label: 'Prompt tokens (total)', unit: '', agg: 'sum' },
  'vllm:generation_tokens_total': { label: 'Generated tokens (total)', unit: '', agg: 'sum' },
  'vllm:request_success_total': { label: 'Requests (total)', unit: '', agg: 'sum' },
  'vllm:prefix_cache_queries_total': { label: 'Prefix cache queries', unit: '', agg: 'sum' },
  'vllm:prefix_cache_hits_total': { label: 'Prefix cache hits', unit: '', agg: 'sum' },
  'vllm:spec_decode_num_draft_tokens_total': { label: 'Spec draft tokens', unit: '', agg: 'sum' },
  'vllm:spec_decode_num_accepted_tokens_total': { label: 'Spec accepted tokens', unit: '', agg: 'sum' },
  'vllm:num_preemptions_total': { label: 'Preemptions', unit: '', agg: 'sum' },

  // --- strata:* ---
  'strata:live_state': { label: 'Engine state', unit: '', agg: 'last' as Agg },
  'strata:live_tok_s': { label: 'Decode rate', unit: 'tok/s', agg: 'avg', heatmap: true },
  'strata:live_prefill_tok_s_mean': { label: 'Prefill rate', unit: 'tok/s', agg: 'avg' },
  'strata:live_prompt_read': { label: 'Prompt read (running req)', unit: '', agg: 'sum' },
  'strata:live_slots': { label: 'Batch slots', unit: '', agg: 'sum' },
  'strata:engine_max_context': { label: 'Max context', unit: '', agg: 'max' },
  'strata:totals_prompt_seconds_total': { label: 'Prompt time (total)', unit: 's', agg: 'sum' },
  'strata:totals_decode_seconds_total': { label: 'Decode time (total)', unit: 's', agg: 'sum' },
  'strata:last_hit_rate': { label: 'Expert cache hit rate', unit: '%', agg: 'avg', heatmap: true, scale: 100 },
  'strata:last_decode_tok_s': { label: 'Last request decode', unit: 'tok/s', agg: 'avg' },
  'strata:gpu_util': { label: 'GPU util', unit: '%', agg: 'avg', heatmap: true },
  'strata:gpu_mem_used_bytes': { label: 'GPU memory used', unit: 'B', agg: 'sum' },
  'strata:gpu_mem_total_bytes': { label: 'GPU memory total', unit: 'B', agg: 'sum' },
  'strata:gpu_temp_celsius': { label: 'GPU temp', unit: '°C', agg: 'max', heatmap: true },
  'strata:gpu_power_watts': { label: 'GPU power', unit: 'W', agg: 'sum', heatmap: true },
  'strata:cpu': { label: 'CPU', unit: '%', agg: 'avg', heatmap: true },
  'strata:ram_used_bytes': { label: 'RAM used', unit: 'B', agg: 'sum' },
  'strata:ram_total_bytes': { label: 'RAM total', unit: 'B', agg: 'sum' },

  // --- derived:* (computed by the scraper) ---
  'derived:gen_tok_s': { label: 'Generation rate', unit: 'tok/s', agg: 'avg', heatmap: true },
  'derived:prompt_tok_s': { label: 'Prompt rate', unit: 'tok/s', agg: 'avg' },
  'derived:req_s': { label: 'Request rate', unit: 'req/s', agg: 'sum', heatmap: true },
  'derived:ttft_avg_s': { label: 'TTFT (window avg)', unit: 's', agg: 'avg' },
  'derived:itl_avg_s': { label: 'Inter-token latency (window avg)', unit: 's', agg: 'avg' },
  'derived:e2e_avg_s': { label: 'E2E latency (window avg)', unit: 's', agg: 'avg' },
  'derived:gpu_mem_pct': { label: 'GPU memory', unit: '%', agg: 'avg', heatmap: true },
  'derived:ram_pct': { label: 'RAM used', unit: '%', agg: 'avg' },
  'derived:decode_busy_pct': { label: 'Decode busy', unit: '%', agg: 'avg', heatmap: true },
  'derived:prefill_busy_pct': { label: 'Prefill busy', unit: '%', agg: 'avg' }
}

export function metricDef (key: string): MetricDef {
  return METRICS[key] ?? { label: key, unit: '', agg: 'avg' }
}

export const HEATMAP_METRICS: string[] = Object.keys(METRICS).filter(k => METRICS[k]!.heatmap)

/** counters -> per-second rate series */
export const COUNTER_RATES: Record<string, string> = {
  'vllm:generation_tokens_total': 'derived:gen_tok_s',
  'vllm:prompt_tokens_total': 'derived:prompt_tok_s',
  'vllm:request_success_total': 'derived:req_s'
}

/** histogram sum/count pairs -> window average (Δsum / Δcount) */
export const HIST_WINDOW_AVG: Array<{ sum: string, count: string, out: string }> = [
  { sum: 'vllm:time_to_first_token_seconds_sum', count: 'vllm:time_to_first_token_seconds_count', out: 'derived:ttft_avg_s' },
  { sum: 'vllm:inter_token_latency_seconds_sum', count: 'vllm:inter_token_latency_seconds_count', out: 'derived:itl_avg_s' },
  { sum: 'vllm:e2e_request_latency_seconds_sum', count: 'vllm:e2e_request_latency_seconds_count', out: 'derived:e2e_avg_s' }
]

/** seconds-spent counters -> busy percent of wall time */
export const BUSY_PCT: Record<string, string> = {
  'strata:totals_decode_seconds_total': 'derived:decode_busy_pct',
  'strata:totals_prompt_seconds_total': 'derived:prefill_busy_pct'
}
