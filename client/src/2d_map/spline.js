// Catmull-Rom (interpolating cubic B-spline) helpers shared by the 2D map
// (waypoint link) and the 3D route preview (flight path).

// Catmull-Rom (interpolating cubic B-spline) sample at parameter t.
export function crSpline(a, b, c, d, t) {
  return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
}

// Dense polyline path of a smooth spline passing through every waypoint
// in order, so the drawn link actually touches each circle.
// When every input point carries a numeric `alt`, the samples interpolate
// it with the same Catmull-Rom curve (used by the 3D route overlay).
export function splinePath(points, samplesPerSeg = 16) {
  if (points.length < 2) return [];
  const hasAlt = points.every((p) => Number.isFinite(p.alt));
  const pts = [points[0], ...points, points[points.length - 1]];
  const out = [];
  for (let i = 0; i < pts.length - 3; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const p2 = pts[i + 2];
    const p3 = pts[i + 3];
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      const sample = {
        lat: crSpline(p0.lat, p1.lat, p2.lat, p3.lat, t),
        lng: crSpline(p0.lng, p1.lng, p2.lng, p3.lng, t),
      };
      if (hasAlt) sample.alt = crSpline(p0.alt, p1.alt, p2.alt, p3.alt, t);
      out.push(sample);
    }
  }
  const last = { lat: points[points.length - 1].lat, lng: points[points.length - 1].lng };
  if (hasAlt) last.alt = points[points.length - 1].alt;
  out.push(last);
  return out;
}
