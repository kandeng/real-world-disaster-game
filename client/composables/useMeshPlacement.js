/**
 * useMeshPlacement.js — place a single GLB mesh into the shared Google Earth
 * 3D scene (the global Cesium viewer created by src/cesium-main.js).
 *
 * The placement logic is extracted from the proven local-only lion test:
 *   - load via Cesium.Model.fromGltfAsync with a synchronous fromGltf fallback
 *     (fromGltfAsync resolves to undefined in some builds);
 *   - read the runtime boundingSphere only once the model reports ready
 *     (model.ready / readyEvent) — the accessor min/max box is wrong because it
 *     ignores glTF node transforms;
 *   - sample the real terrain height with scene.sampleHeightMostDetailed and sit
 *     the mesh bottom on it (+ a user-controlled clearance);
 *   - compose the model matrix from an ENU frame (heading/pitch/roll) × uniform
 *     scale, then translate so the bounding-sphere centre lands where the mesh
 *     bottom + radius says it should.
 *
 * The state is a module-scoped singleton so the placed mesh survives panel
 * toggles and page switches within the session (same pattern as useSessionState).
 */
import { reactive } from 'vue';

const state = reactive({
  meshUrl: '',
  meshName: '',
  lat: null,
  lon: null,
  alt: 0,         // clearance (m) between the mesh bottom and the ground
  heading: 0,     // degrees, 0 = north, clockwise
  pitch: 0,       // degrees
  roll: 0,        // degrees
  length: 10,     // target length (m) along the mesh's long axis -> uniform scale
  groundAlt: 0,   // sampled terrain height at (lat, lon)
  ready: false,   // model loaded, sized and placed at least once
  loading: false,
  error: '',
});

let model = null;     // the live Cesium.Model primitive
let baseRadius = 0;   // bounding-sphere radius at scale 1
let baseCenter = null; // bounding-sphere centre in model-local space (Cartesian3)

export function useMeshPlacement() {
  function viewer() {
    return window.cesiumViewer;
  }

  // scale so that the bounding-sphere diameter (2 * radius) maps to state.length
  function currentScale() {
    if (!baseRadius) return 1;
    return Math.max(0.0001, state.length / (2 * baseRadius));
  }

  function sampleGround() {
    const v = viewer();
    if (!v || state.lat == null || state.lon == null) {
      return Promise.resolve(state.groundAlt);
    }
    const carto = Cesium.Cartographic.fromDegrees(state.lon, state.lat);
    return v.scene
      .sampleHeightMostDetailed([carto])
      .then((updated) => {
        const h = updated && updated[0] && updated[0].height;
        if (Number.isFinite(h)) state.groundAlt = h;
        return state.groundAlt;
      })
      .catch((err) => {
        console.warn('[MeshPlacement] ground sampling failed, keeping', state.groundAlt, err);
        return state.groundAlt;
      });
  }

  // Recompose the model matrix from the current placement state. Called after
  // load/position and on every slider change (altitude/orientation/scale).
  function applyTransform() {
    const v = viewer();
    if (!v || !model || !baseRadius || !baseCenter || state.lat == null) return;
    const scale = currentScale();
    const enuToFixed = Cesium.Transforms.localFrameToFixedFrameGenerator('east', 'north', 'up');
    const hpr = new Cesium.HeadingPitchRoll(
      Cesium.Math.toRadians(state.heading),
      Cesium.Math.toRadians(state.pitch),
      Cesium.Math.toRadians(state.roll)
    );
    const origin = Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.groundAlt + state.alt);
    const frame = Cesium.Transforms.headingPitchRollToFixedFrame(
      origin, hpr, Cesium.Ellipsoid.WGS84, enuToFixed
    );
    // No extra "lay down" rotation: these GLBs are authored Z-up, which Cesium
    // maps flat onto the ENU frame as-is (an extra Rx(-90°) stood them on end).
    const scaled = Cesium.Matrix4.multiply(
      frame, Cesium.Matrix4.fromUniformScale(scale), new Cesium.Matrix4()
    );
    // The mesh BOTTOM must sit at (ground + alt): bottom = centre - radius*scale,
    // so the bounding-sphere centre lands at bottom + radius*scale.
    const desiredCenter = Cesium.Cartesian3.fromDegrees(
      state.lon, state.lat, state.groundAlt + state.alt + baseRadius * scale
    );
    const p = Cesium.Matrix4.multiplyByPoint(scaled, baseCenter, new Cesium.Cartesian3());
    const tcorr = Cesium.Cartesian3.subtract(desiredCenter, p, new Cesium.Cartesian3());
    model.modelMatrix = Cesium.Matrix4.multiply(
      Cesium.Matrix4.fromTranslation(tcorr), scaled, new Cesium.Matrix4()
    );
  }

  function destroyModel() {
    if (model) {
      try {
        const v = viewer();
        if (v) v.scene.primitives.remove(model);
      } catch {
        /* already removed / destroyed */
      }
      model = null;
    }
    baseRadius = 0;
    baseCenter = null;
  }

  function loadMesh(url, name) {
    const v = viewer();
    if (!v || !url) return Promise.resolve(false);
    state.loading = true;
    state.error = '';
    state.meshUrl = url;
    state.meshName = name || '';
    destroyModel();

    let created;
    if (typeof Cesium.Model.fromGltfAsync === 'function') {
      created = Cesium.Model.fromGltfAsync({ url, allowPicking: false });
    } else {
      created = Promise.resolve(Cesium.Model.fromGltf({ url, allowPicking: false }));
    }

    return Promise.resolve(created)
      .then((m) => {
        // fromGltfAsync can resolve to undefined in some Cesium builds: fall
        // back to the synchronous factory.
        if (!m && typeof Cesium.Model.fromGltf === 'function') {
          m = Cesium.Model.fromGltf({ url, allowPicking: false });
        }
        if (!m) throw new Error('could not create Cesium model');
        model = m;
        v.scene.primitives.add(model);
        // Wait for ready before touching boundingSphere.
        return new Promise((resolve, reject) => {
          const onReady = () => {
            try {
              const bs = model.boundingSphere;
              if (!bs) throw new Error('model has no boundingSphere');
              baseRadius = bs.radius;
              baseCenter = Cesium.Cartesian3.clone(bs.center);
              // First placement renders at the mesh's native length.
              state.length = Number((2 * baseRadius).toFixed(2));
              resolve();
            } catch (err) {
              reject(err);
            }
          };
          if (model.ready) onReady();
          else model.readyEvent.addEventListener(onReady);
        });
      })
      .then(() => sampleGround())
      .then(() => {
        applyTransform();
        state.ready = true;
        state.loading = false;
        return true;
      })
      .catch((err) => {
        console.error('[MeshPlacement] load failed:', err);
        state.loading = false;
        state.error = err && err.message ? err.message : String(err);
        destroyModel();
        state.ready = false;
        return false;
      });
  }

  // Place the mesh at a new lat/lon: resample the ground there, then re-seat it.
  function setPosition(lat, lon) {
    state.lat = lat;
    state.lon = lon;
    return sampleGround().then(() => {
      applyTransform();
      return true;
    });
  }

  function remove() {
    destroyModel();
    state.meshUrl = '';
    state.meshName = '';
    state.ready = false;
    state.loading = false;
    state.error = '';
  }

  return { state, loadMesh, setPosition, applyTransform, remove, currentScale, sampleGround };
}
