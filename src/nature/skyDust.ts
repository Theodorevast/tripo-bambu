import * as THREE from 'three/webgpu';
import { cameraPosition, float, fract, instancedBufferAttribute, length, max, mix, sin, smoothstep, time, uniform, uv, vec3, vec4 } from 'three/tsl';
import { NIGHT_SKY, NIGHT_U } from './nightSky';

// 首页空气里的星屑（v2-sky，main 要的）：镜头和云海之间飘着一层很稀的微小星点，慢慢漂、轻轻闪——一打开首页就知道「在星空里」。
// 一次绘制：朝向镜头的小面片（SpriteNodeMaterial + 每个实例的位置、随机数），叠加混合、不写深度（星球挡得住它们）。
// 位置在一个盒子里（星系中心上方、云顶以上）按时间平移再取模绕回来：一直漂、永远铺满，CPU 每帧只推几个 uniform；
// 盒子边上淡出，绕回来的那一下看不出来。大小按像素定（远近都是一两个像素的细点），只在首页、夜里显示。
// 参数：NIGHT_SKY 的 dust、dustSize、dustDrift、dustTwinkle（?tune → Night sky）

const COUNT = 720;
const SPREAD = 16; // 水平方向铺多大（半边长，× 星球半径）
const HEIGHT = 9; // 从云顶往上多高（× 星球半径）
const LIFT = 0.5; // 最低的一粒离云顶多高（× 星球半径）：在云顶以下的会被云海盖住才对（云海不写深度，叠加的星屑会透出来）

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

export interface SkyDustFrame {
  dt: number;
  center: THREE.Vector3; // 星系中心（世界）
  radius: number; // 星球半径
  seaTop: number; // 云顶的高度（沿 up，相对 center）
  e1: THREE.Vector3; // 标架
  up: THREE.Vector3;
  e2: THREE.Vector3;
  home: number; // 0..1：首页
  pixelAngle: number; // 一个像素的张角（弧度）
  shown: boolean;
}

export interface SkyDust {
  readonly sprite: THREE.Sprite;
  update(f: SkyDustFrame): void;
  dispose(): void;
}

export function createSkyDust(): SkyDust {
  const r = rng(271);
  const box = new Float32Array(COUNT * 3); // 盒子里的位置（0..1）
  const seed = new Float32Array(COUNT * 4); // 亮度、闪烁相位、闪烁快慢、冷暖
  for (let i = 0; i < COUNT; i++) {
    box.set([r(), Math.pow(r(), 1.4), r()], i * 3); // 往下（靠近云顶）稍微密一点
    seed.set([Math.pow(r(), 2.5), r(), r(), r()], i * 4);
  }
  const U = {
    origin: uniform(new THREE.Vector3()), // 盒子的一个角（世界）
    ax: uniform(new THREE.Vector3(1, 0, 0)), // 盒子的三条边（世界，带长度）
    ay: uniform(new THREE.Vector3(0, 1, 0)),
    az: uniform(new THREE.Vector3(0, 0, 1)),
    drift: uniform(new THREE.Vector3()), // 漂过的距离（盒子坐标，取模前；CPU 按 dt 累加：慢放、逐帧录屏时也跟着）
    fade: uniform(0),
    size: uniform(0.001), // 一个像素的张角 × 像素数
    twinkle: uniform(0.6),
  };
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  m.name = 'sky-dust';
  m.blending = THREE.AdditiveBlending;
  const b = instancedBufferAttribute(new THREE.InstancedBufferAttribute(box, 3)) as unknown as THREE.Node<'vec3'>;
  const s = instancedBufferAttribute(new THREE.InstancedBufferAttribute(seed, 4)) as unknown as THREE.Node<'vec4'>;
  // 每粒自己再慢慢晃一点（不是整片一起平移）
  const wob = vec3(sin(time.mul(0.11).add(s.y.mul(6.28))), sin(time.mul(0.07).add(s.z.mul(6.28))).mul(0.4), sin(time.mul(0.09).add(s.w.mul(6.28)))).mul(0.006);
  const q = fract(b.add(U.drift).add(wob)).toVar(); // 0..1，绕回来
  const world = U.origin.add(U.ax.mul(q.x)).add(U.ay.mul(q.y)).add(U.az.mul(q.z)).toVar();
  m.positionNode = world;
  m.scaleNode = length(world.sub(cameraPosition)).mul(U.size).mul(s.x.mul(0.9).add(0.7));
  // 盒子边上淡出（绕回来的那一下看不出来）
  const edge = (v: THREE.Node<'float'>) => smoothstep(0, 0.08, v).mul(smoothstep(1, 0.92, v));
  const inBox = edge(q.x).mul(edge(q.y)).mul(edge(q.z));
  const tw = float(1).sub(U.twinkle.mul(sin(time.mul(s.z.mul(1.4).add(0.5)).add(s.y.mul(40))).mul(0.5).add(0.5)));
  const d = length(uv().sub(0.5)).mul(2);
  const spot = smoothstep(1, 0, d).mul(smoothstep(1, 0.25, d));
  const color = mix(vec3(0.85, 0.9, 1.15), vec3(1.15, 1.0, 0.82), s.w);
  const k = spot.mul(s.x.mul(2.4).add(0.35)).mul(tw).mul(inBox).mul(U.fade);
  m.colorNode = vec4(color.mul(k), max(k, 0));
  const sprite = new THREE.Sprite(m);
  sprite.name = 'sky-dust';
  sprite.count = COUNT;
  sprite.frustumCulled = false;
  sprite.renderOrder = -8.5; // 云海（-10）、远处积云（-9）之后，首页星系的点缀（-8 … -5）之前
  sprite.raycast = () => {};

  return {
    sprite,
    update(f) {
      const amount = Math.max(0, NIGHT_SKY.dust) * f.home * NIGHT_U.night.value;
      U.fade.value = amount;
      sprite.visible = f.shown && amount > 0.002;
      if (!sprite.visible) return;
      const w = SPREAD * f.radius;
      U.origin.value.copy(f.center).addScaledVector(f.e1, -w).addScaledVector(f.e2, -w).addScaledVector(f.up, f.seaTop + LIFT * f.radius);
      U.ax.value.copy(f.e1).multiplyScalar(2 * w);
      U.ay.value.copy(f.up).multiplyScalar(HEIGHT * f.radius);
      U.az.value.copy(f.e2).multiplyScalar(2 * w);
      U.size.value = f.pixelAngle * Math.max(0.3, NIGHT_SKY.dustSize);
      U.twinkle.value = THREE.MathUtils.clamp(NIGHT_SKY.dustTwinkle, 0, 1);
      // 漂：水平方向很慢地往一边走，竖直方向更慢（盒子坐标：1 = 盒子一整边）
      const v = Math.max(0, NIGHT_SKY.dustDrift) * f.dt;
      U.drift.value.x = (U.drift.value.x + v * 0.0021) % 1;
      U.drift.value.y = (U.drift.value.y + v * 0.0013) % 1;
      U.drift.value.z = (U.drift.value.z + v * 0.0009) % 1;
    },
    dispose() {
      sprite.removeFromParent();
      m.dispose();
    },
  };
}
