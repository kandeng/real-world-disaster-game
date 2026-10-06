// effects/agent/index.js — E6.3 barrel for the generic L2 render primitives.
//
// The four primitives (marker / model / polyline / cellGrid), each in a 2D
// (Google Maps) and a 3D (Cesium) flavour, plus the PURE scene model that feeds
// them. Everything here is domain-agnostic: package-declared styles/meshes/
// colours drive the paint; the engine names no domain.
//
// Host usage (E6.8): create one scene model, relay the core worker's
// agents.state / agents.event into it, then attach the 2D set to the live map
// and the 3D set to the shared viewer:
//   const model = createAgentSceneModel({ styles });
//   const off2d = attachAgentOverlays2d(mapsApi, map, model);
//   const off3d = attachAgentOverlays3d(viewer, model);
//   ... off2d.detach(); off3d.detach();

export {
  createAgentSceneModel,
  subsampleLOD,
  resolveStyle,
  isModelStyle,
  gridBoundsDeg,
  cellLonLat,
  DEFAULT_STYLE,
} from './sceneModel.js';

export { attachMarkerOverlay2d, attachMarkerOverlay3d } from './markerOverlay.js';
export { attachModelOverlay2d, attachModelOverlay3d } from './modelOverlay.js';
export { attachPolylineOverlay2d, attachPolylineOverlay3d } from './polylineOverlay.js';
export { attachCellGridOverlay2d, attachCellGridOverlay3d } from './cellGridOverlay.js';

import { attachMarkerOverlay2d } from './markerOverlay.js';
import { attachModelOverlay2d } from './modelOverlay.js';
import { attachPolylineOverlay2d } from './polylineOverlay.js';
import { attachCellGridOverlay2d } from './cellGridOverlay.js';
import { attachMarkerOverlay3d } from './markerOverlay.js';
import { attachModelOverlay3d } from './modelOverlay.js';
import { attachPolylineOverlay3d } from './polylineOverlay.js';
import { attachCellGridOverlay3d } from './cellGridOverlay.js';

/** Attach all four 2D primitives to a Google map; returns one { detach() }. */
export function attachAgentOverlays2d(mapsApi, map, model) {
  const handles = [
    attachCellGridOverlay2d(mapsApi, map, model),   // cells first (under markers)
    attachPolylineOverlay2d(mapsApi, map, model),
    attachMarkerOverlay2d(mapsApi, map, model),
    attachModelOverlay2d(mapsApi, map, model),
  ];
  return { detach() { for (const h of handles) h.detach(); } };
}

/** Attach all four 3D primitives to a Cesium viewer; returns one { detach() }. */
export function attachAgentOverlays3d(viewer, model) {
  const handles = [
    attachCellGridOverlay3d(viewer, model),
    attachPolylineOverlay3d(viewer, model),
    attachMarkerOverlay3d(viewer, model),
    attachModelOverlay3d(viewer, model),
  ];
  return { detach() { for (const h of handles) h.detach(); } };
}
