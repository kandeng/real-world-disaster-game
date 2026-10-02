// ── The fleet: machine assets + the ACTIVE asset + the test-phase autopilot ─
// The team has two machine assets — the drone (airborne, ~1000 m above ground)
// and the tank (ground vehicle, gimbal camera ~10 m above ground so the Google
// Earth 3D tiles keep a fine LOD in its first-person view). Both start near
// the LA (Palisades) fire zone, at DIFFERENT positions, and — for this test
// phase — both are driven automatically along hardcoded routes at hardcoded
// speeds. Future phases replace this driver with (1) pre-planned route
// playback and (2) manual Flight/Gimbal-disk control of the active asset; the
// active-asset plumbing below is built to survive that swap.
//
// ACTIVE ASSET: session.fleet.activeAssetId ('drone' | 'tank'). The Steer FPV
// camera follows the active asset, the Plan-view map icon highlights it, and
// selecting a machine teammate in the chat Team popover makes it active and
// switches the main panel to its first-person Steer view.
//
// Module-scoped singleton (same pattern as useDrone / useSessionState): the
// chat panel and the play view share one fleet and one active-asset pick.
import { computed, toRef } from 'vue';
import { useSessionState } from './useSessionState.js';
import { PALISADES_FIRE } from '@/config/palisadesFire.js';

/* global Cesium */

const { session } = useSessionState();

// ── Asset registry ──────────────────────────────────────────────────────────
// `pose` / `gimbal` are the reactive session objects themselves, so every
// existing consumer (physics, HUD, camera sync) keeps reading the drone
// exactly as before while new consumers can address either asset uniformly.
export const FLEET = [
  { id: 'drone', pose: session.drone, gimbal: session.gimbal },
  { id: 'tank', pose: session.tank, gimbal: session.tankGimbal },
];
const BY_ID = new Map(FLEET.map((a) => [a.id, a]));

const activeAssetId = toRef(session.fleet, 'activeAssetId');

/** Select which machine asset the Steer FPV follows ('drone' | 'tank'). */
function setActiveAsset(id) {
  if (BY_ID.has(id)) activeAssetId.value = id;
}

const activeAsset = computed(() => BY_ID.get(activeAssetId.value) || BY_ID.get('drone'));
const activeIsDrone = computed(() => activeAsset.value.id === 'drone');

// ── Hardcoded routes (test phase) ───────────────────────────────────────────
// Local planar approximation around the fire centre: good enough for patrol
// loops a few km across (cos(lat) folded into the longitude scale).
const C = PALISADES_FIRE.center;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((C.lat * Math.PI) / 180);

function offsetLatLng(dxM, dyM) {
  return { lat: C.lat + dyM / M_PER_DEG_LAT, lon: C.lng + dxM / M_PER_DEG_LON };
}

// Drone: analytic circular orbit, 2.5 km radius, clockwise, 20 m/s.
// DIAGNOSTIC TEST (commander-ordered): both machines fly 5000 m ABOVE GROUND
// to check whether the black Steer view was a low-altitude artefact (camera
// inside / below streamed tile geometry). Restore 1000 / 10 once concluded.
const DRONE_ORBIT_RADIUS = 2500;
const DRONE_SPEED = 20; // m/s
const DRONE_AGL = 5000; // m above ground (test value; was 1000)

// Tank: closed rectangular patrol ~3.2 km × 2.2 km south-west of the fire
// centre, 8 m/s on the ground, camera above the sampled surface.
const TANK_SPEED = 8; // m/s
const TANK_CAM_AGL = 5000; // m above ground (test value; was 10)
// The ground sample ray starts from a FIXED height above any coastal LA
// terrain instead of tankSurface + 600: an origin inside a hill would hit
// an interior face and bury the camera underground (black FPV view).
const TANK_SAMPLE_ORIGIN_ALT = 2000; // m above the ellipsoid
const TANK_LOOP = [
  offsetLatLng(-1600, -1100),
  offsetLatLng(1600, -1100),
  offsetLatLng(1600, 1100),
  offsetLatLng(-1600, 1100),
];
const TANK_TURN_RATE = 30; // deg/s heading smoothing at the corners

// Non-reactive follower state: mutated on the 60 fps hot path, consumed only
// through the reactive session poses it writes.
let dronePhi = 0; // orbit angle (rad); 0 = the northernmost point
let droneRejoin = false; // manual input moved the drone off the orbit
let tankSeg = 0; // current loop segment index
let tankT = 0; // progress along that segment [0,1)
let tankHeading = 0; // smoothed heading (deg from north, clockwise)
let tankSurface = 0; // last sampled ground height under the tank (m)

function segLenM(a, b) {
  const dx = (b.lon - a.lon) * M_PER_DEG_LON;
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  return Math.max(1, Math.hypot(dx, dy));
}

/** Compass bearing (deg from north, clockwise) of the a→b segment. */
function segBearing(a, b) {
  const dx = (b.lon - a.lon) * M_PER_DEG_LON;
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  return (((Math.atan2(dx, dy) * 180) / Math.PI) % 360 + 360) % 360;
}

/** Rotate `cur` toward `target` (deg) by at most `maxStep`, the short way. */
function lerpAngle(cur, target, maxStep) {
  const d = ((target - cur + 540) % 360) - 180;
  if (Math.abs(d) <= maxStep) return ((target % 360) + 360) % 360;
  return (((cur + Math.sign(d) * maxStep) % 360) + 360) % 360;
}

/** Position + tangent heading on the drone orbit at angle φ. */
function droneOrbitPose(phi) {
  const p = offsetLatLng(
    DRONE_ORBIT_RADIUS * Math.sin(phi),
    DRONE_ORBIT_RADIUS * Math.cos(phi)
  );
  // Velocity ∝ (cos φ, −sin φ) in (east, north): bearing = atan2(east, north).
  const heading =
    (((Math.atan2(Math.cos(phi), -Math.sin(phi)) * 180) / Math.PI) % 360 + 360) % 360;
  return { lat: p.lat, lon: p.lon, heading };
}

// ── Per-frame driver ────────────────────────────────────────────────────────
function stepDrone(dt, droneSurfaceAlt) {
  const d = session.drone;
  if (droneRejoin) {
    // Fly straight back to the current orbit slot (at 2× cruise so the
    // rejoin does not drag), then hand the drone back to the orbit.
    const target = droneOrbitPose(dronePhi);
    const dx = (target.lon - d.lon) * M_PER_DEG_LON;
    const dy = (target.lat - d.lat) * M_PER_DEG_LAT;
    const dist = Math.hypot(dx, dy);
    if (dist >= 20) {
      const step = Math.min(dist, DRONE_SPEED * 2 * dt);
      d.lat += (dy / dist) * (step / M_PER_DEG_LAT);
      d.lon += (dx / dist) * (step / M_PER_DEG_LON);
      d.heading = lerpAngle(d.heading, segBearing({ lat: d.lat, lon: d.lon }, target), 45 * dt);
      d.alt = droneSurfaceAlt + DRONE_AGL;
      d.speed = DRONE_SPEED * 2;
      return;
    }
    droneRejoin = false;
  }
  dronePhi = (dronePhi + (DRONE_SPEED * dt) / DRONE_ORBIT_RADIUS) % (Math.PI * 2);
  const p = droneOrbitPose(dronePhi);
  d.lat = p.lat;
  d.lon = p.lon;
  d.heading = p.heading;
  d.alt = droneSurfaceAlt + DRONE_AGL;
  d.speed = DRONE_SPEED;
}

function stepTank(dt, viewer) {
  const t = session.tank;
  // Best-effort ground sample under the tank: the same downward ray the
  // altitude gate casts for the drone. Off-screen (tiles not streamed) the
  // ray misses and the last estimate is kept — good enough because the
  // tank's altitude only matters once its FPV is on screen, and by then
  // the tiles around it are loading anyway.
  if (viewer) {
    try {
      const origin = Cesium.Cartesian3.fromDegrees(t.lon, t.lat, TANK_SAMPLE_ORIGIN_ALT);
      const down = Cesium.Cartesian3.negate(
        Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(origin, new Cesium.Cartesian3()),
        new Cesium.Cartesian3()
      );
      const hit = viewer.scene.pickFromRay(new Cesium.Ray(origin, down));
      if (hit && hit.position) {
        const carto = Cesium.Cartographic.fromCartesian(hit.position);
        if (Number.isFinite(carto.height)) tankSurface = carto.height;
      }
    } catch {
      /* transient raycast failure while tiles stream — keep last estimate */
    }
  }
  tankT += (TANK_SPEED * dt) / segLenM(TANK_LOOP[tankSeg], TANK_LOOP[(tankSeg + 1) % TANK_LOOP.length]);
  while (tankT >= 1) {
    tankT -= 1;
    tankSeg = (tankSeg + 1) % TANK_LOOP.length;
  }
  const a = TANK_LOOP[tankSeg];
  const b = TANK_LOOP[(tankSeg + 1) % TANK_LOOP.length];
  t.lat = a.lat + (b.lat - a.lat) * tankT;
  t.lon = a.lon + (b.lon - a.lon) * tankT;
  t.alt = tankSurface + TANK_CAM_AGL;
  tankHeading = lerpAngle(tankHeading, segBearing(a, b), TANK_TURN_RATE * dt);
  t.heading = tankHeading;
  t.speed = TANK_SPEED;
}

/**
 * Advance the whole fleet by dt seconds. Called once per frame from the play
 * view's sim loop, AFTER the manual flight physics (which it overrides in
 * this test phase).
 *
 * @param {number} dt frame delta (s)
 * @param {object} [opts]
 * @param {object} [opts.viewer] Cesium viewer (tank ground sampling)
 * @param {number} [opts.droneSurfaceAlt] ground height under the drone (m),
 *   i.e. altitudeGate.surfaceAlt.value
 * @param {boolean} [opts.droneManual] true while something else owns the
 *   drone (takeoff/landing sequence, play-link route autopilot, or a
 *   deflected Flight stick): the fleet then leaves the drone alone and
 *   rejoins its orbit once the manual input ends.
 */
function stepFleet(dt, { viewer = null, droneSurfaceAlt = 0, droneManual = false } = {}) {
  if (droneManual) droneRejoin = true;
  else stepDrone(dt, droneSurfaceAlt);
  stepTank(dt, viewer);
}

// ── Initial placement ───────────────────────────────────────────────────────
// Park both assets on their routes right away (module load), so the very
// first rendered frame already shows the fleet near the fire zone instead of
// flashing the settings' default drone position for one frame.
{
  const p = droneOrbitPose(dronePhi);
  session.drone.lat = p.lat;
  session.drone.lon = p.lon;
  session.drone.heading = p.heading;
  session.drone.alt = DRONE_AGL; // refined to ground+1000 on the first step
  session.drone.speed = DRONE_SPEED;

  const a = TANK_LOOP[0];
  const b = TANK_LOOP[1];
  tankHeading = segBearing(a, b);
  session.tank.lat = a.lat;
  session.tank.lon = a.lon;
  session.tank.heading = tankHeading;
  session.tank.alt = TANK_CAM_AGL; // refined to ground+10 on the first step
  session.tank.speed = TANK_SPEED;
}

export function useFleet() {
  return {
    FLEET,
    activeAssetId,
    activeAsset,
    activeIsDrone,
    setActiveAsset,
    stepFleet,
  };
}
