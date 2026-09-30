// useSteerFreezePen.js — Steer FPV freeze + annotated-screenshot pen.
//
// The pencil toolbox means two DIFFERENT things on the two drawing surfaces:
//   • Plan (2D map): geographic marks (Google polylines, MapView.vue engine).
//   • Steer (3D FPV): the commander's objective is a MARKED 2D SCREENSHOT of
//     the first-person view — an artifact to hand to the AI for image
//     analysis — not marks glued to the globe. So arming any pen in Steer
//     FREEZES the FPV: a still frame is captured (Cesium canvas + Street View
//     crossfade via useScreenCapture.captureViewerFrame), the live drone
//     follow stops, and the still is shown full-viewport with a transparent
//     ink canvas on top. Pens draw in plain screen space on that still.
//
// While frozen the drone keeps flying. Releasing the freeze (chat Screenshot
// button after submit, the toolbox freeze/disarm button, or leaving Steer)
// hands the camera back to the drone follow, so the view "jumps" from the
// frozen moment to the drone's current pose — accepted by design.
//
// The assistant's Screenshot button (AssistantPanel) calls captureForChat():
// frozen  → the annotated still is composited into ONE PNG, posted to the
//           team chat, marks are dropped and the FPV resumes;
// unfrozen → a plain viewport frame is captured instead.
//
// Module-scope singleton (same pattern as useScreenCapture): AerialView owns
// the overlay/canvas, AssistantPanel owns the submit button, and both must
// see the exact same freeze session.
import { ref } from 'vue';
import { useScreenCapture } from './useScreenCapture.js';

const frozen = ref(false);        // FPV freeze session active (overlay shown)
const snapshotUrl = ref(null);    // data URL of the frozen still (overlay <img>)
const markCount = ref(0);         // committed annotation strokes (toolbox badge)

const { captureViewerFrame } = useScreenCapture();

let snapshotImg = null;           // HTMLImageElement of the still (compositing)
let strokes = [];                 // committed: { tool, color, points: [{x,y}], text? }
let liveStroke = null;            // stroke currently being dragged
let canvasEl = null;              // ink <canvas> bound by AerialView (v-if'd)
let ctx = null;
let cssW = 0;                     // canvas CSS-pixel size at bind time
let cssH = 0;
let textInputEl = null;
let freezeSeq = 0;                // guards stale async captures
// Supplies the live Street View crossfade opacity (0 when SV is not on
// screen). Registered by AerialView, which owns svPaneState.
let svOpacityProvider = () => 0;

// ── drawing primitives (canvas CSS pixels) ────────────────────────────────

function drawStrokes(c, list) {
  c.save();
  c.globalAlpha = 0.95;
  c.lineWidth = 2.5;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const s of list) {
    const pts = s.points;
    if (!pts || !pts.length) continue;
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    if (s.tool === 'text') {
      c.font = '700 14px system-ui, sans-serif';
      c.fillText(s.text || '', pts[0].x, pts[0].y - 8);
      continue;
    }
    if (s.tool === 'rect') {
      if (pts.length < 2) continue;
      const a = pts[0];
      const b = pts[pts.length - 1];
      c.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      continue;
    }
    if (pts.length < 2) continue;
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) c.lineTo(pts[i].x, pts[i].y);
    c.stroke();
    if (s.tool === 'arrow') {
      // Two barb lines off the head, mirroring the 2D/3D pen engines.
      const head = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      const dist = Math.hypot(head.x - prev.x, head.y - prev.y);
      if (dist < 1e-6) continue;
      const ang = Math.atan2(head.y - prev.y, head.x - prev.x);
      const barb = Math.min(dist * 0.25, 16);
      for (const da of [Math.PI - 0.8, 0.8 - Math.PI]) {
        const a = ang + da;
        c.beginPath();
        c.moveTo(head.x, head.y);
        c.lineTo(head.x + barb * Math.cos(a), head.y + barb * Math.sin(a));
        c.stroke();
      }
    }
  }
  c.restore();
}

function redraw() {
  if (!ctx) return;
  ctx.clearRect(0, 0, cssW, cssH);
  drawStrokes(ctx, strokes);
  if (liveStroke) drawStrokes(ctx, [liveStroke]);
}

// ── canvas binding (function ref on the v-if'd overlay canvas) ────────────

function sizeCanvas() {
  if (!canvasEl) return;
  cssW = canvasEl.clientWidth || window.innerWidth;
  cssH = canvasEl.clientHeight || window.innerHeight;
  // Crisp ink on HiDPI: backing store in device pixels, drawing in CSS
  // pixels (strokes are stored in CSS px; compositing rescales them).
  const dpr = window.devicePixelRatio || 1;
  canvasEl.width = Math.round(cssW * dpr);
  canvasEl.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function onWindowResize() {
  sizeCanvas();
  redraw();
}

function bindCanvas(el) {
  if (el) {
    canvasEl = el;
    ctx = el.getContext('2d');
    sizeCanvas();
    redraw();
    window.addEventListener('resize', onWindowResize);
  } else {
    window.removeEventListener('resize', onWindowResize);
    canvasEl = null;
    ctx = null;
  }
}

// ── pointer input (AerialView forwards overlay-canvas events) ─────────────

function localPoint(e) {
  const rect = canvasEl.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function pointerDown(e, tool, color) {
  if (!frozen.value || !tool || e.button !== 0) return;
  const p = localPoint(e);
  if (tool === 'text') {
    e.preventDefault();
    openTextInput(e.clientX, e.clientY, p, color);
    return;
  }
  e.preventDefault();
  try {
    canvasEl.setPointerCapture(e.pointerId);
  } catch {
    // Capture is a nicety; drawing still works via move/up on the canvas.
  }
  commitLive();
  liveStroke = { tool, color, points: [p, { ...p }] };
}

function pointerMove(e) {
  if (!liveStroke) return;
  const p = localPoint(e);
  if (liveStroke.tool === 'curve') liveStroke.points.push(p);
  else liveStroke.points = [liveStroke.points[0], p];
  redraw();
}

function pointerUp() {
  commitLive();
}

function commitLive() {
  if (!liveStroke) return;
  const s = liveStroke;
  liveStroke = null;
  const a = s.points[0];
  const b = s.points[s.points.length - 1];
  // A click without a drag draws nothing (same rule as the other engines).
  if (s.points.length >= 2 && Math.hypot(b.x - a.x, b.y - a.y) >= 1e-6) {
    strokes.push(s);
    markCount.value = strokes.length;
  }
  redraw();
}

function clearMarks() {
  commitLive();
  strokes = [];
  liveStroke = null;
  markCount.value = 0;
  redraw();
}

// ── 'text' pen: floating input at the cursor (Enter/blur commits) ─────────

function openTextInput(clientX, clientY, point, color) {
  closeTextInput();
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'map-text-pen-input';
  input.style.position = 'fixed';
  input.style.left = `${clientX}px`;
  input.style.top = `${clientY}px`;
  input.style.zIndex = '5000';
  input.style.color = color;
  document.body.appendChild(input);
  textInputEl = input;
  input.focus();
  const commit = () => {
    const text = input.value.trim();
    closeTextInput();
    if (!text) return;
    strokes.push({ tool: 'text', color, points: [point], text });
    markCount.value = strokes.length;
    redraw();
  };
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') {
      commit();
    } else if (ev.key === 'Escape') {
      input._penDiscard = true;
      closeTextInput();
    }
  });
  input._penBlur = () => {
    if (input._penDiscard) return;
    commit();
  };
  input.addEventListener('blur', input._penBlur);
}

function closeTextInput() {
  if (!textInputEl) return;
  const el = textInputEl;
  textInputEl = null;
  if (el._penBlur) el.removeEventListener('blur', el._penBlur);
  el.remove();
}

// ── freeze lifecycle ──────────────────────────────────────────────────────

async function beginFreeze() {
  if (frozen.value) return;
  const seq = ++freezeSeq;
  frozen.value = true; // stops the drone-follow camera push immediately
  const url = await captureViewerFrame(svOpacityProvider());
  if (seq !== freezeSeq || !frozen.value) return; // cancelled while capturing
  if (!url) {
    endFreeze();
    return;
  }
  const img = new Image();
  try {
    img.src = url;
    await img.decode();
  } catch {
    endFreeze();
    return;
  }
  if (seq !== freezeSeq || !frozen.value) return;
  snapshotImg = img;
  snapshotUrl.value = url;
}

function endFreeze() {
  freezeSeq += 1; // any in-flight beginFreeze capture is now stale
  frozen.value = false;
  snapshotUrl.value = null;
  snapshotImg = null;
  strokes = [];
  liveStroke = null;
  markCount.value = 0;
  closeTextInput();
}

// ── chat Screenshot button ────────────────────────────────────────────────

/**
 * The image the assistant's Screenshot button sends:
 *   frozen   → composite still + annotations into ONE PNG, then release the
 *              freeze (marks disappear, FPV resumes at the drone's new pose);
 *   unfrozen → a plain frame of the current viewport.
 * Resolves to a PNG data URL, or null when nothing could be captured.
 */
async function captureForChat() {
  if (!frozen.value) {
    return captureViewerFrame(svOpacityProvider());
  }
  if (!snapshotImg) return null;
  let url;
  if (strokes.length === 0) {
    url = snapshotUrl.value;
  } else {
    const out = document.createElement('canvas');
    out.width = snapshotImg.naturalWidth;
    out.height = snapshotImg.naturalHeight;
    const c = out.getContext('2d');
    c.drawImage(snapshotImg, 0, 0);
    // Strokes live in overlay CSS pixels; rescale into the still's natural
    // (device) resolution so the sent image matches what was on screen.
    const k = cssW > 0 ? out.width / cssW : 1;
    c.save();
    c.scale(k, k);
    drawStrokes(c, strokes);
    c.restore();
    url = out.toDataURL('image/png');
  }
  endFreeze();
  return url;
}

function setStreetViewProvider(fn) {
  svOpacityProvider = typeof fn === 'function' ? fn : () => 0;
}

export function useSteerFreezePen() {
  return {
    frozen,
    snapshotUrl,
    markCount,
    beginFreeze,
    endFreeze,
    clearMarks,
    bindCanvas,
    pointerDown,
    pointerMove,
    pointerUp,
    captureForChat,
    setStreetViewProvider,
  };
}
