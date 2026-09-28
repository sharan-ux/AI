// Sculpt the bust as one continuous surface of revolution-like shape (head → neck → trapezius → shoulders),
// with proportions measured from the reference image, then trace contour lines over it.
// Writes bust.bin: Float32 [x, y, z, nx, ny, nz, kind] (kind 0 head/neck, 1 body).
import { writeFileSync } from 'node:fs';

const P = {
  headCy: 0.55, headRy: 0.72, headRx: 0.42, chinTaper: 0.2, headDepth: 1.1,
  neckR: 0.235, neckTop: 0.1, neckBase: -0.56,
  shoulderW: 0.84, shoulderK: 2.3, deltoid: 0.06, torsoDepth: 0.46, torsoPow: 2.6,
  lineStep: 0.0125, rippleLift: 0.12, rippleSquash: 1.0, wTop: 0.12, wBot: 0.3, arc: 0.0062, fillet: 0.32, tStart: 0.06, slope: 1.08, kFillet: 0.3, kCap: 0.4, bodyCurve: 0.72,
  ...JSON.parse(process.env.P ?? '{}'),
};
const smax = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; };
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// half-width X(y) and half-depth Z(y) of the cross-section, and its squareness exponent
function section(y) {
  const v = (y - P.headCy) / P.headRy;
  let hx = 0;
  if (Math.abs(v) < 1) hx = P.headRx * Math.sqrt(1 - v * v) * (v < 0 ? 1 - P.chinTaper * v * v : 1);
  const nx = P.neckR * Math.sqrt(smooth(P.neckTop + 0.3, P.neckTop - 0.12, y)) * (1 - 0.05 * Math.sin(Math.PI * smooth(P.neckBase, P.neckTop, y)));
  const t = P.neckBase + 0.01 - y;
  const g = u => (Math.tanh((u - P.t0) / P.ts) - Math.tanh(-P.t0 / P.ts)) / (1 - Math.tanh(-P.t0 / P.ts));
  const smin = (a, b, k) => -smax(-a, -b, k);
  const L = P.neckR + (t - P.tStart) * P.slope;
  const tx = y > P.neckTop ? 0 : smin(smax(P.neckR - P.kFillet * 0.25, L, P.kFillet), P.neckR + P.shoulderW, P.kCap);
  const X = Math.max(smax(hx, nx, 0.09), tx);
  const hz = hx * P.headDepth, nz = nx * 1.04;
  const tz = y > P.neckTop ? 0 : smin(smax(P.neckR * 1.04 - P.kFillet * 0.25, P.neckR + (t - P.tStart) * 0.55, P.kFillet), P.torsoDepth, 0.3);
  const Z = Math.max(smax(hz, nz, 0.09), tz);
  const pw = 2 + (P.torsoPow - 2) * smooth(P.neckBase, P.neckBase - 0.5, y);
  return [X, Z, pw];
}
function surface(y, th) {
  const [X, Z, pw] = section(y);
  const c = Math.cos(th), s = Math.sin(th);
  return [X * Math.sign(c) * Math.abs(c) ** (2 / pw), y, Z * Math.sign(s) * Math.abs(s) ** (2 / pw)];
}
// contour field: horizontal on the head, arcs parallel to the shoulder line on the body
const bodyW = y => smooth(P.neckBase + P.wTop, P.neckBase - P.wBot, y);
// body: concentric ripples spreading from the base of the neck
const RC = () => P.neckBase + P.rippleLift;
const field = (x, y) => { const w = bodyW(y); const r = Math.hypot(x, (y - RC()) * P.rippleSquash); return (1 - w) * y + w * (RC() - Math.max(0, r - P.neckR)); };

function solveY(c, th) {             // find y on the surface where field = c at angle th
  let lo = -3.2, hi = P.headCy + P.headRy;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2, [x] = surface(m, th);
    if (field(x, m) > c) hi = m; else lo = m;
  }
  return (lo + hi) / 2;
}
function normal(y, th) {
  const e = 0.002, a = surface(y, th), b = surface(y + e, th), d = surface(y, th + e);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const l = Math.hypot(...n) || 1; return [-n[0] / l, -n[1] / l, -n[2] / l];
}

const out = [];
// equal spacing along the surface on the head/neck: smaller height steps where the profile is nearly flat (crown)
function stepAt(c) { if (c < P.neckBase) return P.lineStep; const e = 0.003; const dX = (section(c + e)[0] - section(c - e)[0]) / (2 * e); return Math.max(0.12, 1 / Math.sqrt(1 + dX * dX)) * P.lineStep; }
const top = P.headCy + P.headRy;
for (let c = top - 0.006; c > -3.0; c -= stepAt(c)) {
  // estimate perimeter to space points evenly along the line
  const probe = []; let perim = 0;
  for (let k = 0; k <= 64; k++) { const th = k / 64 * Math.PI * 2; probe.push(surface(solveY(c, th), th)); }
  for (let k = 1; k < probe.length; k++) perim += Math.hypot(probe[k][0] - probe[k - 1][0], probe[k][1] - probe[k - 1][1], probe[k][2] - probe[k - 1][2]);
  const n = Math.max(12, Math.round(perim / P.arc));
  for (let k = 0; k < n; k++) {
    const th = (k + Math.random() * 0.3) / n * Math.PI * 2;
    const y = solveY(c, th); if (y < -2.95) continue;
    const p = surface(y, th), nn = normal(y, th);
    out.push(p[0], p[1], p[2], nn[0], nn[1], nn[2], y > P.neckBase + 0.05 ? 0 : 1);
  }
}
writeFileSync(new URL('./bust.bin', import.meta.url), Buffer.from(new Float32Array(out).buffer));
console.log('points', out.length / 7);
