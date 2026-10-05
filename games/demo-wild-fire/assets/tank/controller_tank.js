// controller_tank.js — game-package component: ground-vehicle controller facade.
//
// Scope split (same contract family as controller_drone.js):
//   • POSE layer (world space): this module owns integration of
//     {lon, lat, alt, headingDeg} from rate commands. Translation of whatever
//     renders the pose (Cesium entity, three.js wrapper, ...) is the host's
//     job: read getState().pose and apply it.
//   • MESH layer (node space): reported as DATA — per-track speeds of a
//     skid-steer drivetrain (left/right m/s, opposite signs during pivot
//     turns) plus roadwheel angular rate, ready for a future bindTracks()-
//     style visual rig. No node manipulation happens here.
//
// Conventions:
//   • headingDeg: compass bearing, degrees clockwise from true north.
//   • Nose = glTF +Z of tank_usa_type10.glb (gun-barrel bounding-box
//     asymmetry: +4.73 m vs -3.56 m). Hosts rendering the pose must apply
//     yaw trim 180 deg (model rotation Y = pi) so heading 0 faces north.
//   • alt is ground elevation: the tank never climbs or sinks; alt is held.
//   • Rates, not positions: forward(6) means "command 6 m/s until stop()".
//     A quick command pulse therefore moves a little; hold or repeat for
//     continuous motion. Easing makes release coast to a halt.
//   • Skid steer: turnLeft/turnRight command yaw rate WITHOUT touching the
//     longitudinal channel, so turning while stopped pivots in place and
//     turning while driving carves a curve — both from the same two channels.
//
// Dependency-free ESM: runs in the browser (URL-importable from the package
// directory) and in Node (headless tier-0/1 validation).

export const TANK_CONTROLLER_API = 1;

const MAX_SPEED_MPS = 10;          // ~36 km/h, generous for a game tank
const MAX_YAW_RATE_DPS = 45;       // pivot turn rate, degrees per second
const SPEED_EASE = 2.0;            // 1/s exponential approach rates
const YAW_EASE = 3.5;
const TRACK_GAUGE_M = 2.6;         // centre-to-centre track spacing
const WHEEL_RADIUS_M = 0.42;       // roadwheel radius for rad/s reporting
const METERS_PER_DEG_LAT = 111320;

const DEG2RAD = Math.PI / 180;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrap360 = (d) => ((d % 360) + 360) % 360;
const wrap180 = (lon) => ((lon + 540) % 360) - 180;
const easeToward = (cur, target, rate, dt) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

/**
 * createTankController(initialPose?, options?) -> controller
 * initialPose: { lon, lat, alt, headingDeg } (defaults 0,0,0,0)
 * options:     { minAltM } — alt floor, held constant afterwards
 */
export function createTankController(initialPose = {}, options = {}) {
  const pose = {
    lon: Number.isFinite(initialPose.lon) ? initialPose.lon : 0,
    lat: clamp(Number.isFinite(initialPose.lat) ? initialPose.lat : 0, -85, 85),
    alt: Number.isFinite(initialPose.alt) ? initialPose.alt : 0,
    headingDeg: wrap360(Number.isFinite(initialPose.headingDeg) ? initialPose.headingDeg : 0),
  };
  const minAltM = Number.isFinite(options.minAltM) ? options.minAltM : pose.alt;
  pose.alt = Math.max(minAltM, pose.alt);

  let targetSpeed = 0;   // +forward / -backward, m/s
  let targetYawRate = 0; // +right(clockwise) / -left, deg/s
  let speed = 0;
  let yawRate = 0;

  // ---- commands -------------------------------------------------------------
  function forward(mps = MAX_SPEED_MPS) {
    targetSpeed = clamp(Math.abs(mps), 0, MAX_SPEED_MPS);
  }
  function backward(mps = MAX_SPEED_MPS) {
    targetSpeed = -clamp(Math.abs(mps), 0, MAX_SPEED_MPS);
  }
  // Steer commands keep the longitudinal channel untouched: pivot in place
  // when stopped, curved path when driving.
  function turnLeft(dps = MAX_YAW_RATE_DPS) {
    targetYawRate = -clamp(Math.abs(dps), 0, MAX_YAW_RATE_DPS);
  }
  function turnRight(dps = MAX_YAW_RATE_DPS) {
    targetYawRate = clamp(Math.abs(dps), 0, MAX_YAW_RATE_DPS);
  }
  function stop() {
    targetSpeed = 0;
    targetYawRate = 0;
  }

  // ---- integration ----------------------------------------------------------
  function update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return getState();
    speed = easeToward(speed, targetSpeed, SPEED_EASE, dt);
    yawRate = easeToward(yawRate, targetYawRate, YAW_EASE, dt);
    if (Math.abs(speed) < 1e-3) speed = 0;     // 1 mm/s snap: exponential tails
    if (Math.abs(yawRate) < 1e-3) yawRate = 0; // must end exactly at rest

    pose.headingDeg = wrap360(pose.headingDeg + yawRate * dt);
    const hdg = pose.headingDeg * DEG2RAD;
    const dNorthM = speed * Math.cos(hdg) * dt;
    const dEastM = speed * Math.sin(hdg) * dt;
    const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos(pose.lat * DEG2RAD);
    pose.lat = clamp(pose.lat + dNorthM / METERS_PER_DEG_LAT, -85, 85);
    pose.lon = wrap180(pose.lon + dEastM / Math.max(metersPerDegLon, 1e-6));
    // Ground vehicle: altitude never integrates; hold the floor.
    pose.alt = Math.max(minAltM, pose.alt);
    return getState();
  }

  function getState() {
    // Skid-steer kinematics: v_track = v_body ± omega * halfGauge.
    const omega = yawRate * DEG2RAD; // rad/s, + = clockwise seen from above
    const half = TRACK_GAUGE_M / 2;
    const left = speed + omega * half;   // clockwise yaw speeds up left track
    const right = speed - omega * half;
    return {
      pose: { ...pose },
      speed,
      yawRate,
      tracks: {
        left,
        right,
        wheelRadPerSec: { left: left / WHEEL_RADIUS_M, right: right / WHEEL_RADIUS_M },
      },
    };
  }

  function describe() {
    return {
      api: TANK_CONTROLLER_API,
      machine: 'tank_usa_type10.glb',
      conventions: {
        heading: 'compass degrees clockwise from true north',
        nose: 'glTF +Z of tank_usa_type10.glb; host applies yaw trim 180 deg',
        movement: 'body-relative: forward follows heading; skid-steer yaw',
        units: 'metres, seconds, degrees',
        altitude: 'held constant (ground vehicle)',
      },
      limits: {
        maxSpeedMps: MAX_SPEED_MPS,
        maxYawRateDps: MAX_YAW_RATE_DPS,
        trackGaugeM: TRACK_GAUGE_M,
        wheelRadiusM: WHEEL_RADIUS_M,
      },
      commands: ['forward', 'backward', 'turnLeft', 'turnRight', 'stop', 'update', 'getState', 'describe'],
    };
  }

  return { forward, backward, turnLeft, turnRight, stop, update, getState, describe };
}

export default createTankController;
