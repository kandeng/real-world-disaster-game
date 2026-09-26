/**
 * useRouteScene3D.js – helpers shared by the Play page (AerialView) to work
 * against the shared Cesium globe (module-scope singleton, same pattern as
 * useFlightCommands / useScreenCapture):
 *   1. sceneTilesReady: true once every 3D tileset finished streaming AND
 *      rendering the current view.
 *   2. The 2D-map <-> 3D-camera altitude scale bridge (modelAltForMapScale /
 *      trueAltForMapScale) so the 2D street map and the 3D nadir overview of
 *      the same spot open at the same ground scale.
 *   3. safeNadirAltitude: terrain-aware floor for the 2D→3D lift.
 */

function getViewer() {
  const viewer = window.cesiumViewer;
  if (!viewer || typeof viewer.isDestroyed !== 'function' || viewer.isDestroyed()) {
    return null;
  }
  return viewer;
}

// True once every 3D tileset in the scene has finished streaming AND
// rendering the current view (tilesLoaded is the reliable signal — see
// waitForTilesRendered in cesium-main.js). Globe imagery counts too when
// the fallback globe is visible.
function sceneTilesReady() {
  const viewer = getViewer();
  if (!viewer || !viewer.scene) return false;
  const prims = viewer.scene.primitives;
  for (let i = 0; i < prims.length; i += 1) {
    const p = prims.get(i);
    if (p && p.tilesLoaded === false) return false;
  }
  const globe = viewer.scene.globe;
  if (globe && globe.show && !globe.tilesLoaded) return false;
  return true;
}

// ── 2D map <-> 3D camera altitude scale bridge ────────────────────────────
// The 2D street map zoom and the 3D camera altitude are different quantities
// (a Cesium camera at 160 m shows a far smaller area than Google zoom 17).
// These helpers convert between the map-model altitude and the true camera
// altitude whose nadir view has the same ground scale (meters/pixel).
const GOOGLE_MPP_K = 156543.03392 / 20971520; // m/px per model-alt meter at equator

function verticalFovRad(viewer) {
  const frustum = viewer.camera.frustum;
  if (typeof frustum.verticalFov === 'number') return frustum.verticalFov;
  // Cesium convention: frustum.fov is the horizontal FOV when aspect > 1.
  const aspect = viewer.canvas.clientWidth / Math.max(1, viewer.canvas.clientHeight);
  return aspect > 1 ? 2 * Math.atan(Math.tan(frustum.fov / 2) / aspect) : frustum.fov;
}

// True camera altitude (m) whose nadir view matches the 2D map's ground
// scale at the given model altitude.
function trueAltForMapScale(modelAlt, lat) {
  const viewer = getViewer();
  if (!viewer) return modelAlt;
  const H = viewer.canvas.clientHeight || window.innerHeight;
  const mpp = GOOGLE_MPP_K * Math.cos((lat * Math.PI) / 180) * modelAlt;
  return (mpp * H) / (2 * Math.tan(verticalFovRad(viewer) / 2));
}

// Inverse: map-model altitude that matches a true 3D camera altitude.
function modelAltForMapScale(trueAlt, lat) {
  const viewer = getViewer();
  if (!viewer) return trueAlt;
  const H = viewer.canvas.clientHeight || window.innerHeight;
  const mppPerAlt = GOOGLE_MPP_K * Math.cos((lat * Math.PI) / 180);
  return (2 * Math.tan(verticalFovRad(viewer) / 2) * trueAlt) / (H * mppPerAlt);
}

// ── Terrain-aware nadir floor ───────────────────────────────────────────────
// The 2D→3D lift is scale-matched, but a searched address can sit on high
// terrain or tall buildings, which puts a scale-only camera BELOW the ground
// (the nadir view renders black/underground). We sample the top surface under
// the lift point and decide the 3D altitude in two branches:
//   (1) 2D altitude already sits above ground + NADIR_KEEP_MARGIN_M ->
//       keep that same altitude (the 3D view matches the 2D map).
//   (2) otherwise -> lift to ground + NADIR_CLEARANCE_M (a safe overview).
// NOTE: in Google photorealistic mode the globe is a flat ellipsoid
// (globe.show=false), so globe.getHeight is useless — the tile surface must
// be sampled from the scene instead.
const NADIR_KEEP_MARGIN_M = 100;   // ground + this: threshold to keep the 2D altitude
const NADIR_CLEARANCE_M = 1000;    // otherwise lift to ground + this

// Async ('MostDetailed' streams the finest available tiles for the spot).
// Returns the surface height (m) above the ellipsoid, or null when nothing
// is loaded there.
async function sampleGroundAltitude(lat, lon) {
  const viewer = getViewer();
  const Cesium = window.Cesium;
  if (!viewer || !Cesium || typeof viewer.scene.sampleHeightMostDetailed !== 'function') return null;
  try {
    const carto = await viewer.scene.sampleHeightMostDetailed(
      Cesium.Cartographic.fromDegrees(lon, lat)
    );
    return carto && Number.isFinite(carto.height) ? carto.height : null;
  } catch (err) {
    return null;
  }
}

// Safe nadir altitude for a lift (see the branch rules above). Falls back to
// the scale height when the surface cannot be sampled.
async function safeNadirAltitude(scaleAlt, lat, lon) {
  const ground = await sampleGroundAltitude(lat, lon);
  if (ground == null) return scaleAlt;
  // (1) The 2D map already sits comfortably above the ground -> keep the
  //     same altitude so the 3D nadir view matches the 2D map.
  if (scaleAlt > ground + NADIR_KEEP_MARGIN_M) return scaleAlt;
  // (2) The 2D map is at/below ground level -> lift to a safe overview.
  return ground + NADIR_CLEARANCE_M;
}

export function useRouteScene3D() {
  return {
    sceneTilesReady,
    trueAltForMapScale,
    modelAltForMapScale,
    safeNadirAltitude,
  };
}
