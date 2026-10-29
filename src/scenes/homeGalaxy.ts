import * as THREE from 'three/webgpu';
import { float, instancedBufferAttribute, length, mix, sin, smoothstep, time, uniform, uv, vec3, vec4 } from 'three/tsl';
import { HOME_SPIRAL, spiralPoint, spiralR0, type HomeSpiral } from './homeLayout';

// 首页螺旋星系的点缀（H2）：星球只有十几颗时看不出螺旋臂，沿两条臂撒上
// - 星尘：一粒粒暖金色的小光点（像绘本里撒的金粉），中间密、亮，往外越来越稀、越淡，慢慢闪
// - 小云絮：几十团很淡的奶油色、桃粉色软云，给螺旋臂一点「身体」
// - 你的星球后面一圈暖光（这颗是你的）
// 都是朝向镜头的面片（SpriteNodeMaterial + 每个实例的位置、大小、颜色），星尘一次绘制、云絮一次绘制、暖光一次绘制。
// 不写深度：星球挡得住它们，它们不挡星球。只在首页显示，进星球时淡出、藏起来

export const HOME_DUST = {
  density: 1, // 星尘多少（× 默认 1400 粒）
  size: 1, // 星尘大小
  glow: 1, // 星尘亮度
  wisps: 1, // 小云絮浓淡（0 = 没有）
  halo: 1, // 你的星球后面那圈暖光（0 = 没有）
  extra: 0.25, // 螺旋臂画到星球外面再多长一截（× 臂的总角度）
};

const DUST_BASE = 3200;
const WISP_COUNT = 90;

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
  color: THREE.InstancedBufferAttribute; // rgb + alpha
  max: number;
}

// 一批朝向镜头的面片：每个实例的位置、大小、颜色（rgb + a）从缓冲里取；shade 按颜色算出这一片的颜色和不透明度
function makeBatch(max: number, name: string, fade: THREE.Node<'float'>, shade: (c: THREE.Node<'vec4'>) => THREE.Node<'vec4'>): Batch {
  const pos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  const size = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
  const color = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: false });
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

export class GalaxyDecor {
  readonly group = new THREE.Group();
  private readonly fade = uniform(1); // 首页 1，星球视图 0
  private readonly glow = uniform(1);
  private readonly wispK = uniform(1);
  private readonly haloK = uniform(1);
  private readonly dust: Batch;
  private readonly wisps: Batch;
  private readonly halo: THREE.Sprite;
  private builtFor = '';

  constructor() {
    this.group.name = 'home-galaxy';
    // 星尘：圆的小光点，中间实、边上一圈软的晕；每粒按自己的相位（拿亮度当相位）慢慢闪
    this.dust = makeBatch(Math.round(DUST_BASE * 2.5), 'home-dust', this.fade, (c) => {
      const d = length(uv().sub(0.5)).mul(2);
      const core = smoothstep(0.45, 0.0, d);
      const halo = smoothstep(1.0, 0.2, d).mul(0.35);
      const twinkle = sin(time.mul(1.7).add(c.a.mul(40))).mul(0.25).add(0.85);
      return vec4(c.rgb.mul(float(1).add(core.mul(0.35))), core.add(halo).mul(c.a).mul(twinkle).mul(this.glow));
    });
    // 小云絮：很软的圆斑
    this.wisps = makeBatch(WISP_COUNT, 'home-wisps', this.fade, (c) => {
      const d = length(uv().sub(0.5)).mul(2);
      const soft = smoothstep(1.0, 0.0, d);
      return vec4(c.rgb, soft.mul(soft).mul(c.a).mul(this.wispK));
    });
    // 你的星球后面的暖光：一个大的软圆，中间暖金、往外淡成透明
    const haloMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    {
      const d = length(uv().sub(0.5)).mul(2);
      const ring = smoothstep(1.0, 0.55, d).mul(smoothstep(0.25, 0.62, d));
      const inner = smoothstep(0.75, 0.0, d).mul(0.55);
      const pulse = sin(time.mul(1.3)).mul(0.08).add(0.92);
      const gold = vec3(new THREE.Color('#ffc94d').r, new THREE.Color('#ffc94d').g, new THREE.Color('#ffc94d').b);
      const cream = vec3(new THREE.Color('#fff1c8').r, new THREE.Color('#fff1c8').g, new THREE.Color('#fff1c8').b);
      haloMat.colorNode = vec4(mix(cream, gold, smoothstep(0.2, 0.9, d)), ring.add(inner).mul(0.85).mul(pulse).mul(this.fade).mul(this.haloK));
    }
    this.halo = new THREE.Sprite(haloMat);
    this.halo.name = 'home-you-halo';
    this.halo.renderOrder = -5; // 云海（-10）之后、星球的透明部分之前
    this.dust.sprite.renderOrder = -6;
    this.wisps.sprite.renderOrder = -7;
    this.group.add(this.wisps.sprite, this.dust.sprite, this.halo);
  }

  // 按螺旋臂的参数和星球半径重新撒（参数改了、半径变了才重撒）。youPos：你的星球在哪、多大
  build(radius: number, p: HomeSpiral = HOME_SPIRAL): void {
    const key = JSON.stringify([radius, p, HOME_DUST.density, HOME_DUST.size, HOME_DUST.extra]);
    if (key === this.builtFor) return;
    this.builtFor = key;
    const R = radius;
    const arms = Math.max(1, Math.round(p.arms));
    const r0 = spiralR0(R, p);
    const total = p.turns * Math.PI * 2 * (1 + HOME_DUST.extra);
    const pt = { x: 0, z: 0, r: 0, a: 0 };
    const rand = rng(91);
    const gold = new THREE.Color('#f7b733');
    const peach = new THREE.Color('#f0805a');
    const cream = new THREE.Color('#ffe48f');
    const tmp = new THREE.Color();
    // —— 星尘 ——
    const n = Math.min(this.dust.max, Math.round(DUST_BASE * HOME_DUST.density));
    const pos = this.dust.pos.array as Float32Array;
    const size = this.dust.size.array as Float32Array;
    const col = this.dust.color.array as Float32Array;
    for (let i = 0; i < n; i++) {
      let x: number;
      let z: number;
      let y: number;
      let k: number; // 0 中心 .. 1 外端
      if (i < n * 0.16) {
        // 中间的一团（核球）：围着你的星球
        const rr = Math.abs(gauss(rand)) * r0 * 0.55 + R * 1.2;
        const a = rand() * Math.PI * 2;
        x = Math.cos(a) * rr;
        z = Math.sin(a) * rr;
        y = gauss(rand) * R * 0.25;
        k = Math.min(1, rr / (r0 * 2.2)) * 0.25;
      } else {
        // 沿臂：越往外越稀（按 t^1.6 撒），横着按正态分布散开，越往外散得越开
        const t = Math.pow(rand(), 1.1);
        const theta = t * total;
        spiralPoint(i % arms, theta, r0, p, pt);
        const across = gauss(rand) * R * (0.32 + 0.75 * t);
        const along = gauss(rand) * R * 0.4;
        const ta = pt.a + Math.PI / 2;
        x = pt.x + Math.cos(pt.a) * across + Math.cos(ta) * along;
        z = pt.z + Math.sin(pt.a) * across + Math.sin(ta) * along;
        y = gauss(rand) * R * (0.18 + 0.3 * t);
        k = t;
      }
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      size[i] = R * (0.14 + 0.36 * rand() * rand()) * (1.25 - 0.55 * k) * HOME_DUST.size;
      tmp.copy(cream).lerp(gold, Math.min(1, 0.3 + k * 1.2)).lerp(peach, Math.max(0, k - 0.55) * 0.9);
      col[i * 4] = tmp.r;
      col[i * 4 + 1] = tmp.g;
      col[i * 4 + 2] = tmp.b;
      // a：亮度（往外越淡），闪的相位也用它
      col[i * 4 + 3] = Math.max(0.22, (1 - k) ** 0.9 * 0.95) * (0.7 + 0.3 * rand());
    }
    this.dust.sprite.count = n;
    this.dust.pos.needsUpdate = true;
    this.dust.size.needsUpdate = true;
    this.dust.color.needsUpdate = true;
    // —— 小云絮 ——
    const wp = this.wisps.pos.array as Float32Array;
    const ws = this.wisps.size.array as Float32Array;
    const wc = this.wisps.color.array as Float32Array;
    const pink = new THREE.Color('#f39a9a');
    const butter = new THREE.Color('#ffc85e');
    for (let i = 0; i < WISP_COUNT; i++) {
      const t = 0.05 + 0.95 * (i / WISP_COUNT) ** 1.1;
      spiralPoint(i % arms, t * total, r0, p, pt);
      const across = gauss(rand) * R * (0.25 + 0.5 * t);
      wp[i * 3] = pt.x + Math.cos(pt.a) * across;
      wp[i * 3 + 1] = -R * (0.35 + 0.3 * rand());
      wp[i * 3 + 2] = pt.z + Math.sin(pt.a) * across;
      ws[i] = R * (1.8 + 1.6 * rand()) * (1 + t * 0.6);
      tmp.copy(butter).lerp(pink, t);
      wc[i * 4] = tmp.r;
      wc[i * 4 + 1] = tmp.g;
      wc[i * 4 + 2] = tmp.b;
      wc[i * 4 + 3] = 0.55 * (1 - t * 0.5);
    }
    this.wisps.pos.needsUpdate = true;
    this.wisps.size.needsUpdate = true;
    this.wisps.color.needsUpdate = true;
  }

  // 每帧：首页显示、星球视图淡出；你的星球后面的暖光跟着它（位置、大小）
  update(dt: number, home: boolean, you: { pos: THREE.Vector3; size: number } | null): void {
    const goal = home ? 1 : 0;
    const f = this.fade.value;
    this.fade.value = Math.abs(goal - f) < 0.01 ? goal : f + (goal - f) * (1 - Math.exp(-6 * dt));
    this.group.visible = this.fade.value > 0.001;
    this.glow.value = HOME_DUST.glow;
    this.wispK.value = HOME_DUST.wisps;
    this.haloK.value = you ? HOME_DUST.halo : 0;
    if (you) {
      this.halo.position.copy(you.pos);
      this.halo.scale.setScalar(you.size * 3.1);
    }
  }

  // 预编译用：全部显示（编译时跳过不可见的）
  showForCompile(): void {
    this.group.visible = true;
  }
}
