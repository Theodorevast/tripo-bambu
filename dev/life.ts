import * as THREE from 'three/webgpu';
import {
  abs, atan, attribute, cameraPosition, dot, float, max, mix, normalize, positionGeometry, positionWorld, pow, saturate, select, sin,
  smoothstep, texture, transformNormalToView, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { Pane } from 'tweakpane';
import { createLife, LIFE_EFFECTS, trampleUV, type LifeEffect, type LifePlanet, type LifeQuality } from '../src/nature/life';
import { windGustNode, windNode } from '../src/nature/wind';
import { mulberry32 } from '../src/planet/rng';

// 生机层演示页：/dev/life.html
// 一颗半径 30 米的草地星球（一条土路、几片野花、一小片演示用的草），一个 1 米高的胶囊人。
// WASD 走、Shift 跑、空格跳、拖动转镜头、滚轮拉远。右边面板调雨、风、傍晚，开关各项效果，显示踩踏图。
// 地址参数：?webgl 强制走 WebGL2；?auto 自动绕圈走（录屏、测性能用）；?ui=0 不显示面板和说明
// 演示用的草只是为了展示「草模块怎么接风场和踩踏图」，正式的草是 N1 的 grass.ts

const params = new URLSearchParams(location.search);
const R = 30;
const PATH_W = 0.62; // 土路半宽（米）

// ---------- 星球：高度、土路 ----------
// 轻微起伏（±0.3 米），检验贴地；土路是一条绕着 x≈0 大圆、左右摆动的带子，经过北极（出生点）

function height(d: THREE.Vector3): number {
  return R + 0.18 * Math.sin(d.x * 7.1 + 1.3) * Math.sin(d.z * 6.3 + 0.4) + 0.12 * Math.sin(d.y * 9.7 + d.x * 4.1);
}
// 到土路中线的有符号距离（米）
function pathOffset(d: THREE.Vector3): number {
  return (d.x + 0.05 * Math.sin(5 * Math.atan2(d.z, d.y))) * R;
}
function pathDist(d: THREE.Vector3): number {
  return Math.abs(pathOffset(d));
}
function bare(d: THREE.Vector3): number {
  return 1 - THREE.MathUtils.smoothstep(pathDist(d), PATH_W * 0.7, PATH_W);
}

const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: params.has('webgl'), trackTimestamp: true });
await renderer.init();
const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const dprCap = Number(params.get('dpr') ?? 2);
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, dprCap));
renderer.setSize(innerWidth, innerHeight, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 900);

// ---------- 天空、光 ----------

const look = { rain: 0, wind: 0.35, evening: 0.15, sunAzimuth: 35, sunElevation: 24, rainLight: 0 };
const sunDir = new THREE.Vector3();
const uSunDir = uniform(new THREE.Vector3(0, 1, 0));
const uLocalUp = uniform(new THREE.Vector3(0, 1, 0));
const uSkyTop = uniform(new THREE.Vector3()); // 颜色存在 xyz 里
const uSkyHorizon = uniform(new THREE.Vector3());
const uSunGlow = uniform(new THREE.Vector3());

const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
{
  const v = normalize(positionWorld.sub(cameraPosition));
  const h = dot(v, uLocalUp);
  const g = pow(saturate(h.mul(1.2).add(0.12)), 0.6);
  const sunAmt = pow(saturate(dot(v, uSunDir)), 48).mul(0.9).add(pow(saturate(dot(v, uSunDir)), 6).mul(0.25));
  skyMat.colorNode = mix(uSkyHorizon, uSkyTop, g).add(uSunGlow.mul(sunAmt));
}
const sky = new THREE.Mesh(new THREE.SphereGeometry(600, 32, 16), skyMat);
sky.frustumCulled = false;
scene.add(sky);

const sun = new THREE.DirectionalLight(0xffeedd, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -11;
sun.shadow.camera.right = sun.shadow.camera.top = 11;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 80;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a5a30, 1.1);
scene.add(hemi);

// ---------- 星球 ----------

const uShowTrample = uniform(0);
const planetGeo = new THREE.SphereGeometry(R, 360, 180);
{
  const p = planetGeo.attributes.position as THREE.BufferAttribute;
  const d = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    d.fromBufferAttribute(p, i).normalize();
    d.multiplyScalar(height(d));
    p.setXYZ(i, d.x, d.y, d.z);
  }
  planetGeo.computeVertexNormals();
}
const planetMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
const planet = new THREE.Mesh(planetGeo, planetMat);
planet.receiveShadow = true;
scene.add(planet);

const lifePlanet: LifePlanet = {
  radius: R,
  center: new THREE.Vector3(),
  height,
  sea: null,
  bare,
  flowerNear: (pos, radius, out) => flowerNear(pos, radius, out),
};
const life3 = createLife(scene, renderer, lifePlanet, { quality: (params.get('quality') as LifeQuality) ?? 'high' });
const trampleTex = life3.trample!.texture;

{
  // 地面颜色：草绿（大片色相变化）→ 土路；踩过的地方略压暗。打开「Show trample」时用橙黄色把踩踏图画在地上
  const dir = normalize(positionWorld);
  const pd = abs(dir.x.add(sin(atan(dir.z, dir.y).mul(5)).mul(0.05))).mul(R);
  const path = float(1).sub(smoothstep(PATH_W * 0.7, PATH_W, pd));
  const n1 = sin(dir.x.mul(23).add(sin(dir.z.mul(17)))).mul(sin(dir.y.mul(19).add(dir.x.mul(7)))).mul(0.5).add(0.5);
  const grass = mix(vec3(0.16, 0.3, 0.07), vec3(0.3, 0.42, 0.1), n1);
  const dirt = mix(vec3(0.5, 0.4, 0.27), vec3(0.58, 0.47, 0.32), n1);
  const tr = texture(trampleTex, trampleUV(dir));
  const base = mix(grass, dirt, path).mul(float(1).sub(tr.r.mul(0.18)));
  const ramp = mix(vec3(0.95, 0.35, 0.08), vec3(1, 0.92, 0.3), tr.g);
  planetMat.colorNode = mix(base, ramp, saturate(tr.r.mul(1.4)).mul(uShowTrample));
}

// ---------- 野花（蝴蝶落脚的地方） ----------

const flowerRng = mulberry32(5);
const flowerHeads: THREE.Vector3[] = [];
{
  const up = new THREE.Vector3();
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  for (let patch = 0; patch < 46; patch++) {
    // 花丛中心：出生点周围 2–22 米
    const a = flowerRng() * Math.PI * 2;
    const r = 2 + flowerRng() * 20;
    const c = new THREE.Vector3(Math.cos(a) * r, R, Math.sin(a) * r).normalize();
    const count = 6 + Math.floor(flowerRng() * 12);
    for (let k = 0; k < count; k++) {
      t1.set(1, 0, 0).addScaledVector(c, -c.x).normalize();
      t2.crossVectors(c, t1);
      const b = flowerRng() * Math.PI * 2;
      const s = Math.sqrt(flowerRng()) * 1.6;
      up.copy(c).multiplyScalar(R).addScaledVector(t1, Math.cos(b) * s).addScaledVector(t2, Math.sin(b) * s).normalize();
      if (bare(up) > 0.05) continue;
      flowerHeads.push(up.clone().multiplyScalar(height(up) + 0.2 + flowerRng() * 0.16));
    }
  }
}
const FLOWER_COLORS = [new THREE.Color(0.98, 0.97, 0.93), new THREE.Color(1, 0.86, 0.3), new THREE.Color(0.74, 0.62, 0.95)];
{
  const n = flowerHeads.length;
  const headGeo = new THREE.SphereGeometry(0.045, 10, 6);
  headGeo.scale(1, 0.45, 1);
  const stemGeo = new THREE.CylinderGeometry(0.006, 0.008, 1, 5);
  stemGeo.translate(0, -0.5, 0);
  const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardNodeMaterial({ roughness: 0.7 }), n);
  const stems = new THREE.InstancedMesh(stemGeo, new THREE.MeshStandardNodeMaterial({ color: 0x4f7a2a, roughness: 0.9 }), n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const up = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    up.copy(flowerHeads[i]).normalize();
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    heads.setMatrixAt(i, m.compose(flowerHeads[i], q, s.set(1, 1, 1)));
    heads.setColorAt(i, FLOWER_COLORS[Math.floor(flowerRng() * 3)]);
    const stemLen = flowerHeads[i].length() - height(up) + 0.02;
    stems.setMatrixAt(i, m.compose(flowerHeads[i], q, s.set(1, stemLen, 1)));
  }
  heads.castShadow = stems.castShadow = true;
  scene.add(heads, stems);
}

// 附近的一朵花：半径内随机挑一朵（蓄水池抽样），不让几只蝴蝶都挤到最近那朵上
function flowerNear(pos: THREE.Vector3, radius: number, out: THREE.Vector3): boolean {
  const r2 = radius * radius;
  let seen = 0;
  for (let i = 0; i < flowerHeads.length; i++) {
    if (flowerHeads[i].distanceToSquared(pos) > r2) continue;
    seen++;
    if (flowerRng() * seen < 1) out.copy(flowerHeads[i]);
  }
  return seen > 0;
}

// ---------- 演示用的草：每片一个三角形，读 windNode 和踩踏图 ----------
// 这一段演示草模块怎么接：叶根世界坐标 → windNode 得到风速 → 草尖偏移 ∝ 风速 × 高度²；
// 叶根方向 → trampleUV → 踩踏图 R 通道 → 压低、放倒；life.influence 是角色的影响球，草被推开

const GRASS_N = Number(params.get('grass') ?? 70000);
const grassGeo = new THREE.InstancedBufferGeometry();
{
  grassGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  const root = new Float32Array(GRASS_N * 4);
  const rnd = new Float32Array(GRASS_N * 4);
  const rng = mulberry32(17);
  const d = new THREE.Vector3();
  let n = 0;
  let guard = 0;
  while (n < GRASS_N && guard++ < GRASS_N * 4) {
    // 出生点周围的球冠里均匀撒（角半径 0.62 弧度，约 18 米）
    const z = 1 - rng() * (1 - Math.cos(0.62));
    const a = rng() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    d.set(Math.cos(a) * s, z, Math.sin(a) * s);
    if (bare(d) > 0.3 + rng() * 0.5) continue;
    const h = height(d);
    root[n * 4] = d.x * h;
    root[n * 4 + 1] = d.y * h;
    root[n * 4 + 2] = d.z * h;
    root[n * 4 + 3] = 0.12 + rng() * rng() * 0.22;
    rnd[n * 4] = rng();
    rnd[n * 4 + 1] = rng();
    rnd[n * 4 + 2] = rng();
    rnd[n * 4 + 3] = rng();
    n++;
  }
  grassGeo.setAttribute('aRoot', new THREE.InstancedBufferAttribute(root, 4));
  grassGeo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnd, 4));
  grassGeo.instanceCount = n;
}
const grassMat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.85 });
{
  const root = attribute<'vec4'>('aRoot', 'vec4');
  const rnd = attribute<'vec4'>('aRnd', 'vec4');
  const up = normalize(root.xyz);
  const ref = select(abs(up.x).lessThan(0.9), vec3(1, 0, 0), vec3(0, 1, 0));
  const t1 = normalize(ref.sub(up.mul(dot(ref, up))));
  const t2 = up.cross(t1);
  const a = rnd.x.mul(6.283);
  const side = t1.mul(a.cos()).add(t2.mul(a.sin()));
  const lay = side.cross(up); // 被踩时往这个方向倒
  const y = positionGeometry.y;
  const tr = texture(trampleTex, trampleUV(up)).r;
  const h = root.w.mul(float(1).sub(tr.mul(0.7)));
  const wind = windNode(root.xyz).mul(0.035).mul(rnd.y.mul(0.6).add(0.7));
  const flutter = side.mul(sin(windGustNode(root.xyz).mul(9).add(rnd.z.mul(30))).mul(0.015));
  const pushD = root.xyz.sub(life3.influence.xyz);
  const push = normalize(pushD.sub(up.mul(dot(pushD, up))).add(t1.mul(1e-4))).mul(max(life3.influence.w.mul(0.45).sub(pushD.length()), 0).mul(0.6));
  const tipOff = wind.add(flutter).add(lay.mul(tr.mul(root.w).mul(0.8))).add(push);
  const width = rnd.w.mul(0.012).add(0.012);
  grassMat.positionNode = root.xyz.add(side.mul(positionGeometry.x.mul(width).mul(float(1).sub(y)))).add(up.mul(h.mul(y))).add(tipOff.mul(y.mul(y)));
  grassMat.normalNode = transformNormalToView(up);
  const hue = rnd.z;
  const baseCol = mix(vec3(0.12, 0.25, 0.06), vec3(0.2, 0.3, 0.07), hue);
  const tipCol = mix(vec3(0.42, 0.58, 0.18), vec3(0.62, 0.62, 0.24), hue.mul(hue));
  grassMat.colorNode = mix(baseCol, tipCol, pow(y, 0.8)).mul(float(1).sub(tr.mul(0.15)));
}
const grass = new THREE.Mesh(grassGeo, grassMat);
grass.frustumCulled = false;
grass.receiveShadow = true;
scene.add(grass);

// ---------- 胶囊人 ----------

const walkerGroup = new THREE.Group();
{
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.6, 6, 16), new THREE.MeshStandardNodeMaterial({ color: 0x3f7a4c, roughness: 0.6 }));
  body.position.y = 0.5;
  const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.045, 8, 20), new THREE.MeshStandardNodeMaterial({ color: 0xe0782c, roughness: 0.7 }));
  scarf.rotation.x = Math.PI / 2;
  scarf.position.y = 0.66;
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.24, 0.03), scarf.material);
  tail.position.set(0.06, 0.55, -0.2);
  tail.rotation.x = 0.35;
  body.castShadow = scarf.castShadow = tail.castShadow = true;
  walkerGroup.add(body, scarf, tail);
}
scene.add(walkerGroup);

// ---------- 走路和跟随镜头 ----------

const walk = {
  dir: new THREE.Vector3(0, 1, 0), // 球面上的方向
  vel: new THREE.Vector3(), // 切向速度
  facing: new THREE.Vector3(0, 0, 1),
  alt: 0, // 离地高度（跳）
  vAlt: 0,
  grounded: true,
};
const cam = { fwd: new THREE.Vector3(0, 0, 1), pitch: 0.3, dist: 5.4 };
const keys = new Set<string>();
const opts = { auto: params.has('auto'), autoTurn: 0.22, autoPath: false }; // 自动走：绕圈，或者沿土路走
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  cam.fwd.applyAxisAngle(walk.dir, -e.movementX * 0.005);
  cam.pitch = THREE.MathUtils.clamp(cam.pitch + e.movementY * 0.004, 0.02, 1.35);
});
canvas.addEventListener('wheel', (e) => {
  cam.dist = THREE.MathUtils.clamp(cam.dist * Math.exp(e.deltaY * 0.001), 2, 70);
}, { passive: true });

let lastPathE = 0;
const _wish = new THREE.Vector3();
const _right = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _target = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _feet = new THREE.Vector3();
const _vel3 = new THREE.Vector3();

function stepWalker(dt: number): void {
  const up = walk.dir;
  _right.crossVectors(cam.fwd, up).normalize();
  let fx = 0;
  let fz = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) fz += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) fz -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) fx += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) fx -= 1;
  if (opts.auto) {
    fz = 1;
    let turn = opts.autoTurn;
    if (opts.autoPath) {
      // 沿土路走：对「离中线的距离」做 PD 控制，往左挪一点看距离怎么变，决定往哪边拐
      const e = pathOffset(up);
      _x.copy(up).multiplyScalar(R).addScaledVector(_right, -0.05).normalize();
      const dLeft = (pathOffset(_x) - e) / 0.05;
      const de = dt > 0 ? (e - lastPathE) / dt : 0;
      lastPathE = e;
      turn = THREE.MathUtils.clamp(-(2.2 * e + 1.6 * de) * Math.sign(dLeft || 1), -1.5, 1.5);
    }
    cam.fwd.applyAxisAngle(up, turn * dt);
  }
  const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
  _wish.copy(cam.fwd).multiplyScalar(fz).addScaledVector(_right, fx);
  if (_wish.lengthSq() > 1e-6) _wish.normalize().multiplyScalar(run ? 3.6 : 1.8);
  walk.vel.lerp(_wish, 1 - Math.exp(-(walk.grounded ? 10 : 2) * dt));
  // 沿切向走一步，贴回球面；速度、朝向、镜头方向跟着转到新的切平面
  _prev.copy(up);
  up.multiplyScalar(R).addScaledVector(walk.vel, dt).normalize();
  _q.setFromUnitVectors(_prev, up);
  walk.vel.applyQuaternion(_q);
  walk.facing.applyQuaternion(_q);
  cam.fwd.applyQuaternion(_q);
  walk.vel.addScaledVector(up, -walk.vel.dot(up));
  cam.fwd.addScaledVector(up, -cam.fwd.dot(up)).normalize();
  const sp = walk.vel.length();
  if (sp > 0.1) walk.facing.lerp(_x.copy(walk.vel).divideScalar(sp), 1 - Math.exp(-12 * dt));
  walk.facing.addScaledVector(up, -walk.facing.dot(up)).normalize();
  // 跳
  if (keys.has('Space') && walk.grounded) {
    walk.vAlt = 3.4;
    walk.grounded = false;
  }
  if (!walk.grounded) {
    walk.vAlt -= 9.8 * dt;
    walk.alt += walk.vAlt * dt;
    if (walk.alt <= 0) {
      walk.alt = 0;
      walk.vAlt = 0;
      walk.grounded = true;
    }
  }
}

function placeWalkerAndCamera(dt: number): void {
  const up = walk.dir;
  _feet.copy(up).multiplyScalar(height(up) + walk.alt);
  walkerGroup.position.copy(_feet);
  _x.crossVectors(up, walk.facing).normalize();
  _m.makeBasis(_x, up, walk.facing);
  walkerGroup.quaternion.setFromRotationMatrix(_m);
  // 跟随镜头：在角色身后上方，「上」是脚下的法线
  _target.copy(_feet).addScaledVector(up, 0.95);
  _pos.copy(_target).addScaledVector(cam.fwd, -cam.dist * Math.cos(cam.pitch)).addScaledVector(up, cam.dist * Math.sin(cam.pitch));
  // 镜头不钻进地里
  const camDir = _x.copy(_pos).normalize();
  const minR = height(camDir) + 0.35;
  if (_pos.length() < minR) _pos.copy(camDir).multiplyScalar(minR);
  camera.position.lerp(_pos, 1 - Math.exp(-14 * dt));
  camera.up.copy(up);
  camera.lookAt(_target);
  // 影子相机跟着角色
  sun.target.position.copy(_feet);
  sun.position.copy(_feet).addScaledVector(sunDir, 40);
}

// ---------- 光和天气 ----------

const SKY_DAY_TOP = new THREE.Color(0.3, 0.52, 0.86);
const SKY_DAY_HOR = new THREE.Color(0.86, 0.87, 0.84);
const SKY_DUSK_TOP = new THREE.Color(0.42, 0.38, 0.66);
const SKY_DUSK_HOR = new THREE.Color(1, 0.66, 0.5);
const SKY_NIGHT_TOP = new THREE.Color(0.05, 0.07, 0.16);
const SKY_NIGHT_HOR = new THREE.Color(0.22, 0.2, 0.32);
const SKY_RAIN = new THREE.Color(0.52, 0.56, 0.62);
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

function applyLook(): void {
  const e = look.evening;
  const r = look.rainLight; // 用 life.onRain 回调来的平滑雨量：雨慢慢下大，光也慢慢变冷变暗
  // 太阳：傍晚越来越低（演示用：evening 推着太阳往地平线走）
  const elev = THREE.MathUtils.degToRad(look.sunElevation * (1 - e) + (-6) * e);
  const az = THREE.MathUtils.degToRad(look.sunAzimuth);
  // 以出生点（北极）为参照：+Y 是上，方位角从 +Z 往 +X 转
  sunDir.set(Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev)).normalize();
  uSunDir.value.copy(sunDir);
  const dusk = THREE.MathUtils.smoothstep(e, 0.15, 0.6);
  const night = THREE.MathUtils.smoothstep(e, 0.6, 1);
  _c1.copy(SKY_DAY_TOP).lerp(SKY_DUSK_TOP, dusk).lerp(SKY_NIGHT_TOP, night).lerp(SKY_RAIN, r * 0.7);
  _c2.copy(SKY_DAY_HOR).lerp(SKY_DUSK_HOR, dusk).lerp(SKY_NIGHT_HOR, night).lerp(SKY_RAIN, r * 0.7);
  uSkyTop.value.set(_c1.r, _c1.g, _c1.b);
  uSkyHorizon.value.set(_c2.r, _c2.g, _c2.b);
  hemi.color.copy(_c1).lerp(_c2.setRGB(1, 1, 1), 0.35);
  const glow = (1 - r * 0.85) * (1 - night);
  uSunGlow.value.set(1, 0.85 - 0.3 * dusk, 0.6 - 0.35 * dusk).multiplyScalar(glow);
  sun.color.setRGB(1, 0.93 - 0.32 * dusk, 0.82 - 0.45 * dusk).lerp(_c1.setRGB(0.75, 0.8, 0.9), r * 0.6);
  sun.intensity = 2.3 * (1 - 0.7 * r) * (1 - 0.9 * night) * THREE.MathUtils.smoothstep(sunDir.y, -0.08, 0.12);
  hemi.groundColor.setRGB(0.3, 0.33, 0.18).multiplyScalar(1 - 0.4 * night);
  hemi.intensity = 0.75 * (1 - 0.35 * r) * (1 - 0.55 * night);
  renderer.toneMappingExposure = 1 - 0.12 * r;
}

function pushWeather(): void {
  life3.setWeather({ rain: look.rain, wind: look.wind, evening: look.evening, sunDir });
}
life3.onRain((r) => {
  look.rainLight = r;
});

// ---------- 踩踏图的屏幕角落显示 ----------

const uWalkerUv = uniform(new THREE.Vector2());
const hudMat = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, fog: false });
hudMat.toneMapped = false;
const hudSize = uniform(new THREE.Vector2(0.1, 0.1)); // 屏幕上的大小：(像素 / 宽, 像素 / 高)
{
  // 左下角一个正方形（按像素算宽高比）：clip 坐标里画，不受镜头影响
  const p = vec2(-0.985, -0.97).add(positionGeometry.xy.mul(0.5).add(0.5).mul(hudSize).mul(2));
  hudMat.vertexNode = vec4(p, 0, 1);
  const tr = texture(trampleTex, uv());
  const ramp = mix(vec3(0.06, 0.08, 0.12), vec3(0.95, 0.4, 0.1), saturate(tr.r.mul(1.3))).add(vec3(0.6, 0.55, 0.2).mul(tr.g));
  const d = uv().sub(uWalkerUv).length();
  const ring = smoothstep(0.012, 0.009, d).mul(smoothstep(0.004, 0.007, d));
  // 菱形：上半球（中间）和下半球（四个角）的分界
  const q = abs(uv().sub(0.5)).mul(2);
  const diamond = smoothstep(0.006, 0, abs(q.x.add(q.y).sub(1))).mul(0.35);
  hudMat.colorNode = ramp.add(vec3(1, 1, 1).mul(max(ring, diamond)));
}
const hud = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), hudMat);
hud.frustumCulled = false;
hud.renderOrder = 1000;
hud.visible = false;
scene.add(hud);

// ---------- 面板 ----------

interface Events {
  on(event: 'change' | 'click', handler: () => void): unknown;
}
interface Folder extends Events {
  addFolder(p: { title: string; expanded?: boolean }): Folder;
  addBinding<T extends object>(target: T, key: keyof T & string, p?: Record<string, unknown>): Events & { refresh?(): void };
  addButton(p: { title: string }): Events;
  refresh(): void;
}

const fx: Record<LifeEffect | 'grass' | 'showTrample', boolean> = {
  dust: true, trample: true, butterflies: true, petals: true, fireflies: true, rain: true, splashes: true, grass: true, showTrample: false,
};
const ui = { quality: (params.get('quality') as LifeQuality) ?? 'high' };
const stats = { backend: isWebGPU ? 'WebGPU' : 'WebGL2', fps: 0, frameMs: 0, gpuMs: 0, lifeCpu: 0, draws: 0, rain: 0, info: '' };

function applyEffects(): void {
  for (const e of LIFE_EFFECTS) life3.setEnabled(e, fx[e]);
  grass.visible = fx.grass;
  hud.visible = fx.showTrample;
  uShowTrample.value = fx.showTrample ? 1 : 0;
  document.getElementById('trample-label')!.style.display = fx.showTrample ? 'block' : 'none';
  life3.setQuality(ui.quality);
}

let pane: Folder | null = null;
if (params.get('ui') !== '0') {
  pane = new Pane({ title: 'Life', container: document.getElementById('pane')! }) as unknown as Folder;
  const w = pane.addFolder({ title: 'Weather' });
  w.addBinding(look, 'rain', { min: 0, max: 1, step: 0.01 }).on('change', pushWeather);
  w.addBinding(look, 'wind', { min: 0, max: 1, step: 0.01 }).on('change', pushWeather);
  w.addBinding(look, 'evening', { min: 0, max: 1, step: 0.01 }).on('change', () => {
    applyLook();
    pushWeather();
  });
  w.addBinding(look, 'sunAzimuth', { label: 'sun azimuth°', min: -180, max: 180, step: 1 }).on('change', () => {
    applyLook();
    pushWeather();
  });
  w.addBinding(look, 'sunElevation', { label: 'sun elevation°', min: 2, max: 70, step: 1 }).on('change', () => {
    applyLook();
    pushWeather();
  });
  const presets = w.addFolder({ title: 'Presets', expanded: true });
  const preset = (rain: number, wind: number, evening: number) => () => {
    Object.assign(look, { rain, wind, evening });
    applyLook();
    pushWeather();
    pane?.refresh();
  };
  presets.addButton({ title: 'Sunny day' }).on('click', preset(0, 0.3, 0.1));
  presets.addButton({ title: 'Rain shower' }).on('click', preset(1, 0.55, 0.2));
  presets.addButton({ title: 'Evening' }).on('click', preset(0, 0.2, 0.85));
  const e = pane.addFolder({ title: 'Effects' });
  for (const k of Object.keys(fx) as (keyof typeof fx)[]) {
    const label = k === 'showTrample' ? 'show trample map' : k === 'grass' ? 'demo grass' : k;
    e.addBinding(fx, k, { label }).on('change', applyEffects);
  }
  e.addBinding(ui, 'quality', { options: { high: 'high', low: 'low' } }).on('change', applyEffects);
  e.addBinding(opts, 'auto', { label: 'auto walk' });
  e.addBinding(opts, 'autoPath', { label: 'auto: follow path' });
  const s = pane.addFolder({ title: 'Stats' });
  s.addBinding(stats, 'backend', { readonly: true });
  s.addBinding(stats, 'fps', { readonly: true, format: (v: number) => v.toFixed(0) });
  s.addBinding(stats, 'frameMs', { label: 'frame ms', readonly: true, view: 'graph', min: 0, max: 40 });
  s.addBinding(stats, 'gpuMs', { label: 'GPU ms (frame)', readonly: true, format: (v: number) => v.toFixed(2) });
  s.addBinding(stats, 'lifeCpu', { label: 'life CPU ms', readonly: true, format: (v: number) => v.toFixed(3) });
  s.addBinding(stats, 'draws', { label: 'life draws', readonly: true, format: (v: number) => v.toFixed(0) });
  s.addBinding(stats, 'rain', { label: 'rain (smoothed)', readonly: true, format: (v: number) => v.toFixed(2) });
  s.addBinding(stats, 'info', { label: 'instances', readonly: true, multiline: true, rows: 4 });
} else {
  document.getElementById('help')!.style.display = 'none';
}

// ---------- 主循环 ----------

// 测量用的「放大」：主画面画完后，把生机层（或一个空组，作对照）在同一帧里再画 amp 遍。
// 生机层在这块显卡上只占零点几毫秒，比显卡频率的抖动还小；画 K 遍再相减、除以 K，才量得准
const bench = { amp: 0, target: 'life' as 'life' | 'empty' };
const lifeRoot = scene.getObjectByName('life')!;
const emptyRoot = new THREE.Group();
const timer = new THREE.Timer();
let frames = 0;
let fpsAcc = 0;
let resolving = false;
const gpuSamples: number[] = [];
let collecting = 0;

function frame(time: number): void {
  timer.update(time);
  const dt = THREE.MathUtils.clamp(timer.getDelta(), 0, 0.1);
  stepWalker(dt);
  placeWalkerAndCamera(dt);
  uLocalUp.value.copy(walk.dir);
  // 生机层：角色脚底位置、速度（世界坐标）、是否着地
  _vel3.copy(walk.vel);
  life3.setWalker(walkerGroup.position, _vel3, walk.grounded);
  applyLook();
  life3.update(dt, camera);
  if (hud.visible) {
    life3.trample!.uvOf(walk.dir, uWalkerUv.value);
    hudSize.value.set(200 / innerWidth, 200 / innerHeight);
  }
  renderer.render(scene, camera);
  if (bench.amp > 0) {
    const prev = renderer.autoClear;
    renderer.autoClear = false;
    const target = bench.target === 'life' ? lifeRoot : emptyRoot;
    for (let i = 0; i < bench.amp; i++) renderer.render(target, camera);
    renderer.autoClear = prev;
  }

  // 统计
  frames++;
  fpsAcc += dt;
  stats.frameMs = dt * 1000;
  if (fpsAcc >= 0.5) {
    stats.fps = frames / fpsAcc;
    frames = 0;
    fpsAcc = 0;
    const st = life3.stats();
    stats.lifeCpu = st.cpuMs;
    stats.draws = st.drawCalls;
    stats.rain = life3.rain;
    const i = st.instances;
    stats.info = `rain ${i.rain} · splash ${i.splashes}\npetal+fluff ${i.petals} · fireflies ${i.fireflies}\nbutterflies ${i.butterflies} · dust ${i.dust}\ntrample ${st.trampleSize}² (${st.tramplePasses} passes)`;
  }
  if (!resolving && (renderer.backend as { trackTimestamp?: boolean }).trackTimestamp) {
    resolving = true;
    renderer.resolveTimestampsAsync('render').then((ms) => {
      resolving = false;
      if (typeof ms === 'number' && ms > 0) {
        stats.gpuMs = stats.gpuMs * 0.9 + ms * 0.1;
        if (collecting > 0) {
          gpuSamples.push(ms);
          collecting--;
        }
      }
    }, () => {
      resolving = false;
    });
  }
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// 初始：站在出生点（土路上），面朝 +Z
applyLook();
pushWeather();
applyEffects();
placeWalkerAndCamera(1);
camera.position.copy(_pos);
camera.lookAt(_target);
renderer.setAnimationLoop(frame);

// ---------- 给自查脚本用的钩子 ----------

declare global {
  interface Window {
    __life?: {
      ready: boolean;
      backend: string;
      set(p: { bench?: { amp: number; target: 'life' | 'empty' }; rain?: number; wind?: number; evening?: number; auto?: boolean; autoTurn?: number; autoPath?: boolean; effects?: Partial<typeof fx>; quality?: LifeQuality; camera?: { pitch?: number; dist?: number; yaw?: number } }): void;
      gpu(frames: number): Promise<{ mean: number; median: number; p90: number; n: number }>;
      stats(): ReturnType<typeof life3.stats> & { fps: number; frameMs: number; gpuMs: number; rainLight: number; rain: number };
      key(code: string, down: boolean): void;
      teleport(dir: [number, number, number]): void;
      butterfly(i: number): [number, number, number];
      walker(): [number, number, number];
      trample(): Promise<{ trampled: number; maxR: number; atWalker: number }>;
    };
  }
}

window.__life = {
  ready: false,
  backend: stats.backend,
  set(p) {
    if (p.bench) Object.assign(bench, p.bench);
    if (p.rain !== undefined) look.rain = p.rain;
    if (p.wind !== undefined) look.wind = p.wind;
    if (p.evening !== undefined) look.evening = p.evening;
    if (p.auto !== undefined) opts.auto = p.auto;
    if (p.autoTurn !== undefined) opts.autoTurn = p.autoTurn;
    if (p.autoPath !== undefined) opts.autoPath = p.autoPath;
    if (p.effects) Object.assign(fx, p.effects);
    if (p.quality) ui.quality = p.quality;
    if (p.camera?.pitch !== undefined) cam.pitch = p.camera.pitch;
    if (p.camera?.dist !== undefined) cam.dist = p.camera.dist;
    if (p.camera?.yaw !== undefined) cam.fwd.applyAxisAngle(walk.dir, p.camera.yaw);
    applyLook();
    pushWeather();
    applyEffects();
    pane?.refresh();
  },
  gpu(n) {
    gpuSamples.length = 0;
    collecting = n;
    return new Promise((resolve) => {
      const poll = () => {
        if (collecting > 0) {
          setTimeout(poll, 50);
          return;
        }
        const s = [...gpuSamples].sort((a, b) => a - b);
        const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
        resolve({ mean, median: s[Math.floor(s.length / 2)] ?? 0, p90: s[Math.floor(s.length * 0.9)] ?? 0, n: s.length });
      };
      poll();
    });
  },
  stats() {
    return { ...life3.stats(), fps: stats.fps, frameMs: stats.frameMs, gpuMs: stats.gpuMs, rainLight: look.rainLight, rain: life3.rain };
  },
  key(code, down) {
    if (down) keys.add(code);
    else keys.delete(code);
  },
  teleport(d) {
    walk.dir.set(d[0], d[1], d[2]).normalize();
    walk.vel.set(0, 0, 0);
    walk.facing.addScaledVector(walk.dir, -walk.facing.dot(walk.dir));
    if (walk.facing.lengthSq() < 1e-6) walk.facing.set(1, 0, 0).addScaledVector(walk.dir, -walk.dir.x);
    walk.facing.normalize();
    cam.fwd.copy(walk.facing);
  },
  butterfly(i) {
    const p = life3.debug.butterflies;
    return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  },
  walker() {
    return [walkerGroup.position.x, walkerGroup.position.y, walkerGroup.position.z];
  },
  // 读回整张踩踏图：被踩过的像素数、最大值、角色脚下的值（两种 y 方向都试，取大的）
  async trample() {
    const rt = life3.debug.trampleTarget;
    const px = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, rt.width, rt.height)) as Uint8Array;
    let trampled = 0;
    let maxR = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 25) trampled++;
      if (px[i] > maxR) maxR = px[i];
    }
    const uvw = life3.trample!.uvOf(walk.dir);
    const x = Math.min(rt.width - 1, Math.floor(uvw.x * rt.width));
    const y = Math.min(rt.height - 1, Math.floor(uvw.y * rt.height));
    const atWalker = Math.max(px[(y * rt.width + x) * 4], px[((rt.height - 1 - y) * rt.width + x) * 4]);
    return { trampled, maxR: maxR / 255, atWalker: atWalker / 255 };
  },
};
requestAnimationFrame(() => requestAnimationFrame(() => {
  window.__life!.ready = true;
}));
