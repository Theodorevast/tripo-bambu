import * as THREE from 'three/webgpu';
import { cameraPosition, color, dot, float, Fn, If, length, max, mix, modelPosition, modelScale, normalize, positionWorld, pow, renderGroup, saturate, smoothstep, uniform, vec3 } from 'three/tsl';
import { valueNoise3 } from '../planet/tslNoise';

// 星球远看的样子（planet 角色）：大气光晕、慢慢转的云层、云在地面上的影子、星球表面边缘的一层空气。
// 都是「远看才有」的东西：镜头离星球近（星球视图、漫游）时整个藏起来，不占填充率。
// 风格：绘本里的星球——空气是一圈很淡、带一点暖色的晕，不是发光的科幻边；云是一团团压暗过的奶白，按真实的太阳和天光打光。
// 配方来自《14-星球视觉效果》：大气强度要远比直觉小；云要压暗（× 0.6 左右）；昼夜分界附近乘一点暖色

// 可调参数（?tune → Planet → Look from afar）。改了以后调 applyPlanetLook()
export const PLANET_LOOK = {
  atmosphere: 1, // 大气光晕的浓度倍数
  atmosphereWarm: '#ffb28a', // 晨昏线附近的暖色
  limbHaze: 0.5, // 星球表面靠边缘的那层空气（远看才有）
  clouds: 0.3, // 云量 0..1
  cloudOpacity: 0.82,
  cloudBrightness: 0.72, // 云的反照率：压暗，不然在亮天空下是一片死白
  cloudSpeed: 1, // 云层转动的速度倍数
  cloudShadow: 0.3, // 云影的深度
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
};

export function applyPlanetLook(): void {
  U.atmosphere.value = PLANET_LOOK.atmosphere;
  U.warm.value.set(PLANET_LOOK.atmosphereWarm);
  U.limbHaze.value = PLANET_LOOK.limbHaze;
  U.clouds.value = PLANET_LOOK.clouds;
  U.cloudOpacity.value = PLANET_LOOK.cloudOpacity;
  U.cloudBrightness.value = PLANET_LOOK.cloudBrightness;
  U.cloudShadow.value = PLANET_LOOK.cloudShadow;
}

// 镜头离星球中心多远（× 星球半径）以内，云层、大气光晕、表面的空气都不画：
// 星球视图在 2.6 倍（shots.ts），漫游贴着地面；星系里镜头在几十倍以外
export const NEAR_HIDE = 3.2;
export const FAR_FULL = 5; // 到这里完全显出来

type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

// 镜头离这颗星球中心多远，按星球半径算（星球组可能被缩放：星球视图里的邻居缩到 0.45）
const camDistanceInRadii = (radius: number | F): F => length(cameraPosition.sub(modelPosition)).div(modelScale.x.mul(radius));

// 云的覆盖率（0..1）：星球本地方向 dir 先绕竖轴转过 drift，再做一次扭曲坐标的四层值噪声。
// offset 让每颗星球的云不一样（按种子）。
// 写成带 layout 的函数（着色器里只生成一份）；uniform 不能在函数体里直接引用（函数体各材质共用，uniform 的名字对不上），
// 转动角度和云量当参数传进去
const cloudCoverFn = Fn(([dir, offset, drift, amount]: [V3, V3, F, F]) => {
  const c = drift.cos();
  const s = drift.sin();
  const d = vec3(dir.x.mul(c).sub(dir.z.mul(s)), dir.y, dir.x.mul(s).add(dir.z.mul(c)));
  const q = d.mul(3.1).add(offset);
  const w = vec3(valueNoise3(q.mul(0.7).add(1.3)), valueNoise3(q.mul(0.7).add(7.9)), valueNoise3(q.mul(0.7).add(4.2))).sub(0.5);
  const p = q.add(w.mul(0.55));
  const n = valueNoise3(p).mul(0.52).add(valueNoise3(p.mul(2.3).add(3.3)).mul(0.26)).add(valueNoise3(p.mul(5.1).add(9.1)).mul(0.14)).add(valueNoise3(p.mul(10.7).add(5.5)).mul(0.08));
  // 纬度越高云越少一点（赤道附近成带），云量 0..1 把阈值往下推
  const th = float(0.64).sub(amount.mul(0.2)).add(d.y.abs().mul(0.05));
  return smoothstep(th, th.add(0.12), n);
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
  const haze = mix(tint, U.warm, smoothstep(0.45, 0.0, mu).mul(lit).mul(0.6)).mul(edge.mul(lit).mul(U.limbHaze).mul(far).mul(0.35));
  return { shade, haze };
}

// 「俯瞰」系数 0..1：镜头离星球中心 1.4 个半径以内（漫游、贴地）是 0，2 个半径以外（星球视图、星系）是 1。
// 地表着色器里只在俯瞰时才有的东西（一片片的草色、花田、冷暖）乘它：贴地时交给 3D 的草和花，地面颜色和草叶对得上
export const overviewFactor = (radius: number | F): F => smoothstep(1.4, 2.0, camDistanceInRadii(radius));

// 「舞台」系数 0..1：星球视图（2.6 个半径）和漫游时是 1，星系里（几十个半径以外）是 0。
// 外沿那一圈石头地只在聚焦时画：星系里一圈石头带在每颗星球上都像一条腰带，不好看
export const stageFactor = (radius: number | F): F => smoothstep(7, 4.5, camDistanceInRadii(radius));

// 冷暖：朝太阳的一侧偏暖（黄一点），背光、晨昏线以外偏冷（蓝紫一点）。n 是球面法线（世界坐标）；返回乘在颜色上的系数
export function sunTint(n: V3, amount: F | number): V3 {
  const mu = dot(n, U.sun);
  const k = smoothstep(-0.3, 0.9, mu);
  return mix(vec3(1, 1, 1), mix(vec3(0.86, 0.93, 1.1), vec3(1.12, 1.03, 0.84), k), amount);
}

export const sunDirNode = (): V3 => U.sun;

// —— 每颗星球的远看部件（PlanetObject 建、World 每帧按镜头距离开关）——
const parts = new Set<PlanetLookParts>();

export interface PlanetLookOptions {
  radius: number; // 星球半径（本地单位）
  top: number; // 地形最高处（本地单位）
  seed: number;
  tint: THREE.ColorRepresentation; // 大气的颜色
  atmosphere: boolean;
  haloStrength: THREE.UniformNode<'float', number>; // 大气光晕的浓淡（World 在星球视图里把聚焦的那颗压淡）
}

export class PlanetLookParts {
  readonly group = new THREE.Group();
  readonly cloudOffset = uniform(new THREE.Vector3());
  // 0..1：别的星球被聚焦时淡出（云层、大气、地面上的云影一起），回星系淡回来。updatePlanetLook 逐帧逼近
  readonly fade = uniform(1);
  radius = 1;
  private atmosphere: THREE.Mesh | null = null;
  private clouds: THREE.Mesh | null = null;

  constructor() {
    this.group.name = 'planet-look';
    parts.add(this);
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
      this.atmosphere = new THREE.Mesh(new THREE.IcosahedronGeometry(shell, 8), atmosphereRimMaterial(o.tint, o.radius, shell, o.haloStrength, o.seed, this.fade));
      this.atmosphere.name = 'planet-atmosphere';
      this.atmosphere.renderOrder = 1;
      this.group.add(this.atmosphere);
    }
  }

  // 镜头离这颗星球多远（× 星球半径，按星球组的缩放）
  distanceInRadii(camPos: THREE.Vector3): number {
    this.group.getWorldPosition(_p);
    return _p.distanceTo(camPos) / (this.radius * this.group.getWorldScale(_s).x);
  }

  dispose(): void {
    parts.delete(this);
    for (const m of [this.atmosphere, this.clouds]) {
      if (!m) continue;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.group.removeFromParent();
  }
}

const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

// World 每帧调：太阳方向、云层转动、各星球远看部件的开关。focused：聚焦的那颗星球的远看部件（星系视图里是 null）。
// 镜头离星球近（星球视图、漫游）：这颗的远看部件藏起来（大气外壳会盖满整个屏幕）。
// 有星球被聚焦时，别的星球的云层、大气、云影约 0.5 秒淡出：星球视图里邻居缩小后沉在云海的雾里，
// 星球本身被雾吃掉了，不受雾影响的大气外壳会剩下一个个透明的泡泡
export function updatePlanetLook(dt: number, sunDir: THREE.Vector3, camera: THREE.Camera, focused: PlanetLookParts | null = null): void {
  U.sun.value.copy(sunDir);
  U.drift.value = (U.drift.value + dt * 0.012 * PLANET_LOOK.cloudSpeed) % (Math.PI * 2);
  const k = 1 - Math.exp(-6 * dt);
  for (const p of parts) {
    if (!p.group.parent?.parent) continue; // 不在场景里的星球（换团队列表时摘掉的）：不管
    const goal = focused && focused !== p ? 0 : 1;
    const now = p.fade.value;
    p.fade.value = Math.abs(goal - now) < 0.01 ? goal : now + (goal - now) * k;
    p.group.visible = p.fade.value > 0 && p.distanceInRadii(camera.position) > NEAR_HIDE;
  }
}
