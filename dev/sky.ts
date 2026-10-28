import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createAtmosphere, type AtmospherePreset } from '../src/nature/atmosphere';

// 天空、云海和光照的演示页：/dev/sky.html
// 一颗半径 30 的草绿色星球，几块石头，一个约 1 m 高的胶囊当作人，再放两件金属小物件看环境反射（金属不能发黑）。
// 地址参数：?view=ground（贴地视角）、?preset=sunset、?webgl（强制 WebGL2）、?timing（GPU 计时，Tweakpane 里显示）、?nopane
// window.__sky 给自查脚本用：ready、setView、setPreset、measure（逐帧 GPU 时间）、atmosphere（显示 / 隐藏天空和云海做对比）

const R = 30;
const q = new URLSearchParams(location.search);
const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: q.has('webgl'), trackTimestamp: q.has('timing') });
await renderer.init();
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight, false);
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 6000);

// ---- 星球和摆设
const up = new THREE.Vector3(0, 1, 0);
const onSurface = (obj: THREE.Object3D, dir: THREE.Vector3, lift = 0) => {
  const d = dir.clone().normalize();
  obj.position.copy(d).multiplyScalar(R + lift);
  obj.quaternion.setFromUnitVectors(up, d);
  return obj;
};
const planet = new THREE.Mesh(new THREE.SphereGeometry(R, 192, 128), new THREE.MeshStandardNodeMaterial({ color: '#6e9a3e', roughness: 0.95, metalness: 0 }));
planet.name = 'planet';
scene.add(planet);

const rockMat = new THREE.MeshStandardNodeMaterial({ color: '#8b8a86', roughness: 0.85, metalness: 0, flatShading: true });
const rng = (() => {
  let s = 12345;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
})();
const rocks = new THREE.Group();
const rockSpots: [number, number, number, number][] = [
  [2.5, 0, -1.8, 0.7], [-3.2, 0, 1.2, 0.5], [1.4, 0, 3.6, 0.9], [-1.6, 0, -4.2, 0.4], [5.5, 0, 2.0, 1.4],
  [-6.5, 0, -2.5, 1.1], [9, 0, -7, 2.0], [-11, 0, 6, 1.6], [3, 0, 12, 1.2], [14, 0, 4, 2.4],
];
// 顶点按自身位置的哈希挪动：IcosahedronGeometry 的面不共用顶点，同一位置的几个顶点要挪得一样，石头才不会裂开
const jitter = (x: number, y: number, z: number, k: number) => {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + k * 19.3) * 43758.5453;
  return h - Math.floor(h);
};
for (const [x, , z, s] of rockSpots) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  const sx = 0.85 + rng() * 0.3;
  const sy = 0.55 + rng() * 0.25;
  const seed = rng() * 100;
  for (let i = 0; i < p.count; i++) {
    const [px, py, pz] = [p.getX(i), p.getY(i), p.getZ(i)];
    const k = 0.82 + jitter(px, py, pz, seed) * 0.36;
    p.setXYZ(i, px * k * sx, py * k * sy, pz * k);
  }
  g.computeVertexNormals();
  const rock = new THREE.Mesh(g, rockMat);
  rock.scale.setScalar(s);
  const dir = new THREE.Vector3(x / R, 1, z / R);
  onSurface(rock, dir, s * 0.15);
  rock.rotateY(rng() * Math.PI * 2);
  rocks.add(rock);
}
scene.add(rocks);

// 人：胶囊高 1 m（半径 0.22 + 身长 0.56 + 半径 0.22），站在北极
const person = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.56, 6, 16), new THREE.MeshStandardNodeMaterial({ color: '#2f6b4f', roughness: 0.7 }));
person.position.set(0, R + 0.5, 0);
scene.add(person);
const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.05, 8, 24), new THREE.MeshStandardNodeMaterial({ color: '#e07a2e', roughness: 0.8 }));
scarf.position.set(0, R + 0.8, 0);
scarf.rotation.x = Math.PI / 2;
scene.add(scarf);

// 金属小物件：镜面球和金色方块（PBR，金属度 1），看环境反射
const chrome = new THREE.Mesh(new THREE.SphereGeometry(0.35, 48, 32), new THREE.MeshStandardNodeMaterial({ color: '#ffffff', roughness: 0.08, metalness: 1 }));
onSurface(chrome, new THREE.Vector3(1.2 / R, 1, 0.6 / R), 0.35);
const gold = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), new THREE.MeshStandardNodeMaterial({ color: '#e8b04a', roughness: 0.35, metalness: 1 }));
onSurface(gold, new THREE.Vector3(-1.1 / R, 1, 0.9 / R), 0.3);
gold.rotateY(0.6);
scene.add(chrome, gold);

// ---- 天空、云海、光照
const preset0: AtmospherePreset = q.get('preset') === 'sunset' ? 'sunset' : 'day';
const atmosphere = createAtmosphere(scene, renderer, { planetRadius: R, preset: preset0 });
atmosphere.setPlanet(new THREE.Vector3(0, 0, 0), R);

// ---- 镜头：轨道视角绕星球中心转；贴地视角绕人转（镜头高度在 0.5–4 m，像站在星球上看云海）
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
type View = 'orbit' | 'ground';
const view = { mode: (q.get('view') === 'ground' ? 'ground' : 'orbit') as View };
const head = new THREE.Vector3(0, R + 0.9, 0);
function setView(mode: View): void {
  view.mode = mode;
  if (mode === 'orbit') {
    // 斜上方俯瞰：星球在画面中下部，上方露出地平线和天空（参考 F2）
    controls.target.set(0, 6, 0);
    controls.minDistance = R * 1.45;
    controls.maxDistance = R * 18;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI;
    camera.position.set(-62, 40, 108);
    camera.fov = 40;
  } else {
    // 站在人身后，朝太阳那边的云海看（太阳在画面右上方，参考 F4）
    controls.target.copy(head).add(new THREE.Vector3(0.2, 0.25, 1.6));
    controls.minDistance = 1.2;
    controls.maxDistance = 9;
    controls.minPolarAngle = THREE.MathUtils.degToRad(55);
    controls.maxPolarAngle = THREE.MathUtils.degToRad(96);
    camera.position.copy(head).add(new THREE.Vector3(-0.5, 0.35, -2.4));
    camera.fov = 50;
  }
  camera.updateProjectionMatrix();
  controls.update();
}
setView(view.mode);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
addEventListener('keydown', (e) => {
  if (e.key === 'g' || e.key === 'G') setView(view.mode === 'orbit' ? 'ground' : 'orbit');
  if (e.key === 'p' || e.key === 'P') ui.preset = ui.preset === 'day' ? 'sunset' : 'day';
  if (e.key === 'p' || e.key === 'P') atmosphere.setPreset(ui.preset);
});

// ---- 计时：每帧读回 GPU 时间（需要 ?timing），记最近 240 帧
const gpuTimes: number[] = [];
const cpuFrames: number[] = [];
const ui = { preset: preset0 as AtmospherePreset, gpu: 0, fps: 0, backend };
let last = performance.now();
let frames = 0;
const timer = new THREE.Timer();
renderer.setAnimationLoop((t) => {
  timer.update(t);
  const dt = Math.min(timer.getDelta(), 0.1);
  controls.update(dt);
  atmosphere.update(dt, camera);
  renderer.render(scene, camera);
  frames++;
  const now = performance.now();
  cpuFrames.push(now - last);
  if (cpuFrames.length > 240) cpuFrames.shift();
  last = now;
  if (q.has('timing')) {
    void renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then((ms) => {
      if (typeof ms === 'number' && ms > 0) {
        gpuTimes.push(ms);
        if (gpuTimes.length > 240) gpuTimes.shift();
      }
    });
  }
});

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const waitFrames = (n: number) => new Promise<void>((resolve) => {
  const start = frames;
  const tick = () => (frames - start >= n ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
});

// ---- Tweakpane（用到的接口自己写类型，和 src/tune.ts 一样）
interface Events {
  on(event: 'change' | 'click', handler: (ev: { value: unknown }) => void): unknown;
}
interface Folder extends Events {
  addFolder(params: { title: string; expanded?: boolean }): Folder;
  addBinding<T extends object>(target: T, key: keyof T & string, params?: Record<string, unknown>): Events;
  addButton(params: { title: string }): Events;
  refresh(): void;
}
if (!q.has('nopane')) {
  const { Pane } = await import('tweakpane');
  const container = document.createElement('div');
  container.className = 'pane';
  document.body.append(container);
  const pane = new Pane({ title: 'Sky & clouds', container }) as unknown as Folder;
  pane.addBinding(ui, 'preset', { options: { Day: 'day', Sunset: 'sunset' } }).on('change', () => atmosphere.setPreset(ui.preset));
  pane.addBinding(view, 'mode', { label: 'view', options: { Orbit: 'orbit', Ground: 'ground' } }).on('change', () => setView(view.mode));
  const p = atmosphere.params;
  const sunF = pane.addFolder({ title: 'Sun' });
  sunF.addBinding(p, 'sunElevation', { label: 'elevation°', min: -4, max: 70, step: 0.1 });
  sunF.addBinding(p, 'sunAzimuth', { label: 'azimuth°', min: -180, max: 180, step: 0.5 });
  const seaF = pane.addFolder({ title: 'Sea of clouds' });
  seaF.addBinding(p, 'seaHeight', { label: 'height × R', min: -0.9, max: 0.2, step: 0.01 });
  seaF.addBinding(p, 'seaThickness', { label: 'thickness × R', min: 0.05, max: 1.2, step: 0.01 });
  seaF.addBinding(p, 'cloudScale', { label: 'cloud size', min: 0.3, max: 3, step: 0.01 });
  seaF.addBinding(p, 'cloudSpeed', { label: 'drift speed', min: 0, max: 6, step: 0.05 });
  seaF.addBinding(p, 'farClouds', { label: 'far cumulus' });
  const lookF = pane.addFolder({ title: 'Air & exposure' });
  lookF.addBinding(p, 'fog', { min: 0, max: 4, step: 0.01 });
  lookF.addBinding(p, 'exposure', { min: 0.3, max: 2.5, step: 0.01 });
  const perf = pane.addFolder({ title: 'Performance', expanded: true });
  perf.addBinding(ui, 'backend', { readonly: true });
  perf.addBinding(ui, 'fps', { readonly: true, format: (v: number) => v.toFixed(0) });
  if (q.has('timing')) perf.addBinding(ui, 'gpu', { label: 'GPU ms', readonly: true, format: (v: number) => v.toFixed(2) });
  else perf.addButton({ title: 'Enable GPU timing (reload)' }).on('click', () => { q.set('timing', ''); location.search = q.toString(); });
  setInterval(() => {
    ui.fps = 1000 / Math.max(1, median(cpuFrames));
    ui.gpu = median(gpuTimes.slice(-60));
    pane.refresh();
  }, 250);
}

// ---- 自查钩子
declare global {
  interface Window {
    __ready?: boolean;
    __sky?: unknown;
  }
}
window.__sky = {
  backend,
  atmosphere,
  setView,
  setPreset: (p: AtmospherePreset) => {
    ui.preset = p;
    atmosphere.setPreset(p);
  },
  // 天空、云海、远处积云、雾一起开关：开关前后各量一次，差值就是这几样的 GPU 开销
  showAtmosphere(on: boolean) {
    atmosphere.visible = on;
    scene.background = on ? null : new THREE.Color('#e9e4d8');
  },
  waitFrames,
  // 等 n 帧，返回这段时间每帧的 GPU 时间（ms）和帧间隔
  async measure(n = 120) {
    gpuTimes.length = 0;
    await waitFrames(n);
    const g = [...gpuTimes];
    return { gpu: g, median: median(g), frames: n, cpu: median(cpuFrames) };
  },
  camera,
  controls,
};
await waitFrames(4);
window.__ready = true;
