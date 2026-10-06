// games/demo-wildfire/agents/roster.js — the initial CAST.
//
// This is the ONLY place the flagship decides WHO exists at spawn. The litmus
// test lives here: removing the tank and adding a dry-ice drone is a one-line
// edit to this list — no engine file changes. Positions seed from the
// environment bounds when the loader supplies the environment (so the cast sits
// inside the playable world), else a sensible default extent.
//
// Thin proof cast: one human commander, one optional VLM staff, two water drones,
// and ONE dry-ice drone (the package-declared capability that proves separation).
// No tank.

import { ARCHETYPES } from './archetypes/index.js';

const FALLBACK_BOUNDS = { lonMin: -118.55, latMin: 34.02, lonMax: -118.5, latMax: 34.085 };

/**
 * createRoster(env, options) -> [agentSpec, ...] for runtime.addAgents().
 * `env` is the attached environment (its bounds frame the spawn); optional.
 */
export function createRoster(env, options = {}) {
  const b = (env && env.bounds) || FALLBACK_BOUNDS;
  const cx = (b.lonMin + b.lonMax) / 2;
  const cy = (b.latMin + b.latMax) / 2;
  const south = b.latMin + (b.latMax - b.latMin) * 0.08;

  return [
    ARCHETYPES.commander({ id: 'commander', lon: cx, lat: south }),
    ARCHETYPES.staff({ id: 'staff', lon: cx, lat: south }),
    ARCHETYPES.waterDrone({ id: 'drone-w1', lon: b.lonMin, lat: cy, speedMps: 18 }),
    ARCHETYPES.waterDrone({ id: 'drone-w2', lon: b.lonMax, lat: cy, speedMps: 18 }),
    ARCHETYPES.dryIceDrone({ id: 'drone-d1', lon: cx, lat: b.latMax, speedMps: 20 }),
  ];
}

export default createRoster;
