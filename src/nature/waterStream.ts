import * as THREE from 'three/webgpu';
import { Fn, If, abs, attribute, dot, float, fract, fwidth, length, max, mix, normalize, positionLocal, positionViewDirection, renderGroup, saturate, smoothstep, time, transformNormalToView, uniform, vec3 } from 'three/tsl';
import type { PresetId } from '../data/types';
import { STAGE_DIR, type HeightFn } from '../planet/noise';
import { mulberry32 } from '../planet/rng';
import { valueNoise3 } from '../planet/tslNoise';
import { litWaterMaterial, noise3v, paletteOf, WATER_U } from './water';

// 小溪：一条从舞台附近的泉眼流进离舞台最近那片水（水塘或海）的小溪，像《小王子》设定图里那条（参考图 G/2、G/6）。
//
// 路线（CPU，按星球种子每次一样）：在舞台中心 70° 以内找离舞台最近的水，从那里朝舞台走到岸上，
// 再沿上坡方向（偏向舞台、带一点左右摆）往上找，最长 STREAM.length 米，碰到土路、作品空地就停；
// 掉头就是水流的方向：源头是一个小圆池（泉眼，一圈圈往外的波纹），往下越流越宽，入水口再往水里伸一点、散开一扇白沫。
//
// 几何：和水面一样从地表网格来（不会被地面挡住、也不会悬空）：挑出小溪附近的地表三角形，细分到约 16 厘米，
// 细分点都在原来的三角形平面上，再沿半径抬高 STREAM.lift。每个顶点带上 离中线的横向距离、顺流的路程、半宽、坡度，
// 着色器按它们画水边（软曲线）、顺流而下的白线（陡的地方更多）、两岸的细白边。
// 草和石头让开小溪：PlanetMask.extraExclude（mask.ts 加的一个接入口）。

type F = THREE.Node<'float'>;
type V4 = THREE.Node<'vec4'>;

export const STREAM = {
  length: 11, // 从水边往上最多找多远（米）
  spring: 0.4, // 泉眼小圆池的半径（米）
  width0: 0.22, // 源头往下的半宽（米）
  width1: 0.36, // 入水口的半宽（米）
  lift: 0.03, // 水面比地面高多少（米）
  speed: 0.75, // 水流速度（米/秒）
};

const STEP = 0.2; // 路线每一步（米）
const INTO_WATER = 1.2; // 入水口往水里伸多远（米）

export interface StreamHost {
  readonly terrain: THREE.Mesh;
  readonly sea: number;
  readonly radius: number;
  readonly height: HeightFn;
  readonly mask: { exclude(d: THREE.Vector3): number; extraExclude: ((d: THREE.Vector3) => number) | null };
  readonly currentRecipe: { preset: PresetId; seed: number };
  onMaskChange(fn: () => void): () => void;
}

// 路线：从源头到入水口外，每 STEP 米一个点
export interface StreamPath {
  points: THREE.Vector3[]; // 单位方向
  along: Float32Array; // 从源头量起的路程（米）
  half: Float32Array; // 半宽（米）
  steep: Float32Array; // 坡度（往下游每米降多少米，≥ 0）
  shore: number; // 水边在第几米（从源头量）
  center: THREE.Vector3; // 包围的中心方向
  cosReach: number; // 包围的球心角余弦（含半宽）
}

const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _q = new THREE.Vector3();

// 切平面里的高度梯度（米/米）写进 out
function slopeAt(height: HeightFn, d: THREE.Vector3, R: number, out: THREE.Vector3): THREE.Vector3 {
  if (Math.abs(d.y) < 0.9) _t1.set(0, 1, 0);
  else _t1.set(1, 0, 0);
  _t1.cross(d).normalize();
  _t2.crossVectors(d, _t1);
  const e = 0.15;
  const h = (v: THREE.Vector3, s: number) => {
    _q.copy(d).addScaledVector(v, s / R).normalize();
    return height(_q.x, _q.y, _q.z);
  };
  const g1 = (h(_t1, e) - h(_t1, -e)) / (2 * e);
  const g2 = (h(_t2, e) - h(_t2, -e)) / (2 * e);
  return out.copy(_t1).multiplyScalar(g1).addScaledVector(_t2, g2);
}

// 方向 d 沿切向单位向量 dir 走 m 米（写进 out）
function stepOn(d: THREE.Vector3, dir: THREE.Vector3, m: number, R: number, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(d).addScaledVector(dir, m / R).normalize();
}

export function findStreamPath(host: StreamHost): StreamPath | null {
  const { height, sea } = host;
  const R = host.radius;
  if (!(sea > 0)) return null;
  const stage = new THREE.Vector3(...STAGE_DIR);
  const h = (d: THREE.Vector3) => height(d.x, d.y, d.z);
  // 1. 舞台中心 70° 以内离舞台最近的水（斐波那契点）
  const cosCap = Math.cos(THREE.MathUtils.degToRad(70));
  const N = 9000;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const d = new THREE.Vector3();
  let wet: THREE.Vector3 | null = null;
  let wetDot = -2;
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(1 - y * y);
    d.set(Math.cos(golden * i) * r, y, Math.sin(golden * i) * r);
    const c = d.dot(stage);
    if (c < cosCap || c <= wetDot) continue;
    if (h(d) < sea - 0.03 && host.mask.exclude(d) < 0.02) {
      wet = d.clone();
      wetDot = c;
    }
  }
  if (!wet) return null;
  // 2. 朝舞台中心走到岸上（比水面高 2 厘米）
  const toward = new THREE.Vector3();
  const shoreDir = wet.clone();
  let onLand = false;
  for (let s = 0; s < 40; s += 0.1) {
    toward.copy(stage).addScaledVector(shoreDir, -stage.dot(shoreDir));
    if (toward.lengthSq() < 1e-10) break;
    toward.normalize();
    stepOn(shoreDir, toward, 0.1, R, shoreDir);
    if (h(shoreDir) > sea + 0.02) {
      onLand = true;
      break;
    }
  }
  if (!onLand || host.mask.exclude(shoreDir) > 0.02) return null;
  // 3. 往上游找：上坡方向 + 偏向舞台 + 一点左右摆（按种子）
  const rng = mulberry32(host.currentRecipe.seed * 31 + 7);
  const phase = rng() * Math.PI * 2;
  const up: THREE.Vector3[] = [shoreDir.clone()];
  const cur = shoreDir.clone();
  const g = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const side = new THREE.Vector3();
  const next = new THREE.Vector3();
  let s = 0;
  while (s < STREAM.length) {
    slopeAt(height, cur, R, g);
    toward.copy(stage).addScaledVector(cur, -stage.dot(cur));
    if (toward.lengthSq() > 1e-10) toward.normalize();
    dir.copy(toward).multiplyScalar(0.6);
    if (g.lengthSq() > 1e-8) dir.add(g.normalize());
    if (dir.lengthSq() < 1e-10) break;
    dir.normalize();
    const wob = Math.sin(s * 0.75 + phase) * 0.35 + Math.sin(s * 1.9 + phase * 2.3) * 0.12;
    side.crossVectors(cur, dir);
    dir.multiplyScalar(Math.cos(wob)).addScaledVector(side, Math.sin(wob));
    stepOn(cur, dir, STEP, R, next);
    if (host.mask.exclude(next) > 0.02 || h(next) < sea + 0.02) break; // 碰到土路、作品空地，或者又下到水里了
    cur.copy(next);
    up.push(cur.clone());
    s += STEP;
  }
  // 源头离土路、空地留一点余地：退回 0.6 米
  for (let k = 0; k < 3 && up.length > 2; k++) up.pop();
  if (up.length * STEP < 3) return null;
  // 4. 掉头：源头 → 水边，再沿最后一段往水里伸一点
  const pts = up.reverse();
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  dir.copy(last).sub(prev).addScaledVector(last, -last.clone().sub(prev).dot(last)).normalize();
  const shoreIndex = pts.length - 1;
  for (let k = 1; k <= Math.round(INTO_WATER / STEP); k++) pts.push(stepOn(last, dir, k * STEP, R, new THREE.Vector3()));
  // 5. 平滑两遍（两头不动）
  for (let pass = 0; pass < 2; pass++) {
    const copy = pts.map((p) => p.clone());
    for (let k = 1; k < pts.length - 1; k++) pts[k].copy(copy[k - 1]).add(copy[k]).add(copy[k]).add(copy[k + 1]).normalize();
  }
  // 6. 每个点的路程、半宽、坡度；包围
  const n = pts.length;
  const along = new Float32Array(n);
  const half = new Float32Array(n);
  const steep = new Float32Array(n);
  for (let k = 1; k < n; k++) along[k] = along[k - 1] + pts[k].angleTo(pts[k - 1]) * R;
  const shore = along[shoreIndex];
  const center = new THREE.Vector3();
  for (let k = 0; k < n; k++) {
    const t = along[k] / Math.max(shore, 1e-3);
    // 源头是个小圆池，一米以内收到溪的宽度，往下慢慢变宽
    half[k] = THREE.MathUtils.lerp(STREAM.spring, THREE.MathUtils.lerp(STREAM.width0, STREAM.width1, Math.min(1, t)), THREE.MathUtils.smoothstep(along[k], 0.2, 1.1));
    const a = pts[Math.max(0, k - 2)];
    const b = pts[Math.min(n - 1, k + 2)];
    const dist = Math.max(1e-3, a.angleTo(b) * R);
    steep[k] = Math.max(0, (Math.max(h(a), sea) - Math.max(h(b), sea)) / dist);
    center.add(pts[k]);
  }
  center.normalize();
  let cosReach = 1;
  for (const p of pts) cosReach = Math.min(cosReach, p.dot(center));
  const reach = Math.acos(THREE.MathUtils.clamp(cosReach, -1, 1)) + (STREAM.spring + 0.6) / R;
  return { points: pts, along, half, steep, shore, center, cosReach: Math.cos(reach) };
}

// 一个点（星球本地坐标，米）到路线中线：横向距离（米，不带符号）、顺流路程（米）、半宽、坡度
interface Closest {
  lat: number;
  along: number;
  half: number;
  steep: number;
}

function closestOnPath(path: StreamPath, R: number, x: number, y: number, z: number, out: Closest): Closest {
  const pts = path.points;
  let best = Infinity;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const ax = a.x * R;
    const ay = a.y * R;
    const az = a.z * R;
    const sx = (b.x - a.x) * R;
    const sy = (b.y - a.y) * R;
    const sz = (b.z - a.z) * R;
    const l2 = sx * sx + sy * sy + sz * sz || 1e-9;
    const t = Math.min(1, Math.max(0, ((x - ax) * sx + (y - ay) * sy + (z - az) * sz) / l2));
    const px = ax + sx * t;
    const py = ay + sy * t;
    const pz = az + sz * t;
    const dx = x - px;
    const dy = y - py;
    const dz = z - pz;
    const dist2 = dx * dx + dy * dy + dz * dz;
    if (dist2 < best) {
      best = dist2;
      // 不带左右的符号：源头背后、拐弯处最近的那一段会跳，带符号的话相邻两个顶点一正一负，插值在三角形中间过 0，凭空多出一块水
      out.lat = Math.sqrt(dist2);
      out.along = path.along[k] + (path.along[k + 1] - path.along[k]) * t;
      out.half = path.half[k] + (path.half[k + 1] - path.half[k]) * t;
      out.steep = path.steep[k] + (path.steep[k + 1] - path.steep[k]) * t;
    }
  }
  return out;
}

const _c: Closest = { lat: 0, along: 0, half: 0, steep: 0 };
const _dirTmp = new THREE.Vector3();

// 草、石头让开小溪：水面以内 1，往外 30 厘米降到 0（给 PlanetMask.extraExclude）
export function streamExclude(path: StreamPath, R: number): (d: THREE.Vector3) => number {
  return (d) => {
    if (d.dot(path.center) < path.cosReach) return 0;
    _dirTmp.copy(d).normalize().multiplyScalar(R);
    const c = closestOnPath(path, R, _dirTmp.x, _dirTmp.y, _dirTmp.z, _c);
    if (c.along > path.shore + 0.3) return 0;
    return 1 - THREE.MathUtils.smoothstep(Math.abs(c.lat) - c.half, 0.05, 0.35);
  };
}

const A = new THREE.Vector3();
const B = new THREE.Vector3();
const C = new THREE.Vector3();
const P = new THREE.Vector3();

// 小溪的几何：小溪附近的地表三角形细分到约 16 厘米（细分点在原三角形平面上），沿半径抬高 lift；入水口那段不低于水面 1 厘米
export function buildStreamGeometry(terrain: THREE.BufferGeometry, path: StreamPath, R: number, sea: number): THREE.BufferGeometry {
  const pos = terrain.getAttribute('position') as THREE.BufferAttribute;
  const src = pos.array as Float32Array;
  const index = terrain.getIndex();
  const idx = index ? index.array : null;
  const triCount = idx ? idx.length / 3 : pos.count / 3;
  const maxHalf = Math.max(...path.half) + 0.15;
  const positions: number[] = [];
  const normals: number[] = [];
  const attrs: number[] = [];
  const indices: number[] = [];
  const keepAt: boolean[] = [];
  for (let t = 0; t < triCount; t++) {
    const ia = idx ? idx[t * 3] : t * 3;
    const ib = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const ic = idx ? idx[t * 3 + 2] : t * 3 + 2;
    A.fromArray(src, ia * 3);
    B.fromArray(src, ib * 3);
    C.fromArray(src, ic * 3);
    P.copy(A).add(B).add(C).divideScalar(3);
    const reach = Math.max(P.distanceTo(A), P.distanceTo(B), P.distanceTo(C));
    _dirTmp.copy(P).normalize();
    if (_dirTmp.dot(path.center) < path.cosReach - reach / R) continue;
    _dirTmp.multiplyScalar(R);
    const c = closestOnPath(path, R, _dirTmp.x, _dirTmp.y, _dirTmp.z, _c);
    if (Math.abs(c.lat) - maxHalf > reach) continue;
    // 细分
    const edge = Math.max(A.distanceTo(B), B.distanceTo(C), C.distanceTo(A));
    const N = Math.max(1, Math.ceil(edge / 0.16));
    const base = positions.length / 3;
    const row: number[] = []; // 每一行第一个顶点的编号
    for (let i = 0; i <= N; i++) {
      row.push(positions.length / 3);
      for (let j = 0; j <= N - i; j++) {
        const wa = (N - i - j) / N;
        const wb = i / N;
        const wc = j / N;
        P.set(A.x * wa + B.x * wb + C.x * wc, A.y * wa + B.y * wb + C.y * wc, A.z * wa + B.z * wb + C.z * wc);
        const r = P.length();
        const lifted = Math.max(r + STREAM.lift, sea > 0 ? sea + 0.01 : 0);
        _dirTmp.copy(P).divideScalar(r);
        positions.push(_dirTmp.x * lifted, _dirTmp.y * lifted, _dirTmp.z * lifted);
        normals.push(_dirTmp.x, _dirTmp.y, _dirTmp.z);
        _dirTmp.multiplyScalar(R);
        closestOnPath(path, R, _dirTmp.x, _dirTmp.y, _dirTmp.z, _c);
        attrs.push(_c.lat, _c.along - path.shore, _c.half, _c.steep);
        keepAt.push(Math.abs(_c.lat) - _c.half < 0.12 && _c.along - path.shore < INTO_WATER + 0.2);
      }
    }
    // 细分出来的小三角形：至少一个顶点在水边以内才留
    const v = (i: number, j: number) => row[i] + j;
    const push = (a: number, b: number, c2: number) => {
      if (keepAt[a] || keepAt[b] || keepAt[c2]) indices.push(a, b, c2);
    };
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N - i; j++) {
        push(v(i, j), v(i + 1, j), v(i, j + 1));
        if (j < N - i - 1) push(v(i + 1, j), v(i + 1, j + 1), v(i, j + 1));
      }
    }
    void base;
  }
  const geo = new THREE.BufferGeometry();
  if (indices.length === 0) {
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    geo.setAttribute('streamA', new THREE.BufferAttribute(new Float32Array([9, 0, 0, 0, 9, 0, 0, 0, 9, 0, 0, 0]), 4));
    geo.setIndex([0, 1, 2]);
  } else {
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
    geo.setAttribute('streamA', new THREE.BufferAttribute(new Float32Array(attrs), 4));
    geo.setIndex(indices);
  }
  geo.computeBoundingSphere();
  return geo;
}

// 小溪的材质：和水面同一套光照（天光反射、太阳高光、闪光），预乘透明度。source：泉眼的位置（星球本地坐标，米）
export function streamMaterial(preset: PresetId, source: THREE.Vector3): THREE.MeshPhysicalNodeMaterial {
  const pal = paletteOf(preset);
  const U = WATER_U;
  const m = litWaterMaterial(`stream-${preset}`);
  const a = attribute('streamA', 'vec4') as unknown as V4;
  const lat = a.x;
  const fromShore = a.y; // 顺流路程，水边是 0，上游是负的
  const half = a.z;
  const steep = a.w;
  const p = positionLocal;
  const n = normalize(p);
  const t = time;
  const perPixel = length(fwidth(p)).max(1e-5).toVar();
  const keep = (f: number) => smoothstep(1.2, 3, float(1).div(perPixel.mul(f)));
  // 离泉眼多远（米）：源头的小圆池、一圈圈的波纹
  const uSource = uniform(source.clone()).setGroup(renderGroup);
  m.userData.source = uSource.value; // 重新找路线时原地改它（createStream）
  const toSource = length(p.sub(uSource));

  // 水边：半宽 − |横向距离|，噪声抖一抖；入水口往水里伸的那段慢慢淡掉
  const wob = valueNoise3(p.mul(3.3).add(1.7)).sub(0.5).mul(0.07);
  const e = half.sub(abs(lat)).add(wob).toVar();
  const exists = smoothstep(0.0, max(fwidth(e).mul(1.5), 0.004), e).mul(float(1).sub(smoothstep(0.25, 1.15, fromShore))).toVar();

  // 顺流而下的白线：沿流向拉长的噪声（横向密、纵向疏），坡陡的地方更多、更白
  const u = fromShore.sub(t.mul(STREAM.speed));
  const s1 = valueNoise3(vec3(lat.mul(7), u.mul(1.5), 3.3));
  const s2 = valueNoise3(vec3(lat.mul(12), u.mul(2.6), 9.1));
  const rapids = saturate(steep.mul(5));
  const streak = smoothstep(mix(float(0.66), float(0.5), rapids), mix(float(0.74), float(0.62), rapids), s1.mul(0.6).add(s2.mul(0.4))).mul(keep(7));
  // 两岸一条细白边；入水口散开一扇白沫
  const bank = float(1).sub(smoothstep(0.015, 0.06, e.add(s2.sub(0.5).mul(0.03))));
  const fan = smoothstep(-0.35, 0.05, fromShore).mul(float(1).sub(smoothstep(0.2, 1.0, fromShore))).mul(smoothstep(0.4, 0.62, s1));
  // 泉眼：一圈圈往外的细白环（绘本里的泉水）
  const springK = float(1).sub(smoothstep(STREAM.spring * 0.7, STREAM.spring * 1.1, toSource));
  const rings = smoothstep(0.82, 0.97, fract(toSource.mul(5.5).sub(t.mul(0.45)))).mul(springK).mul(smoothstep(0.04, 0.12, toSource));
  const foam = saturate(max(max(streak.mul(0.85), bank.mul(0.75)), max(fan.mul(0.8), rings.mul(0.7)))).mul(U.foam).mul(exists).toVar();

  // 身体：中间深一点、两边浅（看得见溪底）
  const middle = saturate(float(1).sub(lat.div(max(half, 0.05)).pow(2)));
  const body = mix(pal.shallow, pal.mid, middle.mul(0.55).add(springK.mul(0.25)));
  const alphaBody = mix(float(0.42), float(0.78), middle).mul(exists);
  // 法线：顺流漂的小波纹
  const o = noise3v(vec3(lat.mul(4), u.mul(2.4), p.x.mul(0.1))).sub(0.5);
  const tilt = o.mul(0.22).mul(rapids.mul(0.8).add(0.6));
  const nW = normalize(n.add(tilt.sub(n.mul(dot(n, tilt))))).toVar();

  m.colorNode = mix(body.mul(alphaBody), pal.foam.mul(exists), foam);
  m.opacityNode = mix(alphaBody, exists, foam);
  m.roughnessNode = mix(U.roughness.add(0.03), float(0.85), foam);
  m.normalNode = transformNormalToView(mix(nW, n, foam));
  m.specularColorNode = vec3(U.sheen);
  m.specularIntensityNode = exists;

  // 闪光：同水面，只在太阳反光的范围里算
  const glintAmt = U.sparkle.mul(keep(23)).mul(exists.sub(foam).max(0)).mul(3).toVar();
  const nView = transformNormalToView(nW);
  m._extras = {
    glint: (L) => Fn(() => {
      const out = float(0).toVar();
      const H = normalize(L.add(positionViewDirection)).toVar();
      If(glintAmt.greaterThan(0.001).and(dot(nView, H).greaterThan(0.8)), () => {
        const g = noise3v(vec3(lat.mul(23), u.mul(23), p.y.mul(23)).add(vec3(t.mul(1.3), 0, t.mul(0.7)))).sub(0.5).mul(0.6);
        const gN = transformNormalToView(normalize(nW.add(g.sub(n.mul(dot(n, g))))));
        out.assign(smoothstep(0.9986, 0.9997, dot(gN, H)).mul(glintAmt));
      });
      return out;
    })() as unknown as F,
    caustic: () => vec3(0),
    mask: exists,
  };
  return m;
}

// 泉眼的位置（星球本地坐标，米）：路线起点那个方向上的地面再抬 lift
function sourceAt(host: StreamHost, path: StreamPath): THREE.Vector3 {
  const s = path.points[0];
  return s.clone().multiplyScalar(host.height(s.x, s.y, s.z) + STREAM.lift);
}

// 建一颗星球的小溪（water.ts 的 createWater 调）。找不到合适的路线时返回 null。
// 地表换细分时跟着重建几何；摆放变了（遮罩重画）时重新找路线；草和石头通过 mask.extraExclude 让开
export function createStream(host: StreamHost): THREE.Mesh | null {
  let path = findStreamPath(host);
  if (!path) return null;
  const R = host.radius;
  let builtFrom = host.terrain.geometry;
  const material = streamMaterial(host.currentRecipe.preset, sourceAt(host, path));
  const mesh = new THREE.Mesh(buildStreamGeometry(builtFrom, path, R, host.sea), material);
  mesh.name = 'stream';
  mesh.receiveShadow = true;
  mesh.renderOrder = 1; // 入水口那一扇白沫叠在水面上面
  let exclude = streamExclude(path, R);
  host.mask.extraExclude = exclude;
  const rebuild = () => {
    const old = mesh.geometry;
    mesh.geometry = buildStreamGeometry(builtFrom, path!, R, host.sea);
    old.dispose();
  };
  mesh.onBeforeRender = () => {
    if (host.terrain.geometry === builtFrom) return;
    builtFrom = host.terrain.geometry;
    rebuild();
  };
  // 摆放变了：先不让草让开（重新找路线时 exclude 不能挡住自己），再找一遍
  const unsubscribe = host.onMaskChange(() => {
    if (host.mask.extraExclude === exclude) host.mask.extraExclude = null;
    const next = findStreamPath(host);
    if (!next) {
      mesh.visible = false;
      return;
    }
    path = next;
    exclude = streamExclude(path, R);
    host.mask.extraExclude = exclude;
    (material.userData.source as THREE.Vector3).copy(sourceAt(host, path));
    mesh.visible = true;
    rebuild();
  });
  material.addEventListener('dispose', () => {
    unsubscribe();
    if (host.mask.extraExclude === exclude) host.mask.extraExclude = null;
  });
  return mesh;
}
