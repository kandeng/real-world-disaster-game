<script setup>
import { nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter, useRoute } from 'vue-router';
import ConfigurableIcon from '@shared/ConfigurableIcon.vue';
import { useTeamRoster } from '@shared-composables/useTeamRoster.js';
import { useTeamChat } from '@shared-composables/useTeamChat.js';
import { useSteerFreezePen } from '@shared-composables/useSteerFreezePen.js';
import { useFleet } from '@shared-composables/useFleet.js';
import { useSessionState } from '@shared-composables/useSessionState.js';

const { t } = useI18n();

// Composer draft. The transcript it feeds lives in useTeamChat so the history
// outlives this component instance.
const draft = ref('');

/* ── Transcript + mention routing ──────────────────────────────────────────
   Phase A: whoever a message is addressed to echoes it back — the teammates
   the commander @mentions, or Staff when the message mentions nobody. See
   useTeamChat.js for which half of that is a smoke test and which half is the
   permanent routing the real agent will inherit. */
const { messages, send, sendImage, displayName, avatarOf } = useTeamChat();

/* ── Screenshot button ──────────────────────────────────────────────
   Frozen Steer FPV (a pencil is armed): composites the still + the drawn
   lines/curves into ONE PNG, posts it here as the commander's message, and
   releases the freeze — the marks disappear and the live view resumes at
   the drone's current pose. Anywhere else: a plain frame of the viewport.
   The guard makes the async capture single-shot (double-click safe). */
const { captureForChat } = useSteerFreezePen();
let capturing = false;

async function onCapture() {
  if (capturing) return;
  capturing = true;
  try {
    const shot = await captureForChat();
    if (shot) sendImage(shot);
  } catch (err) {
    console.error('[AssistantPanel] Screenshot failed:', err);
  } finally {
    capturing = false;
  }
}

function onSend() {
  // send() already ignores whitespace-only text, but the draft is cleared ONLY
  // on a real send — otherwise a lone space would eat what the player typed.
  if (send(draft.value)) draft.value = '';
}

// Enter sends; Shift+Enter inserts a newline, since a multi-line order is
// normal. The composition guard matters here: while a CJK IME composition is
// open, Enter confirms the candidate list and must NOT ship a half-typed
// message. Safari reports that state only via the legacy keyCode 229, so both
// are checked.
function onInputKeydown(e) {
  if (e.key !== 'Enter' || e.shiftKey) return;
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  onSend();
}

// Team popover: the roster of chatroom teammates (commander, AI staff and
// one entry per machine agent). Static list for now; the live room arrives
// with the DSH integration.
const { team } = useTeamRoster();
const teamOpen = ref(false);

/* ── Machine teammates are FPV selectors ────────────────────────────────
   Clicking the drone's (or the tank's) icon makes that machine the fleet's
   ACTIVE asset and switches the main panel to its first-person Steer view —
   navigating to /play first when the commander is on another page. The
   commander and Staff entries are humans/AI, not machines: no view switch. */
const router = useRouter();
const route = useRoute();
const { session } = useSessionState();
const { activeAssetId, setActiveAsset } = useFleet();

function onMateClick(mate) {
  if (mate.kind !== 'machine') return;
  teamOpen.value = false;
  setActiveAsset(mate.id);
  if (route.path !== '/play') router.push('/play');
  session.view.aerial.subView = 'steer';
}

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

// Follow the conversation: scroll to the newest message once it is in the DOM.
// Watching the LENGTH (not the array) is enough because messages are only ever
// appended, and it avoids a deep watcher over the whole transcript.
watch(
  () => messages.value.length,
  async () => {
    await nextTick();
    const el = messagesEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  }
);
</script>

<template>
  <div class="assistant">
    <!-- ── Transcript: the commander's messages right-aligned, teammates left ── -->
    <div ref="messagesEl" class="assistant__messages">
      <!-- empty_hint contains `@`, which vue-i18n treats as its linked-message
           prefix (@:someKey), so the JSON writes it as {'@'} — the same escape
           AuthFlow uses for "you{'@'}example.com". Without it the message
           compiler throws "Invalid linked format" on every render, even though
           the text still appears. Any future string naming a handle needs it. -->
      <p v-if="!messages.length" class="assistant__empty">{{ t('assistantpanel.empty_hint') }}</p>

      <div v-for="msg in messages" :key="msg.id" class="msg" :class="{ 'msg--own': msg.own }">
        <img
          v-if="avatarOf(msg.from)"
          class="msg__avatar"
          :src="avatarOf(msg.from)"
          :alt="displayName(msg.from)"
          draggable="false"
        />
        <div class="msg__body">
          <div class="msg__name">{{ displayName(msg.from) }}</div>
          <div class="msg__bubble" :class="{ 'msg__bubble--shot': msg.image }">
            <!-- Screenshot message: the PNG itself is the payload (download
                 link around it); the text bubble styling would only pad it. -->
            <a v-if="msg.image" :href="msg.image" :download="`screenshot-${msg.id}.png`">
              <img
                class="msg__shot"
                :src="msg.image"
                :alt="t('assistantpanel.capture_viewer')"
                draggable="false"
              />
            </a>
            <template v-else>{{ msg.text }}</template>
          </div>
        </div>
      </div>
    </div>

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
            <div
              v-for="mate in team"
              :key="mate.id"
              class="assistant__team-mate"
              :class="{
                'assistant__team-mate--machine': mate.kind === 'machine',
                'assistant__team-mate--active': mate.kind === 'machine' && mate.id === activeAssetId,
              }"
              :title="mate.name"
              :role="mate.kind === 'machine' ? 'button' : undefined"
              :tabindex="mate.kind === 'machine' ? 0 : undefined"
              @click="onMateClick(mate)"
              @keydown.enter="onMateClick(mate)"
              @keydown.space.prevent="onMateClick(mate)"
            >
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
          @keydown="onInputKeydown"
        />

        <button
          class="assistant__btn assistant__btn--send"
          type="button"
          :title="t('assistantpanel.send')"
          :aria-label="t('assistantpanel.send')"
          @click="onSend"
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
          @click="onCapture"
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

.assistant__empty {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: #9ca3af;
}

/* ── Transcript bubbles ── */
.msg {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 12px;
}

/* The commander's own messages mirror to the right edge. */
.msg--own {
  flex-direction: row-reverse;
}

.msg__avatar {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border-radius: 50%;
  /* contain, never cover: contain is the fit that guarantees the WHOLE viewBox
     is visible, so nothing is ever cropped by the circular rim.

     padding 3px is load-bearing, not decoration. All four roster glyphs are
     square-viewBox and centred, so the ink circumradius is what decides the
     floor: at this 28px box the clip radius is 13px (S/2 - 1px border) and the
     content box is 20px, which renders ink radii of commander 11.3px,
     drone_front 10.7px, tank 9.9px, customer_service 8.2px. Tightest is
     commander.svg, whose floor is padding 1.52px — do not drop below 2px.
     Re-measure with a rasterizing ink scan if any icon is swapped. */
  object-fit: contain;
  padding: 3px;
  box-sizing: border-box;
  background: #f3f4f6;
  border: 1px solid #e5e5ea;
}

.msg__body {
  min-width: 0;
  max-width: 78%;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.msg--own .msg__body {
  align-items: flex-end;
}

.msg__name {
  font-size: 0.68rem;
  color: #6b7280;
}

.msg__bubble {
  font-size: 0.85rem;
  line-height: 1.45;
  padding: 8px 11px;
  border-radius: 12px;
  background: #f3f4f6;
  color: #111827;
  border: 1px solid #e5e5ea;
  /* pre-wrap: a Shift+Enter newline in the draft must survive into the bubble. */
  white-space: pre-wrap;
  word-break: break-word;
}

.msg--own .msg__bubble {
  background: #007aff;
  border-color: #007aff;
  color: #ffffff;
}

/* Screenshot bubble: neutral frame around the image (the blue own-message
   fill would tint nothing but look wrong as a thick border), tight padding,
   and the image itself capped so a full-viewport still stays readable in
   the narrow transcript column. Click = download the PNG. */
.msg__bubble--shot,
.msg--own .msg__bubble--shot {
  background: #ffffff;
  border-color: #e5e5ea;
  padding: 4px;
}

.msg__shot {
  display: block;
  max-width: 260px;
  max-height: 180px;
  border-radius: 8px;
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

/* Machine teammates (drone / tank) double as FPV selectors: clicking one
   makes it the active asset and lifts the main panel into its Steer view. */
.assistant__team-mate--machine {
  cursor: pointer;
  border-radius: 10px;
}

.assistant__team-mate--machine:hover .assistant__team-avatar {
  border-color: #007aff;
}

/* The fleet's ACTIVE machine: blue ring around its avatar. */
.assistant__team-mate--active .assistant__team-avatar {
  border-color: #007aff;
  box-shadow: 0 0 0 2px rgba(0, 122, 255, 0.35);
}

.assistant__team-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  /* contain + padding, matching .msg__avatar. Every roster viewBox is square
     and centred on its own ink now — tank.svg was re-centred for this, since
     its stock iconfont box left the tank 18.4% of the frame height too low.

     padding 4px floor: clip radius is 16px (34/2 - 1px border), content box
     24px, rendered ink radii commander 13.6px / drone_front 12.9px /
     tank 11.9px / customer_service 9.9px. commander.svg sets the floor at
     padding 1.87px — do not drop below 2px. */
  object-fit: contain;
  padding: 4px;
  box-sizing: border-box;
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
