import * as THREE from 'three/webgpu';
import type { ModelLibrary } from '../assets/models';
import { easeOutBack } from '../scenes/ease';
import { createStandIn } from '../scenes/mascot';
import type { PlanetEntry } from '../scenes/world';
import { localTribooUrl } from '../play/localAsset';
import { CHAR_HEIGHT } from '../play/params';
import type { TribooPose } from './couponsMath';

// 站桩的翠宝（coupons）：「你的星球」上、作品前面的草地上站着一个翠宝（向导），面朝镜头、轻轻呼吸，点它就吐券。
// 模型和漫游的角色是同一个：本机有翠宝的 GLB 就从 PlanetView 的 ModelLibrary 克隆一份（几何、材质、贴图共用，着色器不用再编一遍），
// 没有就用 mascot.ts 代码拼的替身。身高按 CHAR_HEIGHT（1 米）；星球视图里镜头离得远，和作品一样按「地标放大」放大。
// 根节点叫 walker：post.ts 的接触阴影按这个名字认翠宝（星球组里名叫 walker 的孩子），脚下一圈草地跟着暗一点

const UP = new THREE.Vector3(0, 1, 0);
const APPEAR_SECONDS = 0.4;
const LEAVE_SECONDS = 0.2;
const BREATH_SECONDS = 3.4;

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _r = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _c = new THREE.Vector3();
const _e = new THREE.Euler();

export interface StandModel {
  object: THREE.Object3D; // 脚底在 y = 0，正面朝 +Z，身高 1（已经缩放好）
  logo: (k: number) => void; // logo 亮度 0..1（× COUPONS.glow 由调用方乘好）
}

// logo 亮一下的开关：GLB 是 Logo_V / Logo_T 两块独立的几何（自发光 = 原色 × k），替身是身体材质里的 uniform（mascot.ts）
export function logoGlow(root: THREE.Object3D): (k: number) => void {
  const mats: Array<{ m: THREE.MeshStandardMaterial; base: THREE.Color; color: THREE.Color }> = [];
  const uniforms: Array<{ value: number }> = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of list) {
      const u = (m.userData as { logoGlow?: { value: number } }).logoGlow;
      if (u && !uniforms.includes(u)) uniforms.push(u);
      const std = m as THREE.MeshStandardMaterial;
      if (/^Logo_/i.test(mesh.name) && std.emissive && !mats.some((x) => x.m === std)) {
        mats.push({ m: std, base: std.emissive.clone(), color: std.color.clone() });
      }
    }
  });
  let last = -1;
  return (k: number) => {
    if (k === last) return;
    last = k;
    for (const u of uniforms) u.value = k;
    for (const x of mats) x.m.emissive.copy(x.base).lerp(x.color, Math.min(1, k)).multiplyScalar(Math.max(1, k));
  };
}

export async function loadStandModel(library: ModelLibrary): Promise<StandModel> {
  let object: THREE.Object3D | null = null;
  let height = 1;
  const url = await localTribooUrl().catch(() => null);
  if (url) {
    const model = await library.load({ id: 'coupon-stand', file: new URL(url, location.href).href });
    if (!model.failed) {
      object = model.object;
      height = model.height;
    }
  }
  if (!object) {
    const s = createStandIn();
    object = s.object;
    height = s.height;
  }
  // 和漫游的角色一样投影（共用材质、同样的开关：管线是同一份）
  object.traverse((o) => { o.castShadow = true; });
  object.scale.multiplyScalar(CHAR_HEIGHT / height);
  const wrap = new THREE.Group();
  wrap.add(object);
  return { object: wrap, logo: logoGlow(wrap) };
}

// 落点：星球视图镜头正对的那一块地往作品那边一点，避开水、土路、小溪、作品四周；同样合适时挑离偏好的位置近的。
// view：镜头方向（星球本地坐标的单位向量），upOnScreen：画面上方在那里的切向，works：作品的方向
export interface SpotGround {
  radius: number;
  sea: number;
  height(x: number, y: number, z: number): number;
  exclude(dir: THREE.Vector3): number;
}

export function chooseSpot(ground: SpotGround, view: THREE.Vector3, upOnScreen: THREE.Vector3, works: THREE.Vector3[], minClear = 6): THREE.Vector3 {
  const right = new THREE.Vector3().crossVectors(upOnScreen, view).normalize();
  const up = new THREE.Vector3().crossVectors(view, right).normalize();
  const d = new THREE.Vector3();
  const best = view.clone();
  let bestScore = -Infinity;
  for (const relax of [0, 1, 2]) {
    const clear = relax === 0 ? minClear : relax === 1 ? minClear * 0.65 : 0;
    for (let ti = 0; ti <= 8; ti++) {
      const theta = THREE.MathUtils.degToRad(2 + ti * 3);
      for (let pi = -6; pi <= 6; pi++) {
        const phi = THREE.MathUtils.degToRad(pi * 12);
        d.copy(view).multiplyScalar(Math.cos(theta))
          .addScaledVector(up, Math.sin(theta) * Math.cos(phi))
          .addScaledVector(right, Math.sin(theta) * Math.sin(phi))
          .normalize();
        const h = ground.height(d.x, d.y, d.z);
        if (ground.sea > 0 && h < ground.sea + 0.08) continue;
        if (relax < 2 && ground.exclude(d) > (relax === 0 ? 0.05 : 0.3)) continue;
        let near = Infinity;
        for (const w of works) near = Math.min(near, d.angleTo(w) * ground.radius);
        if (near < clear) continue;
        // 偏好：比镜头正对的地方往作品那边 10° 左右、画面上稍微偏左；离作品远一点更好（券有地方落）
        const score = -Math.abs(THREE.MathUtils.radToDeg(theta) - 11) * 0.35 - Math.abs(pi + 1.5) * 0.25 + Math.min(near, 14) * 0.2;
        if (score > bestScore) {
          bestScore = score;
          best.copy(d);
        }
      }
    }
    if (bestScore > -Infinity) break;
  }
  return best;
}

export class TribooStand {
  readonly root = new THREE.Group(); // 挂在星球组下：位置、朝向、放大、姿态都在这一层
  readonly dir = new THREE.Vector3(0, 1, 0); // 站的方向（星球本地坐标）
  model: StandModel | null = null;
  entry: PlanetEntry | null = null;
  private groundR = 1; // 脚底离星球中心（星球本地）
  private readonly facing = new THREE.Vector3(0, 0, 1); // 面朝（切向，星球本地）：慢慢转向镜头
  private appear = 0;
  private leaving = false;
  private time = 0;
  scale = 1; // 这一帧的放大倍数（地标放大 × boost），外面读：券、彩屑跟着一样大

  constructor() {
    this.root.name = 'walker';
    this.root.visible = false;
  }

  setModel(model: StandModel): void {
    this.model = model;
    this.root.clear();
    this.root.add(model.object);
  }

  get shown(): boolean {
    return this.root.visible && !this.leaving;
  }

  // 站到 entry 这颗星球的 dir 上，面朝 toward（星球本地的方向，比如镜头）。从小长大地出场
  show(entry: PlanetEntry, dir: THREE.Vector3, toward: THREE.Vector3): void {
    this.entry = entry;
    this.dir.copy(dir).normalize();
    const planet = entry.planet;
    this.groundR = Math.max(planet.height(this.dir.x, this.dir.y, this.dir.z), planet.sea);
    this.facing.copy(toward).addScaledVector(this.dir, -toward.dot(this.dir));
    if (this.facing.lengthSq() < 1e-8) this.facing.set(0, 0, 1).addScaledVector(this.dir, -this.dir.z);
    this.facing.normalize();
    if (this.root.parent !== planet.group) planet.group.add(this.root);
    if (!this.root.visible || this.leaving) this.appear = 0;
    this.leaving = false;
    this.root.visible = true;
  }

  // 缩小退场；immediately：立刻摘掉（离开星球）
  hide(immediately = false): void {
    if (immediately) {
      this.leaving = false;
      this.appear = 0;
      this.root.visible = false;
      this.root.removeFromParent();
      this.entry = null;
      return;
    }
    if (this.root.visible) this.leaving = true;
  }

  // 每帧：位置、朝向、放大、呼吸，再叠上 pose（吐券、摇头、悬停）。hero：地标放大；camLocal：镜头在星球本地的位置
  update(dt: number, hero: number, camLocal: THREE.Vector3, pose: TribooPose, track: boolean): void {
    if (!this.root.visible) return;
    this.time += dt;
    if (this.leaving) {
      this.appear = Math.max(0, this.appear - dt / LEAVE_SECONDS);
      if (this.appear === 0) {
        this.hide(true);
        return;
      }
    } else {
      this.appear = Math.min(1, this.appear + dt / APPEAR_SECONDS);
    }
    const grow = this.leaving ? this.appear * this.appear : Math.max(0.001, easeOutBack(this.appear, 1.6));
    // 慢慢转向镜头（切平面里，绕法线转）：吐券的时候不转，免得券飞出去的方向跟着变
    if (track) {
      _c.copy(camLocal).sub(_p.copy(this.dir).multiplyScalar(this.groundR));
      _c.addScaledVector(this.dir, -_c.dot(this.dir));
      if (_c.lengthSq() > 1e-6) {
        _c.normalize();
        const angle = Math.atan2(_z.crossVectors(this.facing, _c).dot(this.dir), this.facing.dot(_c));
        _r.setFromAxisAngle(this.dir, angle * (1 - Math.exp(-2.2 * dt)));
        this.facing.applyQuaternion(_r).addScaledVector(this.dir, -this.facing.dot(this.dir)).normalize();
      }
    }
    this.scale = hero;
    const s = hero * grow;
    // 底座：+Y = 球面法线，+Z = 面朝
    _x.crossVectors(this.dir, this.facing);
    _m.makeBasis(_x, this.dir, this.facing);
    _q.setFromRotationMatrix(_m);
    _e.set(pose.pitch, pose.yaw, pose.roll, 'YZX');
    _r.setFromEuler(_e);
    this.root.quaternion.copy(_q).multiply(_r);
    const b = Math.sin((this.time / BREATH_SECONDS) * Math.PI * 2) * 0.022;
    this.root.scale.set(s * pose.sxz * (1 - b * 0.5), s * pose.sy * (1 + b), s * pose.sxz * (1 - b * 0.5));
    this.root.position.copy(this.dir).multiplyScalar(this.groundR)
      .addScaledVector(this.dir, pose.lift * CHAR_HEIGHT * s)
      .addScaledVector(_x, pose.jitter * CHAR_HEIGHT * s);
  }

  // 脚下的坐标系（世界坐标）：原点在脚底，up 法线，fwd 面朝，right = up × fwd（面朝镜头时是画面上的右）
  frame(origin: THREE.Vector3, up: THREE.Vector3, fwd: THREE.Vector3, right: THREE.Vector3): void {
    const g = this.entry!.planet.group;
    origin.copy(this.dir).multiplyScalar(this.groundR).multiplyScalar(g.scale.x).add(g.position);
    up.copy(this.dir);
    fwd.copy(this.facing);
    right.crossVectors(up, fwd).normalize();
  }

  // 身体（球）的中心（世界坐标）和半径：拾取、嘴的位置都按它
  body(center: THREE.Vector3): number {
    const g = this.entry!.planet.group;
    const s = this.scale * g.scale.x;
    center.copy(this.dir).multiplyScalar(this.groundR * g.scale.x).add(g.position).addScaledVector(this.dir, 0.62 * CHAR_HEIGHT * s);
    return 0.42 * CHAR_HEIGHT * s;
  }

  static readonly UP = UP;
}
