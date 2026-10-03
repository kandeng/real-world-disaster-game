/**
 * controller_drone.js — flight controller facade for the DJI Air 3 machine
 * of THIS game package (drone_dji_air3.glb).
 *
 * A package component: the engine loads it by URL as a plain ES module,
 * e.g. `const mod = await import(base + 'controller_drone.js')` where `base`
 * is the active package baseUrl ('/games/demo-wild-fire/'). It has NO
 * dependencies (no Vue, no Cesium, no three.js) so it runs identically in the
 * browser and in Node for headless tests.
 *
 * Scope split (why this file does not animate the mesh):
 *   • POSE layer (world space) lives HERE: body-relative forward/back,
 *     yaw turn, vertical speed and yaw-in-place are integrated over
 *     {lon, lat, alt, headingDeg}. A glTF controller can only rotate nodes;
 *     translation is always the host's job, so the host reads getState().pose
 *     and applies it (Cesium entity position + orientation).
 *   • MESH layer (node space) is reported as DATA (rotor rpm per corner with
 *     the CW/CCW yaw-torque differential, gimbal angles) AND can be applied
 *     directly: bindRotors() accepts one spin target per corner (any object
 *     with a settable .rotation.y — e.g. a three.js pivot Object3D placed at
 *     the motor hub, with the propeller nodes attached to it). The controller
 *     then integrates each rotor angle from its rpm and writes the rotation,
 *     diagonal pairs counter-rotating like a real quadcopter.
 *
 * Conventions:
 *   • headingDeg: compass bearing, degrees clockwise from true north — the
 *     same bearing Cesium's headingPitchRollQuaternion expects, and the same
 *     one the mesh nose (glTF -Z) follows at trim 0.
 *   • forward = along the nose; backward = negative speed (no reverse gear
 *     clamp here, unlike the mesh contract's setSpeed).
 *   • turnLeft/turnRight yaw while keeping the current translation;
 *     rotateCw/rotateCccw zero the translation first, so the machine pivots
 *     on the spot (altitude held).
 *   • armed = rotors spinning at hover RPM or above; disarmed = wind-down to
 *     a complete stop and pose frozen (ground state).
 */

export const DRONE_CONTROLLER_API = 1;

const MAX_SPEED_MPS = 15;
const MAX_YAW_RATE_DPS = 90;
const MAX_VZ_MPS = 10;

const HOVER_RPM = 1200;
const CRUISE_RPM = 3000;

const SPEED_EASE = 2.5;
const YAW_EASE = 4.0;
const VZ_EASE = 3.0;
const RPM_EASE = 3.0;
const GIMBAL_EASE = 6.0;

const METERS_PER_DEG_LAT = 111320;
const DEG2RAD = Math.PI / 180;

// Quad rotor layout: spin +1 = clockwise seen from above. Diagonal pairs share
// a direction, as on a real quadcopter; the yaw differential below spins one
// pair up and the other down so the reaction torque yaws the body.
const ROTOR_GROUPS = [
  { key: 'rightFront', spin: 1 },
  { key: 'rightRear', spin: -1 },
  { key: 'leftFront', spin: -1 },
  { key: 'leftRear', spin: 1 },
];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function easeToward(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

function wrap360(deg) {
  return ((deg % 360) + 360) % 360;
}

function wrap180(deg) {
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

export function createDroneController(initialPose = {}, options = {}) {
  const minAltM = typeof options.minAltM === 'number' ? options.minAltM : 0;

  const pose = {
    lon: typeof initialPose.lon === 'number' ? initialPose.lon : 0,
    lat: typeof initialPose.lat === 'number' ? initialPose.lat : 0,
    alt: typeof initialPose.alt === 'number' ? initialPose.alt : minAltM,
    headingDeg: typeof initialPose.headingDeg === 'number' ? wrap360(initialPose.headingDeg) : 0,
  };

  let armed = options.armed !== false;

  // Commanded channels (targets) and eased actuals.
  let targetSpeed = 0;
  let targetYawRate = 0;
  let targetVz = 0;
  let speed = 0;
  let yawRate = 0;
  let vz = 0;

  let targetGimbalPitch = 0;
  let targetGimbalYaw = 0;
  let gimbalPitch = 0;
  let gimbalYaw = 0;

  const rotors = ROTOR_GROUPS.map((g) => ({ key: g.key, spin: g.spin, rpm: 0, angleDeg: 0 }));

  // Optional mesh-side spin targets, injected by the host via bindRotors().
  // Duck-typed: anything with a settable .rotation.y (three.js Object3D pivot).
  const boundRotors = {};

  // ---- commands -------------------------------------------------------------
  function forward(mps = MAX_SPEED_MPS) {
    targetSpeed = clamp(Math.abs(mps), 0, MAX_SPEED_MPS);
  }
  function backward(mps = MAX_SPEED_MPS) {
    targetSpeed = -clamp(Math.abs(mps), 0, MAX_SPEED_MPS);
  }
  function turnLeft(rate = MAX_YAW_RATE_DPS) {
    targetYawRate = -clamp(Math.abs(rate), 0, MAX_YAW_RATE_DPS);
  }
  function turnRight(rate = MAX_YAW_RATE_DPS) {
    targetYawRate = clamp(Math.abs(rate), 0, MAX_YAW_RATE_DPS);
  }
  // Pivot on the spot: kill translation (and hold altitude), then yaw.
  function rotateCw(rate = MAX_YAW_RATE_DPS) {
    targetSpeed = 0;
    targetVz = 0;
    targetYawRate = clamp(Math.abs(rate), 0, MAX_YAW_RATE_DPS);
  }
  function rotateCcw(rate = MAX_YAW_RATE_DPS) {
    targetSpeed = 0;
    targetVz = 0;
    targetYawRate = -clamp(Math.abs(rate), 0, MAX_YAW_RATE_DPS);
  }
  function ascend(mps = MAX_VZ_MPS) {
    targetVz = clamp(Math.abs(mps), 0, MAX_VZ_MPS);
  }
  function descend(mps = MAX_VZ_MPS) {
    targetVz = -clamp(Math.abs(mps), 0, MAX_VZ_MPS);
  }
  function stop() {
    targetSpeed = 0;
    targetYawRate = 0;
    targetVz = 0;
  }
  function setGimbal(pitchDeg, yawDeg) {
    if (typeof pitchDeg === 'number') targetGimbalPitch = clamp(pitchDeg, -90, 30);
    if (typeof yawDeg === 'number') targetGimbalYaw = clamp(yawDeg, -120, 120);
  }
  function arm() {
    armed = true;
  }
  function disarm() {
    armed = false;
    targetSpeed = 0;
    targetYawRate = 0;
    targetVz = 0;
  }
  // targets: [{key, node}] with key matching a ROTOR_GROUPS key. Re-bindable
  // at any time (e.g. after recreating the controller); unknown keys ignored.
  function bindRotors(targets) {
    let n = 0;
    for (const t of targets || []) {
      if (t && t.node && t.node.rotation && rotors.some((r) => r.key === t.key)) {
        boundRotors[t.key] = t.node;
        n++;
      }
    }
    return n;
  }

  // ---- integration ----------------------------------------------------------
  function update(dt) {
    if (!(dt > 0) || !isFinite(dt)) return;

    speed = easeToward(speed, armed ? targetSpeed : 0, SPEED_EASE, dt);
    yawRate = easeToward(yawRate, armed ? targetYawRate : 0, YAW_EASE, dt);
    vz = easeToward(vz, armed ? targetVz : 0, VZ_EASE, dt);

    if (armed) {
      pose.headingDeg = wrap360(pose.headingDeg + yawRate * dt);

      // Body-relative: heading 0 = north, 90 = east (compass clockwise).
      const hdg = pose.headingDeg * DEG2RAD;
      const dNorthM = speed * Math.cos(hdg) * dt;
      const dEastM = speed * Math.sin(hdg) * dt;

      const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos(pose.lat * DEG2RAD);
      pose.lat = clamp(pose.lat + dNorthM / METERS_PER_DEG_LAT, -85, 85);
      pose.lon = wrap180(pose.lon + dEastM / Math.max(metersPerDegLon, 1e-6));
      pose.alt = Math.max(minAltM, pose.alt + vz * dt);
    }

    // Rotors: armed = at least hover; load blends speed, climb and yaw.
    const load = Math.max(
      Math.abs(speed) / MAX_SPEED_MPS,
      Math.abs(vz) / MAX_VZ_MPS,
      Math.abs(yawRate) / MAX_YAW_RATE_DPS
    );
    const baseRpm = armed ? HOVER_RPM + (CRUISE_RPM - HOVER_RPM) * Math.min(load, 1) : 0;
    const turnFactor = yawRate / MAX_YAW_RATE_DPS;
    for (const r of rotors) {
      // Yaw torque comes from the CW-vs-CCW pair differential (a left-right
      // differential would roll the airframe instead).
      const wanted = Math.max(0, baseRpm * (1 - r.spin * turnFactor * 0.35));
      r.rpm = easeToward(r.rpm, wanted, RPM_EASE, dt);
      // Snap the exponential tail: an eased rpm never reaches exactly zero,
      // and a prop that creeps at 1e-5 rad/s forever is a bug, not a wind-down.
      if (r.rpm < 0.01) r.rpm = 0;

      // Visual spin: integrate the angle from rpm (rpm * 360/60 deg per sec)
      // and drive the bound pivot. three.js +rotation.y is CCW seen from
      // above and spin +1 means CW, hence the sign flip.
      r.angleDeg = (r.angleDeg + r.rpm * 6 * dt) % 360;
      const node = boundRotors[r.key];
      if (node) node.rotation.y = -r.spin * r.angleDeg * DEG2RAD;
    }

    gimbalPitch = easeToward(gimbalPitch, targetGimbalPitch, GIMBAL_EASE, dt);
    gimbalYaw = easeToward(gimbalYaw, targetGimbalYaw, GIMBAL_EASE, dt);
  }

  // ---- introspection --------------------------------------------------------
  function getState() {
    return {
      armed,
      pose: { lon: pose.lon, lat: pose.lat, alt: pose.alt, headingDeg: pose.headingDeg },
      speed,
      yawRate,
      vz,
      rotors: rotors.map((r) => ({ key: r.key, spin: r.spin, rpm: r.rpm, angleDeg: r.angleDeg })),
      gimbal: { pitch: gimbalPitch, yaw: gimbalYaw },
    };
  }

  function describe() {
    return {
      api: DRONE_CONTROLLER_API,
      machine: 'drone_dji_air3.glb',
      conventions: {
        heading: 'degrees clockwise from true north (compass bearing)',
        nose: 'glTF -Z; Cesium headingPitchRollQuaternion maps it to north at heading 0 (yaw trim 0)',
        movement: 'body-relative; rotate* pivots on the spot with altitude held',
        units: { speed: 'm/s', yawRate: 'deg/s', vz: 'm/s', rpm: 'rev/min', angles: 'deg' },
      },
      limits: { maxSpeedMps: MAX_SPEED_MPS, maxYawRateDps: MAX_YAW_RATE_DPS, maxVzMps: MAX_VZ_MPS },
      commands: [
        'forward', 'backward', 'turnLeft', 'turnRight',
        'rotateCw', 'rotateCcw', 'ascend', 'descend',
        'stop', 'setGimbal', 'arm', 'disarm', 'bindRotors', 'update', 'getState', 'describe',
      ],
      rotors: ROTOR_GROUPS,
    };
  }

  return {
    forward,
    backward,
    turnLeft,
    turnRight,
    rotateCw,
    rotateCcw,
    ascend,
    descend,
    stop,
    setGimbal,
    arm,
    disarm,
    bindRotors,
    update,
    getState,
    describe,
  };
}

export default createDroneController;
