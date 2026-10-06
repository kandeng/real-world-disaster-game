// engine/agents/geo.js — E6: minimal geodesy for the generic agent world.
//
// The engine is domain-agnostic but geospatial: agents live on a lon/lat world
// (the reused Cesium/Google-Maps globe). These are the pure, dependency-free
// helpers every package's capabilities share — distance, degree/metre
// conversion, bounds clamping — so a package never re-derives them and the
// engine never bakes in a domain. Same flat-earth approximation the fire sim
// uses (fine at neighbourhood scale, which is the play scale); no browser APIs.
//
// Pose convention (matches the package controllers' getState().pose):
//   { lon, lat, alt?, headingDeg? }   headingDeg = compass, 0 = north, CW.

export const METERS_PER_DEG_LAT = 111320;
const DEG2RAD = Math.PI / 180;

/** Metres per degree of longitude at a given latitude (cosine-scaled). */
export function metersPerDegLon(lat) {
  return METERS_PER_DEG_LAT * Math.max(0.2, Math.cos((Number(lat) || 0) * DEG2RAD));
}

/** Metres per degree of latitude (≈ constant). */
export function metersPerDegLat() {
  return METERS_PER_DEG_LAT;
}

/**
 * Approximate ground distance in metres between two {lon,lat} points using an
 * equirectangular projection about the mean latitude. Accurate to <0.5% at the
 * kilometre scale the games play at; deterministic and allocation-free.
 */
export function distanceM(a, b) {
  if (!a || !b) return Infinity;
  const lat = ((Number(a.lat) || 0) + (Number(b.lat) || 0)) / 2;
  const dx = ((Number(b.lon) || 0) - (Number(a.lon) || 0)) * metersPerDegLon(lat);
  const dy = ((Number(b.lat) || 0) - (Number(a.lat) || 0)) * METERS_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/**
 * Offset a {lon,lat} by east/north metres, returning a new point. The inverse
 * of distanceM for small deltas; used by moveTo-style actuators.
 */
export function offsetMeters(point, eastM, northM) {
  const lat = Number(point?.lat) || 0;
  return {
    lon: (Number(point?.lon) || 0) + eastM / metersPerDegLon(lat),
    lat: lat + northM / METERS_PER_DEG_LAT,
  };
}

/** Compass bearing (deg, 0 = north, CW) from a to b. */
export function bearingDeg(a, b) {
  const lat = ((Number(a.lat) || 0) + (Number(b.lat) || 0)) / 2;
  const dx = ((Number(b.lon) || 0) - (Number(a.lon) || 0)) * metersPerDegLon(lat);
  const dy = ((Number(b.lat) || 0) - (Number(a.lat) || 0)) * METERS_PER_DEG_LAT;
  return (Math.atan2(dx, dy) / DEG2RAD + 360) % 360;
}

/** Clamp a number into [lo, hi] (NaN-safe: falls back to lo). */
export function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Clamp a {lon,lat} into world bounds {lonMin,latMin,lonMax,latMax} (if given).
 * The intent pipeline's spatial gate: an actuator target can never leave the
 * authored world, whatever a model or a stray order asked for.
 */
export function clampToBounds(lon, lat, bounds) {
  if (!bounds) return { lon: Number(lon) || 0, lat: Number(lat) || 0 };
  return {
    lon: clamp(lon, bounds.lonMin, bounds.lonMax),
    lat: clamp(lat, bounds.latMin, bounds.latMax),
  };
}

/** Shortest-arc compass delta b-a in (-180, 180]. */
export function angleDeltaDeg(a, b) {
  return ((b - a + 540) % 360) - 180;
}
