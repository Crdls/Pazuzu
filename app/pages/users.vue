<script setup lang="ts">
interface UserRow {
  id: number
  username: string
  role: 'superadmin' | 'admin' | 'user'
  gitlab: number
  disabled: number
  created_at: number
  last_login: number | null
}

const { data: users, refresh } = useFetch<UserRow[]>('/api/users', {
  // forward cookies on the SSR-side call so the auth middleware lets it through
  headers: useRequestHeaders(['cookie'])
})
const toast = useToast()
const { t } = useI18n()
const { status, isSuperadmin } = useAuth()
const meId = computed(() => status.value?.user?.id ?? null)

function fmtTime (ts: number | null): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}

function roleLabel (role: UserRow['role']): string {
  return role === 'superadmin' ? t('users.roleSuperadmin') : role === 'admin' ? t('users.roleAdmin') : t('users.roleUser')
}

const formOpen = ref(false)
const editing = ref<UserRow | null>(null)
const form = reactive({ role: 'user' as 'superadmin' | 'admin' | 'user', disabled: false, password: '', confirm: '' })
const saving = ref(false)
const isSelf = computed(() => editing.value !== null && editing.value.id === meId.value)
const pwdMismatch = computed(() => form.confirm.length > 0 && form.confirm !== form.password)
// the API refuses self demote/freeze, so the controls go dark as well
// superadmin rows are read-only for plain admins (the API enforces it too)
const canEditRow = (user: UserRow): boolean => isSuperadmin.value || user.role !== 'superadmin'
const roleItems = computed(() => [
  ...(isSuperadmin.value ? [{ value: 'superadmin', label: t('users.roleSuperadmin') }] : []),
  { value: 'admin', label: t('users.roleAdmin') },
  { value: 'user', label: t('users.roleUser') }
])

function openEdit (user: UserRow) {
  editing.value = user
  form.role = user.role
  form.disabled = user.disabled === 1
  form.password = ''
  form.confirm = ''
  formOpen.value = true
}

async function save () {
  if (!editing.value || pwdMismatch.value) return
  saving.value = true
  try {
    await $fetch(`/api/users/${editing.value.id}`, {
      method: 'PATCH',
      body: { role: form.role, disabled: form.disabled, ...(form.password ? { password: form.password } : {}) }
    })
    formOpen.value = false
    toast.add({ title: t('users.toastSaved'), color: 'success' })
    await refresh()
  } catch (err: unknown) {
    toast.add({
      title: t('users.toastSaveFailed'),
      description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}

// add modal: new login/password account, role defaults to user
const route = useRoute()
const router = useRouter()
const addOpen = ref(false)
const addForm = reactive({ username: '', password: '', confirm: '', role: 'user' as 'superadmin' | 'admin' | 'user' })
const addSaving = ref(false)
const addMismatch = computed(() => addForm.confirm.length > 0 && addForm.confirm !== addForm.password)

function openAdd () {
  addForm.username = ''
  addForm.password = ''
  addForm.confirm = ''
  addForm.role = 'user'
  addOpen.value = true
}

// ?add=1 from the dashboard opens the form immediately
onMounted(() => {
  if (route.query.add) {
    openAdd()
    void router.replace({ query: { ...route.query, add: undefined } })
  }
})

async function create () {
  if (addMismatch.value) return
  addSaving.value = true
  try {
    await $fetch('/api/users', {
      method: 'POST',
      body: { username: addForm.username, password: addForm.password, role: addForm.role }
    })
    addOpen.value = false
    toast.add({ title: t('users.toastSaved'), color: 'success' })
    await refresh()
  } catch (err: unknown) {
    toast.add({
      title: t('users.toastSaveFailed'),
      description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
      color: 'error'
    })
  } finally {
    addSaving.value = false
  }
}

const deleteTarget = ref<UserRow | null>(null)
async function remove () {
  if (!deleteTarget.value) return
  try {
    await $fetch(`/api/users/${deleteTarget.value.id}`, { method: 'DELETE' })
    toast.add({ title: t('users.toastDeleted'), color: 'success' })
    await refresh()
  } catch (err: unknown) {
    toast.add({
      title: t('users.toastDeleteFailed'),
      description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
      color: 'error'
    })
  } finally {
    deleteTarget.value = null
  }
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-5">
      <div>
        <h1 class="text-xl font-semibold">{{ t('users.title') }}</h1>
        <p class="text-sm text-muted mt-0.5">{{ t('users.subtitle') }}</p>
      </div>
      <UButton color="neutral" variant="outline" icon="i-lucide-plus" @click="openAdd">
        {{ t('users.add') }}
      </UButton>
    </div>

    <UCard variant="soft" class="bg-elevated/30">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs uppercase tracking-wide text-muted border-b border-default">
            <th class="py-2 pr-3 font-medium">{{ t('users.username') }}</th>
            <th class="py-2 pr-3 font-medium">{{ t('users.role') }}</th>
            <th class="py-2 pr-3 font-medium text-center">{{ t('users.status') }}</th>
            <th class="py-2 pr-3 font-medium">{{ t('users.created') }}</th>
            <th class="py-2 pr-3 font-medium">{{ t('users.lastLogin') }}</th>
            <th class="py-2 font-medium text-right">{{ t('users.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in users ?? []" :key="user.id" class="border-b border-default/50 last:border-0">
            <td class="py-2.5 pr-3">
              <span class="font-medium">{{ user.username }}</span>
              <span v-if="user.id === meId" class="text-xs text-muted"> ({{ t('users.you') }})</span>
              <UBadge v-if="user.gitlab" color="info" variant="subtle" size="sm" class="ml-2">
                {{ t('users.gitlab') }}
              </UBadge>
            </td>
            <td class="py-2.5 pr-3">
              <UBadge :color="user.role === 'superadmin' ? 'warning' : user.role === 'admin' ? 'primary' : 'neutral'" variant="subtle" size="sm">
                {{ roleLabel(user.role) }}
              </UBadge>
            </td>
            <td class="py-2.5 pr-3 text-center">
              <UBadge v-if="user.disabled" color="warning" variant="subtle" size="sm">
                {{ t('users.frozen') }}
              </UBadge>
              <UBadge v-else color="success" variant="subtle" size="sm">
                {{ t('users.active') }}
              </UBadge>
            </td>
            <td class="py-2.5 pr-3 text-muted whitespace-nowrap">{{ fmtTime(user.created_at) }}</td>
            <td class="py-2.5 pr-3 text-muted whitespace-nowrap">{{ fmtTime(user.last_login) }}</td>
            <td class="py-2.5 text-right whitespace-nowrap">
              <UButton v-if="canEditRow(user)" size="xs" color="neutral" variant="ghost" icon="i-lucide-pencil" @click="openEdit(user)">
                {{ t('users.edit') }}
              </UButton>
              <UButton
                v-if="user.id !== meId && canEditRow(user)"
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                @click="deleteTarget = user"
              >
                {{ t('users.delete') }}
              </UButton>
            </td>
          </tr>
          <tr v-if="!users?.length">
            <td colspan="6" class="py-10 text-center text-muted">
              <AbyssEyes class="size-9 mx-auto mb-2" />
              <div>{{ t('users.empty') }}</div>
            </td>
          </tr>
        </tbody>
      </table>
    </UCard>

    <!-- edit modal -->
    <UModal v-model:open="formOpen" :title="t('users.editTitle', { name: editing?.username ?? '' })">
      <template #body>
        <form class="space-y-4" @submit.prevent="save">
          <UFormField :label="t('users.role')">
            <USelect v-model="form.role" :items="roleItems" :disabled="isSelf" class="w-40" />
            <p v-if="isSelf" class="text-xs text-muted mt-1">{{ t('users.selfHint') }}</p>
          </UFormField>

          <UFormField :label="t('users.frozen')" :help="t('users.frozenHelp')">
            <USwitch v-model="form.disabled" size="sm" :disabled="isSelf" />
          </UFormField>

          <UFormField :label="t('users.newPassword')" :help="t('users.newPasswordHelp')">
            <UInput v-model="form.password" type="password" autocomplete="new-password" class="w-full" />
          </UFormField>

          <UFormField :label="t('users.confirmNewPassword')">
            <UInput
              v-model="form.confirm"
              type="password"
              autocomplete="new-password"
              class="w-full"
              :color="pwdMismatch ? 'error' : undefined"
            />
            <p v-if="pwdMismatch" class="text-xs text-error mt-1">{{ t('auth.mismatch') }}</p>
          </UFormField>

          <div class="flex justify-end gap-2 pt-2">
            <UButton color="neutral" variant="ghost" @click="formOpen = false">
              {{ t('common.cancel') }}
            </UButton>
            <UButton type="submit" :loading="saving" :disabled="pwdMismatch">
              {{ t('common.save') }}
            </UButton>
          </div>
        </form>
      </template>
    </UModal>

    <!-- add modal -->
    <UModal v-model:open="addOpen" :title="t('users.addTitle')">
      <template #body>
        <form class="space-y-4" @submit.prevent="create">
          <UFormField :label="t('users.username')">
            <UInput v-model="addForm.username" autocomplete="username" class="w-full" />
          </UFormField>

          <UFormField :label="t('users.role')">
            <USelect v-model="addForm.role" :items="roleItems" class="w-40" />
          </UFormField>

          <UFormField :label="t('users.newPassword')" :help="t('users.newPasswordHelp')">
            <UInput v-model="addForm.password" type="password" autocomplete="new-password" class="w-full" />
          </UFormField>

          <UFormField :label="t('users.confirmNewPassword')">
            <UInput
              v-model="addForm.confirm"
              type="password"
              autocomplete="new-password"
              class="w-full"
              :color="addMismatch ? 'error' : undefined"
            />
            <p v-if="addMismatch" class="text-xs text-error mt-1">{{ t('auth.mismatch') }}</p>
          </UFormField>

          <div class="flex justify-end gap-2 pt-2">
            <UButton color="neutral" variant="ghost" @click="addOpen = false">
              {{ t('common.cancel') }}
            </UButton>
            <UButton type="submit" :loading="addSaving" :disabled="!addForm.username || !addForm.password || addMismatch">
              {{ t('common.save') }}
            </UButton>
          </div>
        </form>
      </template>
    </UModal>

    <!-- delete confirm -->
    <UModal
      :open="!!deleteTarget"
      :title="t('users.confirmTitle')"
      @update:open="(v: boolean) => { if (!v) deleteTarget = null }"
    >
      <template #body>
        <p class="text-sm">
          {{ t('users.confirmText', { name: deleteTarget?.username ?? '' }) }}
        </p>
        <div class="flex justify-end gap-2 pt-4">
          <UButton color="neutral" variant="ghost" @click="deleteTarget = null">
            {{ t('common.cancel') }}
          </UButton>
          <UButton color="error" @click="remove">
            {{ t('users.delete') }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
