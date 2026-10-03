// Rough perimeter of the Palisades Fire (Los Angeles, January 2025).
// The Plan view draws it as the disaster-zone overlay; the demo plot
// (fire agent, distance answers) will later own this shape as live state.
export const PALISADES_FIRE = {
  center: { lat: 34.048, lng: -118.532 },
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
};

// Rough Santa Monica Bay water mask: the disaster-zone perimeter above has a
// southern lobe over the ocean, and the fire simulation must never burn water.
// Coastline runs Topanga Beach -> Santa Monica; the polygon closes south of
// the sim grid, so only the bay inside the perimeter matters.
export const SANTA_MONICA_BAY = [
  [34.0465, -118.580],
  [34.0405, -118.565],
  [34.0300, -118.545],
  [34.0215, -118.525],
  [34.0120, -118.508],
  [34.0040, -118.495],
  [33.9800, -118.495],
  [33.9800, -118.580],
];

// 2D map height (m) the Plan view opens at — roughly zoom 12, so the
// whole disaster zone plus the neighbouring towns fit on screen.
export const PLAN_VIEW_ALT = 5200;
