import * as THREE from './vendor/three.module.js';
import { EffectComposer } from './vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from './vendor/addons/postprocessing/ShaderPass.js';
import { OutputPass } from './vendor/addons/postprocessing/OutputPass.js';

export async function createFace(canvas, { bustUrl = '/assets/bust.bin' } = {}) {
// ---------- renderer / camera / post ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
const CAM = new THREE.Vector3(0, -0.05, 7.4), LOOK = new THREE.Vector3(0, -0.28, 0);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.75, 0.4, 0.35);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const finish = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5;
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      float vig = smoothstep(0.95, 0.3, length(c * vec2(1.0, 1.2)));
      col *= mix(0.45, 1.0, vig);
      col += (h(vUv * 900.0 + uTime) - 0.5) * 0.02;
      gl_FragColor = vec4(col, 1.0);
    }`,
});
composer.addPass(finish);
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); composer.setSize(w, h); bloom.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

const U = {
  uTime: { value: 0 }, uAmp: { value: 0 }, uThink: { value: 0 }, uListen: { value: 0 },
  uBurn: { value: 1 }, uPix: { value: renderer.getPixelRatio() },
  uErr: { value: 0 }, uDim: { value: 0 },
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function randn() { return Math.sqrt(-2 * Math.log(Math.random() + 1e-9)) * Math.cos(2 * Math.PI * Math.random()); }
const glowFrag = `varying vec3 vColor; varying float vAlpha;
  void main() { float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vColor, smoothstep(0.5, 0.0, d) * vAlpha); }`;

// ---------- dark navy backdrop ----------
const bg = new THREE.Mesh(new THREE.PlaneGeometry(90, 55), new THREE.ShaderMaterial({
  depthWrite: false,
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `varying vec2 vUv;
    void main(){
      float g = exp(-pow(length((vUv - vec2(0.5, 0.55)) * vec2(1.3, 1.0)) * 3.2, 2.0));
      gl_FragColor = vec4(vec3(0.001, 0.003, 0.012) + vec3(0.004, 0.018, 0.07) * g, 1.0);
    }`,
}));
bg.position.z = -25; scene.add(bg);

// ---------- bust: contour points baked from the sculpt ----------
const HEAD_CY = 0.55, HEAD_RY = 0.6, NECK_BASE = -0.3;
const res = await fetch(bustUrl);
if (!res.ok) throw new Error(`could not load ${bustUrl}: HTTP ${res.status}`);
const raw = new Float32Array(await res.arrayBuffer());

// front-surface depth lookup, used to lay veins and sparkles onto the body
const CELL = 0.03, depth = new Map();
for (let i = 0; i < raw.length; i += 7) {
  const k = Math.round(raw[i] / CELL) + ',' + Math.round(raw[i + 1] / CELL);
  if (!(depth.get(k) > raw[i + 2])) depth.set(k, raw[i + 2]);
}
function frontZ(x, y) {
  const cx = Math.round(x / CELL), cy = Math.round(y / CELL);
  for (let r = 0; r <= 4; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const z = depth.get((cx + dx) + ',' + (cy + dy)); if (z !== undefined) return z;
  }
  return null;
}

const pos = [], nrm = [], seed = [], kind = [];
const add = (x, y, z, nx, ny, nz, k) => { pos.push(x, y, z); nrm.push(nx, ny, nz); seed.push(Math.random()); kind.push(k); };
for (let i = 0; i < raw.length; i += 7) add(raw[i], raw[i + 1], raw[i + 2], raw[i + 3], raw[i + 4], raw[i + 5], raw[i + 6]);
// sparkle aura around the head outline (kind 2)
for (let i = 0; i < raw.length; i += 7) {
  if (raw[i + 6] !== 0 || raw[i + 1] < 0.05 || Math.abs(raw[i + 5]) > 0.1) continue;
  for (let j = 0; j < 2; j++) {
    if (Math.random() > 0.55) continue;
    const out = 1 + Math.abs(randn()) * 0.09;
    add(raw[i] * out, raw[i + 1] + (raw[i + 1] - HEAD_CY) * (out - 1) * 0.8 + randn() * 0.01, raw[i + 2] * 0.3, Math.sign(raw[i]), 0, 0, 2);
  }
}
// golden veins running down the neck and sternum (kind 3)
function vein(x, y, dx, len, depthLeft) {
  for (let s = 0; s < len; s++) {
    dx += (Math.random() - 0.5) * 0.35; dx *= 0.9;
    x += dx * 0.012; y -= 0.012;
    const z = frontZ(x, y); if (z === null) return;
    add(x, y, z + 0.006, 0, 0, 1, 3);
    if (s % 3 === 0) add(x + (Math.random() - 0.5) * 0.004, y, z + 0.006, 0, 0, 1, 3);
    if (depthLeft > 0 && Math.random() < 0.035) vein(x, y, (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.6), (len - s) * 0.6, depthLeft - 1);
  }
}
for (let v = 0; v < 6; v++) vein((Math.random() - 0.5) * 0.14, HEAD_CY - HEAD_RY - 0.02, (Math.random() - 0.5) * 0.3, 85 + Math.random() * 25, 2);
// sparkle burst on the chest (kind 4)
const BURST = new THREE.Vector2(0, -1.22);
for (let i = 0; i < 900; i++) {
  const r = Math.abs(randn()) * 0.07 * (Math.random() < 0.2 ? 2.5 : 1), a = Math.random() * Math.PI * 2;
  const x = BURST.x + Math.cos(a) * r, y = BURST.y + Math.sin(a) * r * 1.2;
  const z = frontZ(x, y) ?? 0.5;
  add(x, y, z + 0.01 + Math.random() * 0.03, 0, 0, 1, 4);
}

const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
geo.setAttribute('aNormal', new THREE.Float32BufferAttribute(nrm, 3));
geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
geo.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));

const FACE = new THREE.Vector2(0, HEAD_CY - 0.1);
const figMat = new THREE.ShaderMaterial({
  uniforms: { ...U, uFace: { value: FACE } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `
    attribute vec3 aNormal; attribute float aSeed; attribute float aKind;
    uniform float uTime, uAmp, uThink, uListen, uBurn, uPix, uErr, uDim; uniform vec2 uFace;
    varying vec3 vColor; varying float vAlpha;
    void main() {
      vec3 p = position;
      bool line = aKind < 1.5, head = aKind < 0.5, aura = aKind > 1.5 && aKind < 2.5, vein = aKind > 2.5 && aKind < 3.5, burst = aKind > 3.5;
      float facing = aNormal.z;
      float rim = pow(1.0 - clamp(abs(facing), 0.0, 1.0), 1.8);
      float back = smoothstep(0.1, -0.3, facing);

      // burn: orange oval over the face, lines ripple with the voice
      vec2 fd = (p.xy - uFace) * vec2(1.25, 1.0);
      float reach = (0.43 + uAmp * 0.1) * uBurn;
      float burn = head ? smoothstep(reach, reach * 0.2, length(fd)) * smoothstep(0.0, 0.45, facing) : 0.0;
      float wave = sin(p.x * 26.0 - uTime * 7.0) * 0.6 + sin(p.x * 11.0 + uTime * 2.7) * 0.4;
      p.y += wave * 0.016 * (0.35 + uAmp) * burn;
      p += aNormal * sin(uTime * 1.2 + aSeed * 6.2831) * 0.002;

      float scanY = mod(-uTime * 0.8, 3.4) - 1.9;
      float scan = uThink * smoothstep(0.045, 0.0, abs(p.y - scanY)) * (line ? 1.0 : 0.0);

      vec3 electric = vec3(0.06, 0.42, 1.0), cyan = vec3(0.4, 0.82, 1.0), ice = vec3(0.85, 0.96, 1.0);
      vec3 col = mix(electric, cyan, 0.15 + 0.55 * rim) + ice * pow(rim, 6.0) * 0.35;
      float a = (0.13 + 0.42 * rim) * (1.0 - back * 0.95);
      float size = 1.3 + rim * 0.8;

      float heat = clamp(burn * (0.9 + uAmp * 0.7), 0.0, 1.0);
      vec3 fire = mix(vec3(1.0, 0.42, 0.05), vec3(1.0, 0.78, 0.3), smoothstep(0.45, 1.0, heat) * (0.5 + 0.5 * max(wave, 0.0)));
      col = mix(col, fire * 0.85, smoothstep(0.03, 0.2, heat));
      a = mix(a, 0.34 + 0.2 * max(wave, 0.0), smoothstep(0.03, 0.2, heat));

      if (!head && line) a *= smoothstep(-2.0, -1.05, p.y);
      if (aura) { col = mix(electric, ice, aSeed * aSeed) * 1.1; a = 0.12 + 0.3 * aSeed; size = 0.9 + aSeed * 1.5;
                  a *= 0.6 + 0.4 * sin(uTime * (1.0 + aSeed * 3.0) + aSeed * 40.0); }
      if (vein) { float flow = 0.55 + 0.45 * sin(uTime * 3.0 + p.y * 14.0 + aSeed);
                  col = mix(vec3(1.0, 0.55, 0.12), vec3(1.0, 0.85, 0.5), flow) * (0.9 + uAmp * 0.5); a = 0.8; size = 2.0; }
      if (burst) { col = mix(ice, vec3(0.6, 0.85, 1.0), aSeed); a = (0.5 + 0.5 * sin(uTime * (2.0 + aSeed * 5.0) + aSeed * 60.0)) * 0.5;
                   size = 1.0 + aSeed * 2.4 * (0.8 + uAmp); }
      col += ice * scan;
      col *= 1.0 + uListen * 0.25 * sin(uTime * 7.0 - p.y * 10.0);

      col = mix(col, vec3(1.0, 0.28, 0.08) * (0.6 + 0.4 * sin(uTime * 28.0)), uErr * 0.55);
      a *= 1.0 - uDim * 0.65;

      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = (size + heat * 0.6 + scan) * uPix * (7.4 / -mv.z);
      vColor = col; vAlpha = a;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: glowFrag,
});
const figure = new THREE.Points(geo, figMat);
figure.renderOrder = 2;
scene.add(figure);

function radialTexture(stops) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const ember = new THREE.Sprite(new THREE.SpriteMaterial({
  map: radialTexture([[0, 'rgba(255,190,80,1)'], [0.35, 'rgba(255,125,20,0.85)'], [0.62, 'rgba(230,80,5,0.35)'], [1, 'rgba(200,60,0,0)']]),
  blending: THREE.NormalBlending, depthWrite: false, depthTest: false, transparent: true }));
ember.position.set(FACE.x, FACE.y, 0.3);
ember.renderOrder = 1;
figure.add(ember);

// ---------- rings ----------
const rings = [];
const ringGeo = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 481 }, (_, i) => {
  const a = i / 480 * Math.PI * 2; return new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
}));
for (let i = 0; i < 9; i++) {
  const m = new THREE.LineBasicMaterial({ color: 0x2f6fd8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const l = new THREE.Line(ringGeo, m); l.position.set(0, HEAD_CY - 0.02, -0.8); scene.add(l); rings.push(l);
}

// ---------- electric mountains with lightning veins ----------
function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function ridged(x, y) { let s = 0, a = 0.55, f = 1; for (let i = 0; i < 5; i++) { s += a * (1 - Math.abs(2 * vnoise(x * f, y * f) - 1)) ** 2; f *= 2.05; a *= 0.5; } return s; }
function terrainH(x, z) {
  const side = clamp((Math.abs(x) - 1.35) / 1.8, 0, 1);
  return -2.2 + ridged(x * 0.42 + 7, z * 0.45) * (0.3 + side * 3.4);
}
const tp = [], tc = [], ts = [];
for (let z = -1.6; z > -9; z -= 0.045) {
  for (let x = -8; x < 8; x += 0.026) {
    if (Math.abs(x) < 1.1) continue;
    const y = terrainH(x, z);
    tp.push(x + (Math.random() - 0.5) * 0.02, y, z + (Math.random() - 0.5) * 0.03);
    const e = 0.04, slope = Math.abs(terrainH(x + e, z) - y) / e;
    const b = 0.28 + clamp((y + 2.2) * 0.25, 0, 0.9) + slope * 0.06;
    tc.push(0.1 * b, 0.45 * b, 1.0 * b); ts.push(Math.random());
  }
}
for (let v = 0; v < 170; v++) {
  let x = (Math.random() < 0.5 ? -1 : 1) * (1.6 + Math.random() * 6), z = -1.8 - Math.random() * 6.5;
  const warm = Math.random() < 0.55;
  for (let s = 0; s < 480; s++) {
    const e = 0.02, h = terrainH(x, z);
    const gx = (terrainH(x + e, z) - h) / e, gz = (terrainH(x, z + e) - h) / e;
    const l = Math.hypot(gx, gz) + 1e-6;
    x -= gx / l * 0.01 + (Math.random() - 0.5) * 0.009;
    z -= gz / l * 0.01 + (Math.random() - 0.5) * 0.009;
    if (z > -1.6 || l < 0.02 || Math.abs(x) < 1.2) break;
    tp.push(x, terrainH(x, z) + 0.006, z);
    if (warm) tc.push(1.0, 0.68, 0.28); else tc.push(0.8, 0.92, 1.0);
    ts.push(2 + Math.random());
  }
}
const terrGeo = new THREE.BufferGeometry();
terrGeo.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
terrGeo.setAttribute('aColor', new THREE.Float32BufferAttribute(tc, 3));
terrGeo.setAttribute('aSeed', new THREE.Float32BufferAttribute(ts, 1));
scene.add(new THREE.Points(terrGeo, new THREE.ShaderMaterial({
  uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `
    attribute vec3 aColor; attribute float aSeed; uniform float uTime, uPix;
    varying vec3 vColor; varying float vAlpha;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float vein = step(1.5, aSeed), s = fract(aSeed);
      float flow = 0.6 + 0.4 * sin(uTime * 2.2 - position.y * 10.0 + s * 3.0);
      float tw = 0.75 + 0.25 * sin(uTime * (0.5 + s * 2.0) + s * 50.0);
      vColor = aColor * mix(tw, flow, vein);
      vAlpha = smoothstep(19.0, 8.0, -mv.z) * mix(0.85, 0.95, vein);
      gl_PointSize = min((1.2 + s * 0.8 + vein * 0.8) * uPix * (7.4 / -mv.z), 2.6 * uPix);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: glowFrag,
})));

// ---------- stars ----------
const sp = [];
for (let i = 0; i < 1600; i++) sp.push((Math.random() - 0.5) * 50, Math.random() * 18 - 2, -16 - Math.random() * 8);
scene.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)),
  new THREE.PointsMaterial({ color: 0x5f9cff, size: 0.04, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false })));

// ---------- state ----------
let state = 'idle', external = null;
const STATE_AMP = { idle: 0.14, listening: 0.3, thinking: 0.2, speaking: 0.5, error: 0.2, muted: 0.06, preparing: 0.16 };
function targetAmp(t, s) {
  if (s === 'speaking') return 0.3 + 0.7 * Math.abs(Math.sin(t * 8.3) * Math.sin(t * 2.2 + 1.0) + 0.22 * Math.sin(t * 19.0));
  if (s === 'listening') return 0.2 + 0.2 * Math.abs(Math.sin(t * 4.3) * Math.sin(t * 1.4));
  if (s === 'preparing') return 0.1 + 0.08 * Math.sin(t * 1.5);
  return (STATE_AMP[s] ?? 0.14) + 0.04 * Math.sin(t * 0.8);
}
let err = 0, dim = 0;

let amp = 0, think = 0, listen = 0;
const clock = new THREE.Clock();
function animate() {
  const t = clock.getElapsedTime();
  const s = state;
  if (!Number.isFinite(amp)) amp = 0;
  amp += ((external ?? targetAmp(t, s)) - amp) * 0.16;
  think += ((s === 'thinking' ? 1 : 0) - think) * 0.05;
  listen += ((s === 'listening' ? 1 : 0) - listen) * 0.05;
  err += ((s === 'error' ? 1 : 0) - err) * 0.12;
  dim += ((s === 'muted' ? 1 : 0) - dim) * 0.08;
  U.uErr.value = err; U.uDim.value = dim;
  U.uTime.value = t; U.uAmp.value = amp; U.uThink.value = think; U.uListen.value = listen;
  finish.uniforms.uTime.value = t;

  figure.rotation.y = Math.sin(t * 0.2) * 0.07;
  camera.position.set(CAM.x + Math.sin(t * 0.09) * 0.12, CAM.y + Math.sin(t * 0.13) * 0.03, CAM.z);
  camera.lookAt(LOOK);

  const es = (0.95 + amp * 0.35) * U.uBurn.value;
  ember.scale.set(es * 0.72, es * 0.82, 1);
  ember.material.opacity = 0.55 + amp * 0.3;

  const speed = s === 'speaking' ? 0.35 : s === 'listening' ? -0.25 : 0.05;
  rings.forEach((r, i) => {
    const ph = ((t * speed + i / rings.length) % 1 + 1) % 1;
    const radius = 0.95 + ph * 2.6;
    r.scale.set(radius, radius, 1);
    const strength = s === 'speaking' ? 0.34 + amp * 0.2 : s === 'listening' ? 0.3 : 0.18;
    r.material.opacity = Math.pow(Math.sin(ph * Math.PI), 1.3) * strength * (1 - dim);
  });

  composer.render();
  requestAnimationFrame(animate);
}
animate();

return {
  setState(s) { state = s; },
  setAmplitude(a) { external = Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : null; },
};
}
