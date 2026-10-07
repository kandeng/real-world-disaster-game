// ── The fleet: machine assets + the ACTIVE asset + the test-phase autopilot ─
// The team has two machine assets — the drone (airborne, ~1000 m above ground)
// and the tank (currently flying 50 m above ground for this test). Both start
// near the LA (Palisades) fire zone, at DIFFERENT positions, and — for this
// test phase — both are driven automatically along hardcoded routes at
// hardcoded speeds. The Steer view shows a third-person chase camera (15 m
// above / 30 m behind the active asset). The fleet no longer renders the
// machines' GLB meshes itself: under ?agentDemo the generic agent overlay
// (modelOverlay) draws every package asset at its live pose instead.
// Future phases replace this driver with (1) pre-planned route playback and
// (2) manual Steer/Gimbal-disk control of the active asset; the active-asset
// plumbing below is built to survive that swap.
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
import { sampleGroundHeight } from './useGroundSample.js';
import { PALISADES_FIRE } from '@/config/palisadesFire.js';

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

// Drone: analytic circular orbit, 2.5 km radius, clockwise. Commander test:
// 10 m/s and PURELY HORIZONTAL — the altitude reference is LOCKED at the
// first good surface sample, so the machine never climbs or descends again
// (no terrain-following, no tile-refinement creep). 1000 m above that lock.
const DRONE_ORBIT_RADIUS = 2500;
const DRONE_SPEED = 10; // m/s
const DRONE_AGL = 1000; // m above the locked surface reference

// Tank: closed rectangular patrol OVER THE PACIFIC (flat sea surface), 10 m/s,
// 50 m above its locked surface reference. The box sits offshore on purpose:
// with a locked altitude a hill on the route would swallow the tank.
const TANK_SPEED = 10; // m/s
const TANK_AGL = 50; // m above the locked surface reference

// ── Steer chase camera (test phase) ─────────────────────────────────────────
// The Steer view is a third-person chase cam: 15 m above the ACTIVE asset and
// 30 m behind it (opposite its travel direction) — offsets chosen so that at
// the −15° default gimbal pitch the machine sits in the LOWER part of the
// frame (its direction from the camera is ≈26.6° below horizontal, ≈12° below
// the view axis). NORTH-UP-THE-NOSE: the camera
// heading equals the machine's nose direction, so the machine always sits at
// the central bottom of the screen, statically oriented, while the world
// rotates around it. The two disks steer differently:
//   • Steer disk (ex-Flight): up/w = forward, down/s = backward, left/a =
//     turn left, right/d = turn right — car-style, applied to the MACHINE
//     (position + heading) every frame while held; the view follows and the
//     mesh stays static on screen;
//   • Gimbal disk: spins / tilts the CAMERA only (yaw / pitch / roll offsets
//     around the machine), so the machine visibly changes its angle on
//     screen while the view tilts.
// The machine's GLB mesh is drawn by the agent overlay (modelOverlay) under
// ?agentDemo — this module only computes the chase-camera pose that frames it.
const CHASE_UP_M = 15; // m above the asset
const CHASE_BACK_M = 30; // m behind the asset (opposite its heading)
// Default gimbal angle of the chase camera: 15° DOWNWARD along the machine's
// nose direction (commander test); the Gimbal disk's pitch accumulates as an
// OFFSET from this.
const CHASE_PITCH_DEG = -15;
// Stick rates of the car-style manual control (deflection normalised to
// −1..1 from the ±3 sensitivity range): 10 m/s along the nose, 45°/s turn,
// 5 m/s climb (drone only). Rejoin glides land within REJOIN_ARRIVE_M so
// releasing the stick never snaps a machine back onto its route.
const MANUAL_SPEED = 10; // m/s at full deflection
const TURN_RATE_DEG = 45; // deg/s at full deflection
const CLIMB_RATE = 5; // m/s at full deflection
const REJOIN_ARRIVE_M = 2;
const TANK_LOOP = [
  offsetLatLng(-6000, -1500),
  offsetLatLng(-3000, -1500),
  offsetLatLng(-3000, 1500),
  offsetLatLng(-6000, 1500),
];
const TANK_TURN_RATE = 30; // deg/s heading smoothing at the corners

// Non-reactive follower state: mutated on the 60 fps hot path, consumed only
// through the reactive session poses it writes.
let dronePhi = 0; // orbit angle (rad); 0 = the northernmost point
let droneRejoin = false; // manual input moved the drone off the orbit
let tankSeg = 0; // current loop segment index
let tankT = 0; // progress along that segment [0,1)
let tankHeading = 0; // smoothed heading (deg from north, clockwise)
let tankSurface = null; // last sampled ground height under the tank (m)
// Locked altitude references (m above the ellipsoid): set once, at the first
// accepted surface sample, then frozen — the commander's horizontal-flight
// test. null until that first sample; alt falls back to 0 + AGL meanwhile.
let droneAltRef = null;
let tankAltRef = null;
// Rejoin bookkeeping: after manual stick input ends, both machines GLIDE back
// to their routes (no teleports): the drone re-syncs its orbit angle to where
// it actually is, the tank glides to the nearest point of its patrol loop.
let dronePhiResynced = false;
let tankWasManual = false;
let tankRejoin = null; // { seg, t, lat, lon } glide target, null when idle

function norm360(x) {
  return ((x % 360) + 360) % 360;
}

/** Move `cur` toward `target` by at most `maxStep`. */
function approach(cur, target, maxStep) {
  const d = target - cur;
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}

/** Orbit angle φ of the drone's CURRENT position (nearest circle point). */
function phiOfDrone(d) {
  const dx = (d.lon - C.lng) * M_PER_DEG_LON;
  const dy = (d.lat - C.lat) * M_PER_DEG_LAT;
  return ((Math.atan2(dx, dy) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
}

/** Nearest point on the tank patrol loop: segment index, progress, lat/lon. */
function nearestLoopPoint(lat, lon) {
  const px = (lon - C.lng) * M_PER_DEG_LON;
  const py = (lat - C.lat) * M_PER_DEG_LAT;
  let best = null;
  for (let i = 0; i < TANK_LOOP.length; i++) {
    const a = TANK_LOOP[i];
    const b = TANK_LOOP[(i + 1) % TANK_LOOP.length];
    const ax = (a.lon - C.lng) * M_PER_DEG_LON;
    const ay = (a.lat - C.lat) * M_PER_DEG_LAT;
    const ex = (b.lon - a.lon) * M_PER_DEG_LON;
    const ey = (b.lat - a.lat) * M_PER_DEG_LAT;
    const len2 = ex * ex + ey * ey || 1;
    const u = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / len2));
    const qx = ax + ex * u;
    const qy = ay + ey * u;
    const dist = Math.hypot(px - qx, py - qy);
    if (!best || dist < best.dist) {
      best = { dist, seg: i, t: u, lat: C.lat + qy / M_PER_DEG_LAT, lon: C.lng + qx / M_PER_DEG_LON };
    }
  }
  return best;
}

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
// `ctl` = normalised stick input { fwd, turn, climb } (−1..1): car-style
// control in the machine's nose frame, applied every frame WHILE HELD so the
// motion is continuous; releasing hands the machine back to its route via a
// smooth glide (never a teleport).
function stepDrone(dt, droneSurfaceAlt, droneSurfaceOk, ctl = null) {
  const d = session.drone;
  if (droneAltRef === null && droneSurfaceOk) droneAltRef = droneSurfaceAlt;
  const baseAlt = (droneAltRef ?? 0) + DRONE_AGL;
  if (ctl) {
    droneRejoin = true;
    dronePhiResynced = false;
    const h = (d.heading * Math.PI) / 180;
    d.lon += (Math.sin(h) * ctl.fwd * MANUAL_SPEED * dt) / M_PER_DEG_LON;
    d.lat += (Math.cos(h) * ctl.fwd * MANUAL_SPEED * dt) / M_PER_DEG_LAT;
    d.heading = norm360(d.heading + ctl.turn * TURN_RATE_DEG * dt);
    d.alt += ctl.climb * CLIMB_RATE * dt;
    d.speed = Math.abs(ctl.fwd) * MANUAL_SPEED;
    return;
  }
  if (droneRejoin) {
    // Glide back to the orbit: first re-sync the orbit angle to where the
    // drone actually is (so the return target is the NEAREST circle point),
    // then fly straight to it at 2× cruise.
    if (!dronePhiResynced) {
      dronePhi = phiOfDrone(d);
      dronePhiResynced = true;
    }
    const target = droneOrbitPose(dronePhi);
    const dx = (target.lon - d.lon) * M_PER_DEG_LON;
    const dy = (target.lat - d.lat) * M_PER_DEG_LAT;
    const dist = Math.hypot(dx, dy);
    if (dist >= REJOIN_ARRIVE_M) {
      const step = Math.min(dist, DRONE_SPEED * 2 * dt);
      d.lat += (dy / dist) * (step / M_PER_DEG_LAT);
      d.lon += (dx / dist) * (step / M_PER_DEG_LON);
      d.heading = lerpAngle(d.heading, segBearing({ lat: d.lat, lon: d.lon }, target), 90 * dt);
      d.alt = approach(d.alt, baseAlt, CLIMB_RATE * 2 * dt);
      d.speed = DRONE_SPEED * 2;
      return;
    }
    droneRejoin = false;
    dronePhiResynced = false;
  }
  dronePhi = (dronePhi + (DRONE_SPEED * dt) / DRONE_ORBIT_RADIUS) % (Math.PI * 2);
  const p = droneOrbitPose(dronePhi);
  d.lat = p.lat;
  d.lon = p.lon;
  d.heading = lerpAngle(d.heading, p.heading, 90 * dt);
  d.alt = approach(d.alt, baseAlt, CLIMB_RATE * 2 * dt);
  d.speed = DRONE_SPEED;
}

function stepTank(dt, viewer, ctl = null) {
  const t = session.tank;
  // Live ground sample (validated ray sampler) — feeds the burial rescue and
  // locks the altitude reference on first contact.
  const sampled = sampleGroundHeight(viewer, t.lon, t.lat, tankSurface);
  if (sampled !== null) tankSurface = sampled;
  if (tankAltRef === null && tankSurface !== null) tankAltRef = tankSurface;
  if (ctl) {
    // Stick owns the tank this frame: turn the nose, drive along it; the
    // patrol loop pauses (no snap-back: release starts a glide home).
    tankWasManual = true;
    tankRejoin = null;
    tankHeading = norm360(tankHeading + ctl.turn * TURN_RATE_DEG * dt);
    t.heading = tankHeading;
    const h = (tankHeading * Math.PI) / 180;
    t.lon += (Math.sin(h) * ctl.fwd * MANUAL_SPEED * dt) / M_PER_DEG_LON;
    t.lat += (Math.cos(h) * ctl.fwd * MANUAL_SPEED * dt) / M_PER_DEG_LAT;
    t.alt = (tankAltRef ?? 0) + TANK_AGL;
    t.speed = Math.abs(ctl.fwd) * MANUAL_SPEED;
    return;
  }
  if (tankWasManual && !tankRejoin) {
    tankRejoin = nearestLoopPoint(t.lat, t.lon);
    tankWasManual = false;
  }
  if (tankRejoin) {
    const dx = (tankRejoin.lon - t.lon) * M_PER_DEG_LON;
    const dy = (tankRejoin.lat - t.lat) * M_PER_DEG_LAT;
    const dist = Math.hypot(dx, dy);
    if (dist >= REJOIN_ARRIVE_M) {
      const step = Math.min(dist, TANK_SPEED * 2 * dt);
      t.lat += (dy / dist) * (step / M_PER_DEG_LAT);
      t.lon += (dx / dist) * (step / M_PER_DEG_LON);
      t.heading = tankHeading = lerpAngle(tankHeading, segBearing(t, tankRejoin), 90 * dt);
      t.alt = (tankAltRef ?? 0) + TANK_AGL;
      t.speed = TANK_SPEED * 2;
      return;
    }
    tankSeg = tankRejoin.seg;
    tankT = tankRejoin.t;
    tankRejoin = null;
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
  t.alt = (tankAltRef ?? 0) + TANK_AGL;
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
 * @param {boolean} [opts.droneSurfaceOk] true once that sample is real
 *   (altitudeGate.hasSurface): gates the one-time altitude lock
 * @param {boolean} [opts.droneManual] true while something else owns the
 *   drone (takeoff/landing sequence, play-link route autopilot): the fleet
 *   then leaves the drone alone and rejoins its orbit once that ends.
 * @param {object|null} [opts.droneCtl] normalised stick input for the DRONE
 *   ({ fwd, turn, climb }, each −1..1) while the drone is the active asset
 * @param {object|null} [opts.tankCtl] normalised stick input for the TANK
 *   ({ fwd, turn }) while the tank is the active asset
 */
function stepFleet(dt, { viewer = null, droneSurfaceAlt = 0, droneSurfaceOk = false, droneManual = false, droneCtl = null, tankCtl = null } = {}) {
  if (droneCtl) {
    droneRejoin = true;
    stepDrone(dt, droneSurfaceAlt, droneSurfaceOk, droneCtl);
  } else if (droneManual) {
    droneRejoin = true; // owned elsewhere this frame: pose untouched
  } else {
    stepDrone(dt, droneSurfaceAlt, droneSurfaceOk, null);
  }
  stepTank(dt, viewer, tankCtl);
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
  session.tank.alt = TANK_AGL; // refined to lock+50 on the first sample
  session.tank.speed = TANK_SPEED;

  // Chase-cam entry framing: gimbals start NEUTRAL (all zeros) — the base
  // look-down chase pitch is added by chaseCameraPose() itself, so the mesh
  // is framed the moment Steer opens and the Gimbal disk moves the view
  // (yaw → machine + camera heading, pitch → offset, roll → camera tilt)
  // from there.
  session.gimbal.yaw = 0;
  session.gimbal.pitch = 0;
  session.gimbal.roll = 0;
  session.tankGimbal.yaw = 0;
  session.tankGimbal.pitch = 0;
  session.tankGimbal.roll = 0;
}

// ── Steer chase camera ──────────────────────────────────────────────────────
/** Camera pose of the third-person chase view of `asset`: 15 m above it and
 *  30 m behind it (opposite its travel direction). NORTH-UP-THE-NOSE: the
 *  camera heading = machine heading + the Gimbal-disk yaw (a camera-only
 *  spin around the machine, which is what makes the machine change its
 *  on-screen angle); pitch = the base chase framing + the Gimbal-disk pitch
 *  offset; roll = the Gimbal-disk roll. Steer-disk turns move the machine
 *  heading itself, so the view follows and the mesh stays static. */
function chaseCameraPose(asset) {
  const p = asset.pose;
  const g = asset.gimbal || {};
  const heading = p.heading + (g.yaw || 0);
  const headingRad = (heading * Math.PI) / 180;
  return {
    lat: p.lat - (CHASE_BACK_M * Math.cos(headingRad)) / M_PER_DEG_LAT,
    lon: p.lon - (CHASE_BACK_M * Math.sin(headingRad)) / M_PER_DEG_LON,
    alt: p.alt + CHASE_UP_M,
    heading,
    pitch: CHASE_PITCH_DEG + (g.pitch || 0),
    roll: g.roll || 0,
  };
}

export function useFleet() {
  return {
    FLEET,
    activeAssetId,
    activeAsset,
    activeIsDrone,
    setActiveAsset,
    stepFleet,
    chaseCameraPose,
    // Last accepted ground height under the tank (m above the ellipsoid,
    // null before the first sample): lets the play view detect a camera
    // buried below the tank's own surface, not just the drone's.
    getTankSurface: () => tankSurface,
  };
}
