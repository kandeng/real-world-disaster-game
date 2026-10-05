// controller_fire.js — game-package component: the Palisades fire SCENARIO.
//
// This file is the output format of the scene-authoring tool
// (tools/geo-editor.html, exporter lands next): the developer draws the
// disaster polygon, clicks ignition spots and sets the wind timeline there,
// and the tool emits exactly this shape. Until then this hand-written
// reference instance defines the contract.
//
// Contract (same family as controller_drone.js / controller_tank.js):
//   • PURE DATA + factory. No imports, no DOM, no engine internals: the
//     polygon and every number are inlined so the package stays standalone.
//   • createFireScenario() returns the config object fire_sim.js consumes:
//     perimeter / noFuelPolygons / ignitions / wind.keyframes / loss / grid.
//   • The perimeter is HIDDEN GAME STATE: only the sim and the loss check
//     ever see it. No renderer receives it; players see fire, never the zone.
//
// Scenario beats encoded below:
//   • One ignition at the perimeter centre at t=0 (the Palisades ignition).
//   • Santa Ana (toward 225 deg, 12 m/s) for the first 20 min, strengthening
//     and veering to 245 deg/16 m/s, then an evening onshore eddy 205 deg/6
//     m/s — the front bends twice mid-run.
//   • Loss when the fire occupies 100% of the fuel cells inside the polygon.

export const FIRE_SCENARIO_API = 1;

export function createFireScenario() {
  return {
    // Disaster-zone boundary, [lat, lon] pairs. Hidden from players.
    perimeter: [
      [34.085, -118.545],
      [34.075, -118.51],
      [34.055, -118.495],
      [34.03, -118.5],
      [34.01, -118.52],
      [34.005, -118.55],
      [34.02, -118.575],
      [34.05, -118.58],
      [34.07, -118.565],
    ],
    // Santa Monica Bay: the perimeter's southern lobe is ocean; water never
    // burns and the front halts at the coastline.
    noFuelPolygons: [
      [
        [34.0465, -118.580],
        [34.0405, -118.565],
        [34.0300, -118.545],
        [34.0215, -118.525],
        [34.0120, -118.508],
        [34.0040, -118.495],
        [33.9800, -118.495],
        [33.9800, -118.580],
      ],
    ],
    // Ignition spots clicked by the developer; atSimS = scenario beat time.
    ignitions: [
      { lon: -118.532, lat: 34.048, radiusM: 150, atSimS: 0 },
    ],
    wind: {
      // Fallback before/without keyframes.
      toDeg: 225,
      speedMps: 12,
      // Piecewise-linear timeline: (sim seconds, compass toward, m/s).
      keyframes: [
        { tS: 0, toDeg: 225, speedMps: 12 },
        { tS: 1200, toDeg: 245, speedMps: 16 },
        { tS: 2400, toDeg: 205, speedMps: 6 },
      ],
    },
    // Game over: fire occupies the whole polygon (watered cells don't count).
    loss: { occupyFrac: 1.0 },
    cellSizeM: 60,
    seed: 7,
  };
}

export function describe() {
  return {
    api: FIRE_SCENARIO_API,
    kind: 'wild-fire scenario (generated scene-asset data)',
    consumes: 'fire_sim.js createFireSim(createFireScenario())',
    hidden: ['perimeter', 'noFuelPolygons', 'loss'],
    beats: ['ignitions at atSimS', 'wind keyframe shifts'],
    commands: ['createFireScenario', 'describe'],
  };
}

export default createFireScenario;
