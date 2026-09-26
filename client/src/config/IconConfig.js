// Configurable icon mapping.
// All SVG source files live in client/icons/ and are imported as raw strings
// via Vite's import.meta.glob. Add or update keys here to change the icons
// used across the application without touching components.

const svgModules = import.meta.glob('../../icons/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const pngModules = import.meta.glob('../../icons/*.png', {
  import: 'default',
  eager: true,
});

export const IconMap = {
  // Aerial page dock + shell top bar
  MENU_CONTROL_STICK: '../../icons/steer.svg',
  MENU_SITUATION: '../../icons/situation.svg',
  MENU_PLAN: '../../icons/plan.svg',
  MENU_TAKEOFF: '../../icons/takeoff.svg',
  MENU_LANDING: '../../icons/landing.svg',
  MENU_STOP: '../../icons/stop.svg',
  MENU_RECORDER: '../../icons/recorder.svg',
  MENU_PHOTO: '../../icons/photo.svg',
  MENU_SEARCH: '../../icons/search.svg',
  MENU_RESET: '../../icons/reset.svg',
  MENU_FILE_FOLDER: '../../icons/file_folder.svg',
  MENU_USER: '../../icons/user.svg',

  // Joystick / flight control glyphs
  FLIGHT_MOVE: '../../icons/flight-move.svg',
  FLIGHT_ROTATE: '../../icons/flight-rotate.svg',
  FLIGHT_HEIGHT: '../../icons/flight-height.svg',

  // Camera / gimbal control glyphs
  CAMERA_ROTATE: '../../icons/camera-rotate.svg',
  CAMERA_PITCH: '../../icons/pitch-indicator.svg',

  // Auth form icons (password visibility toggle)
  PASSWORD_SHOW: '../../icons/view.svg',
  PASSWORD_HIDE: '../../icons/hide.svg',

  // AI assistant panel icons
  CHAT_SEND: '../../icons/send.svg',
  CHAT_CAPTURE: '../../icons/screen_shot.svg',
};

/**
 * Resolve a configured icon key to its raw SVG markup.
 * @param {string} key - A key from IconMap.
 * @returns {string} The SVG markup, or an empty string if not found.
 */
export function getIconSvg(key) {
  const path = IconMap[key];
  return path && svgModules[path] ? svgModules[path] : '';
}

export function getIconImageUrl(key) {
  const path = IconMap[key];
  return path && pngModules[path] ? pngModules[path] : '';
}

/**
 * List all available icon keys. Useful for debugging or dynamic pickers.
 * @returns {string[]}
 */
export function getIconKeys() {
  return Object.keys(IconMap);
}
