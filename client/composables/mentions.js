// ── @mention parsing (pure) ─────────────────────────────────────────────────
// Deliberately dependency-free: no Vue, no vue-i18n, no asset imports. That is
// what makes the routing rule testable in plain Node (`node mentions.test.mjs`)
// instead of only inside a running browser, and it keeps useTeamChat.js free of
// string/regex plumbing.
//
// Living in composables/ alongside wsUrl.js, which is likewise a pure helper
// rather than a composable — this repo has no separate utils/ directory.

/**
 * A handle is `@` followed by word characters, `-`, or any CJK ideograph, so
 * `@drone`, `@staff01` and `@参谋` all parse. `\u4e00-\u9fff` covers the CJK
 * Unified Ideographs block, which is where every localized teammate name in
 * AssistantPanel.zh.i18n.json lives.
 *
 * Not matched, on purpose:
 *   - `@` alone, and `@` followed by punctuation (`@,` `@.`) -> no handle.
 *   - Ids containing a space. Roster ids must stay single-token (see
 *     useTeamRoster.js); a two-word display name is only mentionable through
 *     its first word, which is why the id is the canonical handle.
 *   - Emails (`a@drone.com`) DO yield the handle `drone`. Accepted: a false
 *     positive here merely produces one extra echo, and rejecting it would mean
 *     guessing whether the composer is writing prose or an address.
 */
const HANDLE_SOURCE = '@([\\w\\-\\u4e00-\\u9fff]+)';

/**
 * Every handle mentioned in `text`, lower-cased, de-duplicated, in the order
 * first written.
 * @param {string} text
 * @returns {string[]}
 */
export function extractHandles(text) {
  if (typeof text !== 'string' || !text) return [];
  // Built per call: a module-level /g regex would carry `lastIndex` state
  // between callers, which is exactly the kind of hidden coupling that makes a
  // "pure" helper impure.
  const re = new RegExp(HANDLE_SOURCE, 'g');
  const handles = [];
  for (const match of text.matchAll(re)) {
    const handle = match[1].toLowerCase();
    if (handle && !handles.includes(handle)) handles.push(handle);
  }
  return handles;
}

/**
 * Which candidates does `text` mention?
 *
 * Matching is exact-per-handle and case-insensitive; a candidate may offer
 * several aliases (its stable id plus its localized display name). Results keep
 * CANDIDATE order, not the order the handles were typed, so replies always
 * arrive in roster order no matter how the commander wrote the message.
 *
 * @param {string} text
 * @param {Array<{id: string, aliases: string[]}>} candidates
 * @returns {Array<{id: string, aliases: string[]}>} the mentioned candidates
 */
export function matchMentions(text, candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const handles = extractHandles(text);
  if (!handles.length) return [];
  const wanted = new Set(handles);
  return candidates.filter(
    (candidate) =>
      candidate &&
      Array.isArray(candidate.aliases) &&
      candidate.aliases.some((alias) => wanted.has(String(alias).toLowerCase())),
  );
}
