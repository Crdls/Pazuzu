// Theme color picker data (Settings -> Appearance).
// Names resolve against --color-<name>-<shade>: Tailwind default palettes
// are built-in, the custom abyss/abyssrock scales are declared in
// app/assets/css/main.css. Classes must be literal strings so the Tailwind
// v4 scanner keeps the utilities.

export interface ThemeSwatch {
  value: string
  class: string
}

export const primarySwatches: ThemeSwatch[] = [
  { value: 'abyss', class: 'swatch-abyss' },
  { value: 'green', class: 'bg-green-500' },
  { value: 'emerald', class: 'bg-emerald-500' },
  { value: 'teal', class: 'bg-teal-500' },
  { value: 'blue', class: 'bg-blue-500' },
  { value: 'violet', class: 'bg-violet-500' },
  { value: 'fuchsia', class: 'bg-fuchsia-500' },
  { value: 'rose', class: 'bg-rose-500' },
  { value: 'orange', class: 'bg-orange-500' },
  { value: 'amber', class: 'bg-amber-500' }
]

// a light->dark gradient makes the near-identical grays distinguishable
export const neutralSwatches: ThemeSwatch[] = [
  { value: 'abyssrock', class: 'bg-linear-to-br from-abyssrock-300 to-abyssrock-600' },
  { value: 'slate', class: 'bg-linear-to-br from-slate-300 to-slate-600' },
  { value: 'gray', class: 'bg-linear-to-br from-gray-300 to-gray-600' },
  { value: 'zinc', class: 'bg-linear-to-br from-zinc-300 to-zinc-600' },
  { value: 'neutral', class: 'bg-linear-to-br from-neutral-300 to-neutral-600' },
  { value: 'stone', class: 'bg-linear-to-br from-stone-300 to-stone-600' }
]

const THEME_KEY = 'pazuzu_theme'

// the built-in scheme (standardTheme) must mirror app.config.ts ui.colors -
// standard mode itself means "no override", so it only lives here
export const standardTheme = { primary: 'abyss', neutral: 'abyssrock' }
export type ThemeMode = 'standard' | 'custom'

interface StoredTheme {
  mode: ThemeMode
  primary?: string
  neutral?: string
}

// apply the stored choice on top of the app.config.ts defaults (client
// only); the standard scheme IS the defaults, so it stores no override
export function applyStoredTheme () {
  if (!import.meta.client) return
  const saved = readTheme()
  if (!saved || saved.mode !== 'custom') return
  const appConfig = useAppConfig()
  if (primarySwatches.some(s => s.value === saved.primary)) appConfig.ui.colors.primary = saved.primary!
  if (neutralSwatches.some(s => s.value === saved.neutral)) appConfig.ui.colors.neutral = saved.neutral!
}

// write the current pick; the accent/neutral rows only exist in custom mode
export function storeTheme () {
  if (!import.meta.client) return
  const { primary, neutral } = useAppConfig().ui.colors
  writeTheme({ mode: 'custom', primary, neutral })
}

export function storedThemeMode (): ThemeMode {
  return readTheme()?.mode ?? 'standard'
}

// switch scheme: custom re-picks the stored custom pair (or starts from the
// standard one), standard writes the built-in colors - the custom pair is
// kept in storage either way, so switching back restores it
export function setThemeMode (mode: ThemeMode) {
  const saved = readTheme()
  const customPrimary = primarySwatches.some(s => s.value === saved?.primary) ? saved!.primary! : standardTheme.primary
  const customNeutral = neutralSwatches.some(s => s.value === saved?.neutral) ? saved!.neutral! : standardTheme.neutral
  const appConfig = useAppConfig()
  const active = mode === 'standard' ? standardTheme : { primary: customPrimary, neutral: customNeutral }
  appConfig.ui.colors.primary = active.primary
  appConfig.ui.colors.neutral = active.neutral
  writeTheme({ mode, primary: customPrimary, neutral: customNeutral })
}

function writeTheme (theme: StoredTheme) {
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(theme))
  } catch {
    // private mode / quota - the choice just does not survive a reload
  }
}

function readTheme (): StoredTheme | null {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (!raw) return null
    const theme = JSON.parse(raw) as StoredTheme
    // saves from before the scheme switch were made by hand - treat them as custom
    if (theme.mode !== 'custom' && theme.mode !== 'standard') return { ...theme, mode: 'custom' }
    return theme
  } catch {
    return null
  }
}
