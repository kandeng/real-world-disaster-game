// ── Ground-height sampling for the Google Photorealistic 3D tileset ────────
// "Altitude above ground" only means something relative to the SURFACE the
// eye sees — the top of the streamed 3D-tiles mesh. Cesium's built-in ground
// references (HeightReference.RELATIVE_TO_GROUND / CLAMP_TO_GROUND,
// sampleTerrainMostDetailed) resolve against the GLOBE's terrainProvider,
// which this app does not have: in Google-tiles mode the globe is hidden and
// the terrain IS the tileset. Those APIs would clamp to the WGS84 ellipsoid
// (height 0) and bury every asset inside the coastal hills.
//
// The only correct probe is a downward ray against the rendered tileset
// (scene.pickFromRay). A raw ray is not safe on its own, though: while tiles
// stream, a ray can slip through a crack between LODs or start inside the
// mesh, and a single bad hit fed back as "the ground" buries the camera
// underground — the black FPV view with coloured tile-crack seams.
//
// This sampler makes the ray bulletproof with three rules:
//   1. ORIGIN MARGIN — the ray starts lastGood + 1500 m up (floor 1500 m),
//      never at the asset itself, so the origin cannot be inside the mesh;
//      any burial shallower than 1500 m self-heals on the next sample.
//   2. DOWN-STEP CAP — a hit more than 250 m BELOW the last good sample is
//      rejected: real terrain under a moving asset never drops that fast,
//      but crack / skirt / interior hits do. This breaks the burial loop.
//   3. UPWARD SELF-HEAL — hits above the last good sample are accepted
//      without a cap: nothing renders above the true surface except roofs
//      (legitimate ground for our purposes), so an upward jump can only be
//      a recovery from a stale low estimate.
//
// Returns the surface height in metres above the WGS84 ellipsoid, or null
// when nothing was hit or the hit failed validation — the caller then keeps
// its last estimate.
export const ORIGIN_MARGIN = 1500; // m above the last good surface
export const MIN_ORIGIN_ALT = 1500; // m above the ellipsoid (coastal-LA safe)
export const MAX_DOWN_STEP = 250; // m: max plausible single-sample drop

/* global Cesium */

/**
 * Sample the tileset surface height under (lon, lat).
 *
 * @param {object} viewer Cesium viewer (window.cesiumViewer)
 * @param {number} lon longitude (deg)
 * @param {number} lat latitude (deg)
 * @param {number|null} lastGood last accepted surface height (m above the
 *   ellipsoid), or null when nothing has been sampled yet (bootstrap: the
 *   first finite hit below the origin is accepted as-is)
 * @returns {number|null} surface height (m above the ellipsoid) or null
 */
export function sampleGroundHeight(viewer, lon, lat, lastGood = null) {
  if (!viewer) return null;
  const originAlt = Math.max((lastGood ?? 0) + ORIGIN_MARGIN, MIN_ORIGIN_ALT);
  try {
    const origin = Cesium.Cartesian3.fromDegrees(lon, lat, originAlt);
    const down = Cesium.Cartesian3.negate(
      Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(origin, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    const hit = viewer.scene.pickFromRay(new Cesium.Ray(origin, down));
    if (!hit || !hit.position) return null; // tiles not streamed here yet
    const height = Cesium.Cartographic.fromCartesian(hit.position)?.height;
    if (!Number.isFinite(height)) return null;
    if (height >= originAlt - 1) return null; // hit at/above the origin: impossible
    if (lastGood !== null && lastGood - height > MAX_DOWN_STEP) return null; // crack artefact
    return height;
  } catch {
    return null; // transient raycast failure while tiles stream
  }
}
