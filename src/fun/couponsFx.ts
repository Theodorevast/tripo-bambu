import * as THREE from 'three/webgpu';
import {
  Discard,
  Fn,
  abs,
  attribute,
  cameraFar,
  cameraNear,
  cameraViewMatrix,
  cos,
  cross,
  dot,
  exp,
  faceDirection,
  float,
  frontFacing,
  max,
  mix,
  normalize,
  perspectiveDepthToViewZ,
  positionGeometry,
  pow,
  renderGroup,
  sRGBTransferOETF,
  screenUV,
  select,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { mulberry32 } from '../planet/rng';
import { ATLAS_ROWS, BACK_ROW } from './couponsArt';

// 券和彩屑的 3D 部分（coupons）。都是「一个网格、一次绘制」，对象池固定大小，热路径里不新建对象：
// - TicketMesh：券。每张的位置、朝向、大小、不透明度、发光、飘动由 CPU 每帧写进实例属性（最多 CAPACITY 张），
//   顶点着色器按四元数转、按纸的弯曲和飘动挪顶点；券面从图集里按行取（正面按种类，背面是同一行背面图）。
//   不受光照（像印出来的纸，在哪都看得清），按太阳方向有一点明暗，跟场景一样吃雾
// - GlowDiscs：浮着的券脚下草地上一小圈暖光（叠加混合，草叶会挡住一部分，像光从草缝里透出来）
// - Sparks：一团彩屑和星星。和 decorFx.ts 的扬尘一样：发射时 CPU 往环形缓冲写出生点、初速度、寿命，之后整个寿命都在
//   顶点着色器里按年龄算（带阻力和重力的抛体），CPU 不逐粒更新；彩屑是在空中翻的小纸片，星星是对着镜头的四角星

export const CAPACITY = 16; // 同时最多几张券（冷却 3 秒、浮 10 秒：一直点也就十来张；再多就收走最早落地的）
const SPARK_SLOTS = 128;

type V4 = THREE.Node<'vec4'>;

function dynamic(n: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

// 用四元数 q 转 v：v + w·t + q.xyz × t，t = 2·(q.xyz × v)
function rotate(q: V4, v: THREE.Node<'vec3'>): THREE.Node<'vec3'> {
  const t = cross(q.xyz, v).mul(2);
  return v.add(t.mul(q.w)).add(cross(q.xyz, t));
}

// 光照用的共享 uniform（每帧由 coupons.ts 按太阳方向、傍晚系数、雨量算好；和生机层 life.ts 的粒子同一套：环境光 + 太阳 × 包裹漫反射）
export const COUPON_LIGHT = {
  sunDir: uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup),
  sunCol: uniform(new THREE.Vector3(0.85, 0.8, 0.71)).setGroup(renderGroup),
  ambCol: uniform(new THREE.Vector3(0.55, 0.62, 0.72)).setGroup(renderGroup),
  time: uniform(0).setGroup(renderGroup),
};

// 券画在不调色的那一层（F2，scenes/post.ts 的 UngradedLayer）：1 = 在那一层（颜色是券面原样的显示颜色，自己按场景深度裁掉被挡住的部分），
// 0 = 在主场景里照常过调色（?look=0 关掉后处理时）。coupons.ts 每帧按后处理开没开设
export const TICKET_LAYER = { on: uniform(0).setGroup(renderGroup) };

const SUN_DAY = new THREE.Color(1, 0.94, 0.84);
const SUN_DUSK = new THREE.Color(1, 0.58, 0.32);
const AMB_DAY = new THREE.Color(0.55, 0.62, 0.72);
const AMB_DUSK = new THREE.Color(0.38, 0.32, 0.46);
const _col = new THREE.Color();

// 每帧：太阳方向、傍晚系数（0 白天 … 0.6 日落）、雨量 → 光的颜色（和 life.ts 的 updateLight 同样的配方）
export function updateCouponLight(sunDir: THREE.Vector3, evening: number, rain: number, time: number): void {
  COUPON_LIGHT.sunDir.value.copy(sunDir);
  _col.copy(SUN_DAY).lerp(SUN_DUSK, THREE.MathUtils.smoothstep(evening, 0.2, 0.75)).multiplyScalar((1 - 0.65 * rain) * 0.85);
  COUPON_LIGHT.sunCol.value.set(_col.r, _col.g, _col.b);
  _col.copy(AMB_DAY).lerp(AMB_DUSK, Math.min(1, evening / 0.6)).multiplyScalar(1 - 0.25 * rain);
  COUPON_LIGHT.ambCol.value.set(_col.r, _col.g, _col.b);
  COUPON_LIGHT.time.value = time;
}

export class TicketMesh {
  readonly mesh: THREE.Mesh;
  readonly atlas: THREE.CanvasTexture;
  private readonly pos = dynamic(CAPACITY); // 世界坐标 xyz，大小（长边，米）
  private readonly rot = dynamic(CAPACITY); // 朝向（四元数）
  private readonly fx = dynamic(CAPACITY); // 不透明度、发光、飘动幅度、飘动相位
  private readonly info = dynamic(CAPACITY); // 图集的行、悬停高亮、弯曲、发光闪烁的相位
  private dirty = false;

  // sceneDepth：场景缓冲的深度（画在不调色那一层时按它裁掉被挡住的部分）；没有时不裁
  constructor(atlasCanvas: HTMLCanvasElement, sceneDepth: THREE.DepthTexture | null = null) {
    const plane = new THREE.PlaneGeometry(1, 0.5, 16, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(plane.getIndex());
    g.setAttribute('position', plane.getAttribute('position'));
    g.setAttribute('uv', plane.getAttribute('uv'));
    g.setAttribute('normal', plane.getAttribute('normal'));
    g.setAttribute('aPos', this.pos);
    g.setAttribute('aRot', this.rot);
    g.setAttribute('aFx', this.fx);
    g.setAttribute('aInfo', this.info);
    g.instanceCount = CAPACITY;
    this.atlas = new THREE.CanvasTexture(atlasCanvas);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.atlas.anisotropy = 8;
    this.atlas.name = 'coupon-atlas';

    const P = attribute<'vec4'>('aPos', 'vec4');
    const Q = attribute<'vec4'>('aRot', 'vec4');
    const FX = attribute<'vec4'>('aFx', 'vec4');
    const INFO = attribute<'vec4'>('aInfo', 'vec4');
    const x = positionGeometry.x;
    // 纸的弯：两头往后翘一点（静态）+ 飘的时候沿长边的波（越靠两头越大）
    const bend = INFO.z.mul(x.mul(x).mul(4).sub(0.33)).mul(0.07).add(FX.z.mul(sin(x.mul(9).add(FX.w))).mul(abs(x).mul(2)));
    const local = vec3(x, positionGeometry.y, bend);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: true });
    m.name = 'coupon-ticket';
    // 一张纸、一遍画完：不让 three 把「半透明 + 双面」拆成背面、正面两遍（两遍各要一条管线，一张纸也没有前后遮挡要分）
    m.forceSinglePass = true;
    const world = P.xyz.add(rotate(Q, local).mul(P.w));
    m.positionNode = world;
    const viewZ = varying(cameraViewMatrix.mul(vec4(world, 1)).z, 'vCouponViewZ');
    const normal = varying(rotate(Q, vec3(0, 0, 1)), 'vCouponNormal');
    // 正面按种类取一行；背面取背面那一行，横向镜像（从背后看，字是正的）
    const front = frontFacing;
    const u = select(front, uv().x, float(1).sub(uv().x));
    const row = select(front, INFO.x, float(BACK_ROW));
    const atlasUv = vec2(u, uv().y.add(float(ATLAS_ROWS - 1).sub(row)).div(ATLAS_ROWS));
    const tex = texture(this.atlas, atlasUv);
    // 受光：环境光 + 太阳 × 包裹漫反射（纸薄，背光的一面也不发黑）
    const ndl = dot(normalize(normal).mul(faceDirection), COUPON_LIGHT.sunDir).add(0.45).div(1.45).clamp(0, 1);
    const lit = COUPON_LIGHT.ambCol.add(COUPON_LIGHT.sunCol.mul(ndl));
    // 发光：落地后微微发光（慢慢一明一暗），悬停时更亮
    const pulse = sin(COUPON_LIGHT.time.mul(2.6).add(INFO.w)).mul(0.3).add(0.7);
    const glow = FX.y.mul(pulse).mul(0.32).add(INFO.y.mul(0.3));
    // 不调色的那一层（F2）：券面原样的显示颜色（翠宝黄就是 #F2B705），背光的一面略暗、发光时略亮；被场景挡住的部分裁掉
    const display = sRGBTransferOETF(tex.rgb) as unknown as THREE.Node<'vec3'>; // 类型声明里是 Node：按 vec3 用
    const ungraded = display.mul(mix(float(0.86), float(1), ndl).add(glow.mul(0.15))).clamp(0, 1);
    const depthCut = sceneDepth ? texture(sceneDepth, screenUV).r : null;
    m.colorNode = Fn(() => {
      if (depthCut) {
        // 场景在这个像素上的面比券离镜头近（留 5 厘米 + 千分之一的距离余量）就裁掉
        const sceneZ = perspectiveDepthToViewZ(depthCut, cameraNear, cameraFar);
        Discard(TICKET_LAYER.on.greaterThan(0.5).and(sceneZ.greaterThan(viewZ.add(viewZ.negate().mul(0.001).add(0.05)))));
      }
      return select(TICKET_LAYER.on.greaterThan(0.5), ungraded, tex.rgb.mul(lit.add(glow)));
    })();
    m.opacityNode = tex.a.mul(FX.x);
    // 锯齿边、缺口按图集的透明度裁掉（和淡出分开：阈值跟着不透明度走，淡出时边缘不会先被吃掉）
    m.alphaTestNode = FX.x.mul(0.5);
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'coupon-tickets';
    mesh.frustumCulled = false; // 顶点在着色器里摆，包围球不代表实际位置
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 11; // 画在不透明物体、天空和云海之后
    this.mesh = mesh;
    for (let i = 0; i < CAPACITY; i++) this.hide(i);
  }

  set(i: number, p: THREE.Vector3, q: THREE.Quaternion, size: number, opacity: number, glow: number, flutterAmp: number, flutterPhase: number, row: number, highlight: number, curl: number, glint: number): void {
    this.pos.setXYZW(i, p.x, p.y, p.z, size);
    this.rot.setXYZW(i, q.x, q.y, q.z, q.w);
    this.fx.setXYZW(i, opacity, glow, flutterAmp, flutterPhase);
    this.info.setXYZW(i, row, highlight, curl, glint);
    this.dirty = true;
  }

  hide(i: number): void {
    this.pos.setXYZW(i, 0, -1e5, 0, 0);
    this.fx.setXYZW(i, 0, 0, 0, 0);
    this.dirty = true;
  }

  commit(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.pos.needsUpdate = this.rot.needsUpdate = this.fx.needsUpdate = this.info.needsUpdate = true;
  }
}

export class GlowDiscs {
  readonly mesh: THREE.Mesh;
  private readonly at = dynamic(CAPACITY); // 中心（世界坐标），半径
  private readonly up = dynamic(CAPACITY); // 地面法线，强度
  private dirty = false;

  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aAt', this.at);
    g.setAttribute('aUp', this.up);
    g.instanceCount = CAPACITY;
    const A = attribute<'vec4'>('aAt', 'vec4');
    const U = attribute<'vec4'>('aUp', 'vec4');
    const n = normalize(U.xyz);
    const ref = select(abs(n.y).lessThan(0.9), vec3(0, 1, 0), vec3(1, 0, 0));
    const t1 = normalize(cross(ref, n));
    const t2 = cross(n, t1);
    const c = positionGeometry.xy;
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    m.name = 'coupon-glow';
    m.positionNode = A.xyz.add(t1.mul(c.x.mul(A.w))).add(t2.mul(c.y.mul(A.w))).add(n.mul(0.03));
    const r = c.length();
    const fall = pow(float(1).sub(smoothstep(0, 1, r)), 2);
    m.colorNode = vec3(1, 0.72, 0.28);
    m.opacityNode = fall.mul(U.w).mul(sin(COUPON_LIGHT.time.mul(2.6).add(A.w.mul(31))).mul(0.2).add(0.8));
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'coupon-glow';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 10;
    this.mesh = mesh;
    for (let i = 0; i < CAPACITY; i++) this.hide(i);
  }

  set(i: number, p: THREE.Vector3, up: THREE.Vector3, radius: number, strength: number): void {
    this.at.setXYZW(i, p.x, p.y, p.z, radius);
    this.up.setXYZW(i, up.x, up.y, up.z, strength);
    this.dirty = true;
  }

  hide(i: number): void {
    this.at.setXYZW(i, 0, -1e5, 0, 0);
    this.up.setXYZW(i, 0, 1, 0, 0);
    this.dirty = true;
  }

  commit(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.at.needsUpdate = this.up.needsUpdate = true;
  }
}

// 彩屑的颜色（线性空间）：翠宝黄、奶油、珊瑚粉、薄荷、天蓝
const CONFETTI = ['#f2b705', '#fbf3df', '#ff8f7d', '#86dcc6', '#9ccbff', '#f2b705'].map((h) => new THREE.Color(h));
const STAR = new THREE.Color('#fff4c9');

export class Sparks {
  readonly mesh: THREE.Mesh;
  private readonly a = dynamic(SPARK_SLOTS); // 出生点 xyz（世界坐标），出生时间
  private readonly b = dynamic(SPARK_SLOTS); // 初速度 xyz，随机数
  private readonly c = dynamic(SPARK_SLOTS); // 「上」xyz，寿命
  private readonly d = dynamic(SPARK_SLOTS); // 颜色 rgb，形状（0 彩屑，1 星星）
  private readonly e = dynamic(SPARK_SLOTS); // 大小（米），阻力，重力（× 9.8），转速
  private readonly time = uniform(0).setGroup(renderGroup);
  private readonly camRight = uniform(new THREE.Vector3(1, 0, 0)).setGroup(renderGroup);
  private readonly camUp = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup);
  private readonly rng = mulberry32(777);
  private head = 0;
  private clock = 0;
  private until = -1;
  private dirty = false;

  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.instanceCount = SPARK_SLOTS;
    for (let i = 0; i < SPARK_SLOTS; i++) this.a.array[i * 4 + 3] = -1e4;
    g.setAttribute('aA', this.a);
    g.setAttribute('aB', this.b);
    g.setAttribute('aC', this.c);
    g.setAttribute('aD', this.d);
    g.setAttribute('aE', this.e);
    const A = attribute<'vec4'>('aA', 'vec4');
    const B = attribute<'vec4'>('aB', 'vec4');
    const C = attribute<'vec4'>('aC', 'vec4');
    const D = attribute<'vec4'>('aD', 'vec4');
    const E = attribute<'vec4'>('aE', 'vec4');
    const age = this.time.sub(A.w);
    const k = age.div(C.w).clamp(0, 1);
    const alive = select(age.greaterThanEqual(0).and(age.lessThan(C.w)), float(1), float(0));
    // 带阻力的抛体：v' = g − drag·v
    const drag = max(E.y, 0.01);
    const travel = float(1).sub(exp(drag.negate().mul(age))).div(drag);
    const gravity = C.xyz.mul(E.z.mul(-9.8));
    const center = A.xyz.add(B.xyz.mul(travel)).add(gravity.mul(age.sub(travel).div(drag)));
    const size = E.x.mul(smoothstep(0, 0.06, k)).mul(float(1).sub(smoothstep(0.72, 1, k))).mul(alive);
    const star = D.w.greaterThan(0.5);
    const corner = positionGeometry.xy;
    // 星星：对着镜头，慢慢转
    const spinS = B.w.mul(6.283).add(age.mul(E.w).mul(0.3));
    const cs = cos(spinS);
    const ss = sin(spinS);
    const rc = vec2(corner.x.mul(cs).sub(corner.y.mul(ss)), corner.x.mul(ss).add(corner.y.mul(cs)));
    const billboard = this.camRight.mul(rc.x).add(this.camUp.mul(rc.y));
    // 彩屑：长方形的小纸片绕一根随机的轴翻（罗德里格斯公式）
    const axis = normalize(vec3(sin(B.w.mul(91.7)), cos(B.w.mul(53.3)), sin(B.w.mul(27.1).add(1.3))));
    const angle = B.w.mul(6.283).add(age.mul(E.w));
    const v = vec3(corner.x, corner.y.mul(0.55), 0);
    const ca = cos(angle);
    const sa = sin(angle);
    const tumble = v.mul(ca).add(cross(axis, v).mul(sa)).add(axis.mul(dot(axis, v).mul(float(1).sub(ca))));
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    m.name = 'coupon-sparks';
    m.positionNode = center.add(select(star, billboard, tumble).mul(size));
    // 四角星：|x|^½ + |y|^½ < 1，中心再亮一点
    const sx = abs(corner.x);
    const sy = abs(corner.y);
    const starShape = smoothstep(0, 0.22, float(1).sub(sqrt(sx).add(sqrt(sy))));
    const core = float(1).sub(smoothstep(0, 0.5, corner.length())).mul(0.6);
    const fade = float(1).sub(smoothstep(0.6, 1, k));
    // 彩屑的两面一明一暗（翻的时候闪）
    const flash = select(frontFacing, float(1), float(0.72));
    m.colorNode = select(star, D.xyz.mul(core.add(1.2)), D.xyz.mul(flash));
    m.opacityNode = select(star, max(starShape, core), float(1)).mul(fade);
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'coupon-sparks';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 12;
    mesh.visible = false;
    this.mesh = mesh;
  }

  // 一团彩屑和星星：从 at 往 forward 那一侧喷出去（锥形，往上偏），scale 是放大倍数（星球视图里大一些）
  burst(at: THREE.Vector3, up: THREE.Vector3, forward: THREE.Vector3, right: THREE.Vector3, count: number, scale: number): void {
    const rng = this.rng;
    for (let i = 0; i < count; i++) {
      const star = i % 4 === 0;
      const fwd = (0.8 + rng() * 1.5) * scale;
      const lift = (1.4 + rng() * 1.8) * scale;
      const side = (rng() - 0.5) * 2.6 * scale;
      const vx = forward.x * fwd + up.x * lift + right.x * side;
      const vy = forward.y * fwd + up.y * lift + right.y * side;
      const vz = forward.z * fwd + up.z * lift + right.z * side;
      const col = star ? STAR : CONFETTI[Math.floor(rng() * CONFETTI.length) % CONFETTI.length];
      const size = (star ? 0.06 + rng() * 0.04 : 0.035 + rng() * 0.02) * scale;
      this.emit(at.x, at.y, at.z, vx, vy, vz, up, 0.9 + rng() * 0.6, col, star ? 1 : 0, size, star ? 2.6 : 1.6, star ? 0.12 : 0.35, 8 + rng() * 10);
    }
  }

  // 一颗慢慢往上飘的小星星（落地的券时不时闪一下）
  twinkle(at: THREE.Vector3, up: THREE.Vector3, scale: number): void {
    const rng = this.rng;
    const s = 0.25 * scale;
    this.emit(at.x, at.y, at.z, up.x * s + (rng() - 0.5) * 0.1 * scale, up.y * s, up.z * s + (rng() - 0.5) * 0.1 * scale, up, 0.7 + rng() * 0.4, STAR, 1, (0.05 + rng() * 0.03) * scale, 1.5, 0, 3);
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, up: THREE.Vector3, life: number, col: THREE.Color, shape: number, size: number, drag: number, gravity: number, spin: number): void {
    const i = this.head;
    this.head = (this.head + 1) % SPARK_SLOTS;
    this.a.setXYZW(i, x, y, z, this.clock);
    this.b.setXYZW(i, vx, vy, vz, this.rng());
    this.c.setXYZW(i, up.x, up.y, up.z, life);
    this.d.setXYZW(i, col.r, col.g, col.b, shape);
    this.e.setXYZW(i, size, drag, gravity, spin);
    this.dirty = true;
    this.until = Math.max(this.until, this.clock + life + 0.05);
    this.mesh.visible = true;
  }

  // 预编译用：临时显示（编译时跳过不可见的）
  showForCompile(on: boolean): void {
    this.mesh.visible = on || this.clock < this.until;
  }

  get active(): boolean {
    return this.clock < this.until;
  }

  update(dt: number, camera: THREE.Camera): void {
    this.clock += dt;
    this.time.value = this.clock;
    if (this.dirty) {
      this.dirty = false;
      this.a.needsUpdate = this.b.needsUpdate = this.c.needsUpdate = this.d.needsUpdate = this.e.needsUpdate = true;
    }
    if (!this.mesh.visible) return;
    const el = camera.matrixWorld.elements;
    this.camRight.value.set(el[0], el[1], el[2]).normalize();
    this.camUp.value.set(el[4], el[5], el[6]).normalize();
    if (this.clock > this.until) this.mesh.visible = false;
  }

  clear(): void {
    for (let i = 0; i < SPARK_SLOTS; i++) this.a.array[i * 4 + 3] = -1e4;
    this.a.needsUpdate = true;
    this.until = -1;
    this.mesh.visible = false;
  }
}
