// ── Team roster (package-driven) ─────────────────────────────────────────────
// The teammates shown in the AssistantPanel "Team" popover, and the senders of
// every transcript message. This module no longer hardcodes ANY cast: it is a
// thin adapter over the shared package-driven cast store (useAgentCast.js).
//
// WHO is on the team — ids, display names, avatars, and the human/machine/staff
// kind — is declared by the ACTIVE GAME PACKAGE's render bindings, not here. A
// different game ships a different cast and nothing in the client changes. That
// is the whole point of the agent paradigm: the client names no domain.
//
// The store is fed from two places (see useAgentCast.js):
//   • AppShell boot-loads the active package's cast on mount, so the roster is
//     populated even without the agent worker (the default, non-?agentDemo app).
//   • useAgentScene (?agentDemo=1) feeds the LIVE spawned agents, so the roster
//     becomes per-agent (e.g. two water drones → two entries) and tracks poses.
//
// `id` doubles as the chat handle: the commander mentions a teammate by typing
// `@<id>` (case-insensitive) — or `@<display name>` — and useTeamChat.js routes
// the message to whoever matches. Package ids stay single-token (no spaces) so
// they remain typeable; see mentions.js for the parsing rule.
//
// NOTE ON NAMES: display names come from the package's `displayName` and are
// therefore NOT localized through vue-i18n — the client cannot translate names
// it does not know about. This is the accepted trade-off of a generic client.
import { useAgentCast } from './useAgentCast.js';

/**
 * The reactive team roster for the AssistantPanel popover.
 * @returns {{ team: import('vue').ComputedRef<Array> }} one entry per teammate:
 *   `{ id, archetype, kind, name, avatar, lon?, lat?, alt?, headingDeg? }`.
 */
export function useTeamRoster() {
  const { roster } = useAgentCast();
  return { team: roster };
}
