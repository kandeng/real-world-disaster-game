import { ref } from 'vue';
import { useDrone } from './useDrone.js';
import { useFlightCommands } from './useFlightCommands.js';
import { useCameraCommands } from './useCameraCommands.js';

// Route autopilot for the /play?r=<id> deep link (3D Exploration): the
// virtual drone flies waypoint-to-waypoint on its own; grabbing the Flight
// or Gimbal disk (or keys) takes that domain over per-frame, and releasing
// resumes autonomous flight from the current pose toward the NEXT waypoint
// (the one after the last waypoint actually reached, so a deviation never
// rewinds progress). At the route end the drone hovers at the last
// waypoint while the camera eases to its saved angles.
//
// Cinematic playback mirrors the recorded route video: speed and gimbal
// angles interpolate between the leg's waypoints by travel progress, and
// the authored camera azimuth is ABSOLUTE — the relative yaw is authored
// minus drone.heading, the same convention as the preview / offline video
// renderer in useRouteScene3D.js.
//
// Module-singleton like the other command composables: one autopilot per
// app, owned by AerialView while a play link is active.

const ARRIVE_M = 5; // horizontal arrival radius (m)
const ARRIVE_ALT_M = 2; // vertical arrival band (m)
const GIMBAL_RATE = 30; // deg/s ease toward the waypoint's camera angles
const IDLE_EPS = 0.01; // a stick axis below this counts as released

const active = ref(false);
const waypoints = ref([]);
const leg = ref(0); // index of the last reached waypoint; target = leg+1

export function useRouteAutopilot() {
  const { drone, gimbal } = useDrone();
  const { flightCmd } = useFlightCommands();
  const { cameraCmd } = useCameraCommands();

  function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function bearingDeg(aLat, aLng, bLat, bLng) {
    const latRad = (aLat * Math.PI) / 180;
    const mPerDegLat = 111320;
    const mPerDegLon = Math.max(1e-6, 111320 * Math.cos(latRad));
    const dEast = (bLng - aLng) * mPerDegLon;
    const dNorth = (bLat - aLat) * mPerDegLat;
    return (Math.atan2(dEast, dNorth) * 180) / Math.PI;
  }

  function normDeg(v) {
    return ((((v + 180) % 360) + 360) % 360) - 180;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function lerpAngleDeg(a, b, t) {
    return normDeg(a + normDeg(b - a) * t); // shortest arc
  }

  function distM(aLat, aLng, bLat, bLng) {
    const mPerDegLat = 111320;
    const mPerDegLon = Math.max(1e-6, 111320 * Math.cos((aLat * Math.PI) / 180));
    return Math.hypot((bLng - aLng) * mPerDegLon, (bLat - aLat) * mPerDegLat);
  }

  // Travel progress along the current leg: 0 at wp[leg], 1 at the target.
  // Derived from distances (stateless), so it survives a deviation: flying
  // back toward the leg moves t smoothly again.
  function legProgress(list) {
    if (leg.value >= list.length - 1) return 1;
    const a = list[leg.value];
    const b = list[leg.value + 1];
    const legLen = distM(a.lat, a.lng, b.lat, b.lng);
    if (legLen < 1e-6) return 1;
    const remain = distM(drone.lat, drone.lon, b.lat, b.lng);
    return Math.max(0, Math.min(1, 1 - remain / legLen));
  }

  function start(wps) {
    const list = wps || [];
    if (!list.length) return;
    waypoints.value = list;
    leg.value = 0;
    const w0 = list[0];
    drone.lat = w0.lat;
    drone.lon = w0.lng;
    drone.alt = num(w0.alt, 150);
    drone.heading = list.length > 1 ? bearingDeg(w0.lat, w0.lng, list[1].lat, list[1].lng) : 0;
    // Authored view azimuth is absolute (the view composes camera azimuth as
    // heading + gimbal.yaw): store it relative to the path bearing, exactly
    // like the preview / offline video renderer.
    gimbal.yaw = normDeg(num(w0.camYaw) - drone.heading);
    gimbal.pitch = num(w0.camPitch, -90);
    gimbal.roll = num(w0.camRoll);
    drone.speed = 0;
    active.value = true;
  }

  function stop() {
    active.value = false;
  }

  function flightIdle() {
    return (
      Math.abs(flightCmd.vx) < IDLE_EPS &&
      Math.abs(flightCmd.vy) < IDLE_EPS &&
      Math.abs(flightCmd.yaw) < IDLE_EPS &&
      Math.abs(flightCmd.vz) < IDLE_EPS
    );
  }

  function cameraIdle() {
    return (
      Math.abs(cameraCmd.yaw) < IDLE_EPS &&
      Math.abs(cameraCmd.pitch) < IDLE_EPS &&
      Math.abs(cameraCmd.roll) < IDLE_EPS
    );
  }

  // One autonomous flight step: an ENU move in meters for the caller to run
  // through the existing collision projection + applyEnuMove, so autopilot
  // and manual flight share one movement path. Null means "no autonomous
  // move this frame" (manual input owns the drone, or the route is done).
  function stepFlight(dt) {
    const list = waypoints.value;
    if (!active.value || leg.value >= list.length - 1) {
      if (active.value) drone.speed = 0; // route end: hover
      return null;
    }
    const target = list[leg.value + 1];
    const mPerDegLat = 111320;
    const mPerDegLon = Math.max(1e-6, 111320 * Math.cos((drone.lat * Math.PI) / 180));
    const dEast = (target.lng - drone.lon) * mPerDegLon;
    const dNorth = (target.lat - drone.lat) * mPerDegLat;
    const dist = Math.hypot(dEast, dNorth);
    const dAlt = num(target.alt, 150) - drone.alt;

    if (dist < ARRIVE_M && Math.abs(dAlt) < ARRIVE_ALT_M) {
      leg.value += 1; // next frame heads for the following waypoint
      return null;
    }

    // Speed profile mirrors the recorded video: interpolate between the
    // leg's waypoint speeds by travel progress (not a constant target speed).
    const t = legProgress(list);
    const speed = Math.max(0.5, Math.min(50, lerp(num(list[leg.value].speed, 8), num(target.speed, 8), t)));
    drone.speed = speed;
    drone.heading = bearingDeg(drone.lat, drone.lon, target.lat, target.lng);

    const stepH = Math.min(dist, speed * dt);
    const z = Math.max(-speed * dt, Math.min(speed * dt, dAlt));
    return {
      x: dist > 1e-9 ? (dEast / dist) * stepH : 0,
      y: dist > 1e-9 ? (dNorth / dist) * stepH : 0,
      z,
    };
  }

  function easeToward(cur, tgt, maxStep) {
    const d = tgt - cur;
    return Math.abs(d) <= maxStep ? tgt : cur + Math.sign(d) * maxStep;
  }

  function easeAngleToward(cur, tgt, maxStep) {
    const d = ((tgt - cur + 540) % 360) - 180; // shortest arc
    return Math.abs(d) <= maxStep ? tgt : cur + Math.sign(d) * maxStep;
  }

  // Ease the camera toward the authored angles while the Gimbal disk/keys
  // are released (cinematic playback of the route). The authored camera is
  // interpolated between the leg's waypoints by travel progress — exactly
  // what the recorded route video shows, so at leg start the framing is the
  // leg's OWN saved angles — and its azimuth is absolute, so the relative
  // yaw subtracts the (changing) drone heading every frame.
  function stepGimbal(dt) {
    const list = waypoints.value;
    if (!active.value || !list.length) return;
    const k = Math.min(leg.value, list.length - 1);
    const j = Math.min(leg.value + 1, list.length - 1);
    const t = k === j ? 1 : legProgress(list);
    const authoredYaw = lerpAngleDeg(num(list[k].camYaw), num(list[j].camYaw), t);
    const authoredPitch = lerp(num(list[k].camPitch, -90), num(list[j].camPitch, -90), t);
    const authoredRoll = lerpAngleDeg(num(list[k].camRoll), num(list[j].camRoll), t);
    const maxStep = GIMBAL_RATE * dt;
    gimbal.yaw = easeAngleToward(gimbal.yaw, normDeg(authoredYaw - drone.heading), maxStep);
    gimbal.pitch = easeToward(gimbal.pitch, authoredPitch, maxStep);
    gimbal.roll = easeToward(gimbal.roll, authoredRoll, maxStep);
  }

  return {
    active,
    waypoints,
    leg,
    start,
    stop,
    flightIdle,
    cameraIdle,
    stepFlight,
    stepGimbal,
  };
}
