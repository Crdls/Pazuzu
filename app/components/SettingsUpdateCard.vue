<script setup lang="ts">
// version and self-update: anyone can check, applying is admin-only while auth is on
// (canApply / restarting / applyUpdate live in the shared useUpdate composable)
const { t } = useI18n()
const toast = useToast()
const { status: upd, checkNow, canApply, restarting, applyUpdate } = useUpdate()
const updateChecking = ref(false)
const applyOpen = ref(false)
// only surface a failed autoupdate run; a successful one is visible in the version itself
const failedUpdate = computed(() => (upd.value?.lastUpdate && !upd.value.lastUpdate.ok ? upd.value.lastUpdate : null))

function fmtTime (ms: number) {
  return new Date(ms).toLocaleString()
}

async function checkUpdate () {
  if (updateChecking.value) return
  updateChecking.value = true
  try {
    await checkNow()
  } catch (err: unknown) {
    toast.add({
      title: t('update.toastCheckFailed'),
      description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
      color: 'error'
    })
  } finally {
    updateChecking.value = false
  }
}
</script>

<template>
  <UCard variant="soft" class="bg-elevated/30">
    <h2 class="text-base font-semibold mb-1">{{ t('update.title') }}</h2>
    <p class="text-sm text-muted mb-4">{{ t('update.description') }}</p>

    <div class="space-y-3">
      <div class="flex flex-wrap items-center gap-2 text-sm font-mono">
        <span class="text-muted">{{ upd?.branch ?? '?' }} · {{ shortVersion(upd?.currentSha) }}</span>
        <UIcon name="i-lucide-arrow-right" class="size-3.5 text-dimmed" />
        <span :class="upd?.updateAvailable ? 'text-warning font-semibold' : 'text-muted'">
          {{ upd?.latestSha ? shortVersion(upd.latestSha) : '…' }}
        </span>
        <UBadge v-if="upd && !upd.currentSha" color="neutral" variant="subtle" :label="t('update.notGit')" />
        <UBadge v-else-if="upd?.updateAvailable" color="warning" variant="subtle" :label="t('update.updateAvailable')" />
        <UBadge v-else-if="upd?.error" color="error" variant="subtle" :label="t('update.checkFailed')" />
        <UBadge v-else-if="upd?.checkedAt" color="success" variant="subtle" :label="t('update.upToDate')" />
      </div>

      <p class="text-xs text-dimmed">
        <span v-if="upd?.checkedAt">{{ t('update.checkedAt', { time: fmtTime(upd.checkedAt) }) }}</span>
        <span v-else>{{ t('update.neverChecked') }}</span>
        <a
          v-if="upd?.compareUrl"
          :href="upd.compareUrl"
          target="_blank"
          rel="noopener"
          class="ml-2 text-primary hover:underline"
        >{{ t('update.compare') }}</a>
      </p>

      <p v-if="upd && !upd.currentSha" class="text-xs text-dimmed">{{ t('update.notGit') }}</p>
      <p v-else-if="upd?.dev" class="text-xs text-dimmed">{{ t('update.devMode') }}</p>
      <p v-if="failedUpdate" class="text-xs text-error">
        {{ t('update.lastFailed', { step: failedUpdate.step ?? '?' }) }}
      </p>

      <div class="flex items-center gap-2 pt-1">
        <UButton
          v-if="upd?.currentSha"
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-refresh-cw"
          :loading="updateChecking || upd?.checking"
          :disabled="upd?.applying"
          @click="checkUpdate"
        >
          {{ t('update.check') }}
        </UButton>
        <UButton v-if="canApply" size="sm" icon="i-lucide-download" @click="applyOpen = true">
          {{ t('update.apply') }}
        </UButton>
        <span v-if="restarting" class="text-xs text-muted inline-flex items-center gap-1.5">
          <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
          {{ t('update.restarting') }}
        </span>
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
  </UCard>
</template>
