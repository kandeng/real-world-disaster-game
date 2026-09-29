// ── Team chat: transcript + mention routing (Phase A, local echo) ────────────
// Owns the AssistantPanel conversation. The commander posts into the transcript;
// every teammate they @mention answers.
//
// PHASE A IS AN ECHO, NOT AN AGENT. Each mentioned teammate replies with the
// commander's text verbatim. That is a deliberate smoke test: it proves the
// composer, the mention parser, the per-sender transcript rendering and the
// roster all line up BEFORE any agent exists to hide behind. What survives into
// the real implementation is the routing — `mentionedMates()` below, i.e. which
// teammate a message is addressed to. What gets replaced is `replyFrom()`, which
// stops echoing and instead hands the message to that teammate's DSH agent
// worker and appends whatever comes back. Keeping the echo this small is the
// point: the seam is one function, so swapping it cannot disturb the routing.
//
// Replies are appended synchronously. No timers, no fake typing latency, so the
// transcript is deterministic and a test can assert on it immediately after
// `send()` returns. Latency and streaming arrive with the real agent, where they
// are a property of the network rather than something to simulate.
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { TEAM, COMMANDER_ID, mateById } from './useTeamRoster.js';
import { matchMentions } from './mentions.js';

// Module-level, not per-call: the conversation belongs to the session, not to
// one mounting of the panel. AppShell keeps AssistantPanel mounted today, but a
// future route change or a collapsible assistant column must not wipe history.
const messages = ref([]);
let sequence = 0;

function nextId() {
  sequence += 1;
  return `msg-${sequence}`;
}

export function useTeamChat() {
  const { t } = useI18n();

  /** Display name for a sender id, resolved live so it follows the locale. */
  function displayName(id) {
    const mate = mateById(id);
    return mate ? t(mate.nameKey) : id;
  }

  function avatarOf(id) {
    const mate = mateById(id);
    return mate ? mate.avatar : null;
  }

  // A teammate answers to its stable id AND to its localized display name, so
  // `@drone` works in English and `@参谋` works in Chinese without the player
  // having to know the underlying handle.
  function mentionCandidates() {
    return TEAM.filter((mate) => mate.id !== COMMANDER_ID).map((mate) => ({
      id: mate.id,
      aliases: [mate.id, t(mate.nameKey)],
    }));
  }

  /**
   * Teammates addressed by `text`, in roster order. The commander is excluded:
   * the human is the one typing, so a self-mention must not self-reply.
   */
  function mentionedMates(text) {
    return matchMentions(text, mentionCandidates()).map((hit) => mateById(hit.id)).filter(Boolean);
  }

  function append(from, text, extra = {}) {
    const message = { id: nextId(), from, own: from === COMMANDER_ID, text, at: Date.now(), ...extra };
    messages.value = [...messages.value, message];
    return message;
  }

  /** One teammate's answer to `text`. Phase A: echo it back untouched. */
  function replyFrom(mate, text) {
    return append(mate.id, text, { echoOf: COMMANDER_ID });
  }

  /**
   * Post the commander's message, then let everyone they mentioned answer.
   * @param {string} text raw composer draft
   * @returns {{text: string, replies: string[]}|null} null if nothing was sent
   */
  function send(text) {
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) return null;
    append(COMMANDER_ID, body);
    const mates = mentionedMates(body);
    for (const mate of mates) replyFrom(mate, body);
    return { text: body, replies: mates.map((mate) => mate.id) };
  }

  function clear() {
    messages.value = [];
  }

  return { messages, send, clear, mentionedMates, displayName, avatarOf };
}
