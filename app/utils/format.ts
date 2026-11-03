export function fmtNum (v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 10_000) return Math.round(v).toLocaleString('en-US')
  if (abs >= 100) return v.toFixed(0)
  if (abs >= 10) return v.toFixed(Math.max(0, digits - 1))
  return v.toFixed(digits)
}

export function fmtBytes (b: number | null | undefined): string {
  if (b === null || b === undefined || !Number.isFinite(b)) return '—'
  const gib = b / 1024 ** 3
  if (gib >= 1) return `${gib.toFixed(1)} GiB`
  return `${(b / 1024 ** 2).toFixed(0)} MiB`
}

export function fmtScaled (v: number | null | undefined, scale = 1, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return fmtNum(v * scale, digits)
}

export function fmtClock (ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function fmtDateTime (ts: number): string {
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * "X ago" label for last-seen/last-busy stamps: minutes below an hour,
 * hours+minutes up to 4 h, plain date-time beyond that. `t` is the i18n
 * translate function (ago.* keys).
 */
export function relTime (
  ts: number,
  now: number,
  t: (key: string, params?: Record<string, unknown>) => string
): string {
  const min = Math.max(0, Math.floor((now - ts) / 60_000))
  if (min < 1) return t('ago.now')
  if (min < 60) return t('ago.minutes', { n: min })
  const h = Math.floor(min / 60)
  if (h < 4) return t('ago.hoursMinutes', { h, m: min % 60 })
  return fmtDateTime(ts)
}

/** `gpu=0,model_name=x` -> { gpu: '0', model_name: 'x' } */
export function parseLabelStr (s: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!s) return out
  for (const part of s.split(',')) {
    const eq = part.indexOf('=')
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return out
}

/** Human series name from metric label + label set, e.g. `GPU util · gpu 0` */
export function seriesName (base: string, labels: string): string {
  const parsed = parseLabelStr(labels)
  const parts = Object.entries(parsed)
    .filter(([k]) => k !== 'model_name')
    .map(([k, v]) => `${k} ${v}`)
  return parts.length ? `${base} · ${parts.join(', ')}` : base
}
