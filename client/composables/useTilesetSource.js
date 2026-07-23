/**
 * useTilesetSource.js – singleton that manages the active 3D data source of
 * the shared Cesium viewer.
 *
 * The `3D Aerial` and `3D Mesh` subpages of the 3D Exploration page are
 * identical in every respect (flight disk, gimbal disk, sidebars, physics)
 * except for the 3D dataset rendered:
 *   - 'google' → Google Photorealistic 3D Tiles (created by cesium-main.js)
 *   - 'osm'    → OSM Buildings (Cesium Ion) over World Terrain
 *
 * This composable swaps the tilesets on the single global viewer and exposes
 * the currently active tileset so collision / ground raycasts always target
 * the dataset that is actually on screen.
 */
import { ref } from 'vue';

/* global Cesium */

// ── Module-level singleton state (shared by every consumer) ──────────────
const activeSource = ref('google'); // 'google' | 'osm'
const isSwitching = ref(false);

let osmTileset = null; // lazily created Cesium3DTileset (OSM Buildings)
let worldTerrain = null; // cached CesiumTerrainProvider used for OSM context
let worldImageryProvider = null; // cached Bing Maps aerial imagery for the OSM globe

function getViewer() {
  return window.cesiumViewer || null;
}

function getGoogleTilesetRef() {
  return window.getGoogleTileset ? window.getGoogleTileset() : null;
}

/**
 * The 3D tileset that collision / ground raycasts should target for the
 * currently active data source. Returns null if it is not (yet) available.
 */
function getActiveTileset() {
  if (activeSource.value === 'osm') return osmTileset;
  return getGoogleTilesetRef();
}

/**
 * Give the OSM Buildings tileset an explicit image-based-lighting spherical
 * harmonic coefficient set (the same neutral values applied to the scene in
 * cesium-main.js). The OSM tileset's PBR shader expects a vec3[9] uniform
 * (model_sphericalHarmonicCoefficients) for diffuse IBL; without an explicit
 * set Cesium computes it from the atmosphere, which yields an EMPTY array in
 * the pick pass used by scene.pickFromRay (the per-frame ground-altitude
 * raycast) → "WebGL: INVALID_VALUE: uniform3fv: no array" once per frame.
 * Supplying explicit coefficients makes the uniform valid in every pass.
 */
function applyOsmSphericalHarmonics(tileset) {
  const sh = [
    new Cesium.Cartesian3(0.50, 0.50, 0.50), // L0,0 — base ambient irradiance
    new Cesium.Cartesian3(0.0, 0.0, 0.0),    // L1,-1
    new Cesium.Cartesian3(0.20, 0.20, 0.20), // L1,0 — sky is brighter overhead
    new Cesium.Cartesian3(0.0, 0.0, 0.0),    // L1,1
    new Cesium.Cartesian3(0.0, 0.0, 0.0),    // L2,-2
    new Cesium.Cartesian3(0.0, 0.0, 0.0),    // L2,-1
    new Cesium.Cartesian3(0.0, 0.0, 0.0),    // L2,0
    new Cesium.Cartesian3(0.0, 0.0, 0.0),    // L2,1
    new Cesium.Cartesian3(0.0, 0.0, 0.0)     // L2,2
  ];
  if (tileset.imageBasedLighting) {
    tileset.imageBasedLighting.sphericalHarmonicCoefficients = sh;
  } else {
    tileset.imageBasedLighting = new Cesium.ImageBasedLighting({ sphericalHarmonicCoefficients: sh });
  }
}

/** Show OSM Buildings: hide Google tiles, enable globe + World Terrain. */
async function activateOsm(viewer) {
  const google = getGoogleTilesetRef();
  if (google) viewer.scene.primitives.remove(google);

  // OSM Buildings need a visible globe + terrain for ground context.
  viewer.scene.globe.show = true;

  // Drape real satellite/aerial imagery (Bing Maps via Cesium Ion) over the
  // globe so the 3D Mesh view reads as "satellite imagery + mesh buildings"
  // rather than the stylized NaturalEarthII map set at viewer creation. The
  // globe is hidden in Google/aerial mode, so this only affects 3D Mesh.
  if (!worldImageryProvider) {
    try {
      worldImageryProvider = await Cesium.createWorldImageryAsync();
    } catch (e) {
      console.warn('[TilesetSource] World Imagery failed to load:', e);
    }
  }
  if (worldImageryProvider) {
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(worldImageryProvider);
  }

  if (!worldTerrain) {
    try {
      worldTerrain = await Cesium.createWorldTerrainAsync();
    } catch (e) {
      console.warn('[TilesetSource] World Terrain failed to load:', e);
    }
  }
  if (worldTerrain) viewer.terrainProvider = worldTerrain;

  if (!osmTileset) {
    osmTileset = await Cesium.createOsmBuildingsAsync();
    applyOsmSphericalHarmonics(osmTileset);
  }
  if (!viewer.scene.primitives.contains(osmTileset)) {
    viewer.scene.primitives.add(osmTileset);
  }
  console.log('[TilesetSource] OSM Buildings active.');
}

/** Restore Google Photorealistic 3D Tiles and the default globe state. */
function activateGoogle(viewer) {
  if (osmTileset) viewer.scene.primitives.remove(osmTileset);

  const google = getGoogleTilesetRef();
  if (google && !viewer.scene.primitives.contains(google)) {
    viewer.scene.primitives.add(google);
  }

  // Google photorealistic tiles cover the whole scene; hide the base globe
  // and restore a flat ellipsoid (matches the cesium-main.js default).
  viewer.scene.globe.show = false;
  viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
  console.log('[TilesetSource] Google Photorealistic 3D Tiles active.');
}

export function useTilesetSource() {
  /**
   * Switch the viewer's 3D data source ('google' | 'osm'). Safe to call
   * repeatedly; a switch already in progress is ignored. On failure the
   * scene falls back to Google tiles so it is never left empty.
   */
  async function setSource(source) {
    const viewer = getViewer();
    if (!viewer || isSwitching.value || source === activeSource.value) return;
    isSwitching.value = true;
    try {
      if (source === 'osm') {
        await activateOsm(viewer);
        activeSource.value = 'osm';
      } else {
        activateGoogle(viewer);
        activeSource.value = 'google';
      }
    } catch (e) {
      console.error(`[TilesetSource] Failed to switch to "${source}":`, e);
      if (source === 'osm') {
        activateGoogle(viewer);
        activeSource.value = 'google';
      }
    } finally {
      isSwitching.value = false;
    }
  }

  return { activeSource, isSwitching, setSource, getActiveTileset };
}
