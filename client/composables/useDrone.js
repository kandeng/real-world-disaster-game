import { useSessionState } from './useSessionState.js';

// Phase 1: pose now lives in the shared session store (useSessionState.js).
// useDrone() stays the stable accessor so the 60 fps hot path and every
// consumer (views, physics, HUD, route scene) remain unchanged — they all
// receive the very same reactive objects, now owned by `session`.
const { session } = useSessionState();
const drone = session.drone;
const gimbal = session.gimbal;

export function useDrone() {
  function setDroneLocation(lat, lon, altitude = null) {
    drone.lat = lat;
    drone.lon = lon;
    if (altitude !== null) {
      drone.alt = altitude;
    }
  }

  return { drone, gimbal, setDroneLocation };
}
