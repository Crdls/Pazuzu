<script setup lang="ts">
import type { GatewayClientView } from '~~/server/utils/gateway/view'

interface GatewayServerStatus {
  id: number
  name: string
  mode: 'on' | 'drain' | 'off'
  capacity: number
  inflight: number
  up: boolean
  ejected: boolean
  upstreamWaiting: number
  kvUsage: number
}

interface GatewayStatus {
  enabled: boolean
  clients: number
  activeClients: number
  queue: { total: number, high: number, normal: number, low: number }
  servers: GatewayServerStatus[]
}

interface ClientIpRow { ip: string, first_seen: number, last_seen: number, hits: number }

interface ServerOption { id: number, name: string }

const { data: clients, refresh } = useFetch<GatewayClientView[]>('/api/gateway/clients', {
  // forward cookies on the SSR-side call so the auth middleware lets it through
  headers: useRequestHeaders(['cookie'])
})
const { data: serverOptions } = useFetch<ServerOption[]>('/api/servers', {
  headers: useRequestHeaders(['cookie'])
})
const toast = useToast()
const { t } = useI18n()

// ---------- server access selection (add + edit modals) ----------
function allServerIds (): number[] {
  return (serverOptions.value ?? []).map(s => s.id)
}

function toggleIn (list: { value: number[] }, id: number, on: boolean): void {
  list.value = on ? [...new Set([...list.value, id])] : list.value.filter(x => x !== id)
}

// ---------- per-server preference tiers (add + edit modals) ----------
const serverPrioItems = computed(() => [
  { value: 'high', label: t('clients.srvPrioHome') },
  { value: 'normal', label: t('clients.srvPrioNormal') },
  { value: 'low', label: t('clients.srvPrioFallback') }
])
function prioOf (prios: Record<number, string>, id: number): string {
  return prios[id] ?? 'normal'
}
function setPrio (prios: Record<number, string>, id: number, tier: unknown): void {
  prios[id] = String(tier)
}
/** Checked servers -> tiers; 'normal' is left out, the server stores it as absent. */
function prioPayload (prios: Record<number, string>, ids: number[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of ids) {
    const tier = prios[id] ?? 'normal'
    if (tier !== 'normal') out[String(id)] = tier
  }
  return out
}

function fmtTime (ts: number | null): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}

// ---------- live gateway status panel ----------
const gw = ref<GatewayStatus | null>(null)
async function pollStatus () {
  try {
    gw.value = await $fetch<GatewayStatus>('/api/gateway/status')
  } catch { /* auth off-page or transient - next tick retries */ }
}
let statusTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void pollStatus()
  statusTimer = setInterval(() => void pollStatus(), 3000)
})
onBeforeUnmount(() => { if (statusTimer) clearInterval(statusTimer) })

const endpoint = computed(() => (import.meta.client ? `${window.location.origin}/v1` : ''))

// ---------- token shown once ----------
const tokenModal = ref(false)
const tokenValue = ref('')
const copied = ref(false)

function showToken (token: string) {
  tokenValue.value = token
  copied.value = false
  tokenModal.value = true
}

async function copyToken () {
  try {
    await navigator.clipboard.writeText(tokenValue.value)
    copied.value = true
  } catch {
    toast.add({ title: t('clients.copyFailed'), color: 'warning' })
  }
}

// ---------- create ----------
const addOpen = ref(false)
const addForm = reactive({ name: '', priority: 'normal', debug: false, token: '' })
const addServers = ref<number[]>([])
const addPrios = ref<Record<number, string>>({})
const saving = ref(false)
const priorityItems = computed(() => [
  { value: 'high', label: t('clients.prioHigh') },
  { value: 'normal', label: t('clients.prioNormal') },
  { value: 'low', label: t('clients.prioLow') }
])

function openAdd () {
  addForm.name = ''
  addForm.priority = 'normal'
  addForm.debug = false
  addForm.token = ''
  addServers.value = allServerIds()
  addPrios.value = {}
  addOpen.value = true
}

// ?add=1 from the dashboard opens the form immediately
const route = useRoute()
const router = useRouter()
onMounted(() => {
  if (route.query.add) {
    openAdd()
    void router.replace({ query: { ...route.query, add: undefined } })
  }
})

async function createClient () {
  saving.value = true
  try {
    const created = await $fetch<{ id: number, token: string }>('/api/gateway/clients', {
      method: 'POST',
      body: {
        name: addForm.name,
        priority: addForm.priority,
        debug: addForm.debug,
        serversAll: addServers.value.length === allServerIds().length,
        serverIds: addServers.value,
        serverPriorities: prioPayload(addPrios.value, addServers.value),
        ...(addForm.token.trim() ? { token: addForm.token.trim() } : {})
      }
    })
    addOpen.value = false
    await refresh()
    showToken(created.token)
  } catch (err: unknown) {
    toast.add({
      title: t('clients.toastSaveFailed'),
      description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}

// ---------- edit ----------
const editOpen = ref(false)
const editing = ref<GatewayClientView | null>(null)
const editForm = reactive({ name: '', priority: 'normal', debug: false, enabled: true })
const editServers = ref<number[]>([])
const editPrios = ref<Record<number, string>>({})

function openEdit (client: GatewayClientView) {
  editing.value = client
  editForm.name = client.name
  editForm.priority = client.priority
  editForm.debug = client.debug
  editForm.enabled = client.enabled
  const known = allServerIds()
  editServers.value = client.serversAll ? known : client.serverIds.filter(id => known.includes(id))
  editPrios.value = Object.fromEntries(
    Object.entries(client.serverPriorities ?? {}).filter(([id]) => known.includes(Number(id)))
  )
  editOpen.value = true
}

async function saveEdit () {
  if (!editing.value) return
  saving.value = true
  try {
    await $fetch(`/api/gateway/clients/${editing.value.id}`, {
      method: 'PATCH',
      body: {
        ...editForm,
        serversAll: editServers.value.length === allServerIds().length,
        serverIds: editServers.value,
        serverPriorities: prioPayload(editPrios.value, editServers.value)
      }
    })
    editOpen.value = false
    toast.add({ title: t('clients.toastSaved'), color: 'success' })
    await refresh()
  } catch (err: unknown) {
    toast.add({
      title: t('clients.toastSaveFailed'),
      description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}

// ---------- rotate ----------
const rotateTarget = ref<GatewayClientView | null>(null)

async function rotate () {
  if (!rotateTarget.value) return
  try {
    const res = await $fetch<{ token: string }>(`/api/gateway/clients/${rotateTarget.value.id}/rotate`, { method: 'POST' })
    rotateTarget.value = null
    await refresh()
    showToken(res.token)
  } catch (err: unknown) {
    toast.add({
      title: t('clients.toastSaveFailed'),
      description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
      color: 'error'
    })
  }
}

// ---------- IP history ----------
const ipsOpen = ref(false)
const ipsClient = ref<GatewayClientView | null>(null)
const ips = ref<ClientIpRow[]>([])

async function openIps (client: GatewayClientView) {
  ipsClient.value = client
  ips.value = []
  ipsOpen.value = true
  try {
    ips.value = await $fetch<ClientIpRow[]>(`/api/gateway/clients/${client.id}/ips`)
  } catch {
    toast.add({ title: t('clients.toastIpsFailed'), color: 'error' })
  }
}

// ---------- delete ----------
const deleteTarget = ref<GatewayClientView | null>(null)

async function remove () {
  if (!deleteTarget.value) return
  try {
    await $fetch(`/api/gateway/clients/${deleteTarget.value.id}`, { method: 'DELETE' })
    toast.add({ title: t('clients.toastDeleted'), color: 'success' })
    await refresh()
  } catch (err: unknown) {
    toast.add({
      title: t('clients.toastDeleteFailed'),
      description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
      color: 'error'
    })
  } finally {
    deleteTarget.value = null
  }
}

function priorityColor (p: string): 'error' | 'primary' | 'neutral' {
  return p === 'high' ? 'error' : p === 'normal' ? 'primary' : 'neutral'
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-5">
      <div>
        <h1 class="text-xl font-semibold">{{ t('clients.title') }}</h1>
        <p class="text-sm text-muted mt-0.5">{{ t('clients.subtitle') }}</p>
      </div>
      <UButton color="neutral" variant="outline" icon="i-lucide-plus" @click="openAdd">
        {{ t('clients.add') }}
      </UButton>
    </div>

    <UAlert
      v-if="gw && !gw.enabled"
      class="mb-4"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('gateway.disabledBanner')"
    />

    <!-- live gateway status: plain block, no card - the server tiles carry it -->
    <div v-if="gw" class="mb-5 space-y-3">
      <div class="flex flex-wrap gap-x-8 gap-y-3 text-sm">
        <div>
          <div class="text-xs uppercase tracking-wide text-muted mb-1">{{ t('gateway.endpoint') }}</div>
          <div v-if="endpoint" class="flex items-center gap-1.5">
            <code class="text-xs bg-elevated px-1.5 py-0.5 rounded select-all">{{ endpoint }}</code>
          </div>
        </div>
        <div>
          <div class="text-xs uppercase tracking-wide text-muted mb-1">{{ t('gateway.queueTitle') }}</div>
          <div class="flex items-center gap-2">
            <UBadge color="error" variant="subtle" size="sm">{{ t('gateway.queueHigh') }}: {{ gw.queue.high }}</UBadge>
            <UBadge color="primary" variant="subtle" size="sm">{{ t('gateway.queueNormal') }}: {{ gw.queue.normal }}</UBadge>
            <UBadge color="neutral" variant="subtle" size="sm">{{ t('gateway.queueLow') }}: {{ gw.queue.low }}</UBadge>
          </div>
        </div>
      </div>
      <div class="border-t border-default pt-3">
        <div class="text-xs uppercase tracking-wide text-muted mb-2">{{ t('gateway.serversTitle') }}</div>
        <div v-if="!gw.servers.length" class="text-sm text-muted">{{ t('gateway.noServers') }}</div>
        <div v-else class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
          <div v-for="s in gw.servers" :key="s.id" class="rounded-lg bg-elevated/50 p-3 space-y-2.5">
            <div class="flex items-center gap-1.5 min-w-0">
              <UIcon
                :name="s.up ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
                class="size-4 shrink-0"
                :class="s.up ? 'text-success' : 'text-error'"
              />
              <span class="truncate font-semibold text-sm">{{ s.name }}</span>
              <div class="ml-auto flex items-center gap-1 shrink-0">
                <UBadge v-if="s.mode === 'drain'" color="warning" variant="subtle" size="sm">{{ t('gateway.draining') }}</UBadge>
                <UBadge v-if="s.mode === 'off'" color="neutral" variant="subtle" size="sm">{{ t('gateway.off') }}</UBadge>
                <UBadge v-if="s.ejected" color="error" variant="subtle" size="sm">{{ t('gateway.ejected') }}</UBadge>
              </div>
            </div>
            <div class="grid grid-cols-3 gap-2 text-center">
              <div>
                <div class="text-lg font-semibold tabular-nums">{{ t('gateway.inflight', { n: s.inflight, cap: s.capacity }) }}</div>
                <div class="text-[10px] uppercase tracking-wide text-muted">{{ t('gateway.inflightTitle') }}</div>
              </div>
              <div>
                <div class="text-lg font-semibold tabular-nums">{{ s.upstreamWaiting }}</div>
                <div class="text-[10px] uppercase tracking-wide text-muted">{{ t('card.queued') }}</div>
              </div>
              <div>
                <div class="text-lg font-semibold tabular-nums">{{ Math.round(s.kvUsage * 100) }}%</div>
                <div class="text-[10px] uppercase tracking-wide text-muted">{{ t('card.kvCache') }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <UCard variant="soft" class="bg-elevated/30">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs uppercase tracking-wide text-muted border-b border-default">
            <th class="py-2 pr-3 font-medium">{{ t('clients.name') }}</th>
            <th class="py-2 pr-3 font-medium">{{ t('clients.priority') }}</th>
            <th class="py-2 pr-3 font-medium text-center">{{ t('clients.status') }}</th>
            <th class="py-2 pr-3 font-medium text-right">{{ t('clients.requestsToday') }}</th>
            <th class="py-2 pr-3 font-medium text-right">{{ t('clients.requestsTotal') }}</th>
            <th class="py-2 pr-3 font-medium text-right">{{ t('clients.tokens') }}</th>
            <th class="py-2 pr-3 font-medium">{{ t('clients.created') }}</th>
            <th class="py-2 font-medium text-right">{{ t('clients.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="client in clients ?? []" :key="client.id" class="border-b border-default/50 last:border-0">
            <td class="py-2.5 pr-3">
              <div class="font-medium">{{ client.name }}</div>
              <div class="text-xs text-dimmed font-mono">{{ client.tokenHint }}</div>
              <div class="text-xs text-dimmed">
                {{ client.serversAll ? t('clients.serversAll') : t('clients.serversCount', { n: client.serverIds.length, total: (serverOptions ?? []).length }) }}
                <span v-if="Object.keys(client.serverPriorities ?? {}).length" class="ml-1 text-warning" :title="t('clients.srvPrioHelp')">
                  ★ {{ t('clients.srvPrioMark', { n: Object.keys(client.serverPriorities).length }) }}
                </span>
              </div>
            </td>
            <td class="py-2.5 pr-3">
              <UBadge :color="priorityColor(client.priority)" variant="subtle" size="sm">
                {{ client.priority === 'high' ? t('clients.prioHigh') : client.priority === 'normal' ? t('clients.prioNormal') : t('clients.prioLow') }}
              </UBadge>
            </td>
            <td class="py-2.5 pr-3 text-center whitespace-nowrap">
              <UBadge v-if="!client.enabled" color="warning" variant="subtle" size="sm">{{ t('clients.disabled') }}</UBadge>
              <UBadge v-else color="success" variant="subtle" size="sm">{{ t('clients.active') }}</UBadge>
              <UBadge v-if="client.debug" color="info" variant="subtle" size="sm" class="ml-1">debug</UBadge>
            </td>
            <td class="py-2.5 pr-3 text-right tabular-nums">{{ client.requestsToday }}</td>
            <td class="py-2.5 pr-3 text-right tabular-nums">{{ client.requestsTotal }}</td>
            <td class="py-2.5 pr-3 text-right tabular-nums text-muted" :title="t('clients.tokensHelp')">
              ~{{ client.tokensTotal.toLocaleString() }}
            </td>
            <td class="py-2.5 pr-3 text-muted whitespace-nowrap">{{ fmtTime(client.createdAt) }}</td>
            <td class="py-2.5 text-right whitespace-nowrap">
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-pencil" @click="openEdit(client)">
                {{ t('clients.edit') }}
              </UButton>
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-network" @click="openIps(client)">
                {{ t('clients.ips') }}
              </UButton>
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" @click="rotateTarget = client">
                {{ t('clients.rotate') }}
              </UButton>
              <UButton size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" @click="deleteTarget = client">
                {{ t('clients.delete') }}
              </UButton>
            </td>
          </tr>
          <tr v-if="!clients?.length">
            <td colspan="8" class="py-10 text-center text-muted">
              <AbyssEyes class="size-9 mx-auto mb-2" />
              <div>{{ t('clients.empty') }}</div>
            </td>
          </tr>
        </tbody>
      </table>
    </UCard>

    <!-- token shown once after create/rotate -->
    <UModal v-model:open="tokenModal" :title="t('clients.tokenOnceTitle')" :dismissible="false">
      <template #body>
        <p class="text-sm mb-3">{{ t('clients.tokenOnceText') }}</p>
        <div class="flex items-center gap-2">
          <UInput v-model="tokenValue" readonly class="font-mono text-xs flex-1" @click="($event.target as HTMLInputElement).select()" />
          <UButton icon="i-lucide-copy" :color="copied ? 'success' : 'neutral'" variant="outline" @click="copyToken">
            {{ copied ? t('clients.copied') : t('clients.copy') }}
          </UButton>
        </div>
        <div class="flex justify-end pt-4">
          <UButton @click="tokenModal = false">{{ t('common.ok') }}</UButton>
        </div>
      </template>
    </UModal>

    <!-- add modal -->
    <UModal v-model:open="addOpen" :title="t('clients.addTitle')">
      <template #body>
        <form class="space-y-4" @submit.prevent="createClient">
          <UFormField :label="t('clients.name')" required>
            <UInput v-model="addForm.name" placeholder="mobile-app" class="w-full" autofocus />
          </UFormField>
          <UFormField :label="t('clients.priority')" :help="t('clients.priorityHelp')">
            <USelect v-model="addForm.priority" :items="priorityItems" class="w-40" />
          </UFormField>
          <UFormField :label="t('clients.servers')" :help="t('clients.serversHelp')">
            <div class="flex items-center gap-2 mb-1.5">
              <UButton size="xs" color="neutral" variant="outline" @click="addServers = allServerIds()">
                {{ t('common.selectAll') }}
              </UButton>
              <UButton size="xs" color="neutral" variant="outline" @click="addServers = []">
                {{ t('common.selectNone') }}
              </UButton>
            </div>
            <div v-if="!serverOptions?.length" class="text-sm text-muted">{{ t('clients.serversEmpty') }}</div>
            <div v-else class="max-h-48 overflow-y-auto rounded-md border border-default divide-y divide-default">
              <div v-for="s in serverOptions" :key="s.id" class="flex items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-elevated/50">
                <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <UCheckbox :model-value="addServers.includes(s.id)" @update:model-value="toggleIn(addServers, s.id, $event as boolean)" />
                  <span class="truncate">{{ s.name }}</span>
                </label>
                <USelect
                  v-if="addServers.includes(s.id)"
                  :model-value="prioOf(addPrios, s.id)"
                  :items="serverPrioItems"
                  :aria-label="t('clients.srvPrio')"
                  :title="t('clients.srvPrioHelp')"
                  size="xs"
                  class="w-28 shrink-0"
                  @update:model-value="setPrio(addPrios, s.id, $event)"
                />
              </div>
            </div>
          </UFormField>
          <UFormField :label="t('clients.debug')" :help="t('clients.debugHelp')">
            <USwitch v-model="addForm.debug" size="sm" />
          </UFormField>
          <UFormField :label="t('clients.customToken')" :help="t('clients.customTokenHelp')">
            <UInput v-model="addForm.token" type="text" autocomplete="off" placeholder="msk_…" class="w-full font-mono text-xs" />
          </UFormField>
          <div class="flex justify-end gap-2 pt-2">
            <UButton color="neutral" variant="ghost" @click="addOpen = false">
              {{ t('common.cancel') }}
            </UButton>
            <UButton type="submit" :loading="saving" :disabled="!addForm.name.trim()">
              {{ t('clients.add') }}
            </UButton>
          </div>
        </form>
      </template>
    </UModal>

    <!-- edit modal -->
    <UModal v-model:open="editOpen" :title="t('clients.editTitle', { name: editing?.name ?? '' })">
      <template #body>
        <form class="space-y-4" @submit.prevent="saveEdit">
          <UFormField :label="t('clients.name')" required>
            <UInput v-model="editForm.name" class="w-full" />
          </UFormField>
          <UFormField :label="t('clients.priority')" :help="t('clients.priorityHelp')">
            <USelect v-model="editForm.priority" :items="priorityItems" class="w-40" />
          </UFormField>
          <UFormField :label="t('clients.servers')" :help="t('clients.serversHelp')">
            <div class="flex items-center gap-2 mb-1.5">
              <UButton size="xs" color="neutral" variant="outline" @click="editServers = allServerIds()">
                {{ t('common.selectAll') }}
              </UButton>
              <UButton size="xs" color="neutral" variant="outline" @click="editServers = []">
                {{ t('common.selectNone') }}
              </UButton>
            </div>
            <div v-if="!serverOptions?.length" class="text-sm text-muted">{{ t('clients.serversEmpty') }}</div>
            <div v-else class="max-h-48 overflow-y-auto rounded-md border border-default divide-y divide-default">
              <div v-for="s in serverOptions" :key="s.id" class="flex items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-elevated/50">
                <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <UCheckbox :model-value="editServers.includes(s.id)" @update:model-value="toggleIn(editServers, s.id, $event as boolean)" />
                  <span class="truncate">{{ s.name }}</span>
                </label>
                <USelect
                  v-if="editServers.includes(s.id)"
                  :model-value="prioOf(editPrios, s.id)"
                  :items="serverPrioItems"
                  :aria-label="t('clients.srvPrio')"
                  :title="t('clients.srvPrioHelp')"
                  size="xs"
                  class="w-28 shrink-0"
                  @update:model-value="setPrio(editPrios, s.id, $event)"
                />
              </div>
            </div>
          </UFormField>
          <UFormField :label="t('clients.debug')" :help="t('clients.debugHelp')">
            <USwitch v-model="editForm.debug" size="sm" />
          </UFormField>
          <UFormField :label="t('clients.status')" :help="t('clients.disabledHelp')">
            <USwitch v-model="editForm.enabled" size="sm" />
          </UFormField>
          <div class="flex justify-end gap-2 pt-2">
            <UButton color="neutral" variant="ghost" @click="editOpen = false">
              {{ t('common.cancel') }}
            </UButton>
            <UButton type="submit" :loading="saving">
              {{ t('common.save') }}
            </UButton>
          </div>
        </form>
      </template>
    </UModal>

    <!-- IP history modal -->
    <UModal v-model:open="ipsOpen" :title="t('clients.ipsTitle', { name: ipsClient?.name ?? '' })">
      <template #body>
        <table v-if="ips.length" class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs uppercase tracking-wide text-muted border-b border-default">
              <th class="py-1.5 pr-3 font-medium">{{ t('clients.ip') }}</th>
              <th class="py-1.5 pr-3 font-medium text-right">{{ t('clients.hits') }}</th>
              <th class="py-1.5 pr-3 font-medium">{{ t('clients.lastSeen') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in ips" :key="row.ip" class="border-b border-default/50 last:border-0">
              <td class="py-1.5 pr-3 font-mono text-xs">{{ row.ip }}</td>
              <td class="py-1.5 pr-3 text-right tabular-nums">{{ row.hits }}</td>
              <td class="py-1.5 pr-3 text-muted whitespace-nowrap">{{ fmtTime(row.last_seen) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="text-sm text-muted py-4 text-center">{{ t('clients.ipsEmpty') }}</p>
      </template>
    </UModal>

    <!-- rotate confirm -->
    <UModal
      :open="!!rotateTarget"
      :title="t('clients.rotateTitle')"
      @update:open="(v: boolean) => { if (!v) rotateTarget = null }"
    >
      <template #body>
        <p class="text-sm">{{ t('clients.rotateText', { name: rotateTarget?.name ?? '' }) }}</p>
        <div class="flex justify-end gap-2 pt-4">
          <UButton color="neutral" variant="ghost" @click="rotateTarget = null">
            {{ t('common.cancel') }}
          </UButton>
          <UButton color="warning" @click="rotate">
            {{ t('clients.rotate') }}
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- delete confirm -->
    <UModal
      :open="!!deleteTarget"
      :title="t('clients.confirmTitle')"
      @update:open="(v: boolean) => { if (!v) deleteTarget = null }"
    >
      <template #body>
        <p class="text-sm">{{ t('clients.confirmText', { name: deleteTarget?.name ?? '' }) }}</p>
        <div class="flex justify-end gap-2 pt-4">
          <UButton color="neutral" variant="ghost" @click="deleteTarget = null">
            {{ t('common.cancel') }}
          </UButton>
          <UButton color="error" @click="remove">
            {{ t('clients.delete') }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
