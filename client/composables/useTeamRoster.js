// ── Team roster (static, Phase A) ────────────────────────────────────────────
// The teammates shown in the AssistantPanel "Team" popover, and the senders of
// every transcript message. One entry per chatroom participant: the human
// commander, the AI staff, and every machine asset (each machine's agent is a
// dedicated teammate).
//
// Names are localized: each entry carries a `nameKey` resolved through the
// shared vue-i18n instance (keys live in AssistantPanel.[locale].i18n.json).
//
// `id` doubles as the chat handle. The commander mentions a teammate by typing
// `@<id>` — or `@<localized name>`, which useTeamChat.js also accepts — and the
// message is routed to whoever matches. Keep ids lowercase and free of spaces
// so they stay typeable, and remember an id is load-bearing: renaming one here
// silently breaks every `@mention` a player has learned to type.
//
// Avatars are the monochrome glyphs in client/icons/, the same set MapView.vue
// and ConfigurableIcon resolve, so the whole UI speaks one icon language.
// NOTE: client/src/config/IconConfig.js EAGERLY globs icons/*.svg, so every
// file sitting in that folder ships in the bundle whether or not it is
// referenced — see the "Unused assets" section of the root .gitignore.
//
// ── TO REPLACE A TEAMMATE'S AVATAR, OR ADD A NEW TEAMMATE ───────────────────
// 1. Put the artwork in client/icons/ — NOWHERE ELSE. Not
//    assets/media/teammates/ (deleted for exactly this reason: it collected
//    avatar placeholders that nothing imported), not assets/media/, not
//    public/. client/icons/ is the one folder the whole UI reads glyphs from.
// 2. `git add` it. Tracking is NOT optional: the import below is resolved at
//    build time, so an untracked avatar builds fine on this machine and breaks
//    the next fresh clone. No .gitignore change is needed — the "Unused assets"
//    section blacklists unreferenced glyphs BY NAME, so a new file in
//    client/icons/ is tracked by default. Do not add a rule for it.
// 3. Import it here and set the roster entry's `avatar:` to that import.
// 4. Measure it against the circle (below) before shipping.
//
// Format: an SVG is strongly preferred — it stays crisp at the 34px / 28px the
// panel renders, and a monochrome glyph matches the rest of the UI. Because the
// avatar is a plain Vite asset import rather than an IconConfig key, any format
// Vite can import (.png, .jpg, .webp) also works if the artwork is a photo; it
// just will not scale, and it skips the icon language.
//
// Every avatar is drawn into a CIRCLE (border-radius: 50%) with object-fit:
// contain, so a glyph only looks right if its ink is both centred in its own
// viewBox and inscribed in that viewBox's incircle. All four were measured by
// rasterizing them and scanning ink pixels; see the padding floors recorded on
// .assistant__team-avatar / .msg__avatar in AssistantPanel.vue before changing
// either the icons or that padding.
//
// A NEW icon has to pass the same measurement: square viewBox, ink bbox centred
// on it (compare centres in viewBox-LOCAL coords), and ink circumradius <= half
// the box, or the circle clips it. Fix a miss by editing the viewBox, never the
// path data — tank.svg carries the worked example, and drone_front.svg is what
// a correctly-centred icon looks like out of the box. Also leave at least 2px of
// padding at the smallest rendered size: commander.svg already sits at 1.87px,
// so it sets the floor for everyone.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import commanderIcon from '../icons/commander.svg';
import staffIcon from '../icons/customer_service.svg';
// drone_front.svg (front elevation) is the avatar; drone.svg (plan view) stays
// the map marker in MapView.vue. Both remain in the bundle.
import droneIcon from '../icons/drone_front.svg';
// tank.svg's viewBox was re-centred on its artwork for exactly the reason above:
// the stock iconfont box left the tank sitting in the bottom of the frame.
import tankIcon from '../icons/tank.svg';

// Exported (not just closure-local) because useTeamChat.js routes mentions
// against the same list the popover renders: one roster, one source of truth.
export const TEAM = [
  { id: 'commander', nameKey: 'assistantpanel.mate_commander', kind: 'human', avatar: commanderIcon },
  { id: 'staff01', nameKey: 'assistantpanel.mate_staff', kind: 'staff', avatar: staffIcon },
  { id: 'drone', nameKey: 'assistantpanel.mate_drone', kind: 'machine', avatar: droneIcon },
  { id: 'tank', nameKey: 'assistantpanel.mate_tank', kind: 'machine', avatar: tankIcon },
];

// The human player's own handle: outgoing messages are stamped with it, and a
// self-mention must never produce a reply.
export const COMMANDER_ID = 'commander';

// The AI staff officer's handle. Exported for the same reason COMMANDER_ID is:
// the id is load-bearing and there must be exactly one spelling of it in the
// codebase. Staff is additionally the DEFAULT responder — a commander message
// that @mentions nobody is routed to them, exactly as if it had said `@staff`
// (see `respondersFor()` in useTeamChat.js).
export const STAFF_ID = 'staff01';

const BY_ID = new Map(TEAM.map((mate) => [mate.id, mate]));

/** @returns {object|null} the raw roster entry for an id, or null. */
export function mateById(id) {
  return BY_ID.get(id) || null;
}

export function useTeamRoster() {
  const { t } = useI18n();
  // Resolve display names reactively so they follow the active locale.
  const team = computed(() => TEAM.map((mate) => ({ ...mate, name: t(mate.nameKey) })));
  return { team };
}
