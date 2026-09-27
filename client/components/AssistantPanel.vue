<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import { useTeamRoster } from '@shared-composables/useTeamRoster.js';

const { t } = useI18n();

// Composer draft text only. Sending, streaming and every other piece of
// internal logic intentionally arrives in a later phase — the buttons are
// pure layout for now.
const draft = ref('');

// Team popover: the roster of chatroom teammates (commander, AI staff and
// one entry per machine agent). Static list for now; the live room arrives
// with the DSH integration.
const { team } = useTeamRoster();
const teamOpen = ref(false);

/* ── Draggable hairline above the composer ───────────────────────────────
   Dragging it UP grows the textbox (the transcript above shrinks by the
   same amount) so the player can read a long draft in full. */
const INPUT_MIN = 64;      // px — the textarea's floor (former min-height)
const MESSAGES_MIN = 72;   // px of transcript that always stays visible
const inputHeight = ref(96);
const isDraggingInput = ref(false);
const messagesEl = ref(null);

let dragStartY = 0;
let dragStartHeight = 0;

// The box only ever grows at the transcript's expense.
function maxInputHeight() {
  const messagesH = messagesEl.value ? messagesEl.value.clientHeight : 0;
  return inputHeight.value + Math.max(0, messagesH - MESSAGES_MIN);
}

function clampInputHeight(h) {
  return Math.min(maxInputHeight(), Math.max(INPUT_MIN, h));
}

function onInputDividerPointerDown(e) {
  e.preventDefault();
  dragStartY = e.clientY;
  dragStartHeight = inputHeight.value;
  isDraggingInput.value = true;
  document.addEventListener('pointermove', onInputDividerPointerMove);
  document.addEventListener('pointerup', onInputDividerPointerUp);
}

function onInputDividerPointerMove(e) {
  if (!isDraggingInput.value) return;
  inputHeight.value = clampInputHeight(dragStartHeight + (dragStartY - e.clientY));
}

function onInputDividerPointerUp() {
  isDraggingInput.value = false;
  document.removeEventListener('pointermove', onInputDividerPointerMove);
  document.removeEventListener('pointerup', onInputDividerPointerUp);
}

// Keyboard mirror of the drag: Arrow Up/Down (Shift = a bigger step).
function onInputDividerKeydown(e) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  const step = e.shiftKey ? 48 : 16;
  inputHeight.value = clampInputHeight(inputHeight.value + (e.key === 'ArrowUp' ? step : -step));
}
</script>

<template>
  <div class="assistant">
    <!-- ── Message list: rendering / streaming lands here later ── -->
    <div ref="messagesEl" class="assistant__messages" />

    <!-- Draggable divider: its height IS the textbox's ceiling. -->
    <div
      class="assistant__divider"
      :class="{ 'assistant__divider--dragging': isDraggingInput }"
      role="separator"
      aria-orientation="horizontal"
      tabindex="0"
      :title="t('assistantpanel.resize_input')"
      :aria-label="t('assistantpanel.resize_input')"
      @pointerdown="onInputDividerPointerDown"
      @keydown="onInputDividerKeydown"
    />

    <!-- ── Composer: row 1 [stop][input][send], row 2 [team][screenshot][upload] ── -->
    <div class="assistant__composer">
      <!-- Teammate popover: anchored above the composer, click-outside closes -->
      <template v-if="teamOpen">
        <div class="assistant__team-backdrop" @click="teamOpen = false" />
        <div class="assistant__team-pop">
          <div class="assistant__team-title">{{ t('assistantpanel.team_title') }}</div>
          <div class="assistant__team-list">
            <div v-for="mate in team" :key="mate.id" class="assistant__team-mate" :title="mate.name">
              <img class="assistant__team-avatar" :src="mate.avatar" :alt="mate.name" draggable="false" />
              <span class="assistant__team-name">{{ mate.name }}</span>
            </div>
          </div>
        </div>
      </template>

      <div class="assistant__row">
        <button
          class="assistant__btn assistant__btn--stop"
          type="button"
          :title="t('assistantpanel.stop')"
          :aria-label="t('assistantpanel.stop')"
        >
          <ConfigurableIcon name="MENU_STOP" :size="18" />
        </button>

        <textarea
          v-model="draft"
          class="assistant__input"
          rows="3"
          :style="{ height: inputHeight + 'px' }"
          :placeholder="t('assistantpanel.placeholder')"
        />

        <button
          class="assistant__btn assistant__btn--send"
          type="button"
          :title="t('assistantpanel.send')"
          :aria-label="t('assistantpanel.send')"
        >
          <ConfigurableIcon name="CHAT_SEND" :size="18" color="#fff" />
        </button>
      </div>

      <!-- Purely aesthetic hairline between the input row and the tool row. -->
      <div class="assistant__rowline" />

      <div class="assistant__row assistant__row--tools">
        <button
          class="assistant__btn"
          type="button"
          :class="{ 'assistant__btn--on': teamOpen }"
          :title="t('assistantpanel.team')"
          :aria-label="t('assistantpanel.team')"
          @click="teamOpen = !teamOpen"
        >
          <ConfigurableIcon name="MENU_TEAM" :size="18" />
        </button>
        <button
          class="assistant__btn"
          type="button"
          :title="t('assistantpanel.capture_viewer')"
          :aria-label="t('assistantpanel.capture_viewer')"
        >
          <ConfigurableIcon name="CHAT_CAPTURE" :size="18" />
        </button>
        <button
          class="assistant__btn"
          type="button"
          :title="t('assistantpanel.attach_folder')"
          :aria-label="t('assistantpanel.attach_folder')"
        >
          <ConfigurableIcon name="MENU_FILE_FOLDER" :size="18" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.assistant {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  box-sizing: border-box;
  pointer-events: auto;
  /* Single knob for BOTH gaps around the divider: divider↔textbox (the
     composer's top padding) and divider↔teammate box (the popover offset),
     which the design requires to be equal. */
  --divider-gap: 12px;
}

.assistant__messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}

/* ── Draggable divider above the composer (was a static border-top) ── */
.assistant__divider {
  position: relative;
  height: 1px;
  flex-shrink: 0;
  background: #e5e5ea;
  cursor: ns-resize;
  /* Without this, a touch drag scrolls the panel instead of resizing. */
  touch-action: none;
  transition: background 0.15s ease;
  z-index: 5;
}

/* Invisible 7px hit strip centred on the hairline so it is easy to grab. */
.assistant__divider::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -3px;
  height: 7px;
}

.assistant__divider:hover,
.assistant__divider:focus-visible,
.assistant__divider--dragging {
  background: #007aff;
}

.assistant__divider:focus-visible {
  outline: none;
}

.assistant__composer {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: var(--divider-gap) 16px;
  /* Anchor of the Team popover rising above the input row. */
  position: relative;
}

.assistant__row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

/* Tool row sits under the textarea, indented past the Stop button. */
.assistant__row--tools {
  margin-left: 44px; /* 36px button + 8px gap */
}

/* Thin horizontal divider between the input row and the tool row. */
.assistant__rowline {
  height: 1px;
  background: #e5e5ea;
  flex-shrink: 0;
}

.assistant__btn {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 8px;
  border: 1.5px solid #374151;
  background: transparent;
  color: #111827;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}

.assistant__btn:hover {
  background: rgba(0, 0, 0, 0.06);
}

/* Team button while its popover is open. */
.assistant__btn--on {
  border-color: #007aff;
  background: rgba(0, 122, 255, 0.12);
}

/* ── Team popover ── */
/* Transparent full-panel layer that closes the popover on click-outside. */
.assistant__team-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
}

.assistant__team-pop {
  position: absolute;
  left: 16px;
  right: 16px;
  /* Sits ABOVE the draggable divider: 100% clears the composer, +1px clears
     the divider hairline itself, and the remaining --divider-gap makes the
     box↔divider gap exactly equal to the divider↔textbox gap. */
  bottom: calc(100% + var(--divider-gap) + 1px);
  z-index: 31;
  background: #ffffff;
  border: 1px solid #e5e5ea;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  padding: 12px 14px;
}

.assistant__team-title {
  font-size: 0.78rem;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 10px;
}

.assistant__team-list {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
}

.assistant__team-mate {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  width: 56px;
}

.assistant__team-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  object-fit: cover;
  background: #f3f4f6;
  border: 1px solid #e5e5ea;
}

.assistant__team-name {
  font-size: 0.7rem;
  color: #374151;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.assistant__btn--send {
  background: #007aff;
  border-color: #007aff;
}

.assistant__btn--send:hover {
  background: #0066d6;
}

.assistant__btn--stop {
  background: #d81e06;
  border-color: #d81e06;
}

.assistant__btn--stop:hover {
  background: #b31805;
}

/* stop.svg ships a fixed gray fill; force it white on the red button. */
.assistant__btn--stop :deep(path) {
  fill: #ffffff;
}

.assistant__input {
  flex: 1;
  min-width: 0;
  resize: none;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
  font-size: 0.9rem;
  line-height: 1.4;
  /* The draggable divider owns the height (inline style); INPUT_MIN is the
     floor and the transcript's free space is the only ceiling. */
  min-height: 64px;
  background: #ffffff;
  color: #111827;
  box-sizing: border-box;
}

.assistant__input:focus {
  outline: 2px solid rgba(0, 122, 255, 0.4);
  border-color: #007aff;
}
</style>
