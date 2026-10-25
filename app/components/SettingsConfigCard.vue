<script setup lang="ts">
// config.json (system configuration): superadmin-only card, values apply on save
interface ConfigFile {
  path: string
  exists: boolean
  config: {
    db: { path: string }
    auth: {
      enabled: boolean
      gitlab: {
        enabled: boolean
        baseUrl: string
        clientId: string
        clientSecret: string
        redirectUri: string
        allowedGroups: string[]
        caCert: string
        insecureTls: boolean
      }
    }
    gateway: {
      enabled: boolean
      queueTimeoutS: number
      queueMax: number
      queueMaxPerClient: number
      sessionIdleMin: number
      defaultCapacity: number
      ejectionS: number
    }
  }
}

const { t } = useI18n()
const toast = useToast()
const { status, isSuperadmin } = useAuth()

const canEditConfig = computed(() => !status.value?.authEnabled || isSuperadmin.value)
// lazy: superadmins (or anyone while auth is off) pull the file client-side,
// so lower roles never fire a request that would only 403
const { data: cfgFile, refresh: refreshCfg } = useFetch<ConfigFile>('/api/config', { immediate: false })
if (canEditConfig.value) refreshCfg()

const cfg = reactive({
  dbPath: '',
  authEnabled: false,
  gitlab: { enabled: false, baseUrl: '', clientId: '', clientSecret: '', redirectUri: '', groups: '', caCert: '', insecureTls: false },
  gw: { enabled: false, queueTimeoutS: 60, queueMax: 200, queueMaxPerClient: 20, sessionIdleMin: 60, defaultCapacity: 32, ejectionS: 30 }
})
watch(cfgFile, (f) => {
  if (!f) return
  const gl = f.config.auth.gitlab
  cfg.dbPath = f.config.db.path
  cfg.authEnabled = f.config.auth.enabled
  Object.assign(cfg.gitlab, {
    enabled: gl.enabled,
    baseUrl: gl.baseUrl,
    clientId: gl.clientId,
    clientSecret: gl.clientSecret,
    redirectUri: gl.redirectUri,
    caCert: gl.caCert,
    insecureTls: gl.insecureTls,
    groups: gl.allowedGroups.join(', ')
  })
  Object.assign(cfg.gw, f.config.gateway)
})

const cfgSaving = ref(false)

async function saveCfg () {
  cfgSaving.value = true
  try {
    await $fetch('/api/config', {
      method: 'PUT',
      body: {
        db: { path: cfg.dbPath },
        auth: {
          enabled: cfg.authEnabled,
          gitlab: {
            enabled: cfg.gitlab.enabled,
            baseUrl: cfg.gitlab.baseUrl,
            clientId: cfg.gitlab.clientId,
            clientSecret: cfg.gitlab.clientSecret,
            redirectUri: cfg.gitlab.redirectUri,
            allowedGroups: cfg.gitlab.groups.split(',').map(s => s.trim()).filter(s => s !== ''),
            caCert: cfg.gitlab.caCert,
            insecureTls: cfg.gitlab.insecureTls
          }
        },
        gateway: { ...cfg.gw }
      }
    })
    await refreshCfg()
    toast.add({ title: t('settings.toastSaved'), description: t('config.toastApplied'), color: 'success' })
  } catch (err: unknown) {
    toast.add({
      title: t('settings.toastSaveFailed'),
      description: (err as { statusMessage?: string })?.statusMessage ?? String(err),
      color: 'error'
    })
  } finally {
    cfgSaving.value = false
  }
}
</script>

<template>
  <UCard v-if="cfgFile" variant="soft" class="bg-elevated/30">
    <div class="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 class="text-base font-semibold">{{ t('config.title') }}</h2>
      <span class="font-mono text-xs text-dimmed">
        {{ cfgFile.path }}
        <span v-if="!cfgFile.exists">· {{ t('config.fileMissing') }}</span>
      </span>
    </div>
    <p class="text-sm text-muted mb-4">{{ t('config.description') }}</p>

    <form class="space-y-5" @submit.prevent="saveCfg">
      <div>
        <h3 class="mb-3 text-sm font-semibold">{{ t('config.db') }}</h3>
        <div class="space-y-5">
          <UFormField :label="t('config.dbPath')" :help="t('config.dbPathHelp')">
            <UInput v-model="cfg.dbPath" class="w-full max-w-md" :ui="{ base: 'font-mono' }" />
          </UFormField>
        </div>
      </div>

      <div>
        <h3 class="mb-3 text-sm font-semibold">{{ t('config.auth') }}</h3>
        <div class="space-y-5">
          <UFormField :label="t('config.authEnabled')" :help="t('config.authEnabledHelp')">
            <USwitch v-model="cfg.authEnabled" size="sm" />
          </UFormField>

          <UFormField :label="t('config.gitlabEnabled')" :help="t('config.gitlabHelp')">
            <USwitch v-model="cfg.gitlab.enabled" size="sm" />
          </UFormField>

          <UFormField :label="t('config.gitlabBaseUrl')">
            <UInput v-model="cfg.gitlab.baseUrl" placeholder="http://gitlab.lan" class="w-full max-w-md" />
          </UFormField>

          <UFormField :label="t('config.gitlabClientId')">
            <UInput v-model="cfg.gitlab.clientId" class="w-full max-w-md" />
          </UFormField>

          <UFormField :label="t('config.gitlabClientSecret')">
            <UInput v-model="cfg.gitlab.clientSecret" class="w-full max-w-md" />
          </UFormField>

          <UFormField :label="t('config.gitlabRedirect')" :help="t('config.gitlabRedirectHelp')">
            <UInput v-model="cfg.gitlab.redirectUri" placeholder="http://<host>:3003/api/auth/gitlab/callback" class="w-full max-w-md font-mono" />
          </UFormField>

          <UFormField :label="t('config.gitlabGroups')" :help="t('config.gitlabGroupsHelp')">
            <UInput v-model="cfg.gitlab.groups" placeholder="ops, sre" class="w-full max-w-md" />
          </UFormField>

          <UFormField :label="t('config.gitlabCaCert')" :help="t('config.gitlabCaHelp')">
            <UInput v-model="cfg.gitlab.caCert" class="w-full max-w-md font-mono" />
          </UFormField>

          <UFormField :label="t('config.gitlabInsecure')" :help="t('config.gitlabInsecureHelp')">
            <USwitch v-model="cfg.gitlab.insecureTls" size="sm" />
          </UFormField>
        </div>
      </div>

      <div>
        <h3 class="mb-3 text-sm font-semibold">{{ t('config.gateway') }}</h3>
        <div class="space-y-5">
          <UFormField :label="t('config.gatewayEnabled')" :help="t('config.gatewayHelp')">
            <USwitch v-model="cfg.gw.enabled" size="sm" />
          </UFormField>

          <UFormField :label="t('config.queueTimeout')" :help="t('config.queueTimeoutHelp')">
            <UInputNumber v-model="cfg.gw.queueTimeoutS" :min="1" :max="3600" :step="1" class="w-40" />
          </UFormField>

          <UFormField :label="t('config.queueMax')" :help="t('config.queueMaxHelp')">
            <UInputNumber v-model="cfg.gw.queueMax" :min="1" :max="10000" :step="1" class="w-40" />
          </UFormField>

          <UFormField :label="t('config.queueMaxPerClient')" :help="t('config.queueMaxPerClientHelp')">
            <UInputNumber v-model="cfg.gw.queueMaxPerClient" :min="1" :max="1000" :step="1" class="w-40" />
          </UFormField>

          <UFormField :label="t('config.sessionIdle')" :help="t('config.sessionIdleHelp')">
            <UInputNumber v-model="cfg.gw.sessionIdleMin" :min="1" :max="43200" :step="1" class="w-40" />
          </UFormField>

          <UFormField :label="t('config.defaultCapacity')" :help="t('config.defaultCapacityHelp')">
            <UInputNumber v-model="cfg.gw.defaultCapacity" :min="1" :max="4096" :step="1" class="w-40" />
          </UFormField>

          <UFormField :label="t('config.ejection')" :help="t('config.ejectionHelp')">
            <UInputNumber v-model="cfg.gw.ejectionS" :min="1" :max="3600" :step="1" class="w-40" />
          </UFormField>
        </div>
      </div>

      <div class="flex justify-end pt-2">
        <UButton type="submit" :loading="cfgSaving">
          {{ t('common.save') }}
        </UButton>
      </div>
    </form>
  </UCard>
</template>
