<script setup lang="ts">
// Signature mascot: a pair of glowing eyes watching from the dark, used in
// empty states. Blinks every few seconds; static for prefers-reduced-motion.
</script>

<template>
  <svg viewBox="0 0 64 30" fill="none" aria-hidden="true" class="abyss-eyes">
    <g class="abyss-eye">
      <circle cx="19" cy="15" r="7.5" fill="var(--ui-primary)" />
      <ellipse cx="19" cy="15" rx="2.2" ry="6" fill="var(--ui-bg)" />
    </g>
    <g class="abyss-eye abyss-eye-offset">
      <circle cx="45" cy="15" r="7.5" fill="var(--ui-primary)" />
      <ellipse cx="45" cy="15" rx="2.2" ry="6" fill="var(--ui-bg)" />
    </g>
  </svg>
</template>

<style scoped>
.abyss-eyes {
  filter: drop-shadow(0 0 7px color-mix(in oklab, var(--ui-primary) 55%, transparent));
}
.abyss-eye {
  /* per-eye center so scaleY closes the eye like a lid */
  transform-box: fill-box;
  transform-origin: center;
  animation: abyss-blink 7s ease-in-out infinite;
}
.abyss-eye-offset {
  animation-delay: 0.08s;
}
@keyframes abyss-blink {
  0%, 90%, 100% { transform: scaleY(1); }
  93%, 96% { transform: scaleY(0.06); }
}
@media (prefers-reduced-motion: reduce) {
  .abyss-eye { animation: none; }
}
</style>
