// games/demo-wildfire/environment/environment.js — the package ENVIRONMENT.
//
// The world the agents perceive and act on. It adapts this package's fire
// cellular automaton to the engine's GENERIC environment contract (see
// client/src/engine/agents/world/environment.js): { bounds, grid, cellAt, tick,
// snapshot, capabilities }. The engine attaches it without ever naming fire — it
// only reads this contract, applies the bounds, registers the capabilities, and
// ticks it before the agents each step.
//
// Layout note: the fire cellular automaton + scenario live as pure-JS modules
// under assets/fire/ (fire_sim.js, controller_fire.js). This adapter is the
// ONLY runtime importer; the dev viewers (dev/fire_sim_viewer.html,
// tools/geo-editor.html) import the same modules directly. E6.9 retired the
// legacy scene.json + engine driver path, so the sim is now package content
// with no engine-side driver — it renders through the generic cellGridOverlay.
//
// One rule: pure JS, no browser APIs. The sim renders nothing; the engine's L2
// cellGridOverlay reads snapshot()/changes() through render/bindings.js.

import { createFireSim } from '../assets/fire/fire_sim.js';
import { createFireScenario } from '../assets/fire/controller_fire.js';
import { PACKAGE_CAPABILITIES } from '../capabilities/index.js';

/**
 * createEnvironment(options) -> the generic environment object.
 *   options.scenarioFactory?  override the scenario source (default the shipped one)
 *   options.seed?             override the sim seed (default the scenario's)
 *   options.cellSizeM?        override the grid pitch (default the scenario's)
 */
export function createEnvironment(options = {}) {
  const scenarioFactory = typeof options.scenarioFactory === 'function' ? options.scenarioFactory : createFireScenario;
  const scenario = scenarioFactory() || {};
  const config = { ...scenario };
  if (Number.isFinite(options.seed)) config.seed = options.seed;
  if (Number.isFinite(options.cellSizeM)) config.cellSizeM = options.cellSizeM;

  const sim = createFireSim(config);
  const g = sim.gridInfo();

  const bounds = {
    lonMin: g.lonMin,
    latMin: g.latMax - g.rows * g.cellDegLat,
    lonMax: g.lonMin + g.cols * g.cellDegLon,
    latMax: g.latMax,
  };
  const grid = {
    cols: g.cols, rows: g.rows,
    lonMin: g.lonMin, latMax: g.latMax,
    cellDegLon: g.cellDegLon, cellDegLat: g.cellDegLat,
  };

  const CELL = sim.CELL;
  let cellsSeeded = false;

  // Generic render relay (E6.9): the host's cellGridOverlay paints the fire grid
  // from OPAQUE value deltas the runtime forwards as 'agents.world'. The FIRST
  // call sends a full frame (so never-changing cells — the NO_FUEL bay — are
  // captured); later calls send only what changed since the previous frame, and
  // null when nothing did (so the runtime stays silent). Values are the sim's
  // CELL numbers; the engine forwards them untouched and render/bindings.js maps
  // value -> colour. This is package content: only the package knows its cells.
  function cellFrame() {
    if (!cellsSeeded) {
      cellsSeeded = true;
      sim.takeChanges();                       // drain: the full scan supersedes any pending delta
      const gi = sim.gridInfo();
      const cells = [];
      for (let r = 0; r < gi.rows; r++) {
        for (let c = 0; c < gi.cols; c++) {
          const v = gi.stateAt(c, r);
          if (v !== CELL.UNBURNED) cells.push([r * gi.cols + c, v]);
        }
      }
      return { grid, cells };
    }
    const ch = sim.takeChanges();
    const cells = [];
    const push = (list, v) => { for (const i of list || []) cells.push([i, v]); };
    push(ch.burning, CELL.BURNING);
    push(ch.ash, CELL.ASH);
    push(ch.wet, CELL.WET);
    push(ch.unburned, CELL.UNBURNED);
    return cells.length ? { grid, cells } : null;
  }

  return {
    bounds,
    grid,
    // Generic contract the engine reads:
    cellAt: (lon, lat) => sim.cellAt(lon, lat),
    tick: (dt) => { sim.tick(dt); },
    snapshot: () => sim.getState(),
    // Package extras (used by capabilities + render bindings, opaque to engine):
    hotspot: () => sim.hotspot(),
    changes: () => sim.takeChanges(),
    cellFrame,
    capabilities: PACKAGE_CAPABILITIES,
    sim,
    CELL: sim.CELL,
  };
}

export default createEnvironment;
