// games/demo-wildfire/agents/commander/render.js — the commander RENDER BINDING.
//
// Pure content, dependency-free ESM (the one rule). The commander is a PACKAGE
// character anchored at its command post, so it draws as a flat marker via the
// engine's generic 'engine:markerOverlay' primitive (referenced BY NAME). The
// avatar is package-declared (avatarUrl) so the 2D plan badge + chatbot icon
// come from the package, never a hardcoded client glyph.
//
// NOTE: the old binding carried `icon: 'commander'` (a NAME the client resolved
// to a bundled svg). That is replaced by `avatarUrl` (a package-relative URL the
// host resolves against the baseUrl) so no client-side icon map is needed.

const AVATAR_URL = 'agents/commander/avatar.svg';

export const COMMANDER_BINDINGS = Object.freeze({
  commander: {
    primitive: 'engine:markerOverlay',
    kind: 'marker',
    color: '#f59e0b',
    radiusPx: 9,
    avatarUrl: AVATAR_URL,
    displayName: 'Commander',
    avatarKind: 'human',
  },
});

export default COMMANDER_BINDINGS;
