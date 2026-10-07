// games/demo-wildfire/agents/staff/render.js — the staff RENDER BINDING.
//
// Pure content, dependency-free ESM (the one rule). The staff (optional VLM
// advisor) is a PACKAGE character anchored at the command post, so it draws as a
// flat marker via the engine's generic 'engine:markerOverlay' primitive
// (referenced BY NAME). The avatar is package-declared (avatarUrl) so the 2D plan
// badge + chatbot icon come from the package, never a hardcoded client glyph.
//
// NOTE: the old binding carried `icon: 'staff'` (a NAME the client resolved to a
// bundled svg). That is replaced by `avatarUrl` (a package-relative URL the host
// resolves against the baseUrl) so no client-side icon map is needed.

const AVATAR_URL = 'agents/staff/avatar.svg';

export const STAFF_BINDINGS = Object.freeze({
  staff: {
    primitive: 'engine:markerOverlay',
    kind: 'marker',
    color: '#a78bfa',
    radiusPx: 8,
    avatarUrl: AVATAR_URL,
    displayName: 'Staff Officer',
    avatarKind: 'staff',
  },
});

export default STAFF_BINDINGS;
