import * as THREE from 'three/webgpu';
import { FineLines, type FineSegment } from './fineLines';

// 第二版 [v2-world]：首页你的星球周围的「天体仪环」——两三圈细细的香槟金同心圆，带刻度（每 5° 一道短的、每 30° 一道长的），
// 各自斜着一点（赤道环、黄道环斜 23°、一圈接近竖直的子午环），整个慢慢转。正面看是围着星球的几道椭圆，侧面看像一架天体仪。
// 一份 FineLines（细线 + 几颗小星）：一次绘制；几何是静态的，每帧只改整体的位置、大小、转角

export const ARMILLARY = {
  on: 1, // 0 = 不要
  rings: 3, // 几圈（1–3）
  radius: 1.3, // 最里那圈的半径（× 你的星球在首页上的半径）（main 05:45：收小一点，1.38 → 1.3）
  spacing: 0.11, // 一圈比一圈大多少（× 半径）（0.14 → 0.11）
  tilt: 1, // 倾斜的倍数（0 = 都平放）
  speed: 1, // 转动速度的倍数
  ticks: 1, // 刻度（0 = 没有，1 = 默认）
  width: 1, // 线宽（像素）
  brightness: 1, // 亮度
};

const GOLD = new THREE.Color('#d8c08e'); // Champagne gold
const DEEP = new THREE.Color('#a8894f'); // Antique gold：短刻度、背面那几段淡一点
const SEG = 160; // 一圈多少段（圆上）

interface RingDef {
  euler: [number, number, number]; // 这一圈的倾斜（弧度）
  minor: number; // 一圈多少道短刻度（0 = 没有）
  majorEvery: number; // 每几道短刻度有一道长的
  alpha: number;
}

// 赤道环（斜一点）、黄道环（相对赤道环再斜 23°）、子午环（接近竖直）
const RINGS: RingDef[] = [
  { euler: [0.3, 0, 0.1], minor: 72, majorEvery: 6, alpha: 0.85 },
  { euler: [0.3 + 0.41, 0.7, 0.18], minor: 36, majorEvery: 9, alpha: 0.7 },
  { euler: [1.42, 0.35, 0], minor: 24, majorEvery: 6, alpha: 0.55 },
];

// 天体仪环最外面伸到离星球中心多远（× 你的星球在首页上的半径，连刻度）；关掉时是 0。
// 首页你的星球的名牌（ui/galaxyUi.ts）按它往下挪，名牌落在环的外面，不被环穿过
export function armillaryReach(): number {
  if (ARMILLARY.on <= 0) return 0;
  return ARMILLARY.radius + ARMILLARY.spacing * (THREE.MathUtils.clamp(Math.round(ARMILLARY.rings), 1, 3) - 1) + 0.075 * Math.min(1, ARMILLARY.ticks);
}

export class Armillary {
  readonly group = new THREE.Group();
  private lines: FineLines | null = null;
  private builtFor = '';
  private spin = 0;
  private fade = 0;

  constructor() {
    this.group.name = 'home-armillary';
    this.build();
  }

  // 按参数重建几何（?tune 改了圈数、刻度、倾斜才重建）
  build(): void {
    const key = JSON.stringify([ARMILLARY.rings, ARMILLARY.radius, ARMILLARY.spacing, ARMILLARY.tilt, ARMILLARY.ticks, ARMILLARY.width, ARMILLARY.brightness]);
    if (key === this.builtFor) return;
    this.builtFor = key;
    const rings = RINGS.slice(0, THREE.MathUtils.clamp(Math.round(ARMILLARY.rings), 1, 3));
    const segs: FineSegment[] = [];
    const stars: Array<{ at: THREE.Vector3; size: number; phase: number }> = [];
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const w = ARMILLARY.width;
    rings.forEach((ring, i) => {
      const r = ARMILLARY.radius + ARMILLARY.spacing * i;
      q.setFromEuler(e.set(ring.euler[0] * ARMILLARY.tilt, ring.euler[1], ring.euler[2] * ARMILLARY.tilt));
      const at = (ang: number, rr: number, out: THREE.Vector3) => out.set(Math.cos(ang) * rr, 0, Math.sin(ang) * rr).applyQuaternion(q);
      const col = GOLD.clone().multiplyScalar(1.15 * ARMILLARY.brightness);
      for (let k = 0; k < SEG; k++) {
        const a0 = (k / SEG) * Math.PI * 2;
        const a1 = ((k + 1) / SEG) * Math.PI * 2;
        segs.push({ a: at(a0, r, a).clone(), b: at(a1, r, b).clone(), width: w, color: col, alpha: ring.alpha });
      }
      // 刻度：往外的短线（长的每 majorEvery 道一道）
      const n = Math.round(ring.minor * Math.min(1, ARMILLARY.ticks));
      if (ARMILLARY.ticks > 0 && n > 0) {
        for (let k = 0; k < n; k++) {
          const ang = (k / n) * Math.PI * 2;
          const major = k % ring.majorEvery === 0;
          const len = major ? 0.075 : 0.032;
          segs.push({ a: at(ang, r, a).clone(), b: at(ang, r + len, b).clone(), width: w * (major ? 1 : 0.85), color: major ? col : DEEP.clone().multiplyScalar(1.3 * ARMILLARY.brightness), alpha: ring.alpha * (major ? 0.95 : 0.6) });
        }
      }
      // 每圈两颗小星：钉在环上（像天体仪上的铆钉），转起来时一闪一闪
      for (const ang of [0.6 + i * 1.7, 0.6 + i * 1.7 + Math.PI]) stars.push({ at: at(ang, r, a).clone(), size: 3.2, phase: ang * 3.7 });
    });
    this.lines?.dispose();
    const lines = new FineLines(segs.length, stars.length, { additive: true, twinkle: 0.5, twinkleSpeed: 1.3, name: 'home-armillary' });
    segs.forEach((s, i) => lines.setSegment(i, s));
    const starCol = new THREE.Color('#f6f1e7').multiplyScalar(1.6 * ARMILLARY.brightness);
    stars.forEach((s, i) => lines.setStar(i, { ...s, color: starCol, alpha: 0.9 }));
    lines.commit();
    lines.fade.value = this.fade;
    lines.mesh.renderOrder = -4; // 星尘（-6）、你的星球的暖光（-5）之后
    this.lines = lines;
    this.group.add(lines.mesh);
  }

  // 每帧：首页淡入、星球视图淡出；跟着你的星球（pos、size = 星球在首页上的半径），慢慢转
  update(dt: number, home: boolean, you: { pos: THREE.Vector3; size: number } | null, reduced: boolean): void {
    const on = home && you !== null && ARMILLARY.on > 0;
    this.fade += ((on ? 1 : 0) - this.fade) * (1 - Math.exp(-5 * dt));
    if (Math.abs(this.fade - (on ? 1 : 0)) < 0.002) this.fade = on ? 1 : 0;
    if (this.lines) this.lines.fade.value = this.fade;
    this.group.visible = this.fade > 0.001;
    if (!you || !this.group.visible) return;
    if (!reduced) this.spin += dt * 0.045 * ARMILLARY.speed;
    this.group.position.copy(you.pos);
    this.group.scale.setScalar(you.size);
    // 绕竖轴慢慢转，转轴再轻轻晃一点（不是死板地原地转）
    this.group.rotation.set(Math.sin(this.spin * 0.37) * 0.05, this.spin, Math.cos(this.spin * 0.29) * 0.04);
  }

  // 预编译时显示着（compileAsync 跳过不显示的）
  showForCompile(): void {
    this.group.visible = true;
  }
}
