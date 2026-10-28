import * as THREE from 'three/webgpu';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, cameraPosition, color, dot, float, Fn, If, instanceColor, length, max, mix, modelPosition, modelScale, normalize, normalWorld, positionLocal, positionWorld, pow, renderGroup, saturate, sin, smoothstep, time, uniform, vec3 } from 'three/tsl';
import { DECOR, decorInstances, rockGeometry } from '../planet/decor';
import { applyGround, GROUND, RIM, RIM_RING } from '../planet/ground';
import { STAGE_DIR } from '../planet/noise';
import { mulberry32 } from '../planet/rng';
import { valueNoise3 } from '../planet/tslNoise';
import { PLANET_RADIUS } from '../planet/presets';
import type { Atmosphere } from './atmosphere';

// 星球远看的样子（planet 角色）：大气光晕、慢慢转的云层、云在地面上的影子、星球表面边缘的一层空气。
// 都是「远看才有」的东西：镜头离星球近（星球视图、漫游）时整个藏起来，不占填充率。
// 风格：绘本里的星球——空气是一圈很淡、带一点暖色的晕，不是发光的科幻边；云是一团团压暗过的奶白，按真实的太阳和天光打光。
// 配方来自《14-星球视觉效果》：大气强度要远比直觉小；云要压暗（× 0.6 左右）；昼夜分界附近乘一点暖色

// 可调参数（?tune → Planet → Look from afar）。改了以后调 applyPlanetLook()
export const PLANET_LOOK = {
  atmosphere: 0.55, // 大气光晕的浓度倍数（星系里大了像一层奶白的雾）
  atmosphereWarm: '#ffb28a', // 晨昏线附近的暖色
  limbHaze: 0.2, // 星球表面靠边缘的那层空气（远看才有）
  clouds: 0.2, // 云量 0..1
  cloudOpacity: 0.36,
  cloudBrightness: 0.72, // 云的反照率：压暗，不然在亮天空下是一片死白
  cloudSpeed: 1, // 云层转动的速度倍数
  cloudShadow: 0.3, // 云影的深度
  seaShadow: 1, // 星系里星球在云海上的影子（浓度）
  rimLight: 1, // 星系里星球朝阳一侧边缘的暖光（让星球从云海里跳出来）
};

const U = {
  sun: uniform(new THREE.Vector3(0.55, 0.38, 0.74).normalize()).setGroup(renderGroup), // 指向太阳（世界坐标）
  drift: uniform(0).setGroup(renderGroup), // 云层转过的角度（弧度），每帧按 dt 累加
  atmosphere: uniform(PLANET_LOOK.atmosphere).setGroup(renderGroup),
  warm: uniform(new THREE.Color(PLANET_LOOK.atmosphereWarm)).setGroup(renderGroup),
  limbHaze: uniform(PLANET_LOOK.limbHaze).setGroup(renderGroup),
  clouds: uniform(PLANET_LOOK.clouds).setGroup(renderGroup),
  cloudOpacity: uniform(PLANET_LOOK.cloudOpacity).setGroup(renderGroup),
  cloudBrightness: uniform(PLANET_LOOK.cloudBrightness).setGroup(renderGroup),
  cloudShadow: uniform(PLANET_LOOK.cloudShadow).setGroup(renderGroup),
  seaShadow: uniform(PLANET_LOOK.seaShadow).setGroup(renderGroup),
  rimLight: uniform(PLANET_LOOK.rimLight).setGroup(renderGroup),
};

export function applyPlanetLook(): void {
  U.atmosphere.value = PLANET_LOOK.atmosphere;
  U.warm.value.set(PLANET_LOOK.atmosphereWarm);
  U.limbHaze.value = PLANET_LOOK.limbHaze;
  U.clouds.value = PLANET_LOOK.clouds;
  U.cloudOpacity.value = PLANET_LOOK.cloudOpacity;
  U.cloudBrightness.value = PLANET_LOOK.cloudBrightness;
  U.cloudShadow.value = PLANET_LOOK.cloudShadow;
  U.seaShadow.value = PLANET_LOOK.seaShadow;
  U.rimLight.value = PLANET_LOOK.rimLight;
}

// 镜头离星球中心多远（× 星球半径）以内，云层、大气光晕、表面的空气都不画：
// 星球视图在 2.6 倍（shots.ts），漫游贴着地面；星系里镜头在几十倍以外
export const NEAR_HIDE = 3.2;
export const FAR_FULL = 5; // 到这里完全显出来

type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

// 镜头离这颗星球中心多远，按星球半径算（星球组可能被缩放：星球视图里的邻居缩到 0.45）
const camDistanceInRadii = (radius: number | F): F => length(cameraPosition.sub(modelPosition)).div(modelScale.x.mul(radius));

// 云的覆盖率（0..1）：星球本地方向 dir 先绕竖轴转过 drift。一缕一缕的薄云：沿经度方向拉长的低频噪声（横着的云带），
// 阈值高、边缘柔和，只在中低纬度；又薄又少，星球的颜色透得出来（白色的大团、碎絮远看像发霉、像贴了胶布，lead 看过两轮）。
// offset 让每颗星球的云不一样（按种子）。
// 写成带 layout 的函数（着色器里只生成一份）；uniform 不能在函数体里直接引用（函数体各材质共用，uniform 的名字对不上），
// 转动角度和云量当参数传进去
const cloudCoverFn = Fn(([dir, offset, drift, amount]: [V3, V3, F, F]) => {
  const c = drift.cos();
  const s = drift.sin();
  const d = vec3(dir.x.mul(c).sub(dir.z.mul(s)), dir.y, dir.x.mul(s).add(dir.z.mul(c)));
  const q = d.mul(vec3(2.2, 6.5, 2.2)).add(offset);
  const n = valueNoise3(q).mul(0.6).add(valueNoise3(q.mul(2.3).add(3.3)).mul(0.28)).add(valueNoise3(q.mul(5.2).add(9.1)).mul(0.12));
  const th = float(0.74).sub(amount.mul(0.5));
  return smoothstep(th, th.add(0.16), n).mul(smoothstep(0.75, 0.35, d.y.abs()));
}).setLayout({
  name: 'planetCloudCover',
  type: 'float',
  inputs: [{ name: 'dir', type: 'vec3' }, { name: 'offset', type: 'vec3' }, { name: 'drift', type: 'float' }, { name: 'amount', type: 'float' }],
}) as unknown as (dir: V3, offset: V3, drift: F, amount: F) => F;

export const cloudCover = (dir: V3, offset: V3): F => cloudCoverFn(dir, offset, U.drift, U.clouds);

// 大气光晕：背面渲染的薄外壳。按视线离星球中心最近的距离 b 算：b = 星球半径时最浓，到外壳边缘淡到 0（没有硬边）。
// 颜色按那一处的受光：白天是预设的天色，晨昏线附近偏暖，夜面淡掉；厚度沿轮廓按噪声起伏一点，像一笔一笔刷出来的。
// 普通混合（不是叠加）：是一层淡淡的颜色，不会在亮天空前面变成发光的边
export function atmosphereRimMaterial(tint: THREE.ColorRepresentation, planetRadius: number, shellRadius: number, strength: THREE.UniformNode<'float', number>, seed: number, fade: F): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false, fog: false });
  m.name = 'planet-atmosphere';
  const scale = modelScale.x;
  const v = normalize(positionWorld.sub(cameraPosition));
  const oc = cameraPosition.sub(modelPosition);
  const along = max(dot(oc, v).negate(), 0);
  const closest = oc.add(v.mul(along)); // 视线上离星球中心最近的点（相对中心）
  const b = length(closest).div(scale);
  const t = saturate(b.sub(planetRadius).div(shellRadius - planetRadius));
  const limb = normalize(closest);
  const mu = dot(limb, U.sun);
  const day = smoothstep(-0.38, 0.2, mu);
  const dusk = smoothstep(0.5, 0.0, mu).mul(day);
  const brush = valueNoise3(limb.mul(3.1).add(seed % 97)).mul(0.5).add(valueNoise3(limb.mul(7.3).add(17.7)).mul(0.25)).add(0.62);
  const profile = pow(saturate(float(1).sub(t.div(brush))), 2.2);
  m.colorNode = mix(color(new THREE.Color(tint)), U.warm, dusk.mul(0.75));
  m.opacityNode = profile.mul(day.mul(0.85).add(0.15)).mul(strength).mul(U.atmosphere).mul(fade).mul(0.5);
  return m;
}

// 云层：一个略大的球壳，用标准材质（按场景里真实的太阳和天光打光：白天、日落、下雨都跟着变），颜色压暗。
// 云团朝太阳的一侧亮、背面偏暗（沿太阳方向再取一次覆盖率，前面挡着的越多越暗）
export function cloudLayerMaterial(offset: THREE.UniformNode<'vec3', THREE.Vector3>, fade: F): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 1, metalness: 0 });
  m.name = 'planet-clouds';
  const dir = normalize(positionWorld.sub(modelPosition));
  const cov = cloudCover(dir, offset);
  const toward = cloudCover(normalize(dir.add(U.sun.mul(0.035))), offset);
  const selfShade = float(1).sub(toward.mul(0.4)).mul(cov.mul(0.2).add(0.8));
  m.colorNode = vec3(1, 0.98, 0.95).mul(U.cloudBrightness).mul(selfShade);
  m.opacityNode = cov.mul(U.cloudOpacity).mul(fade);
  return m;
}

// 地表着色器里用：云影（按太阳方向偏一点采样同一个云层）和边缘的空气。远看才有：
// 镜头离星球近（星球视图、漫游）时 far = 0，云影那一段在一个分支里整个跳过（同一次绘制里条件处处一样，GPU 不会两边都算）。
// 返回 { shade: 乘在地面颜色上（云影）, haze: 加在自发光上（边缘的空气，按受光） }
export function planetSurfaceLook(radius: number | F, offset: THREE.UniformNode<'vec3', THREE.Vector3>, fade: F, tint: THREE.Node<'color'>): { shade: F; haze: THREE.Node<'vec3'> } {
  const far = smoothstep(NEAR_HIDE, FAR_FULL, camDistanceInRadii(radius)).mul(fade).toVar();
  const n = normalize(positionWorld.sub(modelPosition));
  const shade = Fn(() => {
    const s = float(1).toVar();
    If(far.greaterThan(0.001), () => {
      const shadowCov = cloudCover(normalize(n.add(U.sun.mul(0.05))), offset);
      s.assign(float(1).sub(shadowCov.mul(U.cloudShadow).mul(far)));
    });
    return s;
  })() as unknown as F;
  const view = normalize(cameraPosition.sub(positionWorld));
  const mu = dot(n, U.sun);
  const edge = pow(float(1).sub(saturate(dot(n, view))), 3);
  const lit = smoothstep(-0.2, 0.35, mu);
  const hazeCol = mix(tint, U.warm, smoothstep(0.45, 0.0, mu).mul(lit).mul(0.6)).mul(edge.mul(lit).mul(U.limbHaze).mul(far).mul(0.35));
  // 轮廓光（星系里）：朝阳一侧贴着轮廓一道窄窄的暖白光，星球从下面亮白的云海里跳出来；背光一侧的轮廓压暗一点（下面 shade 里）
  const rimEdge = pow(float(1).sub(saturate(dot(n, view))), 5);
  const rimSide = smoothstep(-0.1, 0.6, mu);
  const rim = vec3(1, 0.78, 0.5).mul(rimEdge.mul(rimSide).mul(far).mul(U.rimLight).mul(0.12));
  const haze = hazeCol.add(rim);
  const darkLimb = float(1).sub(rimEdge.mul(float(1).sub(rimSide)).mul(far).mul(U.rimLight).mul(0.35));
  return { shade: shade.mul(darkLimb), haze };
}

// 「俯瞰」系数 0..1：镜头离星球中心 1.4 个半径以内（漫游、贴地）是 0，2 个半径以外（星球视图、星系）是 1。
// 地表着色器里只在俯瞰时才有的东西（一片片的草色、花田、冷暖）乘它：贴地时交给 3D 的草和花，地面颜色和草叶对得上
export const overviewFactor = (radius: number | F): F => smoothstep(1.4, 2.0, camDistanceInRadii(radius));

// 「舞台」系数 0..1：星球视图（2.6 个半径）和漫游时是 1，星系里（几十个半径以外）是 0。
// 外沿那一圈石头地只在聚焦时画：星系里一圈石头带在每颗星球上都像一条腰带，不好看
export const stageFactor = (radius: number | F): F => smoothstep(7, 4.5, camDistanceInRadii(radius));

// 「星系」系数 0..1：星球视图（2.6 个半径）是 0，星系里（十几个半径以外）是 1。星系里每颗星球的团队色更多，一眼分得开
export const galaxyFactor = (radius: number | F): F => smoothstep(5, 10, camDistanceInRadii(radius));

// 冷暖：朝太阳的一侧偏暖（黄一点），背光、晨昏线以外偏冷（蓝紫一点）。n 是球面法线（世界坐标）；返回乘在颜色上的系数
export function sunTint(n: V3, amount: F | number): V3 {
  const mu = dot(n, U.sun);
  const k = smoothstep(-0.3, 0.9, mu);
  return mix(vec3(1, 1, 1), mix(vec3(0.86, 0.93, 1.1), vec3(1.12, 1.03, 0.84), k), amount);
}

export const sunDirNode = (): V3 => U.sun;

// —— 星系里的点缀：石头带（带光环的星球）、小浮岛 ——
// 石头带：一圈慢慢绕着转的圆润小石头（顶上长苔藓），代替原来半透明的条纹光环（那个太像科幻）；
// 小浮岛：每颗星球旁边飘着一两个小岛，顶上是草、底下是圆润的石头，慢慢上下浮动（像《宇宙机器人》《光遇》的浮空岛）。
// 都挂在远看部件里：镜头近了、看别的星球时跟着藏起来
export const GALAXY_DECOR = {
  beltRocks: 520, // 一条石头带多少块
  beltSpeed: 1, // 转动速度倍数
  islands: 1, // 小浮岛数量倍数（0 = 没有）
};

let floatMaterial: THREE.MeshStandardNodeMaterial | null = null;

// 浮在空中的石头（石头带、浮岛底下）共用：顶亮底暗的绘本式渐变、大块深浅斑，朝上（世界 +Y）的面长苔藓。颜色 = 实例颜色
function floatingRockMaterial(): THREE.MeshStandardNodeMaterial {
  if (floatMaterial) return floatMaterial;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
  m.name = 'floating-rock';
  const p = positionLocal;
  const facing = normalize(normalWorld).y;
  const spots = valueNoise3(p.mul(2.4)).mul(0.6).add(valueNoise3(p.mul(6.1).add(3.7)).mul(0.4));
  const light = mix(float(0.62), float(1.12), smoothstep(-0.6, 0.8, facing));
  const moss = smoothstep(0.25, 0.75, facing).mul(smoothstep(0.32, 0.58, spots)).mul(0.9);
  const stone = instanceColor.mul(vec3(1.06, 1.0, 0.9)).mul(light.mul(spots.mul(0.25).add(0.87)));
  m.colorNode = mix(stone, color('#5d7a2c').mul(light), moss);
  floatMaterial = m;
  return m;
}

// 石头带里的石头（所有星球共用一份几何）：圆润的石头，挪到以中心为原点（飘在空中，不用「底面贴地」）
let beltGeometry: THREE.BufferGeometry | null = null;
function beltRockGeometry(): THREE.BufferGeometry {
  if (beltGeometry) return beltGeometry;
  const g = rockGeometry(131, 1);
  g.center();
  g.computeBoundingSphere();
  beltGeometry = g;
  return g;
}

// 云海上的影子：一块水平的圆片（半径 1，所有星球共用），材质按到中心的距离做柔和的径向衰减，冷一点的紫灰
let shadowGeo: THREE.BufferGeometry | null = null;
function shadowGeometry(): THREE.BufferGeometry {
  if (shadowGeo) return shadowGeo;
  shadowGeo = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
  return shadowGeo;
}

// 乘法混合（结果 = 云的颜色 × 这里的颜色）：云的纹理留着，只是压暗、偏冷。普通的半透明叠一层暗色在 AgX 下几乎看不出来
// （亮云在色调映射的高光段被压缩，线性亮度减半屏幕上只暗一成），叠得浓又会把云的纹理抹平成一块色片
function shadowMaterial(fade: F): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  m.name = 'planet-sea-shadow';
  const r = length(positionLocal.xz);
  // 一块平平的影子（中间一大片差不多一样深，边缘柔和），中心再深一点点：读起来是「投在云上的影子」，不是一个暗点
  const soft = smoothstep(1.0, 0.3, r).mul(0.78).add(smoothstep(0.55, 0.0, r).mul(0.22));
  m.colorNode = mix(vec3(1, 1, 1), vec3(0.42, 0.45, 0.68), soft.mul(U.seaShadow).mul(fade).clamp(0, 1));
  m.opacityNode = float(1);
  return m;
}

// 舞台中心（星球本地方向）：小浮岛不放在这一面
const STAGE_DIR_HINT = STAGE_DIR;

// 小浮岛的几何（所有星球共用一份）：上半个球压成微微鼓起的草顶，下半个往下拉成圆润的倒锥；顶点颜色的 r 是「草」（1 草顶，0 石头）
let islandGeometry: THREE.BufferGeometry | null = null;
function floatingIslandGeometry(): THREE.BufferGeometry {
  if (islandGeometry) return islandGeometry;
  const ico = new THREE.IcosahedronGeometry(1, 3);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const geo = mergeVertices(ico, 1e-6);
  ico.dispose();
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const noise = new SimplexNoise({ random: mulberry32(907) });
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = noise.noise3d(v.x * 1.7, v.y * 1.7, v.z * 1.7);
    let grass = 0;
    if (v.y > 0) {
      // 草顶：半球压扁成缓缓鼓起的一块，边缘有一圈草垂下来
      v.y = 0.16 * v.y + 0.04 * n;
      v.x *= 1 + 0.08 * n;
      v.z *= 1 + 0.08 * n;
      grass = 1;
    } else {
      // 底：往下拉长，越往下越收，像倒挂的一块圆润石头
      const d = -v.y;
      v.y = -d * (1.15 + 0.25 * n);
      const shrink = 1 - 0.55 * d * d;
      v.x *= shrink * (1 + 0.12 * n);
      v.z *= shrink * (1 + 0.12 * n);
      grass = Math.max(0, 1 - d * 6); // 边上一圈草垂下来一点
    }
    pos.setXYZ(i, v.x, v.y, v.z);
    col[i * 3] = grass;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  islandGeometry = geo;
  return geo;
}

// 小浮岛的材质（每颗星球一份：草色、石头色按星球的配色）
function floatingIslandMaterial(grass: THREE.ColorRepresentation, rock: THREE.ColorRepresentation): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  m.name = 'floating-island';
  const p = positionLocal;
  const g = smoothstep(0.35, 0.75, attribute('color', 'vec3').x);
  const facing = normalize(normalWorld).y;
  const light = mix(float(0.62), float(1.12), smoothstep(-0.6, 0.8, facing));
  const spots = valueNoise3(p.mul(3.1)).mul(0.6).add(valueNoise3(p.mul(7.7).add(1.9)).mul(0.4));
  const stone = color(new THREE.Color(rock)).mul(light.mul(spots.mul(0.3).add(0.85)));
  const turf = color(new THREE.Color(grass)).mul(spots.mul(0.25).add(0.88));
  m.colorNode = mix(stone, turf, g);
  return m;
}

// —— 建设中的星球：舞台中间翻过的空地上立一个小脚手架，顶上插一面团队色的三角旗（会飘）——
// 星系里按镜头距离放大（最多 3 倍），远远地也看得出「这里在盖东西」；近了是原大小（脚手架约 2 米，旗杆顶约 4.6 米）
const sites = new Set<THREE.Object3D>();
let woodMat: THREE.MeshStandardNodeMaterial | null = null;

function scaffoldMaterial(): THREE.MeshStandardNodeMaterial {
  if (woodMat) return woodMat;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  m.name = 'site-wood';
  const grain = valueNoise3(positionLocal.mul(vec3(2, 14, 2)));
  m.colorNode = color('#9a6b42').mul(grain.mul(0.25).add(0.85));
  woodMat = m;
  return m;
}

export function constructionSite(accent: THREE.ColorRepresentation): THREE.Group {
  const g = new THREE.Group();
  g.name = 'construction-site';
  const wood = scaffoldMaterial();
  const parts: THREE.BufferGeometry[] = [];
  const post = (x: number, z: number, h: number) => parts.push(new THREE.CylinderGeometry(0.06, 0.07, h, 6).translate(x, h / 2, z));
  const bar = (len: number, y: number, rotY: number, x: number, z: number) => {
    const b = new THREE.BoxGeometry(len, 0.08, 0.08);
    b.rotateY(rotY);
    b.translate(x, y, z);
    parts.push(b);
  };
  // 脚手架：四根立柱 + 两层横梁 + 一块小平台
  const s = 0.55;
  for (const [x, z] of [[-s, -s], [s, -s], [s, s], [-s, s]]) post(x, z, 2);
  for (const y of [0.9, 1.9]) {
    bar(s * 2, y, 0, 0, -s);
    bar(s * 2, y, 0, 0, s);
    bar(s * 2, y, Math.PI / 2, -s, 0);
    bar(s * 2, y, Math.PI / 2, s, 0);
  }
  parts.push(new THREE.BoxGeometry(s * 2.2, 0.08, s * 2.2).translate(0, 1.95, 0));
  // 旗杆
  parts.push(new THREE.CylinderGeometry(0.045, 0.05, 2.7, 6).translate(0, 1.95 + 1.35, 0));
  const woodMesh = new THREE.Mesh(mergeGeometries(parts), wood);
  woodMesh.castShadow = true;
  g.add(woodMesh);
  // 三角旗（双面，按时间飘）
  const flagGeo = new THREE.BufferGeometry();
  const segs = 8;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const half = 0.55 * (1 - t);
    pos.push(t * 1.6, -half, 0, t * 1.6, half, 0);
    if (i < segs) {
      const k = i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  flagGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  flagGeo.setIndex(idx);
  flagGeo.computeVertexNormals();
  const flagMat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.8, metalness: 0 });
  flagMat.name = 'site-flag';
  const x = positionLocal.x;
  flagMat.positionNode = positionLocal.add(vec3(0, 0, sin(time.mul(4.2).sub(x.mul(5))).mul(x).mul(0.14)));
  flagMat.colorNode = color(new THREE.Color(accent)).mul(0.85);
  const flag = new THREE.Mesh(flagGeo, flagMat);
  flag.position.set(0.05, 4.1, 0);
  g.add(flag);
  return g;
}

// 建设中的工地按镜头距离放大：PlanetObject 建好以后登记，拆掉时取消
export function registerSite(site: THREE.Object3D): () => void {
  sites.add(site);
  return () => sites.delete(site);
}

// —— 每颗星球的远看部件（PlanetObject 建、World 每帧按镜头距离开关）——
const parts = new Set<PlanetLookParts>();

export interface PlanetLookOptions {
  radius: number; // 星球半径（本地单位）
  top: number; // 地形最高处（本地单位）
  seed: number;
  tint: THREE.ColorRepresentation; // 大气的颜色
  atmosphere: boolean;
  haloStrength: THREE.UniformNode<'float', number>; // 大气光晕的浓淡（World 在星球视图里把聚焦的那颗压淡）
  ring: boolean; // 有光环：做成一圈石头带
  grass: THREE.ColorRepresentation; // 小浮岛的草顶
  rock: THREE.ColorRepresentation; // 石头带、小浮岛底下的石头
}

interface Island {
  mesh: THREE.Mesh;
  base: THREE.Vector3; // 星球本地坐标
  phase: number;
}

export class PlanetLookParts {
  readonly group = new THREE.Group();
  readonly cloudOffset = uniform(new THREE.Vector3());
  // 0..1：别的星球被聚焦时淡出（云层、大气、地面上的云影一起），回星系淡回来。updatePlanetLook 逐帧逼近
  readonly fade = uniform(1);
  // 团队色（星系里各队的星球一眼分得开）：俯瞰时朝阳的大片、一种花田的颜色往它靠，大气、石头带也染一点
  readonly accent = uniform(new THREE.Color('#ffffff'));
  readonly accentAmount = uniform(0);
  // 建设中：团队色的花海只铺一半（还没装饰完），工地的空地是浅色的沙土
  readonly construction = uniform(0);
  private accentHex: string | null = null;
  radius = 1;
  ring: THREE.Object3D | null = null; // 石头带（名字叫 ring：PlanetObject 的光环浓淡照旧开关它）
  private atmosphere: THREE.Mesh | null = null;
  private clouds: THREE.Mesh | null = null;
  private belt: THREE.InstancedMesh | null = null;
  private islands: Island[] = [];
  private islandMaterial: THREE.MeshStandardNodeMaterial | null = null;
  private time = Math.random() * 100;
  private shadow: THREE.Mesh | null = null;

  constructor() {
    this.group.name = 'planet-look';
    parts.add(this);
  }

  // 团队色（十六进制）。null：不染（演示页、测试）。下一次 build 时大气和石头带用上；地面的 uniform 立刻生效
  setAccent(hex: string | null): void {
    this.accentHex = hex;
    this.accentAmount.value = hex ? 1 : 0;
    if (hex) this.accent.value.set(hex);
  }

  private tinted(base: THREE.ColorRepresentation, k: number): THREE.Color {
    const c = new THREE.Color(base);
    return this.accentHex ? c.lerp(new THREE.Color(this.accentHex), k) : c;
  }

  // 按配方重建：云层、大气外壳。几何每次新建（星球半径会变），云的材质留着（第一次画要编译着色器）
  build(o: PlanetLookOptions): void {
    this.radius = o.radius;
    const rng = Math.sin(o.seed * 12.9898) * 43758.5453;
    this.cloudOffset.value.set((rng - Math.floor(rng)) * 40, (o.seed % 53) * 0.71, (o.seed % 31) * 1.37);
    if (!this.clouds) {
      this.clouds = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 8), cloudLayerMaterial(this.cloudOffset, this.fade));
      this.clouds.name = 'planet-clouds';
      this.clouds.renderOrder = 2; // 在大气外壳之后画
      this.group.add(this.clouds);
    }
    this.clouds.scale.setScalar(o.top + o.radius * 0.035);
    if (this.atmosphere) {
      this.atmosphere.removeFromParent();
      this.atmosphere.geometry.dispose();
      (this.atmosphere.material as THREE.Material).dispose();
      this.atmosphere = null;
    }
    if (o.atmosphere) {
      const shell = o.top + o.radius * 0.11;
      this.atmosphere = new THREE.Mesh(new THREE.IcosahedronGeometry(shell, 8), atmosphereRimMaterial(this.tinted(o.tint, 0.5), o.radius, shell, o.haloStrength, o.seed, this.fade));
      this.atmosphere.name = 'planet-atmosphere';
      this.atmosphere.renderOrder = 1;
      this.group.add(this.atmosphere);
    }
    this.buildBelt(o);
    this.buildIslands(o);
  }

  // 石头带：放在倾斜的赤道面上，半径 1.5–2.1 倍星球半径，中间密、两边稀；大小按幂律（小石头多、大石头少）
  private buildBelt(o: PlanetLookOptions): void {
    if (this.ring) {
      this.ring.removeFromParent();
      this.belt?.dispose();
      this.belt = null;
      this.ring = null;
    }
    if (!o.ring) return;
    const R = o.radius;
    const n = Math.round(GALAXY_DECOR.beltRocks);
    const mesh = decorInstances(beltRockGeometry(), floatingRockMaterial(), n);
    mesh.name = 'belt-rocks';
    const rng = mulberry32((o.seed * 7919 + 13) >>> 0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const c = new THREE.Color();
    const rock = this.tinted(o.rock, 0.25);
    const sand = new THREE.Color(o.grass);
    for (let i = 0; i < n; i++) {
      const u = (rng() + rng() + rng()) / 3; // 中间密
      const r = R * (1.6 + 0.42 * u);
      const a = rng() * Math.PI * 2;
      p.set(Math.cos(a) * r, (rng() + rng() - 1) * R * 0.03, Math.sin(a) * r);
      const size = R * (0.009 + 0.034 * rng() ** 3);
      s.set(size, size * (0.7 + rng() * 0.5), size);
      q.setFromEuler(e.set(rng() * 6.28, rng() * 6.28, rng() * 6.28));
      mesh.setMatrixAt(i, m.compose(p, q, s));
      mesh.setColorAt(i, c.copy(rock).lerp(sand, 0.35).multiplyScalar(1.5 + rng() * 0.6));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    const tilt = new THREE.Group();
    tilt.name = 'ring';
    tilt.rotation.set(0.38, 0, 0.22); // 赤道面再稍微倾斜（和原来的光环一样）
    tilt.add(mesh);
    this.belt = mesh;
    this.ring = tilt;
    this.group.add(tilt);
  }

  // 小浮岛：一两个，离星球中心 1.8–2.4 倍半径，避开舞台那一面（星球视图里不挡作品），大小 0.08–0.15 倍半径
  private buildIslands(o: PlanetLookOptions): void {
    for (const it of this.islands) it.mesh.removeFromParent();
    this.islands = [];
    this.islandMaterial?.dispose();
    this.islandMaterial = null;
    const rng = mulberry32((o.seed * 104729 + 7) >>> 0);
    const count = Math.round((1 + (rng() < 0.55 ? 1 : 0)) * GALAXY_DECOR.islands);
    if (count <= 0) return;
    this.islandMaterial = floatingIslandMaterial(this.tinted(o.grass, 0.15), o.rock);
    const R = o.radius;
    for (let i = 0; i < count; i++) {
      const az = rng() * Math.PI * 2;
      const el = (rng() * 2 - 1) * 0.45;
      const d = R * (1.65 + rng() * 0.5);
      const base = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).multiplyScalar(d);
      if (base.clone().normalize().dot(new THREE.Vector3(...STAGE_DIR_HINT)) > 0.55) base.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
      const mesh = new THREE.Mesh(floatingIslandGeometry(), this.islandMaterial);
      mesh.name = 'floating-island';
      mesh.scale.setScalar(R * (0.15 + rng() * 0.12));
      mesh.rotation.y = rng() * Math.PI * 2;
      mesh.position.copy(base);
      this.group.add(mesh);
      this.islands.push({ mesh, base, phase: rng() * Math.PI * 2 });
    }
  }

  // 云海上的影子（星系里）：星球正下方偏离太阳一点的云面上，一块柔和的冷色暗斑，星球像浮在云海上，不是贴在一张图上。
  // seaY：云面的高度（世界坐标）；null 时藏起来
  placeShadow(seaY: number | null, sunDir: THREE.Vector3): void {
    if (!this.shadow) {
      this.shadow = new THREE.Mesh(shadowGeometry(), shadowMaterial(this.fade));
      this.shadow.name = 'planet-sea-shadow';
      this.shadow.renderOrder = -8; // 云海（-10）、远处积云（-9）之后
      this.shadow.frustumCulled = false;
      this.group.add(this.shadow);
    }
    const parent = this.group.parent;
    if (seaY === null || !parent) {
      this.shadow.visible = false;
      return;
    }
    parent.getWorldPosition(_p);
    const scale = parent.getWorldScale(_s).x || 1;
    const gap = Math.max(0, _p.y - this.radius * scale - seaY);
    // 离太阳的方向（水平）：影子往背着太阳的那边挪一点（太阳低，挪得多，但封顶，不然影子跑远了认不出是谁的）
    _h.set(-sunDir.x, 0, -sunDir.z);
    if (_h.lengthSq() < 1e-6) _h.set(0, 0, 1);
    _h.normalize().multiplyScalar(Math.min(gap * 0.3, this.radius * scale * 0.5));
    this.shadow.position.set(_h.x / scale, (seaY - _p.y) / scale, _h.z / scale);
    // 越高越大越淡
    const spread = 1.35 + Math.min(0.8, gap / (this.radius * scale * 3));
    this.shadow.scale.set(this.radius * spread, 1, this.radius * spread * 1.15);
    this.shadow.rotation.y = Math.atan2(_h.x, _h.z);
    this.shadow.visible = true;
  }

  // 每帧：石头带慢慢转，小浮岛上下浮动
  animate(dt: number): void {
    this.time += dt;
    if (this.belt) this.belt.rotation.y += dt * 0.03 * GALAXY_DECOR.beltSpeed;
    for (const it of this.islands) {
      it.mesh.position.y = it.base.y + Math.sin(this.time * 0.5 + it.phase) * this.radius * 0.02;
      it.mesh.rotation.y += dt * 0.02;
    }
  }

  // 镜头离这颗星球多远（× 星球半径，按星球组的缩放）
  distanceInRadii(camPos: THREE.Vector3): number {
    this.group.getWorldPosition(_p);
    return _p.distanceTo(camPos) / (this.radius * this.group.getWorldScale(_s).x);
  }

  // 石头带、小浮岛（不透明，不能跟着淡出）：别的星球被聚焦时藏起来。石头带还受光环浓淡管（PlanetObject.setRingStrength）
  setSolidsVisible(on: boolean): void {
    if (this.belt) this.belt.visible = on;
    for (const it of this.islands) it.mesh.visible = on;
  }

  dispose(): void {
    parts.delete(this);
    for (const m of [this.atmosphere, this.clouds]) {
      if (!m) continue;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.belt?.dispose();
    this.islandMaterial?.dispose();
    this.group.removeFromParent();
  }
}

const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _h = new THREE.Vector3();

// ?tune 的「Copy parameters」里带上这几张表
export function planetLookParams(): Record<string, unknown> {
  return { look: PLANET_LOOK, galaxy: GALAXY_DECOR, rim: RIM, edge: RIM_RING, rimWall: DECOR.rimWall };
}

// ?tune 面板（tune.ts 调一次）：Planet 组里加「Look from afar」：俯瞰的草甸层次、外沿和舞台的边、云层、大气、石头带
interface TuneEvents {
  on(event: 'change', handler: () => void): unknown;
}
export interface TuneFolder extends TuneEvents {
  addFolder(params: { title: string; expanded?: boolean }): TuneFolder;
  addBinding<T extends object>(target: T, key: keyof T & string, params?: Record<string, unknown>): TuneEvents;
}

export function installPlanetLookTune(folder: TuneFolder, rebuildRocks: () => void): void {
  const f = folder.addFolder({ title: 'Look from afar', expanded: false });
  const meadow = f.addFolder({ title: 'Meadow from above', expanded: false });
  meadow.addBinding(GROUND, 'farMix', { label: 'spring green', min: 0, max: 1, step: 0.01 });
  meadow.addBinding(GROUND, 'farTint', { label: 'brightness', min: 0.05, max: 1, step: 0.01 });
  meadow.addBinding(GROUND, 'fieldSun', { label: 'sunny fields', min: 0, max: 1, step: 0.01 });
  meadow.addBinding(GROUND, 'fieldDeep', { label: 'deep hollows', min: 0, max: 1, step: 0.01 });
  meadow.addBinding(GROUND, 'fieldFlowers', { label: 'flower fields', min: 0, max: 2, step: 0.01 });
  meadow.addBinding(GROUND, 'warmCool', { label: 'warm / cool', min: 0, max: 2, step: 0.01 });
  meadow.on('change', () => applyGround());
  const rim = f.addFolder({ title: 'Stage rim', expanded: false });
  rim.addBinding(RIM, 'center', { label: 'band latitude (sin)', min: -0.3, max: 0.4, step: 0.005 });
  rim.addBinding(RIM, 'half', { label: 'band half width', min: 0, max: 0.3, step: 0.005 });
  rim.addBinding(RIM_RING, 'angle', { label: 'edge ring angle°', min: 40, max: 90, step: 0.5 });
  rim.addBinding(RIM_RING, 'width', { label: 'edge ring width°', min: 0, max: 15, step: 0.1 });
  rim.addBinding(DECOR, 'rimWall', { label: 'rim boulders ×', min: 0, max: 3, step: 0.05 });
  rim.on('change', () => {
    applyGround();
    rebuildRocks();
  });
  const sky = f.addFolder({ title: 'Clouds & air', expanded: false });
  sky.addBinding(PLANET_LOOK, 'clouds', { label: 'cloud cover', min: 0, max: 1, step: 0.01 });
  sky.addBinding(PLANET_LOOK, 'cloudOpacity', { label: 'cloud opacity', min: 0, max: 1, step: 0.01 });
  sky.addBinding(PLANET_LOOK, 'cloudBrightness', { label: 'cloud brightness', min: 0.1, max: 1.5, step: 0.01 });
  sky.addBinding(PLANET_LOOK, 'cloudSpeed', { label: 'cloud drift', min: 0, max: 6, step: 0.05 });
  sky.addBinding(PLANET_LOOK, 'cloudShadow', { label: 'cloud shadows', min: 0, max: 1, step: 0.01 });
  sky.addBinding(PLANET_LOOK, 'atmosphere', { label: 'atmosphere', min: 0, max: 3, step: 0.01 });
  sky.addBinding(PLANET_LOOK, 'atmosphereWarm', { label: 'dusk tint' });
  sky.addBinding(PLANET_LOOK, 'limbHaze', { label: 'edge haze', min: 0, max: 2, step: 0.01 });
  sky.addBinding(GALAXY_DECOR, 'beltSpeed', { label: 'rock belt spin', min: 0, max: 5, step: 0.05 });
  sky.addBinding(PLANET_LOOK, 'seaShadow', { label: 'shadow on cloud sea', min: 0, max: 1.5, step: 0.01 });
  sky.addBinding(PLANET_LOOK, 'rimLight', { label: 'rim light (galaxy)', min: 0, max: 3, step: 0.01 });
  const team = f.addFolder({ title: 'Team colours', expanded: false });
  team.addBinding(GROUND, 'teamCover', { label: 'cover (planet view)', min: 0, max: 1, step: 0.01 });
  team.addBinding(GROUND, 'teamCoverGalaxy', { label: 'cover (galaxy)', min: 0, max: 1, step: 0.01 });
  team.addBinding(GROUND, 'teamBright', { label: 'brightness', min: 0.2, max: 3, step: 0.01 });
  team.on('change', () => applyGround());
  sky.on('change', () => applyPlanetLook());
}

// World 每帧调：太阳方向、云层转动、各星球远看部件的开关。focused：聚焦的那颗星球的远看部件（星系视图里是 null）。
// 镜头离星球近（星球视图、漫游）：这颗的远看部件藏起来（大气外壳会盖满整个屏幕）。
// 有星球被聚焦时，别的星球的云层、大气、云影约 0.5 秒淡出：星球视图里邻居缩小后沉在云海的雾里，
// 星球本身被雾吃掉了，不受雾影响的大气外壳会剩下一个个透明的泡泡
// atmo：天空（星系视图里云海压在所有星球下面），按它算云面的高度，给星球在云海上的影子用；null = 不画影子
export function updatePlanetLook(dt: number, sunDir: THREE.Vector3, camera: THREE.Camera, focused: PlanetLookParts | null = null, atmo: Atmosphere | null = null): void {
  // 云面：云海圆盘放在「云底 + 厚度 + 堆云 + 0.5」（atmosphere.ts 的 discTop），云顶的平均高度在云底以上 0.6 个厚度
  let seaY: number | null = null;
  if (atmo && atmo.objects.sea.visible) seaY = atmo.objects.sea.position.y - PLANET_RADIUS * (0.45 + 0.4 * atmo.params.seaThickness) - 0.5;
  U.sun.value.copy(sunDir);
  U.drift.value = (U.drift.value + dt * 0.012 * PLANET_LOOK.cloudSpeed) % (Math.PI * 2);
  const k = 1 - Math.exp(-6 * dt);
  // 工地：镜头越远放得越大（离星球中心 6 个半径以内原大小，星系里最多 3 倍）
  for (const s of sites) {
    const host = s.parent;
    if (!host) continue;
    host.getWorldPosition(_p);
    const kd = _p.distanceTo(camera.position) / (PLANET_RADIUS * (host.getWorldScale(_s).x || 1));
    s.scale.setScalar(THREE.MathUtils.clamp(kd / 5, 1, 4.5));
  }
  for (const p of parts) {
    if (!p.group.parent?.parent) continue; // 不在场景里的星球（换团队列表时摘掉的）：不管
    const goal = focused && focused !== p ? 0 : 1;
    const now = p.fade.value;
    p.fade.value = Math.abs(goal - now) < 0.01 ? goal : now + (goal - now) * k;
    p.group.visible = p.fade.value > 0 && p.distanceInRadii(camera.position) > NEAR_HIDE;
    if (p.group.visible) {
      p.animate(dt);
      p.placeShadow(focused ? null : seaY, sunDir);
    }
    // 石头带、小浮岛是不透明的，不能跟着淡：淡到一半就藏起来
    p.setSolidsVisible(p.fade.value > 0.5);
  }
}
