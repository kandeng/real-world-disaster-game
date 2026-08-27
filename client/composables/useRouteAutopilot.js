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
    gimbal.yaw = num(w0.camYaw);
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

    const speed = Math.max(0.5, Math.min(50, num(target.speed, 8)));
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

  // Ease the camera toward the target waypoint's saved angles while the
  // Gimbal disk/keys are released (cinematic playback of the route).
  function stepGimbal(dt) {
    const list = waypoints.value;
    if (!active.value || !list.length) return;
    const target = list[Math.min(leg.value + 1, list.length - 1)];
    const maxStep = GIMBAL_RATE * dt;
    gimbal.yaw = easeAngleToward(gimbal.yaw, num(target.camYaw), maxStep);
    gimbal.pitch = easeToward(gimbal.pitch, num(target.camPitch, -90), maxStep);
    gimbal.roll = easeToward(gimbal.roll, num(target.camRoll), maxStep);
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
