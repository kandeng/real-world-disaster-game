// games/demo-wildfire/render/bindings.js — the package's L2 RENDER BINDINGS aggregator.
//
// Pure content, dependency-free ESM: runs identically in the core Web Worker and
// in plain Node, and touches NO browser API (the one rule). This module no longer
// OWNS the bindings — each agent folder declares its own (agents/*/render.js) and
// the environment declares its cell ramp (environment/render.js). This file
// AGGREGATES them into the single table the host relay reads, and keeps the
// stable public surface the engine depends on:
//   • named exports RENDER_BINDINGS / cellColorOf / FALLBACK_STYLE — the host's
//     "no createRenderBindings()" fallback path reads these directly, and
//   • createRenderBindings() -> { styles, cellColorOf, fallback, cell, bindings, cast }.
//
// Because the styles are PACKAGE-DECLARED, the engine stays domain-agnostic:
// adding a dry-ice drone or dropping a character edits only an agents/*/render.js
// (and the roster) — never client/src/engine or client/src/workers. That is the
// litmus. `cast` (archetype -> { avatarUrl, displayName, kind }) lets the host
// build the chatbot roster + 2D plan badges FROM the package instead of
// hardcoding a cast — so a different game's characters need zero client edits.

import { DRONE_BINDINGS } from '../agents/drone/render.js';
import { COMMANDER_BINDINGS } from '../agents/commander/render.js';
import { STAFF_BINDINGS } from '../agents/staff/render.js';
import { CELL, cellColorOf, CELL_BINDING } from '../environment/render.js';

// archetype -> the engine primitive (BY NAME) + the style params the generic
// scene model understands (kind, meshUrl, avatarUrl, color, modelScale, radiusPx,
// displayName, avatarKind). A binding with kind:'model' (or a meshUrl) draws as a
// 3D GLB; else a flat marker. Composed from the per-agent modules so each
// character owns its own appearance.
export const RENDER_BINDINGS = Object.freeze({
  ...DRONE_BINDINGS,
  ...COMMANDER_BINDINGS,
  ...STAFF_BINDINGS,
});

// The neutral style an UNKNOWN archetype degrades to (degrade never break): the
// engine's scene model merges this under any per-archetype binding.
export const FALLBACK_STYLE = Object.freeze({ kind: 'marker', color: '#9ca3af', radiusPx: 6, scale: 1 });

// Re-exported for back-compat: earlier revisions of this module owned the cell
// ramp directly, and callers may still read these off render/bindings.js.
export { CELL, cellColorOf, CELL_BINDING };

/**
 * buildCast(bindings) -> archetype -> { avatarUrl, displayName, kind }.
 * The chatbot / 2D-badge view of the cast, DERIVED from the same per-agent
 * bindings so the roster can never drift from what actually renders. `kind` is
 * the character category (avatarKind: 'machine' | 'human' | 'staff'), NOT the
 * render `kind`.
 */
function buildCast(bindings) {
  const cast = {};
  for (const [archetype, b] of Object.entries(bindings)) {
    cast[archetype] = {
      avatarUrl: b.avatarUrl || null,
      displayName: b.displayName || archetype,
      kind: b.avatarKind || (b.kind === 'model' ? 'machine' : 'human'),
    };
  }
  return cast;
}

/**
 * createRenderBindings() -> the bundle the host relay feeds the scene model:
 *   { styles, cellColorOf, fallback, cell, bindings, cast }
 * `styles` is the archetype -> style table sceneModel.setStyles() consumes;
 * `cast` is the archetype -> { avatarUrl, displayName, kind } roster view the
 * host uses to build the chatbot team + 2D plan badges from the package.
 */
export function createRenderBindings() {
  const styles = {};
  for (const archetype of Object.keys(RENDER_BINDINGS)) styles[archetype] = RENDER_BINDINGS[archetype];
  return {
    styles,
    cellColorOf,
    fallback: FALLBACK_STYLE,
    cell: CELL_BINDING,
    bindings: RENDER_BINDINGS,
    cast: buildCast(RENDER_BINDINGS),
  };
}

export default createRenderBindings;
