import * as THREE from 'three/webgpu';
import { Fn, attribute, cameraPosition, color, dot, equirectUV, length, mix, mx_noise_float, normalize, positionWorld, pow, saturate, smoothstep, uniform } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Pane } from 'tweakpane';
import { createGrassField, type GrassField, type GrassPlanet, type GrassTrample } from '../src/nature/grass';
import { mulberry32 } from '../src/planet/rng';

// 草和野花的演示页：/dev/grass.html
// 半径 30 的星球，地面是泥土色加噪声起伏；低角度暖色太阳；镜头可以贴地走（Ground），也可以绕着转（Orbit）。
// 地址参数：?webgl 强制走 WebGL2；?view=ground|backlit|orbit 开场视角；?nopane 不显示面板（截图用）

const params = new URLSearchParams(location.search);
const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: params.has('webgl'), trackTimestamp: true });
await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
// 显卡名字：写进自查结果，性能数字要知道是哪块卡上量的
function adapterName(): string {
  const b = renderer.backend as { adapter?: { info?: { vendor?: string; architecture?: string; description?: string } }; gl?: WebGL2RenderingContext };
  if (b.adapter?.info) return [b.adapter.info.vendor, b.adapter.info.architecture, b.adapter.info.description].filter(Boolean).join(' ');
  const ext = b.gl?.getExtension('WEBGL_debug_renderer_info');
  return ext && b.gl ? String(b.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
}
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 3000);

// —— 星球 ——
const R = 30;
const center = new THREE.Vector3(0, 0, 0);
const uCenter = uniform(center);
const simplex = new SimplexNoise({ random: mulberry32(11) });
// 起伏：4 层 simplex，大约 14 m 一个起伏，最高约 ±1.4 m
function terrain(x: number, y: number, z: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 2.1;
  let norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += amp * simplex.noise3d(x * freq + 3.1, y * freq, z * freq);
    norm += amp;
    amp *= 0.45;
    freq *= 2.2;
  }
  return R + 1.4 * (sum / norm);
}
const planet: GrassPlanet = { radius: R, center, height: (d) => terrain(d.x, d.y, d.z), sea: null };

// 主视点：星球上的一个点和它的切平面基（north 指向「前方」，east 在右手边）
const home = new THREE.Vector3(0.22, 0.93, 0.29).normalize();
const north = new THREE.Vector3(0, 0, -1).addScaledVector(home, home.z).normalize();
const east = new THREE.Vector3().crossVectors(north, home).normalize();
const along = (dir: THREE.Vector3, tangent: THREE.Vector3, meters: number, out = new THREE.Vector3()) =>
  out.copy(dir).applyAxisAngle(new THREE.Vector3().crossVectors(dir, tangent).normalize(), meters / R).normalize();

// 演示用的「不长草」：一条小路和一个展台
const plinthDir = along(along(home, north, 7.5), east, 2.2);
const PLINTH_R = 1.0;
const demo = { exclusion: true, sea: false, trample: false };
function exclusion(d: THREE.Vector3): number {
  if (!demo.exclusion) return 0;
  // 小路：离主视点东边 2.5 m 的一条南北向的小圆，带一点弯
  const lat = Math.asin(THREE.MathUtils.clamp(d.dot(east), -1, 1)) * R;
  const lon = Math.atan2(d.dot(north), d.dot(home)) * R;
  const off = Math.abs(lat - 2.5 - 0.9 * Math.sin(lon * 0.35));
  const path = 1 - THREE.MathUtils.smoothstep(off, 0.45, 0.8);
  const plinth = 1 - THREE.MathUtils.smoothstep(d.angleTo(plinthDir) * R, PLINTH_R + 0.1, PLINTH_R + 0.45);
  return Math.max(path, plinth);
}

// —— 地面 ——
// 合并共用顶点：IcosahedronGeometry 是每面独立的顶点，不合并的话法线是面法线，地面一块一块的
const groundGeo = (() => {
  const g = new THREE.IcosahedronGeometry(1, 80);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv'); // uv 在接缝处不同，留着会合并不了
  return mergeVertices(g);
})();
{
  const pos = groundGeo.getAttribute('position') as THREE.BufferAttribute;
  const mask = new Float32Array(pos.count);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    mask[i] = exclusion(v);
    v.multiplyScalar(terrain(v.x, v.y, v.z));
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  groundGeo.setAttribute('pathMask', new THREE.BufferAttribute(mask, 1));
  groundGeo.computeVertexNormals();
}

let grass: GrassField = makeGrass();

const uFull = uniform(grass.settings.fullRadius);
const uRadius = uniform(grass.settings.radius);
const groundMat = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
// 泥土色加噪声；草底下偏暗的橄榄土，往远处渐变成草从远处看的颜色（草淡出的地方没有边界）；小路和展台周围是泥土
groundMat.colorNode = Fn(() => {
  const q = positionWorld.sub(uCenter);
  const n = mx_noise_float(q.mul(0.9)).mul(0.5).add(mx_noise_float(q.mul(3.7)).mul(0.25)).add(0.5);
  const soil = mix(color('#3f3022'), color('#6a5238'), saturate(n));
  const under = mix(soil, color('#26331a'), 0.65);
  const d = length(cameraPosition.sub(positionWorld));
  const far = grass.groundTint(positionWorld);
  const toFar = smoothstep(uFull.mul(1.2), uRadius.mul(0.95), d);
  const base = mix(under, far, toFar);
  const path = attribute('pathMask', 'float');
  return mix(base, mix(soil, color('#7a6448'), 0.4), smoothstep(0.15, 0.6, path));
})();
const ground = new THREE.Mesh(groundGeo, groundMat);
scene.add(ground);

const water = new THREE.Mesh(new THREE.SphereGeometry(R - 0.35, 96, 64), new THREE.MeshStandardNodeMaterial({ color: '#3e6f86', roughness: 0.25, transparent: true, opacity: 0.85 }));
water.visible = false;
scene.add(water);

// 一个约 1 m 高的胶囊当作人（看比例），一个石头展台
const standOn = (obj: THREE.Object3D, dir: THREE.Vector3, lift: number) => {
  obj.position.copy(dir).multiplyScalar(terrain(dir.x, dir.y, dir.z) + lift);
  obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
};
const personDir = along(home, north, 3.2);
const person = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.6, 6, 16), new THREE.MeshStandardNodeMaterial({ color: '#e9dcc0', roughness: 0.7 }));
standOn(person, personDir, 0.48);
const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.05, 8, 20), new THREE.MeshStandardNodeMaterial({ color: '#d9692a', roughness: 0.8 }));
scarf.rotation.x = Math.PI / 2;
scarf.position.y = 0.22;
person.add(scarf);
scene.add(person);
const plinth = new THREE.Mesh(new THREE.CylinderGeometry(PLINTH_R, PLINTH_R * 1.06, 0.5, 40), new THREE.MeshStandardNodeMaterial({ color: '#b8b0a2', roughness: 0.9 }));
standOn(plinth, plinthDir, 0.1);
scene.add(plinth);

// —— 光和天空 ——
const sun = { azimuth: 160, elevation: 16, intensity: 2.4, color: '#ffd9a8' };
const sunLight = new THREE.DirectionalLight(sun.color, sun.intensity);
const hemi = new THREE.HemisphereLight('#bcd3ff', '#4d5a2e', 1.1);
hemi.position.copy(home);
scene.add(sunLight, sunLight.target, hemi);
const sunDir = new THREE.Vector3();
const uSunDir = uniform(new THREE.Vector3());
const uSunCol = uniform(new THREE.Color());

const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
skyMat.colorNode = Fn(() => {
  const v = normalize(positionWorld.sub(cameraPosition));
  const up = normalize(cameraPosition.sub(uCenter));
  const e = dot(v, up);
  const horizon = color('#f1e7d2');
  const zenith = color('#5a92d4');
  const c = mix(horizon, zenith, smoothstep(-0.02, 0.55, e)).toVar();
  c.assign(mix(c, color('#d8dde0'), smoothstep(0.0, -0.35, e)));
  const s = saturate(dot(v, uSunDir));
  c.addAssign(uSunCol.mul(pow(s, 6).mul(0.35).add(pow(s, 90).mul(0.8)).add(pow(s, 2400).mul(8))));
  return c;
})();
const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 48, 24), skyMat);
sky.renderOrder = -1;
scene.add(sky);
scene.fog = new THREE.Fog('#e6e4da', 45, 260);

function applySun(): void {
  const az = THREE.MathUtils.degToRad(sun.azimuth);
  const el = THREE.MathUtils.degToRad(sun.elevation);
  sunDir.copy(home).multiplyScalar(Math.sin(el)).addScaledVector(north, Math.cos(el) * Math.cos(az)).addScaledVector(east, Math.cos(el) * Math.sin(az)).normalize();
  sunLight.color.set(sun.color);
  sunLight.intensity = sun.intensity;
  sunLight.position.copy(sunDir).multiplyScalar(100);
  uSunDir.value.copy(sunDir);
  uSunCol.value.set(sun.color);
  grass.setSun(sunDir, sun.color, sun.intensity * 0.92);
}
applySun();

// —— 草 ——
function makeTrample(): GrassTrample {
  // 测试用的踩痕：等距柱状投影的贴图，画一圈绕着胶囊的小路
  const W = 1024;
  const H = 512;
  const data = new Uint8Array(W * H * 4);
  const d = new THREE.Vector3();
  for (let y = 0; y < H; y++) {
    const phi = ((y + 0.5) / H - 0.5) * Math.PI;
    for (let x = 0; x < W; x++) {
      const th = ((x + 0.5) / W - 0.5) * Math.PI * 2;
      d.set(Math.cos(th) * Math.cos(phi), Math.sin(phi), Math.sin(th) * Math.cos(phi));
      const r = d.angleTo(personDir) * R;
      const a = Math.max(0, 1 - Math.abs(r - 1.6) / 0.45);
      data[(y * W + x) * 4] = Math.round(255 * Math.min(1, a * 1.4));
    }
  }
  const tex = new THREE.DataTexture(data, W, H);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { texture: tex, uvOf: (dir) => equirectUV(dir) };
}

function makeGrass(): GrassField {
  const g = createGrassField({ renderer, planet, exclude: exclusion, density: 1, trample: demo.trample ? makeTrample() : undefined });
  scene.add(g.object);
  return g;
}

function rebuildGrass(): void {
  const old = grass;
  const keep = { ...old.settings, colors: { ...old.settings.colors }, windDir: old.settings.windDir.clone() };
  grass = makeGrass();
  Object.assign(grass.settings, keep);
  old.dispose();
  applySun();
}

// —— 镜头 ——
const orbit = new OrbitControls(camera, canvas);
orbit.enabled = false;
orbit.enableDamping = true;
orbit.minDistance = 2; // 目标点在地面上：可以拉得很近
orbit.maxDistance = 260;
const walker = { dir: home.clone(), heading: north.clone(), pitch: -0.12, eye: 1.3 };
let mode: 'ground' | 'orbit' = 'ground';
const keys = new Set<string>();
addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  if (mode !== 'ground') return;
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('pointermove', (e) => {
  if (!dragging || mode !== 'ground') return;
  walker.heading.applyAxisAngle(walker.dir, -e.movementX * 0.004);
  walker.pitch = THREE.MathUtils.clamp(walker.pitch - e.movementY * 0.004, -1.3, 1.0);
});
canvas.addEventListener('wheel', (e) => {
  if (mode !== 'ground') return;
  walker.eye = THREE.MathUtils.clamp(walker.eye * (1 + e.deltaY * 0.001), 0.25, 14);
});

const tmpQ = new THREE.Quaternion();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
function stepWalker(dt: number): void {
  const fwd = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
  const side = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
  if (fwd !== 0 || side !== 0) {
    const right = tmpA.crossVectors(walker.heading, walker.dir).normalize();
    const move = tmpB.copy(walker.heading).multiplyScalar(fwd).addScaledVector(right, side).normalize();
    const speed = keys.has('shift') ? 6 : 2.2;
    const axis = tmpA.crossVectors(walker.dir, move).normalize();
    tmpQ.setFromAxisAngle(axis, (speed * dt) / R);
    walker.dir.applyQuaternion(tmpQ).normalize();
    walker.heading.applyQuaternion(tmpQ);
  }
  walker.heading.addScaledVector(walker.dir, -walker.heading.dot(walker.dir)).normalize();
  const g = terrain(walker.dir.x, walker.dir.y, walker.dir.z);
  camera.position.copy(walker.dir).multiplyScalar(g + walker.eye).add(center);
  camera.up.copy(walker.dir);
  tmpB.copy(walker.heading).multiplyScalar(Math.cos(walker.pitch)).addScaledVector(walker.dir, Math.sin(walker.pitch));
  camera.lookAt(tmpA.copy(camera.position).add(tmpB));
}

function setMode(m: 'ground' | 'orbit'): void {
  mode = m;
  orbit.enabled = m === 'orbit';
  if (m === 'orbit') {
    camera.up.set(0, 1, 0);
    orbit.target.copy(center);
    orbit.update();
  }
}

// 预设视角：贴地（顺光，看胶囊）、逆光（看向低太阳）、斜上方
function view(name: string): void {
  if (name === 'orbit') {
    sun.azimuth = 150;
    sun.elevation = 20;
    const t = along(home, north, 4);
    camera.position.copy(along(home, north, -5)).multiplyScalar(terrain(t.x, t.y, t.z) + 8).addScaledVector(east, 3);
    setMode('orbit');
    orbit.target.copy(t).multiplyScalar(terrain(t.x, t.y, t.z));
    orbit.update();
  } else {
    walker.dir.copy(home);
    walker.heading.copy(north);
    walker.eye = 1.35;
    if (name === 'backlit') {
      sun.azimuth = 8;
      sun.elevation = 9;
      walker.pitch = -0.1;
    } else {
      sun.azimuth = 150;
      sun.elevation = 17;
      // fill：往下看，整屏都是近处的草（量 GPU 时间的最坏情况）
      walker.pitch = name === 'fill' ? -0.62 : -0.16;
    }
    setMode('ground');
  }
  applySun();
}
view(params.get('view') ?? 'ground');

// —— 面板 ——
interface Events {
  on(event: 'change' | 'click', handler: () => void): unknown;
}
interface Folder extends Events {
  addFolder(p: { title: string; expanded?: boolean }): Folder;
  addBinding<T extends object>(target: T, key: keyof T & string, p?: Record<string, unknown>): Events & { refresh?(): void };
  addButton(p: { title: string }): Events;
  refresh(): void;
}
const live = { backend, instances: 0, flowers: 0, tiles: 0, triangles: 0, calls: 0, frameMs: 0, gpuMs: 0, grassGpuMs: 0, toneMapping: 'ACES', windAzimuth: 20 };
if (!params.has('nopane')) {
  const pane = new Pane({ title: `Grass (${backend})`, container: document.querySelector<HTMLElement>('#pane')! }) as unknown as Folder;
  const v = pane.addFolder({ title: 'View' });
  v.addButton({ title: 'Ground (front-lit)' }).on('click', () => view('ground'));
  v.addButton({ title: 'Backlit' }).on('click', () => view('backlit'));
  v.addButton({ title: 'Orbit' }).on('click', () => view('orbit'));
  v.addBinding(walker, 'eye', { label: 'eye height', min: 0.25, max: 14, step: 0.05 });
  v.addBinding(live, 'toneMapping', { label: 'tone mapping', options: { AgX: 'AgX', ACES: 'ACES', Neutral: 'Neutral' } }).on('change', () => {
    renderer.toneMapping = live.toneMapping === 'ACES' ? THREE.ACESFilmicToneMapping : live.toneMapping === 'Neutral' ? THREE.NeutralToneMapping : THREE.AgXToneMapping;
  });
  v.addBinding(renderer, 'toneMappingExposure', { label: 'exposure', min: 0.3, max: 2, step: 0.01 });

  const g = pane.addFolder({ title: 'Grass' });
  const s = grass.settings;
  const density = { value: 1 };
  g.addBinding(density, 'value', { label: 'density', min: 0.05, max: 1, step: 0.01 }).on('change', () => grass.setDensity(density.value));
  g.addBinding(s, 'radius', { label: 'radius m', min: 8, max: 60, step: 0.5 });
  g.addBinding(s, 'fullRadius', { label: 'full density m', min: 1, max: 15, step: 0.1 });
  g.addBinding(s, 'height', { min: 0.4, max: 2, step: 0.01 });
  g.addBinding(s, 'width', { min: 0.4, max: 3, step: 0.01 });
  g.addBinding(s, 'dryness', { min: 0, max: 1, step: 0.01 });
  g.addBinding(s, 'translucency', { label: 'backlight glow', min: 0, max: 3, step: 0.01 });
  g.addBinding(s, 'flowers', { min: 0, max: 1, step: 0.01 });
  g.addBinding(s, 'flowerRadius', { label: 'flower radius m', min: 4, max: 50, step: 0.5 });

  const w = pane.addFolder({ title: 'Wind' });
  w.addBinding(s, 'windStrength', { label: 'strength', min: 0, max: 1.5, step: 0.01 });
  w.addBinding(s, 'windSpeed', { label: 'speed', min: 0, max: 3, step: 0.01 });
  w.addBinding(live, 'windAzimuth', { label: 'direction °', min: -180, max: 180, step: 1 }).on('change', () => {
    const a = THREE.MathUtils.degToRad(live.windAzimuth);
    s.windDir.copy(north).multiplyScalar(Math.cos(a)).addScaledVector(east, Math.sin(a)).normalize();
  });

  const c = pane.addFolder({ title: 'Colors', expanded: false });
  for (const key of ['root', 'lush', 'fresh', 'dry', 'tip', 'shadow'] as const) c.addBinding(s.colors, key);

  const l = pane.addFolder({ title: 'Sun' });
  l.addBinding(sun, 'azimuth', { label: 'azimuth °', min: -180, max: 180, step: 1 }).on('change', applySun);
  l.addBinding(sun, 'elevation', { label: 'elevation °', min: -5, max: 85, step: 0.5 }).on('change', applySun);
  l.addBinding(sun, 'intensity', { min: 0, max: 6, step: 0.05 }).on('change', applySun);
  l.addBinding(sun, 'color').on('change', applySun);

  const d = pane.addFolder({ title: 'Test', expanded: false });
  d.addBinding(demo, 'exclusion', { label: 'path + plinth' }).on('change', () => grass.refresh());
  d.addBinding(demo, 'sea').on('change', () => {
    planet.sea = demo.sea ? R - 0.35 : null;
    water.visible = demo.sea;
  });
  d.addBinding(demo, 'trample', { label: 'trample ring' }).on('change', rebuildGrass);

  const st = pane.addFolder({ title: 'Stats' });
  st.addBinding(live, 'backend', { readonly: true });
  st.addBinding(live, 'instances', { label: 'blades', readonly: true, format: (x: number) => x.toFixed(0) });
  st.addBinding(live, 'flowers', { label: 'flowers', readonly: true, format: (x: number) => x.toFixed(0) });
  st.addBinding(live, 'tiles', { readonly: true, format: (x: number) => x.toFixed(0) });
  st.addBinding(live, 'triangles', { readonly: true, format: (x: number) => x.toFixed(0) });
  st.addBinding(live, 'calls', { label: 'grass draws', readonly: true, format: (x: number) => x.toFixed(0) });
  st.addBinding(live, 'frameMs', { label: 'frame ms', readonly: true, format: (x: number) => x.toFixed(1) });
  st.addBinding(live, 'gpuMs', { label: 'GPU ms (all)', readonly: true, format: (x: number) => x.toFixed(2) });
  st.addBinding(live, 'grassGpuMs', { label: 'GPU ms (grass)', readonly: true, format: (x: number) => x.toFixed(2) });
  st.addButton({ title: 'Measure grass GPU time' }).on('click', () => void measure().then((r) => (live.grassGpuMs = r.grass)));
} else {
  document.querySelector<HTMLElement>('#hint')!.style.display = 'none';
}

// —— GPU 计时：草开着和关着各画若干帧，取中位数相减 ——
const gpuSamples: number[] = [];
let sampling = false;
// 拿不到时间戳（浏览器没开放 timestamp-query 或 WebGL 的计时扩展）时，等满 4 倍帧数就放弃，返回 NaN
async function sampleGpu(frames: number): Promise<number> {
  gpuSamples.length = 0;
  sampling = true;
  for (let i = 0; i < frames * 4 && gpuSamples.length < frames; i++) await new Promise((r) => requestAnimationFrame(r));
  sampling = false;
  if (gpuSamples.length === 0) return NaN;
  const s = [...gpuSamples].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
async function measure(frames = 90): Promise<{ withGrass: number; without: number; grass: number; backend: string; samples: number }> {
  grass.object.visible = false;
  await sampleGpu(20);
  const without = await sampleGpu(frames);
  grass.object.visible = true;
  await sampleGpu(20);
  const withGrass = await sampleGpu(frames);
  return { withGrass, without, grass: withGrass - without, backend, samples: gpuSamples.length };
}

// —— 主循环 ——
const timer = new THREE.Timer();
function resize(): void {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
let frames = 0;
renderer.setAnimationLoop((t) => {
  timer.update(t);
  const dt = Math.min(0.1, timer.getDelta());
  live.frameMs = live.frameMs * 0.9 + dt * 1000 * 0.1;
  if (mode === 'ground') stepWalker(dt);
  else orbit.update();
  uFull.value = grass.settings.fullRadius;
  uRadius.value = grass.settings.radius;
  grass.update(camera, timer.getElapsed());
  renderer.render(scene, camera);
  void renderer.resolveTimestampsAsync('render').then((ms) => {
    if (typeof ms === 'number' && ms > 0) {
      live.gpuMs = ms;
      if (sampling) gpuSamples.push(ms);
    }
  });
  const st = grass.stats;
  live.instances = st.instances;
  live.flowers = st.flowerInstances;
  live.tiles = st.tiles;
  live.triangles = st.triangles;
  live.calls = st.drawCalls;
  if (++frames === 3) (window as unknown as { __ready: boolean }).__ready = true;
});

// 自查脚本用
Object.assign(window, {
  __grass: {
    get field() {
      return grass;
    },
    renderer,
    camera,
    backend,
    adapter: adapterName(),
    view,
    measure,
    stats: () => ({ ...grass.stats, bands: [...grass.stats.bands], backend, frameMs: live.frameMs, camHeight: camera.position.distanceTo(center) - R }),
    setVisible: (v: boolean) => (grass.object.visible = v),
    walker,
    sun,
    applySun,
    demo,
  },
});
