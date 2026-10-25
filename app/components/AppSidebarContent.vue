<script setup lang="ts">
// emitted on any action that should also close the mobile slideover
const emit = defineEmits<{ dismiss: [] }>()

const route = useRoute()
const { status, isAdmin, signOut } = useAuth()
const { connected } = useLive()
const { status: updateStatus, checkNow, canApply, restarting, applyUpdate } = useUpdate()
const authUser = computed(() => (status.value?.authEnabled ? status.value.user : null))
const { t } = useI18n()
const toast = useToast()

const versionLabel = computed(() => (updateStatus.value ? shortVersion(updateStatus.value.currentSha) : ''))
const versionDate = computed(() => (updateStatus.value?.commitTs ? new Date(updateStatus.value.commitTs).toLocaleDateString() : ''))

// the version line doubles as the quick check button
const checkingUpdate = ref(false)

// apply confirm dialog (the same flow as the Settings update card); the modal
// must stay mounted, so on mobile we do not dismiss the slideover before opening
// it - UModal teleports to the body and layers above the slideover
const applyOpen = ref(false)

async function checkUpdate () {
  if (checkingUpdate.value) return
  checkingUpdate.value = true
  try {
    await checkNow()
  } catch {
    toast.add({ title: t('update.toastCheckFailed'), color: 'error' })
  } finally {
    checkingUpdate.value = false
  }
}

// the user table is only listed for admins while auth is on
const nav = computed(() => [
  { to: '/', icon: 'i-lucide-layout-dashboard', label: 'nav.dashboard' },
  { to: '/heatmap', icon: 'i-lucide-grid-3x3', label: 'nav.heatmap' },
  { to: '/servers', icon: 'i-lucide-server', label: 'nav.servers' },
  // gateway clients work with auth off too (trusted LAN), so the page is only
  // admin-gated while auth is on (the API enforces it regardless)
  ...(status.value?.authEnabled && !isAdmin.value
    ? []
    : [{ to: '/clients', icon: 'i-lucide-key-round', label: 'nav.clients' }]),
  ...(status.value?.authEnabled && isAdmin.value
    ? [{ to: '/users', icon: 'i-lucide-users', label: 'nav.users' }]
    : []),
  { to: '/settings', icon: 'i-lucide-settings', label: 'nav.settings' }
])

function isActive (to: string) {
  if (to === '/') return route.path === '/'
  return route.path === to || route.path.startsWith(`${to}/`)
}
</script>

<template>
  <div class="flex flex-col h-full gap-4 p-3">
    <NuxtLink
      to="/"
      class="flex items-center gap-2 font-semibold text-highlighted px-2 py-1.5 shrink-0"
      @click="emit('dismiss')"
    >
      <img src="/logo.svg" class="size-6 glow-hover" alt="" />
      <span>Pazuzu</span>
    </NuxtLink>

    <nav class="flex flex-col gap-0.5 flex-1 min-h-0 overflow-y-auto">
      <NuxtLink
        v-for="item in nav"
        :key="item.to"
        :to="item.to"
        class="px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-2 transition-colors whitespace-nowrap"
        :class="isActive(item.to)
          ? 'bg-elevated text-highlighted light:bg-default'
          : 'text-muted hover:text-default hover:bg-elevated'"
        @click="emit('dismiss')"
      >
        <UIcon :name="item.icon" class="size-4" />
        {{ t(item.label) }}
      </NuxtLink>
    </nav>

    <!-- footer group: build info sits above the divider as plain text,
         the utility buttons (live state · theme · source · logout) below it -->
    <div class="shrink-0">
      <!-- click runs the same check as the Settings button, right in place -->
      <UTooltip :text="updateStatus?.updateAvailable ? t('update.updateAvailable') : t('update.checkHint')">
        <button
          v-if="versionLabel"
          type="button"
          class="px-2 pb-1.5 flex items-center gap-1 text-[11px] font-mono text-dimmed transition-colors hover:text-default"
          :aria-label="t('update.check')"
          @click="checkUpdate"
        >
          <span>{{ versionLabel }}{{ versionDate ? ` · ${versionDate}` : '' }}</span>
          <UIcon
            v-if="checkingUpdate || updateStatus?.checking"
            name="i-lucide-loader-circle"
            class="size-3 animate-spin"
          />
          <UIcon
            v-else-if="updateStatus?.updateAvailable"
            name="i-lucide-arrow-up-circle"
            class="size-3 text-warning"
          />
        </button>
      </UTooltip>

      <!-- the arrow badge alone is easy to miss: offer the action right here,
           only to those who may apply it (the API enforces this regardless) -->
      <UButton
        v-if="canApply && !restarting"
        size="xs"
        color="warning"
        icon="i-lucide-download"
        class="mx-2 mb-1"
        @click="applyOpen = true"
      >
        {{ t('update.apply') }}
      </UButton>
      <p v-else-if="restarting" class="px-2 pb-1.5 flex items-center gap-1 text-[11px] text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-3 shrink-0 animate-spin" />
        <span class="truncate">{{ t('update.restarting') }}</span>
      </p>

      <div class="flex items-center justify-between gap-1 -mx-3 px-3 pt-2 border-t border-(--ui-bg)">
        <UTooltip :text="connected ? t('common.liveHint') : t('common.pollHint')">
          <UIcon
            :name="connected ? 'i-lucide-radio' : 'i-lucide-wifi-off'"
            :class="connected ? 'text-success' : 'text-warning'"
            class="size-4 shrink-0"
          />
        </UTooltip>

        <!-- ClientOnly + fallback: avoids the stale aria-label hydration
             mismatch when the system theme differs from the SSR default -->
        <ClientOnly>
          <UColorModeButton
            size="xs"
            color="neutral"
            variant="ghost"
          />
          <template #fallback>
            <div class="size-6" />
          </template>
        </ClientOnly>

        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-github"
          :aria-label="t('footer.source')"
          to="https://github.com/Crdls/Pazuzu"
          target="_blank"
          rel="noopener"
          class="shrink-0"
        />

        <UTooltip
          v-if="authUser"
          :text="t('auth.logoutAs', { username: authUser.username })"
        >
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-log-out"
            :aria-label="t('auth.logout')"
            class="shrink-0"
            @click="signOut()"
          />
        </UTooltip>
      </div>
    </div>

    <!-- update confirm: the server pulls, rebuilds and restarts itself -->
    <UModal v-model:open="applyOpen" :title="t('update.applyTitle')">
      <template #body>
        <p class="text-sm">{{ t('update.applyText') }}</p>
        <div class="flex justify-end gap-2 pt-4">
          <UButton color="neutral" variant="ghost" @click="applyOpen = false">
            {{ t('common.cancel') }}
          </UButton>
          <UButton @click="applyOpen = false; applyUpdate()">
            {{ t('update.applyConfirm') }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
