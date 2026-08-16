import { reactive } from 'vue';
import { useAppSettings } from './useAppSettings.js';

const { settings } = useAppSettings();

const drone = reactive({
  lat: settings.defaultLat,
  lon: settings.defaultLon,
  alt: settings.defaultAlt,
  heading: settings.defaultYaw,
  // Scalar speed along the flying trajectory (m/s); updated by the sim
  // loop each frame, displayed in the HUD.
  speed: 0,
});

const gimbal = reactive({
  yaw: 0.0,
  pitch: settings.defaultPitch,
  roll: settings.defaultRoll,
});

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
