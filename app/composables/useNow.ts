/**
 * Shared ticking clock (ms) for "X ago" labels. One interval for the whole
 * app; on SSR it is just the current time (no interval, no stale module state).
 */
let clock: Ref<number> | null = null

export function useNow (intervalMs = 30_000): Readonly<Ref<number>> {
  if (!import.meta.client) return ref(Date.now())
  if (!clock) {
    clock = ref(Date.now())
    setInterval(() => { clock!.value = Date.now() }, intervalMs)
  }
  return clock
}
