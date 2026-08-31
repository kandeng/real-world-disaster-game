/**
 * useSceneAssets.js — place MULTIPLE GLB mesh assets into the shared Google
 * Earth 3D scene (the global Cesium viewer created by src/cesium-main.js),
 * backed by the session store's `scene` domain so the placed assets survive
 * panel toggles and page switches.
 *
 * Each asset carries { id, meshUrl, meshName, lat, lon, alt, heading, pitch,
 * roll, length, groundAlt, ready }. The proven single-mesh placement math
 * (from the lion test) runs per asset:
 *   - load via Cesium.Model.fromGltfAsync with a synchronous fromGltf
 *     fallback (fromGltfAsync resolves to undefined in some builds);
 *   - read the runtime boundingSphere only once the model reports ready;
 *   - sample the real terrain height with scene.sampleHeightMostDetailed and
 *     sit the mesh bottom on it (+ user clearance `alt`, may be negative);
 *   - compose the model matrix from an ENU frame (yaw/pitch/roll) × uniform
 *     scale, translated so the bounding-sphere centre lands at
 *     ground + alt + radius*scale.
 *
 * Every asset also owns a pickable Cesium POINT entity (the blue dot of the
 * 3D nadir view; a mesh-chosen asset turns red when selected, while an asset
 * whose mesh has NOT been chosen yet flashes blue to draw attention), so a
 * click in the 3D tiles can select it / fly the camera to it.
 *
 * Module-scoped singleton state (same pattern as useSessionState).
 */
import { useSessionState } from './useSessionState.js';

const { session } = useSessionState();
const scene = session.scene;

// id -> { model, baseRadius, baseCenter } live Cesium model records.
const models = new Map();
// id -> Cesium.Entity (point) pickable 3D dot.
const dots = new Map();
// The dots are pure UI (they mark the assets for clicking / selection), so
// they are only shown while the Build Scene page displays the 3D globe.
let dotsShown = false;
// Attention pulse for the 3D dots of assets whose mesh has NOT been chosen
// yet: instead of sitting as a static dot they flash (blue <-> faded blue),
// mirroring the flashing of the 2D map dots.
let dotFlashTimer = null;
let dotFlashDim = false;

const DOT_BLUE = () => new Cesium.Color(0.15, 0.45, 0.95, 1);
const DOT_RED = () => new Cesium.Color(0.86, 0.15, 0.15, 1);

function viewer() {
  return window.cesiumViewer;
}

function findAsset(id) {
  return scene.assets.find((a) => a.id === id) || null;
}

// Current color of an asset's 3D dot. An asset whose mesh has not been
// chosen yet always FLASHES blue (it must never read as a static red dot):
// full blue one phase, faded blue the next. Only mesh-chosen assets use the
// red highlight for the one that is currently selected.
function dotPointColor(asset) {
  if (asset && !asset.meshChosen) {
    return dotFlashDim ? DOT_BLUE().withAlpha(0.15) : DOT_BLUE();
  }
  return scene.selectedId === asset.id ? DOT_RED() : DOT_BLUE();
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// ── Cesium model per asset ─────────────────────────────────────────────────
function loadModel(url) {
  let created;
  if (typeof Cesium.Model.fromGltfAsync === 'function') {
    created = Cesium.Model.fromGltfAsync({ url, allowPicking: false });
  } else {
    created = Promise.resolve(Cesium.Model.fromGltf({ url, allowPicking: false }));
  }
  return Promise.resolve(created).then((m) => {
    // fromGltfAsync can resolve to undefined in some Cesium builds: fall
    // back to the synchronous factory.
    let model = m;
    if (!model && typeof Cesium.Model.fromGltf === 'function') {
      model = Cesium.Model.fromGltf({ url, allowPicking: false });
    }
    if (!model) throw new Error('could not create Cesium model');
    const v = viewer();
    if (v) v.scene.primitives.add(model);
    // Wait for ready before touching boundingSphere.
    return new Promise((resolve, reject) => {
      const onReady = () => {
        try {
          const bs = model.boundingSphere;
          if (!bs) throw new Error('model has no boundingSphere');
          resolve({ model, baseRadius: bs.radius, baseCenter: Cesium.Cartesian3.clone(bs.center) });
        } catch (err) {
          reject(err);
        }
      };
      if (model.ready) onReady();
      else model.readyEvent.addEventListener(onReady);
    });
  });
}

function destroyModel(id) {
  const rec = models.get(id);
  if (rec) {
    try {
      const v = viewer();
      if (v) v.scene.primitives.remove(rec.model);
    } catch {
      /* already removed / destroyed */
    }
    models.delete(id);
  }
}

// ── Per-asset placement ────────────────────────────────────────────────────
function sampleGround(asset) {
  const v = viewer();
  if (!v || asset.lat == null || asset.lon == null) {
    return Promise.resolve(asset.groundAlt);
  }
  const carto = Cesium.Cartographic.fromDegrees(asset.lon, asset.lat);
  return v.scene
    .sampleHeightMostDetailed([carto])
    .then((updated) => {
      const h = updated && updated[0] && updated[0].height;
      if (Number.isFinite(h)) asset.groundAlt = h;
      return asset.groundAlt;
    })
    .catch((err) => {
      console.warn('[SceneAssets] ground sampling failed, keeping', asset.groundAlt, err);
      return asset.groundAlt;
    });
}

// Recompose the model matrix + 3D dot from the asset's current fields.
function applyAsset(id) {
  const v = viewer();
  const asset = findAsset(id);
  const rec = models.get(id);
  if (!v || !asset) return;
  if (rec && rec.baseRadius && rec.baseCenter && asset.lat != null) {
    const scale = Math.max(0.0001, asset.length / (2 * rec.baseRadius));
    const enuToFixed = Cesium.Transforms.localFrameToFixedFrameGenerator('east', 'north', 'up');
    const hpr = new Cesium.HeadingPitchRoll(toRad(asset.heading), toRad(asset.pitch), toRad(asset.roll));
    const origin = Cesium.Cartesian3.fromDegrees(asset.lon, asset.lat, asset.groundAlt + asset.alt);
    const frame = Cesium.Transforms.headingPitchRollToFixedFrame(
      origin, hpr, Cesium.Ellipsoid.WGS84, enuToFixed
    );
    // No extra "lay down" rotation: these GLBs are authored Z-up, which
    // Cesium maps flat onto the ENU frame as-is.
    const scaled = Cesium.Matrix4.multiply(
      frame, Cesium.Matrix4.fromUniformScale(scale), new Cesium.Matrix4()
    );
    // The mesh BOTTOM sits at (ground + alt): centre = bottom + radius*scale.
    const desiredCenter = Cesium.Cartesian3.fromDegrees(
      asset.lon, asset.lat, asset.groundAlt + asset.alt + rec.baseRadius * scale
    );
    const p = Cesium.Matrix4.multiplyByPoint(scaled, rec.baseCenter, new Cesium.Cartesian3());
    const tcorr = Cesium.Cartesian3.subtract(desiredCenter, p, new Cesium.Cartesian3());
    rec.model.modelMatrix = Cesium.Matrix4.multiply(
      Cesium.Matrix4.fromTranslation(tcorr), scaled, new Cesium.Matrix4()
    );
  }
  syncDot(asset);
}

// Move an asset to a new lat/lon: resample the ground there, then re-seat it.
function moveAsset(id, lat, lon) {
  const asset = findAsset(id);
  if (!asset) return Promise.resolve(false);
  asset.lat = lat;
  asset.lon = lon;
  return sampleGround(asset).then(() => {
    applyAsset(id);
    return true;
  });
}

// ── Pickable 3D dots ───────────────────────────────────────────────────────
function syncDot(asset) {
  const v = viewer();
  if (!v || asset.lat == null) return;
  const pos = Cesium.Cartesian3.fromDegrees(asset.lon, asset.lat, (asset.groundAlt || 0) + 5);
  let e = dots.get(asset.id);
  if (!e) {
    e = v.entities.add({
      show: dotsShown,
      position: pos,
      point: {
        pixelSize: 18,
        color: dotPointColor(asset),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        // Keep the dot visible on top of the 3D tiles regardless of depth.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    e.assetId = asset.id;
    dots.set(asset.id, e);
  } else {
    e.position = pos;
    e.point.color = dotPointColor(asset);
  }
  syncDotFlash();
}

function removeDot(id) {
  const e = dots.get(id);
  if (e) {
    try {
      const v = viewer();
      if (v) v.entities.remove(e);
    } catch {
      /* viewer gone */
    }
    dots.delete(id);
  }
}

function refreshDots() {
  scene.assets.forEach((a) => syncDot(a));
}

// Show / hide every asset dot (Build Scene 3D view only).
function setDotsVisible(on) {
  dotsShown = !!on;
  dots.forEach((e) => {
    e.show = dotsShown;
  });
  syncDotFlash();
}

// Repaint every dot with its current (possibly flashing) color.
function paintDotFlash() {
  dots.forEach((e) => {
    const asset = findAsset(e.assetId);
    if (asset) e.point.color = dotPointColor(asset);
  });
}

// Start / stop the pulse that makes still-unspecified assets blink in the
// 3D finetune view. It only runs while the dots are actually showing and at
// least one asset still waits for a mesh choice.
function syncDotFlash() {
  const need = dotsShown && scene.assets.some((a) => !a.meshChosen);
  if (need && !dotFlashTimer) {
    dotFlashTimer = window.setInterval(() => {
      dotFlashDim = !dotFlashDim;
      paintDotFlash();
    }, 500);
  } else if (!need && dotFlashTimer) {
    window.clearInterval(dotFlashTimer);
    dotFlashTimer = null;
    dotFlashDim = false;
  }
  paintDotFlash();
}

// ── Public API ─────────────────────────────────────────────────────────────
export function useSceneAssets() {
  // Create a new asset and load its model. Defaults per the Build Scene
  // spec: altitude 0 (ON the ground), length 20 m, angles 0°.
  // `meshChosen` tells whether the user explicitly picked this mesh from the
  // library, or whether the asset just carries the fallback template — the
  // 2D dot of an unspecified asset flashes to draw attention to it.
  function addAsset(meshUrl, meshName, lat, lon, meshChosen = false) {
    if (!meshUrl || lat == null || lon == null) return null;
    const asset = {
      id: ++scene.seq,
      meshUrl,
      meshName: meshName || '',
      meshChosen: !!meshChosen,
      lat,
      lon,
      alt: 0,
      heading: 0,
      pitch: 0,
      roll: 0,
      length: 20,
      groundAlt: 0,
      ready: false,
    };
    scene.assets.push(asset);
    scene.selectedId = asset.id;
    // The dot shows immediately (at the default ground guess); the model
    // seats itself once loaded + the terrain is sampled.
    syncDot(asset);
    sampleGround(asset)
      .then(() => loadModel(meshUrl))
      .then((rec) => {
        models.set(asset.id, rec);
        applyAsset(asset.id);
        asset.ready = true;
      })
      .catch((err) => {
        console.error('[SceneAssets] load failed:', err);
        asset.error = err && err.message ? err.message : String(err);
      });
    return asset;
  }

  function selectAsset(id) {
    scene.selectedId = id;
    refreshDots();
  }

  // Assign (or replace) the mesh of an already placed asset: the position and
  // all other parameters stay, only the model is swapped and the asset counts
  // as "mesh specified" from now on.
  function setAssetMesh(id, meshUrl, meshName) {
    const asset = findAsset(id);
    if (!asset || !meshUrl) return Promise.resolve(false);
    asset.meshChosen = true;
    asset.meshName = meshName || asset.meshName;
    // This asset no longer needs the attention flash (mesh is now chosen).
    syncDotFlash();
    if (asset.meshUrl === meshUrl) return Promise.resolve(true);
    asset.meshUrl = meshUrl;
    asset.ready = false;
    destroyModel(id);
    return loadModel(meshUrl)
      .then((rec) => {
        models.set(id, rec);
        applyAsset(id);
        asset.ready = true;
        return true;
      })
      .catch((err) => {
        console.error('[SceneAssets] mesh swap failed:', err);
        asset.error = err && err.message ? err.message : String(err);
        return false;
      });
  }

  function removeAsset(id) {
    destroyModel(id);
    removeDot(id);
    const idx = scene.assets.findIndex((a) => a.id === id);
    if (idx >= 0) scene.assets.splice(idx, 1);
    if (scene.selectedId === id) scene.selectedId = null;
    syncDotFlash();
  }

  // "Clean Up the Assets": drop every model, dot and record.
  function clearAll() {
    scene.assets.slice().forEach((a) => removeAsset(a.id));
    scene.assets.splice(0, scene.assets.length);
    scene.selectedId = null;
    syncDotFlash();
  }

  return {
    scene,
    findAsset,
    addAsset,
    selectAsset,
    removeAsset,
    clearAll,
    applyAsset,
    moveAsset,
    setAssetMesh,
    refreshDots,
    setDotsVisible,
  };
}
