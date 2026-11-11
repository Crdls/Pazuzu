// no-break space as the digit-group separator (not commas, everywhere)
const NB_SPACE = '\u00A0'

/** Group digit triples with non-break spaces: `262 144`, `1 234.5`. */
export function groupNum (v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const [int, frac] = Math.abs(v).toFixed(digits).split('.')
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, NB_SPACE)
  return (v < 0 ? '-' : '') + g + (frac ? `.${frac}` : '')
}

/** Thousands-sized count (token pools, engine contexts) without a suffix. */
export function kVal (v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return groupNum(Math.round(v / 1000))
}

export function fmtNum (v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 10_000) return groupNum(v)
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

/** Local calendar date as `dd.mm.yy` (dotted, 2-digit year), e.g. `05.11.26`. */
export function fmtDate (ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${p(d.getFullYear() % 100)}`
}

/** Local timestamp as `dd.mm.yy hh:mm`, e.g. `09.11.26 08:14`. */
export function fmtStamp (ts: number): string {
  return `${fmtDate(ts)} ${new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
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
 * hours+minutes up to 4 h, plain date (`dd.mm.yy`) beyond that. `t` is the i18n
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
  return fmtDate(ts)
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
