import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, length, mix, sin, smoothstep, time, uniform, uv, vec3, vec4 } from 'three/tsl';
import { HOME_SPIRAL, spiralB, spiralPoint, spiralR0, type HomeSpiral } from './homeLayout';

// 首页螺旋星系的点缀（H2）：星球只有十几颗时看不出螺旋臂，沿两条臂撒上
// - 星尘：沿臂的中线密、离开中线很快变稀，一条窄窄的弧带；靠中心亮、往外慢慢暗，一直画到最外那颗星球外面；
//   一条臂偏暖金、一条偏奶白；两边再零星撒几粒。叠加混合（会发光），慢慢闪
// - 小云絮：几十团很淡的奶油色、桃粉色软云，压在臂底下，给螺旋臂一点「身体」
// - 你的星球：后面一圈暖光，底下的云面上一圈柔和的光环（这颗是你的）
// 星尘、云絮各一次绘制（朝向镜头的面片：SpriteNodeMaterial + 每个实例的位置、大小、颜色），暖光、光环各一次。
// 不写深度：星球挡得住它们，它们不挡星球。只在首页显示，进星球时淡出、藏起来

export const HOME_DUST = {
  density: 1, // 星尘多少（× 默认粒数）
  size: 1, // 星尘大小
  glow: 1, // 星尘亮度
  width: 1, // 弧带多宽
  wisps: 1, // 小云絮浓淡（0 = 没有）
  halo: 1, // 你的星球的暖光、底下的光环（0 = 没有）
  extra: 1.6, // 螺旋臂画到最外那颗星球外面再多长多少（× 半径）
};

const DUST_BASE = 3600;
const WISP_COUNT = 110;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 正态分布（Box–Muller）
function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-6, r()))) * Math.cos(2 * Math.PI * r());
}

interface Batch {
  sprite: THREE.Sprite;
  pos: THREE.InstancedBufferAttribute;
  size: THREE.InstancedBufferAttribute;
  color: THREE.InstancedBufferAttribute; // rgb + 亮度
  max: number;
}

// 一批朝向镜头的面片：每个实例的位置、大小、颜色从缓冲里取；shade 按颜色算出这一片的颜色和不透明度
function makeBatch(max: number, name: string, fade: THREE.Node<'float'>, additive: boolean, shade: (c: THREE.Node<'vec4'>) => THREE.Node<'vec4'>): Batch {
  const pos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  const size = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
  const color = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  if (additive) m.blending = THREE.AdditiveBlending;
  m.positionNode = instancedBufferAttribute(pos);
  m.scaleNode = instancedBufferAttribute(size);
  const out = shade(instancedBufferAttribute(color) as unknown as THREE.Node<'vec4'>);
  m.colorNode = vec4(out.rgb, out.a.mul(fade));
  const sprite = new THREE.Sprite(m);
  sprite.name = name;
  sprite.frustumCulled = false;
  sprite.count = max;
  return { sprite, pos, size, color, max };
}

const lin = (hex: string) => {
  const c = new THREE.Color(hex);
  return vec3(c.r, c.g, c.b);
};

export interface GalaxyExtent {
  maxR: number; // 最外那颗星球离中心多远（没拉长时，世界单位）
  stretch: number; // 沿纵深（z）拉长多少（手机竖屏）
  rotation: number; // 版式把星系在平面里转了多少（弧度，homeLayout 的 meta）
}

export class GalaxyDecor {
  readonly group = new THREE.Group();
  private readonly fade = uniform(1); // 首页 1，星球视图 0
  private readonly glow = uniform(1);
  private readonly wispK = uniform(1);
  private readonly haloK = uniform(1);
  private readonly dust: Batch;
  private readonly wisps: Batch;
  private readonly halo: THREE.Sprite;
  private readonly ground: THREE.Mesh;
  private builtFor = '';

  constructor() {
    this.group.name = 'home-galaxy';
    // 星尘：圆的小光点，中间实、边上一圈软的晕；每粒按自己的亮度当相位慢慢闪。叠加混合：和云海拉开，像在发光
    this.dust = makeBatch(Math.round(DUST_BASE * 2.5), 'home-dust', this.fade, true, (c) => {
      const d = length(uv().sub(0.5)).mul(2);
      const core = smoothstep(0.42, 0.0, d);
      const halo = smoothstep(1.0, 0.15, d).mul(0.3);
      const twinkle = sin(time.mul(1.6).add(c.a.mul(53))).mul(0.22).add(0.88);
      const k = core.add(halo).mul(c.a).mul(twinkle).mul(this.glow).mul(1.8);
      return vec4(c.rgb.mul(k), k); // 叠加：颜色本身乘亮度
    });
    // 小云絮：很软的圆斑
    this.wisps = makeBatch(WISP_COUNT, 'home-wisps', this.fade, false, (c) => {
      const d = length(uv().sub(0.5)).mul(2);
      const soft = smoothstep(1.0, 0.0, d);
      return vec4(c.rgb, soft.mul(soft).mul(c.a).mul(this.wispK));
    });
    // 你的星球后面的暖光：一个大的软圆，中间奶白、往外暖金、再淡成透明
    const haloMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    haloMat.blending = THREE.AdditiveBlending;
    {
      const d = length(uv().sub(0.5)).mul(2);
      const ring = smoothstep(1.0, 0.55, d).mul(smoothstep(0.25, 0.62, d));
      const inner = smoothstep(0.75, 0.0, d).mul(0.5);
      const pulse = sin(time.mul(1.3)).mul(0.08).add(0.92);
      const k = ring.add(inner).mul(0.55).mul(pulse).mul(this.fade).mul(this.haloK);
      haloMat.colorNode = vec4(mix(lin('#fff1c8'), lin('#ffc94d'), smoothstep(0.2, 0.9, d)).mul(k), k);
    }
    this.halo = new THREE.Sprite(haloMat);
    this.halo.name = 'home-you-halo';
    // 底下云面上的光环：平放的一圈柔光（中间空、一圈亮、外面淡掉），慢慢呼吸
    const groundMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide });
    groundMat.blending = THREE.AdditiveBlending;
    {
      const d = length(uv().sub(0.5)).mul(2);
      const band = smoothstep(0.42, 0.68, d).mul(smoothstep(1.0, 0.72, d));
      const fill = smoothstep(0.85, 0.0, d).mul(0.25);
      const pulse = sin(time.mul(1.1)).mul(0.1).add(0.9);
      const k = band.add(fill).mul(0.6).mul(pulse).mul(this.fade).mul(this.haloK);
      groundMat.colorNode = vec4(lin('#ffcf5c').mul(k), k);
    }
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.name = 'home-you-ring';
    this.ground.frustumCulled = false;
    this.ground.renderOrder = -8; // 云海（-10）、远处积云（-9）之后
    this.wisps.sprite.renderOrder = -7;
    this.dust.sprite.renderOrder = -6;
    this.halo.renderOrder = -5;
    this.group.add(this.ground, this.wisps.sprite, this.dust.sprite, this.halo);
  }

  // 按螺旋臂的参数、星球半径、星系多大重新撒（参数改了、半径变了、星系变大了才重撒）
  build(radius: number, ext: GalaxyExtent, p: HomeSpiral = HOME_SPIRAL): void {
    const key = JSON.stringify([radius, Math.round(ext.maxR), ext.stretch, p, HOME_DUST]);
    if (key === this.builtFor) return;
    this.builtFor = key;
    const R = radius;
    const arms = Math.max(1, Math.round(p.arms));
    const r0 = spiralR0(R, p);
    const b = spiralB(p);
    // 臂画到最外那颗星球再往外 extra 个半径（螺旋臂一直延伸到星球外面）
    const rEnd = Math.max(r0 * 1.5, ext.maxR + HOME_DUST.extra * R);
    const total = Math.log(rEnd / r0) / b;
    const sz = ext.stretch;
    const rc = Math.cos(ext.rotation);
    const rs = Math.sin(ext.rotation);
    const pt = { x: 0, z: 0, r: 0, a: 0 };
    const rand = rng(91);
    const gold = new THREE.Color('#ffb42e');
    const amber = new THREE.Color('#ff8a3d');
    const cream = new THREE.Color('#fff0c4');
    const pearl = new THREE.Color('#ffd9a6');
    const tmp = new THREE.Color();
    // —— 星尘 ——
    const n = Math.min(this.dust.max, Math.round(DUST_BASE * HOME_DUST.density));
    const pos = this.dust.pos.array as Float32Array;
    const size = this.dust.size.array as Float32Array;
    const col = this.dust.color.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const arm = i % arms;
      let x: number;
      let z: number;
      let y: number;
      let k: number; // 0 中心 .. 1 外端
      let bright: number;
      if (rand() < 0.1) {
        // 中间一小团（核球）：围着你的星球
        const rr = Math.abs(gauss(rand)) * r0 * 0.45 + R * 1.6;
        const a = rand() * Math.PI * 2;
        x = Math.cos(a) * rr;
        z = Math.sin(a) * rr;
        y = gauss(rand) * R * 0.25;
        k = 0.05;
        bright = 0.9;
      } else {
        // 沿臂：里面密一点，横着按窄的正态分布（越往外略宽）；12% 的是零星散在两边的
        const t = Math.pow(rand(), 0.85);
        spiralPoint(arm, t * total, r0, p, pt);
        const loose = rand() < 0.12;
        const w = R * HOME_DUST.width * (loose ? 1.6 + 1.4 * t : 0.32 + 0.45 * t);
        const across = gauss(rand) * w;
        const along = gauss(rand) * R * 0.3;
        const ta = pt.a + Math.PI / 2;
        x = pt.x + Math.cos(pt.a) * across + Math.cos(ta) * along;
        z = pt.z + Math.sin(pt.a) * across + Math.sin(ta) * along;
        y = gauss(rand) * R * (0.15 + 0.2 * t);
        k = t;
        bright = (loose ? 0.45 : 1) * (1 - 0.6 * t); // 往外慢慢暗，但一直看得出来
      }
      pos[i * 3] = x * rc - z * rs;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = (x * rs + z * rc) * sz;
      size[i] = R * (0.22 + 0.55 * rand() * rand()) * (1.15 - 0.35 * k) * HOME_DUST.size;
      // 一条臂暖金（往外偏琥珀），一条奶白（往外偏珍珠桃）
      if (arm === 0) tmp.copy(gold).lerp(amber, k * 0.8);
      else tmp.copy(cream).lerp(pearl, k * 0.8);
      col[i * 4] = tmp.r;
      col[i * 4 + 1] = tmp.g;
      col[i * 4 + 2] = tmp.b;
      col[i * 4 + 3] = bright * (0.7 + 0.3 * rand());
    }
    this.dust.sprite.count = n;
    this.dust.pos.needsUpdate = true;
    this.dust.size.needsUpdate = true;
    this.dust.color.needsUpdate = true;
    // —— 小云絮：压在臂底下 ——
    const wp = this.wisps.pos.array as Float32Array;
    const ws = this.wisps.size.array as Float32Array;
    const wc = this.wisps.color.array as Float32Array;
    const pink = new THREE.Color('#f2a07a');
    const butter = new THREE.Color('#ffc65a');
    for (let i = 0; i < WISP_COUNT; i++) {
      const t = 0.04 + 0.96 * (i / WISP_COUNT);
      spiralPoint(i % arms, t * total, r0, p, pt);
      const across = gauss(rand) * R * (0.12 + 0.2 * t);
      const wx = pt.x + Math.cos(pt.a) * across;
      const wz = pt.z + Math.sin(pt.a) * across;
      wp[i * 3] = wx * rc - wz * rs;
      wp[i * 3 + 1] = -R * (0.5 + 0.3 * rand());
      wp[i * 3 + 2] = (wx * rs + wz * rc) * sz;
      ws[i] = R * (1.3 + 0.9 * rand()) * (1 + t * 0.4);
      tmp.copy(butter).lerp(pink, t);
      wc[i * 4] = tmp.r;
      wc[i * 4 + 1] = tmp.g;
      wc[i * 4 + 2] = tmp.b;
      wc[i * 4 + 3] = 0.7 * (1 - t * 0.45);
    }
    this.wisps.pos.needsUpdate = true;
    this.wisps.size.needsUpdate = true;
    this.wisps.color.needsUpdate = true;
  }

  // 每帧：首页显示、星球视图淡出；你的星球的暖光跟着它，光环平放在它底下的云面上（seaTop：云顶的高度）
  update(dt: number, home: boolean, you: { pos: THREE.Vector3; size: number } | null, seaTop: number): void {
    const goal = home ? 1 : 0;
    const f = this.fade.value;
    this.fade.value = Math.abs(goal - f) < 0.01 ? goal : f + (goal - f) * (1 - Math.exp(-6 * dt));
    this.group.visible = this.fade.value > 0.001;
    this.glow.value = HOME_DUST.glow;
    this.wispK.value = HOME_DUST.wisps;
    this.haloK.value = you ? HOME_DUST.halo : 0;
    if (you) {
      this.halo.position.copy(you.pos);
      this.halo.scale.setScalar(you.size * 3.0);
      this.ground.position.set(you.pos.x, seaTop + you.size * 0.05, you.pos.z);
      this.ground.scale.setScalar(you.size * 4.6);
    }
  }
}
