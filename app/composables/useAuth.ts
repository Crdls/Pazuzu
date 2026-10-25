export type UserRole = 'superadmin' | 'admin' | 'user'

const ROLE_RANK: Record<string, number> = { user: 0, admin: 1, superadmin: 2 }

/** Rank of a role; missing (signed out) ranks below everything. */
export function roleRank (role?: UserRole | null): number {
  return role ? ROLE_RANK[role] ?? 0 : -1
}

export interface AuthUser {
  id: number
  username: string
  /** effective role — view-as mask applied, so the UI shows what this role sees */
  role: UserRole
  /** actual role from the users table, untouched by masking */
  realRole: UserRole
  /** false for GitLab-created users who have not set a local password yet */
  hasPassword: boolean
  /** UI language saved on the account; null = browser detection */
  lang: string | null
}

export interface AuthStatus {
  authEnabled: boolean
  gitlabEnabled: boolean
  hasUsers: boolean
  user: AuthUser | null
}

export function useAuth () {
  // cached per page load by the global route middleware (transferred via SSR payload)
  const status = useState<AuthStatus | null>('authStatus', () => null)
  // admin-or-above by effective role — a masked superadmin sees the plain-user UI
  const isAdmin = computed(() => roleRank(status.value?.user?.role) >= roleRank('admin'))
  const isSuperadmin = computed(() => status.value?.user?.role === 'superadmin')
  // role checks against the users table: what view-as can never hide
  const realIsAdmin = computed(() => roleRank(status.value?.user?.realRole) >= roleRank('admin'))
  const isMasked = computed(() => {
    const u = status.value?.user
    return u != null && u.role !== u.realRole
  })
  /** the masked role while masked, null when acting as the real role */
  const viewingAs = computed<UserRole | null>(() => {
    const u = status.value?.user
    return u && u.role !== u.realRole ? u.role : null
  })

  async function load (force = false): Promise<AuthStatus | null> {
    if (status.value && !force) return status.value
    // useRequestFetch so SSR forwards the incoming cookies to /api
    const requestFetch = useRequestFetch()
    try {
      status.value = await requestFetch<AuthStatus>('/api/auth/status')
    } catch {
      status.value = null // server unreachable — let pages render and fail naturally
    }
    return status.value
  }

  /** Switch the session's view-as mask (null = own role); reloads the page. */
  async function switchViewAs (role: UserRole | null): Promise<void> {
    if (import.meta.server) return
    status.value = await $fetch<AuthStatus>('/api/auth/view-as', { method: 'POST', body: { role } })
    // full reload so the role-gated, lazily loaded cards fetch from scratch
    location.reload()
  }

  async function signOut () {
    if (import.meta.server) return
    try {
      await $fetch('/api/auth/logout', { method: 'POST' })
    } catch { /* already signed out */ }
    // full reload so the live plugin drops its WebSocket
    location.assign('/login')
  }

  return { status, isAdmin, isSuperadmin, realIsAdmin, isMasked, viewingAs, load, switchViewAs, signOut }
}
