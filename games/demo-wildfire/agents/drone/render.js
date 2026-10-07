// games/demo-wildfire/agents/drone/render.js — the drone archetypes' RENDER BINDING.
//
// Pure content, dependency-free ESM (the one rule): declares HOW the waterDrone
// and dryIceDrone archetypes are drawn by referencing the engine's generic L2
// primitive BY NAME ('engine:modelOverlay') plus a PACKAGE-RELATIVE meshUrl and
// avatarUrl. render/bindings.js aggregates this table; the host (L3) resolves
// the relative URLs against the package baseUrl before painting.
//
// Both variants share ONE airframe mesh + avatar; the dry-ice drone is tinted a
// cold white so the two suppression roles read apart at a glance. The avatar is
// package-declared (mirrors meshUrl) so the chatbot icon + 2D plan badge never
// hardcode a cast — a different game ships different avatars and nothing in the
// client changes.
//
// Field notes:
//   primitive    the engine L2 primitive, referenced BY NAME (never imported).
//   kind         the RENDER kind ('model' draws a 3D GLB; 'marker' a flat dot).
//   meshUrl      package-relative GLB; the host lazily fetches it for the 3D view.
//   modelScale   host mm->m factor (see agents/drone/drone.json).
//   avatarUrl    package-relative SVG for the 2D plan marker + chatbot icon.
//   displayName  the human-facing name the chatbot/badge shows (package-declared).
//   avatarKind   the character category surfaced to the cast as `kind`
//                ('machine' | 'human' | 'staff'); distinct from the render `kind`.

const MESH_URL = 'meshes/drone_dji_air3.glb';
const AVATAR_URL = 'agents/drone/avatar.svg';

export const DRONE_BINDINGS = Object.freeze({
  waterDrone: {
    primitive: 'engine:modelOverlay',
    kind: 'model',
    meshUrl: MESH_URL,
    modelScale: 0.1,
    color: '#38bdf8',
    avatarUrl: AVATAR_URL,
    displayName: 'Water Drone',
    avatarKind: 'machine',
  },
  dryIceDrone: {
    primitive: 'engine:modelOverlay',
    kind: 'model',
    meshUrl: MESH_URL,
    modelScale: 0.1,
    color: '#e2e8f0',
    avatarUrl: AVATAR_URL,
    displayName: 'Dry-Ice Drone',
    avatarKind: 'machine',
  },
});

export default DRONE_BINDINGS;
