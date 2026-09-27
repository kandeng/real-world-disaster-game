// useCesiumPen.js — pencil-toolbox pen engine for the 3D Steer view.
//
// The 2D Plan view draws with Google Maps polylines inside MapView.vue; the
// Steer view has no Google map mounted (it is unmounted outside street mode),
// so this composable mirrors the same tool semantics on the Cesium globe:
// screen pixels are picked to world positions (depth-buffer pick first, so
// strokes land on the Google photorealistic tileset surfaces, ellipsoid as
// fallback) and committed as Cesium entities. Marks are depth-test disabled
// so they stay visible even where a picked height sinks into geometry.
//
// While a pen is armed the Cesium camera controllers are locked so a left
// drag draws instead of orbiting / panning the globe.
import { onBeforeUnmount, watch } from 'vue';

export function useCesiumPen({ active, tool, color, onMarksChange }) {
  let openStroke = null;   // { tool, color, points: [{lon,lat,h}], entities: [] }
  let marks = [];          // committed entities of the current session
  let attached = false;
  let cameraLocked = false;
  let textInputEl = null;

  const api = () => window.Cesium || null;
  const viewer = () => window.cesiumViewer || null;

  // ── camera lock ────────────────────────────────────────────────────────
  function lockCamera(on) {
    const v = viewer();
    if (!v) return;
    if (on && !cameraLocked) {
      const ssc = v.scene.screenSpaceCameraController;
      ssc.enableRotate = false;
      ssc.enableTranslate = false;
      ssc.enableZoom = false;
      ssc.enableTilt = false;
      ssc.enableLook = false;
      // Depth-buffer picking is what lets a stroke land on tileset surfaces.
      v.scene.pickPositionEnabled = true;
      cameraLocked = true;
    } else if (!on && cameraLocked) {
      const ssc = v.scene.screenSpaceCameraController;
      ssc.enableRotate = true;
      ssc.enableTranslate = true;
      ssc.enableZoom = true;
      ssc.enableTilt = true;
      ssc.enableLook = true;
      v.scene.pickPositionEnabled = false;
      cameraLocked = false;
    }
  }

  // ── picking ────────────────────────────────────────────────────────────
  // Client pixel → { lon, lat, h } on the visible surface (degrees / meters).
  function pickWorld(clientX, clientY) {
    const v = viewer();
    const Cesium = api();
    if (!v || !Cesium) return null;
    const rect = v.canvas.getBoundingClientRect();
    const win = new Cesium.Cartesian2(clientX - rect.left, clientY - rect.top);
    let world = null;
    try {
      if (v.scene.pickPositionSupported) world = v.scene.pickPosition(win);
    } catch {
      world = null;
    }
    if (!world || !Number.isFinite(world.x)) {
      world = v.camera.pickEllipsoid(win, v.scene.globe.ellipsoid);
    }
    if (!world) return null;
    const carto = Cesium.Cartographic.fromCartesian(world);
    if (!carto) return null;
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      h: Number.isFinite(carto.height) ? carto.height : 0,
    };
  }

  // ── entity builders ────────────────────────────────────────────────────
  function ink(hex) {
    return api().Color.fromCssColorString(hex).withAlpha(0.95);
  }

  function positionsOf(points) {
    const Cesium = api();
    return points.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h));
  }

  function addPolyline(points, hex) {
    return viewer().entities.add({
      polyline: {
        positions: positionsOf(points),
        width: 2.5,
        material: ink(hex),
        // Always visible: a picked height can sit a hair inside a facade.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  // Axis-aligned rectangle corners (same convention as the 2D engine).
  function rectCorners(a, b) {
    return [a, { lat: a.lat, lon: b.lon, h: b.h }, b, { lat: b.lat, lon: a.lon, h: a.h }, a];
  }

  function segmentLength(a, b) {
    const dx = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
    const dy = b.lat - a.lat;
    return Math.hypot(dx, dy);
  }

  function arrowHeadEntities(points, hex) {
    const head = points[points.length - 1];
    let prev = null;
    for (let i = points.length - 2; i >= 0; i--) {
      if (segmentLength(points[i], head) > 1e-6) {
        prev = points[i];
        break;
      }
    }
    if (!prev) return [];
    const cosLat = Math.cos((head.lat * Math.PI) / 180);
    const ang = Math.atan2(head.lat - prev.lat, (head.lon - prev.lon) * cosLat);
    const barb = Math.min(segmentLength(prev, head) * 0.25, 0.004);
    const out = [];
    for (const da of [Math.PI - 0.8, 0.8 - Math.PI]) {
      const a = ang + da;
      out.push(
        addPolyline(
          [
            head,
            {
              lat: head.lat + barb * Math.sin(a),
              lon: head.lon + (barb * Math.cos(a)) / cosLat,
              h: head.h,
            },
          ],
          hex
        )
      );
    }
    return out;
  }

  function addLabel(point, text, hex) {
    const Cesium = api();
    return viewer().entities.add({
      position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat, point.h),
      label: {
        text,
        fillColor: ink(hex),
        font: '700 14px system-ui, sans-serif',
        pixelOffset: new Cesium.Cartesian2(0, -8),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  // ── stroke lifecycle ───────────────────────────────────────────────────
  function removeEntities(entities) {
    const v = viewer();
    if (!v) return;
    (entities || []).forEach((e) => v.entities.remove(e));
  }

  function discardOpenStroke() {
    if (!openStroke) return;
    removeEntities(openStroke.entities);
    openStroke = null;
  }

  function commitOpenStroke() {
    if (!openStroke) return;
    const { tool: tl, color: hex, points, entities } = openStroke;
    openStroke = null;
    if (points.length < 2 || segmentLength(points[0], points[points.length - 1]) < 1e-6) {
      // A click without a drag draws nothing (rect / arrow); a curve needs
      // at least two sampled points.
      removeEntities(entities);
      return;
    }
    if (tl === 'arrow') entities.push(...arrowHeadEntities(points, hex));
    if (tl === 'rect') {
      entities[0].polyline.positions = positionsOf(rectCorners(points[0], points[points.length - 1]));
    }
    marks.push(...entities);
    if (onMarksChange) onMarksChange(marks.length);
  }

  function clearMarks() {
    discardOpenStroke();
    removeEntities(marks);
    marks = [];
    if (onMarksChange) onMarksChange(0);
  }

  // ── DOM handlers ───────────────────────────────────────────────────────
  function onDown(e) {
    if (!active.value || !tool.value || e.button !== 0) return;
    if (tool.value === 'text') return; // the click handler opens the input
    const p = pickWorld(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    commitOpenStroke();
    openStroke = {
      tool: tool.value,
      color: color.value,
      points: [p],
      entities: [addPolyline([p, p], color.value)],
    };
  }

  function onMove(e) {
    if (!openStroke) return;
    const p = pickWorld(e.clientX, e.clientY);
    if (!p) return;
    if (openStroke.tool === 'curve') {
      openStroke.points.push(p);
    } else {
      openStroke.points = [openStroke.points[0], p];
    }
    const path =
      openStroke.tool === 'rect'
        ? rectCorners(openStroke.points[0], p)
        : openStroke.points;
    openStroke.entities[0].polyline.positions = positionsOf(path);
  }

  function onUp() {
    if (!openStroke) return;
    commitOpenStroke();
  }

  // 'text' pen: a click drops a floating input at the cursor; Enter or blur
  // places a label entity, Escape discards.
  function onClick(e) {
    if (!active.value || tool.value !== 'text') return;
    const p = pickWorld(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    openTextInput(e.clientX, e.clientY, p);
  }

  function openTextInput(clientX, clientY, point) {
    closeTextInput();
    const input = document.createElement('input');
    input.type = 'text';
    // Reuses the 2D engine's unscoped look; fixed + body-level because the
    // Cesium container sits BEHIND #app and would hide an inner input.
    input.className = 'map-text-pen-input';
    input.style.position = 'fixed';
    input.style.left = `${clientX}px`;
    input.style.top = `${clientY}px`;
    input.style.zIndex = '5000';
    input.style.color = color.value;
    document.body.appendChild(input);
    textInputEl = input;
    input.focus();
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        const text = input.value.trim();
        closeTextInput();
        if (text) commitLabel(point, text);
      } else if (ev.key === 'Escape') {
        input._penDiscard = true;
        closeTextInput();
      }
    });
    input._penBlur = () => {
      if (input._penDiscard) return;
      const text = input.value.trim();
      closeTextInput();
      if (text) commitLabel(point, text);
    };
    input.addEventListener('blur', input._penBlur);
  }

  function commitLabel(point, text) {
    const v = viewer();
    if (!v) return;
    marks.push(addLabel(point, text, color.value));
    if (onMarksChange) onMarksChange(marks.length);
  }

  function closeTextInput() {
    if (!textInputEl) return;
    const el = textInputEl;
    textInputEl = null;
    if (el._penBlur) el.removeEventListener('blur', el._penBlur);
    el.remove();
  }

  // ── wiring ─────────────────────────────────────────────────────────────
  function attach() {
    const el = document.getElementById('cesiumContainer');
    if (!el || attached) return;
    el.addEventListener('mousedown', onDown, true);
    el.addEventListener('click', onClick, true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    attached = true;
  }

  function detach() {
    if (!attached) return;
    const el = document.getElementById('cesiumContainer');
    if (el) {
      el.removeEventListener('mousedown', onDown, true);
      el.removeEventListener('click', onClick, true);
    }
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    attached = false;
  }

  watch([active, tool], () => {
    lockCamera(active.value && !!tool.value);
    if (!active.value) {
      discardOpenStroke();
      closeTextInput();
    }
  });

  attach();

  onBeforeUnmount(() => {
    discardOpenStroke();
    closeTextInput();
    clearMarks();
    lockCamera(false);
    detach();
  });

  return { clearMarks };
}
