<template>
  <!-- Teleported into the shell top bar so the warning sits centered in
       the bar itself, styled like the other notices (red regular text). -->
  <Teleport to="#shell-notices">
    <transition name="flash">
      <div v-if="visible" class="collision-warning">
        <span class="collision-warning__icon">⚠</span>
        <span class="collision-warning__text">{{ $t('collisionwarning.warning') }}</span>
        <span class="collision-warning__icon">⚠</span>
      </div>
    </transition>
  </Teleport>
</template>

<script setup>
defineProps({
  visible: {
    type: Boolean,
    default: false,
  },
});
</script>

<style scoped>
.collision-warning {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: #dc143c;
  font-family: Calibri, 'Segoe UI', sans-serif;
  font-size: 0.8rem;
  font-weight: 400;
  text-align: center;
  white-space: nowrap;
  pointer-events: none;
  animation: warningPulse 1s ease-in-out infinite;
}

.collision-warning__icon {
  font-size: 1rem;
  line-height: 1;
}

.collision-warning__text {
  letter-spacing: 0.02em;
}

@keyframes warningPulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

.flash-enter-active,
.flash-leave-active {
  transition: opacity 0.25s ease;
}

.flash-enter-from,
.flash-leave-to {
  opacity: 0;
}
</style>
