<script setup lang="ts">
const { t } = useI18n()
const slideoverOpen = ref(false)
</script>

<template>
  <div class="min-h-svh flex bg-default">
    <!-- darker than the content in dark mode (a trench next to the strata),
       faintly gray in light mode; color-mix follows any neutral palette -->
    <aside class="hidden lg:flex flex-col w-56 shrink-0 sticky top-0 h-svh bg-(--color-abyssrock-50)/42 dark:bg-[color-mix(in_oklab,var(--ui-bg)_89%,#000)]">
      <AppSidebarContent />
    </aside>

    <div class="flex-1 min-w-0 flex flex-col min-h-svh">
      <!-- slim mobile bar; the sidebar content moves into a slideover -->
      <header class="lg:hidden sticky top-0 z-40 bg-(--color-abyssrock-50)/42 dark:bg-[color-mix(in_oklab,var(--ui-bg)_89%,#000)]">
        <div class="h-14 px-3 flex items-center gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-menu"
            :aria-label="t('nav.menu')"
            @click="slideoverOpen = true"
          />
          <NuxtLink to="/" class="flex items-center gap-2 font-semibold text-highlighted">
            <img src="/logo.svg" class="size-6 glow-hover" alt="" />
            <span>Pazuzu</span>
          </NuxtLink>
        </div>
      </header>

      <main class="flex-1 w-full max-w-7xl mx-auto px-4 py-6">
        <slot />
      </main>
    </div>

    <USlideover
      v-model:open="slideoverOpen"
      side="left"
      :title="t('nav.menu')"
      :ui="{ body: 'p-0' }"
    >
      <template #body>
        <AppSidebarContent @dismiss="slideoverOpen = false" />
      </template>
    </USlideover>
  </div>
</template>
