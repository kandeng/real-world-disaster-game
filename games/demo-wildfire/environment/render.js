// games/demo-wildfire/environment/render.js — the fire-grid RENDER ramp.
//
// Pure content, dependency-free ESM (the one rule): the ENVIRONMENT's part of the
// L2 render bindings. It declares HOW the fire cellular automaton's cells are
// painted by referencing the engine's generic 'engine:cellGridOverlay' primitive
// BY NAME, plus the value -> colour ramp. render/bindings.js aggregates this
// alongside the per-agent bindings; the host reads createRenderBindings().
//
// The cell states mirror the fire sim (environment/fire_sim.js CELL). Kept as a
// local legend so this module stays dependency-free; the values are the contract
// between the sim and its colour ramp.

export const CELL = Object.freeze({ UNBURNED: 0, BURNING: 1, ASH: 2, WET: 3, NO_FUEL: 4 });

/**
 * cellColorOf(value) -> a CSS colour, or null to leave the cell transparent.
 * The fire palette: unburned ground shows nothing, the active front burns hot
 * orange, the burn scar is near-black, soaked ground is a dark blue-grey, and
 * non-fuel terrain (the bay) is a faint slate so it reads as "cannot burn".
 */
export function cellColorOf(value) {
  switch (value) {
    case CELL.BURNING: return 'rgba(255, 140, 26, 0.85)';
    case CELL.ASH:     return 'rgba(20, 19, 18, 0.82)';
    case CELL.WET:     return 'rgba(38, 54, 74, 0.60)';
    case CELL.NO_FUEL: return 'rgba(120, 120, 120, 0.12)';
    case CELL.UNBURNED:
    default:           return null;
  }
}

// The environment raster binding: which primitive paints the cell grid + the
// value->colour ramp above.
export const CELL_BINDING = Object.freeze({ primitive: 'engine:cellGridOverlay', colorOf: cellColorOf });

export default CELL_BINDING;
