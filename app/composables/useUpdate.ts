export interface LastUpdateResult {
  startedAt: number
  finishedAt: number
  ok: boolean
  step: string | null
  error: string | null
}

export interface UpdateStatus {
  /** commit of the running checkout; null when it is not a git checkout */
  currentSha: string | null
  /** commit time of the running checkout (ms) for the version label */
  commitTs: number | null
  branch: string | null
  latestSha: string | null
  updateAvailable: boolean
  compareUrl: string | null
  checkedAt: number | null
  checking: boolean
  error: string | null
  dev: boolean
  applying: boolean
  lastUpdate: LastUpdateResult | null
}

/** Short form of a commit SHA for the UI; '?' when the version is unknown. */
export function shortVersion (sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '?'
}

export function useUpdate () {
  // one shared fetch per page load (sidebar chip + settings card);
  // client-side only so ordinary SSR page renders do not add an /api hop
  const { data, pending, refresh } = useFetch<UpdateStatus>('/api/update/status', {
    key: 'update-status',
    server: false,
    lazy: true
  })

  async function checkNow (): Promise<void> {
    await $fetch('/api/update/check', { method: 'POST' })
    await refresh()
  }

  const { status: authStatus, isAdmin } = useAuth()
  const { t } = useI18n()
  const toast = useToast()

  // anyone can check for updates, applying is admin-only while auth is on
  const canApply = computed(() =>
    (!authStatus.value?.authEnabled || isAdmin.value) &&
    Boolean(data.value?.currentSha) && Boolean(data.value?.updateAvailable) &&
    !data.value?.dev && !data.value?.applying
  )

  // shared across every useUpdate() call site (two sidebar copies + settings)
  const restarting = useState('update-restarting', () => false)

  async function applyUpdate (): Promise<void> {
    const from = data.value?.currentSha ?? ''
    const startedAt = Date.now()
    try {
      await $fetch('/api/update/apply', { method: 'POST' })
    } catch (err: unknown) {
      toast.add({
        title: t('update.toastApplyFailed'),
        description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
        color: 'error'
      })
      return
    }
    // the server exits for the rebuild - poll until the new build answers
    restarting.value = true
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      try {
        const st = await $fetch<{
          currentSha: string | null
          lastUpdate: { startedAt: number, ok: boolean, step: string | null } | null
        }>('/api/update/status')
        if (st.currentSha && st.currentSha !== from) {
          toast.add({ title: t('update.backOnline', { version: shortVersion(st.currentSha) }), color: 'success' })
          setTimeout(() => location.reload(), 1200)
          return
        }
        // the same build came back: the updater finished but gave up on a step
        if (st.lastUpdate && st.lastUpdate.startedAt >= startedAt - 60_000 && !st.lastUpdate.ok) {
          restarting.value = false
          toast.add({ title: t('update.lastFailed', { step: st.lastUpdate.step ?? '?' }), color: 'error' })
          await refresh()
          return
        }
      } catch { /* still restarting */ }
    }
    restarting.value = false
    toast.add({ title: t('update.restartTimeout'), color: 'error' })
  }

  return { status: data, pending, refresh, checkNow, canApply, restarting, applyUpdate }
}
