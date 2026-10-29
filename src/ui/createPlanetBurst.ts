import * as THREE from 'three/webgpu';
import { attribute, length, smoothstep, uniform, uv } from 'three/tsl';
import { sharedAudio } from '../fun/couponsAudio';
import { blendPalette, clonePalette, PRESETS, RAIN_MIX, RAIN_PALETTE } from '../nature/atmosphere';
import type { World } from '../scenes/world';

// 「星球从云里冲出来」的特效（P3，createPlanetLaunch.ts 的转场用）：
// - 云团（PuffPool）：一个 InstancedMesh 画所有的云团（朝向镜头的软边面片，每个实例自己的颜色、透明度），用对象池循环用：
//   蓄力时落点下面的云打旋、鼓起来；冲出来时被推开往外翻；星球拖出来的云尾巴
// - 星星（StarPool）：另一个 InstancedMesh：冲出来时的星尘、落定时飘的星星彩纸
// - 云里的光（glow）：落点下面一块暖光，蓄力时慢慢亮起来，冲出来时一闪再暗下去（加色混合；暖黄偏奶油，不是霓虹）
// - 冲击环（ring）：云面上一圈往外推开的环
// - 镜头抖动（Shake）：trauma² 的做法，抖动量 = trauma²，方向用几条正弦叠的平滑噪声（不随机），trauma 每秒线性回落
// - 声音：Web Audio 现场合成（借 coupons 的 AudioContext，用户交互过以后才有）：蓄力时低沉的隆隆、冲出来时「呼——」
// 所有材质在造星窗口第二、三步时预编译好（prepare），Launch 以后不在主线程上同步编

// ?tune → Create 调这张表（ui/createPlanetTune.ts）
export const BURST = {
  aim: 1.2, // 1. 窗口收起、镜头转到看得清落点的角度（秒）
  charge: 0.55, // 2. 蓄力：云鼓起、发光、打旋，隆隆声，镜头轻轻抖
  burst: 0.4, // 3. 冲出来
  settle: 0.65, // 4. 落定：冲过头、回弹、压扁再弹回，名牌弹出来、飘星星
  hold: 1.0, // 5. 收尾前停一拍
  after: 0, // 收尾：0 = 回首页、停在新星球上；1 = 照常穿云进这颗星球
  distance: 8.5, // 镜头离落点（× 半径）
  elevation: 26, // 镜头往下看（度）
  sink: 1.5, // 星球一开始在云顶以下几个半径
  overshoot: 0.85, // 冲过头多高（× 半径）
  stretch: 0.3, // 冲上来时竖着拉长多少
  squash: 0.18, // 落定时压扁多少
  spin: 2.6, // 冲出来时转过的角度（弧度），落定时转回去
  shake: 1, // 镜头抖动强度
  glow: 1, // 云里的光
  volume: 0.9, // 声音
};

type V3 = THREE.Vector3;
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const smooth = (t: number) => t * t * (3 - 2 * t);

// 一个粒子（云团或星星）：自由运动（速度、阻力、重力）或者绕着中心打旋
interface Particle {
  live: boolean;
  orbit: boolean; // 打旋：位置按 ang / rad / h 算
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  drag: number; // 每秒速度留下 e^(-drag)
  gravity: number; // 世界单位 / 秒²（往下为正）
  age: number;
  life: number;
  fadeIn: number; // 前多少比例淡入
  size0: number;
  size1: number;
  rot: number;
  spin: number;
  alpha: number; // 最大透明度
  color: THREE.Color;
  ang: number;
  rad: number;
  h: number;
}

// 一池朝向镜头的面片：一个 InstancedMesh，每帧在 CPU 上摆好每个实例（位置、朝镜头、大小）、写透明度；死掉的缩成 0
class Pool {
  readonly mesh: THREE.InstancedMesh;
  readonly items: Particle[] = [];
  private readonly alpha: THREE.InstancedBufferAttribute;
  private next = 0;

  constructor(n: number, map: THREE.Texture, blending: THREE.Blending, name: string, renderOrder: number) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', this.alpha);
    const m = new THREE.MeshBasicNodeMaterial({ map, transparent: true, depthWrite: false, fog: false, blending });
    m.name = name;
    m.opacityNode = attribute('aAlpha', 'float'); // 最后的透明度 = 贴图的透明度 × 这个实例的透明度
    this.mesh = new THREE.InstancedMesh(geo, m, n);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < n; i++) {
      this.items.push({ live: false, orbit: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), drag: 0, gravity: 0, age: 0, life: 1, fadeIn: 0.1, size0: 1, size1: 1, rot: 0, spin: 0, alpha: 1, color: new THREE.Color(1, 1, 1), ang: 0, rad: 0, h: 0 });
      this.mesh.setColorAt(i, this.items[i].color);
      this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }

  // 拿一个空着的（都在用就拿最老的那个）
  take(): Particle {
    for (let k = 0; k < this.items.length; k++) {
      const p = this.items[(this.next + k) % this.items.length];
      if (!p.live) {
        this.next = (this.next + k + 1) % this.items.length;
        return this.reset(p);
      }
    }
    const p = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    return this.reset(p);
  }

  private reset(p: Particle): Particle {
    p.live = true;
    p.orbit = false;
    p.vel.set(0, 0, 0);
    p.drag = 0;
    p.gravity = 0;
    p.age = 0;
    p.fadeIn = 0.12;
    p.rot = Math.random() * Math.PI * 2;
    p.spin = 0;
    p.alpha = 1;
    return p;
  }

  clear(): void {
    for (const p of this.items) p.live = false;
  }

  get alive(): number {
    let n = 0;
    for (const p of this.items) if (p.live) n++;
    return n;
  }

  // 每帧：走一步、摆好实例。center、camera：打旋的中心、朝向镜头
  update(dt: number, camera: THREE.Camera, center: V3): void {
    camera.getWorldQuaternion(_q);
    const items = this.items;
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      if (!p.live) {
        this.alpha.setX(i, 0);
        this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
        continue;
      }
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        p.live = false;
        this.alpha.setX(i, 0);
        this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
        continue;
      }
      if (p.orbit) {
        p.pos.set(center.x + Math.cos(p.ang) * p.rad, center.y + p.h, center.z + Math.sin(p.ang) * p.rad);
      } else {
        p.vel.multiplyScalar(Math.exp(-p.drag * dt));
        p.vel.y -= p.gravity * dt;
        p.pos.addScaledVector(p.vel, dt);
      }
      p.rot += p.spin * dt;
      // 打旋的云不按年龄淡入淡出（透明度由蓄力的进度直接给）
      const a = p.orbit ? p.alpha : p.alpha * Math.min(1, k / Math.max(1e-3, p.fadeIn)) * (1 - smooth(Math.max(0, (k - 0.45) / 0.55)));
      this.alpha.setX(i, a);
      const size = p.size0 + (p.size1 - p.size0) * (1 - (1 - k) * (1 - k));
      _q2.setFromAxisAngle(_z, p.rot);
      _s.setScalar(Math.max(1e-4, size));
      this.mesh.setMatrixAt(i, _m.compose(p.pos, _q3.copy(_q).multiply(_q2), _s));
      this.mesh.setColorAt(i, p.color);
    }
    this.alpha.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// —— 镜头抖动：trauma² ——
export class Shake {
  trauma = 0;
  private t = 0;

  // 一下子加一点（冲出来的那一下）
  add(x: number): void {
    this.trauma = Math.min(1, this.trauma + x);
  }

  // 至少这么多（蓄力时持续地轻轻抖）
  floor(x: number): void {
    this.trauma = Math.max(this.trauma, Math.min(1, x));
  }

  // lookAt 之后调：按 trauma² 转一点点（偏航、俯仰、侧倾），方向是几条正弦叠的平滑噪声
  apply(camera: THREE.Camera, dt: number, amount: number): void {
    this.t += dt;
    const s = this.trauma * this.trauma * amount;
    if (s > 1e-5) {
      const n = (f: number, ph: number) => Math.sin(this.t * f + ph) * 0.62 + Math.sin(this.t * f * 1.73 + ph * 2.1) * 0.38;
      camera.rotateY(THREE.MathUtils.degToRad(1.5) * s * n(23, 0.3));
      camera.rotateX(THREE.MathUtils.degToRad(1.2) * s * n(19, 1.7));
      camera.rotateZ(THREE.MathUtils.degToRad(2.2) * s * n(13, 4.1));
      camera.updateMatrixWorld();
    }
    this.trauma = Math.max(0, this.trauma - dt * 1.3);
  }
}

// —— 特效 ——
export class BurstFx {
  readonly group = new THREE.Group();
  private readonly puffs: Pool;
  private readonly stars: Pool;
  private readonly glow: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly glowAmount = uniform(0);
  private readonly glowColor = uniform(new THREE.Color(1.9, 1.35, 0.62));
  private readonly ringAlpha = uniform(0);
  private readonly ringColor = uniform(new THREE.Color(1, 0.97, 0.9));
  private readonly center = new THREE.Vector3();
  private R = 30;
  private ringT = -1; // 冲击环放了多久（< 0：没在放）
  private flashT = -1; // 冲出来那一下的闪光
  private charge = 0; // 蓄力的进度 0..1
  private readonly lit = new THREE.Color();
  private readonly mid = new THREE.Color();
  private readonly warm = new THREE.Color(1.6, 1.15, 0.55);
  private prepared: Promise<void> | null = null;

  constructor() {
    this.group.name = 'create-burst';
    this.puffs = new Pool(110, puffTexture(), THREE.NormalBlending, 'create-puffs', -6);
    this.stars = new Pool(90, starTexture(), THREE.NormalBlending, 'create-stars', -4);
    // 云里的光：水平的一块，中心最亮，往外软软地淡掉（加色混合）
    const glowGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    // 普通混合、比云亮一些的暖金色（HDR）：加色混合叠在很亮的云上，色调映射以后几乎看不出来
    const gm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    gm.name = 'create-glow';
    const rg = length(uv().sub(0.5)).mul(2);
    gm.colorNode = this.glowColor;
    gm.opacityNode = smoothstep(1, 0, rg).pow(1.6).mul(this.glowAmount).clamp(0, 0.9);
    this.glow = new THREE.Mesh(glowGeo, gm);
    this.glow.name = 'create-glow';
    this.glow.frustumCulled = false;
    this.glow.renderOrder = -7;
    // 冲击环：一圈软边的环（半径 0.8–1 之间最浓），整块往外放大、淡掉
    const ringGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    const rm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    rm.name = 'create-ring';
    const rr = length(uv().sub(0.5)).mul(2);
    rm.colorNode = this.ringColor;
    rm.opacityNode = smoothstep(0.52, 0.84, rr).mul(smoothstep(1.0, 0.86, rr)).mul(this.ringAlpha);
    this.ring = new THREE.Mesh(ringGeo, rm);
    this.ring.name = 'create-ring';
    this.ring.frustumCulled = false;
    this.ring.renderOrder = -5;
    this.group.add(this.glow, this.ring, this.puffs.mesh, this.stars.mesh);
    this.group.visible = false;
  }

  // 造星窗口第二、三步时调：挂进主场景前在后台编好（GatedStager.precompile；WebGL2 上还会先画一次）
  prepare(world: World): Promise<void> {
    this.prepared ??= (() => {
      this.group.visible = true;
      this.glowAmount.value = 0.001;
      this.ringAlpha.value = 0.001;
      return world.stage.precompile(this.group).catch((err: unknown) => console.warn('burst fx precompile failed', err)).then(() => {
        this.group.visible = false;
      });
    })();
    return this.prepared;
  }

  // 开始：特效挂进主场景，放在 at（云顶上、星球冒出来的那一点）；R 星球半径。颜色取当前天空预设的云色
  begin(world: World, at: V3, R: number): void {
    const atm = world.atmosphere;
    const pal = clonePalette(PRESETS[atm.preset]);
    blendPalette(pal, PRESETS[atm.preset], RAIN_PALETTE, atm.rain * RAIN_MIX);
    this.lit.copy(pal.cloudLit).multiplyScalar(0.78);
    this.mid.copy(pal.cloudMid);
    this.ringColor.value.copy(pal.cloudLit).multiplyScalar(0.85);
    this.center.copy(at);
    this.R = R;
    this.glow.position.copy(at).y += 0.06 * R;
    this.glow.scale.setScalar(2.3 * R);
    this.ring.position.copy(at).y += 0.08 * R;
    this.puffs.clear();
    this.stars.clear();
    this.charge = 0;
    this.ringT = -1;
    this.flashT = -1;
    this.glowAmount.value = 0;
    this.ringAlpha.value = 0;
    this.group.visible = true;
    if (!this.group.parent) world.scene.add(this.group);
    // 打旋的云：一圈一圈绕着落点，离中心近的转得快；一开始贴着云面、看不见，蓄力时淡进来、鼓起来
    for (let i = 0; i < 34; i++) {
      const p = this.puffs.take();
      p.orbit = true;
      p.ang = Math.random() * Math.PI * 2;
      p.rad = R * (0.35 + 2.1 * Math.sqrt(Math.random()));
      p.h = 0;
      p.life = 99;
      p.fadeIn = 0.004;
      p.alpha = 0;
      p.size0 = p.size1 = R * (0.55 + 0.45 * Math.random());
      p.color.copy(this.mid).lerp(this.lit, 0.55 + 0.4 * Math.random());
    }
  }

  // 蓄力：k 0..1（云打旋、鼓起来、发光）
  setCharge(k: number): void {
    this.charge = k;
  }

  // 冲出来的那一下：打旋的云被推开往外翻，冲击环放出去，光一闪
  blast(): void {
    const R = this.R;
    for (const p of this.puffs.items) {
      if (!p.live || !p.orbit) continue;
      p.orbit = false;
      const out = new THREE.Vector3(Math.cos(p.ang), 0, Math.sin(p.ang));
      p.vel.copy(out).multiplyScalar(R * (5 + 4 * Math.random()));
      p.vel.y = R * (0.5 + 1.1 * Math.random());
      p.drag = 3.2;
      p.gravity = R * 0.4;
      p.age = 0;
      p.life = 0.9 + 0.5 * Math.random();
      p.fadeIn = 0.001;
      p.alpha = 0.95;
      p.size1 = p.size0 * 1.6;
    }
    this.ringT = 0;
    this.flashT = 0;
  }

  // 星球拖出来的云尾巴：在 at（星球底下）放一团
  tail(at: V3): void {
    const R = this.R;
    const p = this.puffs.take();
    p.pos.set(at.x + (Math.random() - 0.5) * R * 0.6, at.y + (Math.random() - 0.5) * R * 0.3, at.z + (Math.random() - 0.5) * R * 0.6);
    p.vel.set((Math.random() - 0.5) * R * 0.6, -R * (0.2 + 0.4 * Math.random()), (Math.random() - 0.5) * R * 0.6);
    p.drag = 1.5;
    p.life = 0.7 + 0.35 * Math.random();
    p.fadeIn = 0.05;
    p.alpha = 0.9;
    p.size0 = R * (0.35 + 0.25 * Math.random());
    p.size1 = p.size0 * 2.1;
    p.spin = (Math.random() - 0.5) * 1.5;
    p.color.copy(this.mid).lerp(this.lit, 0.65 + 0.3 * Math.random());
  }

  // 星尘：在星球边上（center 周围 r）放几颗小亮点，往外、往下飘
  dust(center: V3, r: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const p = this.stars.take();
      const d = _p.randomDirection();
      p.pos.copy(center).addScaledVector(d, r * (0.95 + 0.15 * Math.random()));
      p.vel.copy(d).multiplyScalar(this.R * (0.6 + 0.8 * Math.random()));
      p.vel.y -= this.R * 0.9;
      p.drag = 1.2;
      p.life = 0.6 + 0.6 * Math.random();
      p.fadeIn = 0.08;
      p.alpha = 1;
      p.size0 = this.R * (0.07 + 0.07 * Math.random());
      p.size1 = p.size0 * 0.4;
      p.spin = (Math.random() - 0.5) * 8;
      p.color.setRGB(1, 0.94, 0.72).multiplyScalar(1.4 + Math.random() * 0.6);
    }
  }

  // 落定时飘的星星彩纸：绕着星球中间一圈，往外、往上散开，慢慢转着落下来
  confetti(center: V3, r: number, n = 30): void {
    const palette = [0xf2b705, 0xe7799f, 0x4b9fe0, 0x62b357, 0xef9550, 0x9a80dc, 0xfff3d6];
    for (let i = 0; i < n; i++) {
      const p = this.stars.take();
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      p.pos.copy(center).addScaledVector(out, r * (1.05 + 0.4 * Math.random()));
      p.pos.y += (Math.random() - 0.3) * r * 0.9;
      p.vel.copy(out).multiplyScalar(this.R * (0.8 + 0.9 * Math.random()));
      p.vel.y = this.R * (0.9 + 1.0 * Math.random());
      p.drag = 1.4;
      p.gravity = this.R * 0.7;
      p.life = 1.5 + 0.7 * Math.random();
      p.fadeIn = 0.04;
      p.alpha = 1;
      p.size0 = this.R * (0.13 + 0.1 * Math.random());
      p.size1 = p.size0 * 0.85;
      p.spin = (Math.random() - 0.5) * 6;
      p.color.setHex(palette[i % palette.length]).convertSRGBToLinear().multiplyScalar(1.6);
    }
  }

  get busy(): boolean {
    return this.group.visible && (this.puffs.alive > 0 || this.stars.alive > 0 || this.ringT >= 0 || this.flashT >= 0);
  }

  // 每帧（主画面画之前）
  tick(dt: number, camera: THREE.Camera): void {
    if (!this.group.visible) return;
    const R = this.R;
    const k = this.charge;
    // 打旋的云：越来越快，往中心收一点，中间鼓起来（一个圆顶），离中心近的被下面的光染暖
    for (const p of this.puffs.items) {
      if (!p.live || !p.orbit) continue;
      const w = (1.0 + 4.2 * k) / (0.45 + p.rad / R);
      p.ang += w * dt;
      p.rad = Math.max(R * 0.25, p.rad * (1 - 0.18 * k * dt));
      const dome = Math.max(0, 1 - (p.rad / (2.7 * R)) ** 2);
      p.h = R * (0.05 + 1.0 * smooth(k) * dome);
      p.alpha = 0.95 * smooth(Math.min(1, k * 2.5));
      p.color.copy(this.mid).lerp(this.lit, 0.7).lerp(this.warm, 0.55 * smooth(k) * dome * BURST.glow);
      p.size1 = p.size0 * (1 + 0.3 * k);
      p.age = 0;
    }
    this.puffs.update(dt, camera, this.center);
    this.stars.update(dt, camera, this.center);
    // 光：蓄力时亮起来（带一点起伏），冲出来时一闪再暗下去
    let g = smooth(k) * (0.75 + 0.25 * Math.sin(performance.now() * 0.025));
    if (this.flashT >= 0) {
      this.flashT += dt;
      const f = this.flashT / 0.55;
      g = f < 0.12 ? 1 + 0.8 * (f / 0.12) : Math.max(0, 1.8 * (1 - (f - 0.12) / 0.88));
      if (f >= 1) this.flashT = -1;
    }
    this.glowAmount.value = Math.max(0, g) * 0.85 * BURST.glow;
    // 冲击环
    if (this.ringT >= 0) {
      this.ringT += dt;
      const f = Math.min(1, this.ringT / 0.85);
      this.ring.scale.setScalar(R * (1.0 + 4.5 * (1 - (1 - f) ** 3)));
      this.ringAlpha.value = 0.95 * (1 - smooth(f));
      if (f >= 1) {
        this.ringT = -1;
        this.ringAlpha.value = 0;
      }
    }
  }

  stop(): void {
    this.puffs.clear();
    this.stars.clear();
    this.group.visible = false;
    this.group.removeFromParent();
    this.ringT = -1;
    this.flashT = -1;
  }
}

// —— 声音 ——
// 蓄力：低沉的隆隆（低通的噪声 + 一个很低的正弦），seconds 秒里慢慢变响，冲出来时收掉
export function rumble(seconds: number): void {
  const a = sharedAudio();
  if (!a || BURST.volume <= 0) return;
  const { ctx, out, noise } = a;
  const t0 = ctx.currentTime;
  const v = BURST.volume;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(80, t0);
  lp.frequency.linearRampToValueAtTime(240, t0 + seconds);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.9 * v, t0 + seconds * 0.9);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds + 0.3);
  src.connect(lp).connect(g).connect(out);
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(38, t0);
  osc.frequency.linearRampToValueAtTime(62, t0 + seconds);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, t0);
  og.gain.exponentialRampToValueAtTime(0.6 * v, t0 + seconds * 0.85);
  og.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds + 0.25);
  osc.connect(og).connect(out);
  src.start(t0);
  src.stop(t0 + seconds + 0.35);
  osc.start(t0);
  osc.stop(t0 + seconds + 0.3);
}

// 冲出来：「呼——」（带通的噪声，频率很快扫上去再落回来）+ 底下一声闷响
export function whoosh(): void {
  const a = sharedAudio();
  if (!a || BURST.volume <= 0) return;
  const { ctx, out, noise } = a;
  const t0 = ctx.currentTime;
  const v = BURST.volume;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 0.9;
  bp.frequency.setValueAtTime(320, t0);
  bp.frequency.exponentialRampToValueAtTime(2600, t0 + 0.16);
  bp.frequency.exponentialRampToValueAtTime(700, t0 + 0.8);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(1.3 * v, t0 + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.85);
  src.connect(bp).connect(g).connect(out);
  src.start(t0);
  src.stop(t0 + 0.9);
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(110, t0);
  osc.frequency.exponentialRampToValueAtTime(38, t0 + 0.3);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, t0);
  og.gain.exponentialRampToValueAtTime(0.9 * v, t0 + 0.012);
  og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34);
  osc.connect(og).connect(out);
  osc.start(t0);
  osc.stop(t0 + 0.36);
}

// —— 贴图 ——
// 一团软边的积云：几个重叠的圆，下半团压暗偏冷一点（有体积）
function puffTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (g) {
    const blob = (x: number, y: number, r: number, a: number) => {
      const grad = g.createRadialGradient(x, y, r * 0.15, x, y, r);
      grad.addColorStop(0, `rgba(255,255,255,${a})`);
      grad.addColorStop(0.6, `rgba(255,255,255,${a * 0.75})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    };
    blob(64, 72, 46, 0.9);
    blob(42, 66, 30, 0.85);
    blob(86, 64, 32, 0.85);
    blob(62, 48, 30, 0.8);
    g.globalCompositeOperation = 'source-atop';
    const shade = g.createLinearGradient(0, 40, 0, 120);
    shade.addColorStop(0, 'rgba(150,145,190,0)');
    shade.addColorStop(1, 'rgba(150,145,190,0.42)');
    g.fillStyle = shade;
    g.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 一颗圆角的五角星（白色，按实例的颜色染），外面一圈很淡的光晕
function starTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (g) {
    const halo = g.createRadialGradient(32, 32, 4, 32, 32, 30);
    halo.addColorStop(0, 'rgba(255,255,255,0.35)');
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, size, size);
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 22 : 9.5;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const x = 32 + Math.cos(a) * r;
      const y = 33 + Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.lineJoin = 'round';
    g.lineWidth = 5;
    g.strokeStyle = '#ffffff';
    g.fillStyle = '#ffffff';
    g.fill();
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
