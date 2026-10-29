import * as THREE from 'three/webgpu';
import { abs, attribute, cameraPosition, cross, float, length, max, modelWorldMatrixInverse, normalize, positionLocal, renderGroup, select, sin, smoothstep, time, uniform, vec3, vec4 } from 'three/tsl';

// 第二版 [v2-world] 的「细金线」：天体仪环、星座线、星座翠宝都用它。一份几何里放很多段线和很多颗小星，一次绘制。
// - 线：每段一个四边形，顶点着色器里把两端往「垂直于线段、也垂直于视线」的方向撑开，宽度按到镜头的距离换算成固定的像素宽
//   （屏幕上永远是 1 像素左右的细线，远近一样），四边形比线宽两边各多 1 个像素，片元里按到中线的距离做柔和的边（不锯齿、不闪）
// - 小星：每颗一个朝着镜头的四边形，十字形的四道细芒加一个亮点，按相位慢慢闪
// 每个顶点的颜色、透明度在 tint 属性里（CPU 改了 needsUpdate 就行：悬停时星座线变亮、星座翠宝一笔一笔亮起来都是改它）。
// 不写深度：星球挡得住它们（深度测试），它们不挡星球

// 屏幕上 1 个 CSS 像素在离镜头 1 个单位处是多少世界单位（2·tan(fov/2) / 画布高度）：每帧按主镜头更新一次（updateFineLines）
const PX = uniform(0.001).setGroup(renderGroup);

export function updateFineLines(camera: THREE.PerspectiveCamera, heightPx: number): void {
  PX.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, heightPx);
}

export interface FineSegment {
  a: THREE.Vector3;
  b: THREE.Vector3;
  width: number; // 线宽（CSS 像素）
  color: THREE.Color; // 线性颜色（可以大于 1：HDR，色调映射前）
  alpha: number;
}

export interface FineStar {
  at: THREE.Vector3;
  size: number; // 半径（CSS 像素）
  color: THREE.Color;
  alpha: number;
  phase: number; // 闪烁的相位（弧度）
}

export interface FineLinesOptions {
  additive?: boolean; // 叠加混合（夜空上像发光）；默认普通混合
  blend?: 'max'; // 取亮的那个（线和线接头重叠的地方不会叠出一个个亮点：一圈分很多段的圆线条均匀）
  twinkle?: number; // 小星闪烁的幅度 0..1
  twinkleSpeed?: number; // 闪烁的速度（弧度 / 秒）
  name?: string;
  // 四边形怎么排：默认先放所有的线、再放所有的小星；group：每组 segments 条线 + stars 颗小星连着放
  // （星座线一条线带两头两颗星：只画前 n 组时用 setDrawGroups 设绘制范围，后面没用到的组不画）
  group?: { segments: number; stars: number };
}

// 一批细线和小星：segments、stars 的数量建好以后不变（容量），位置、颜色可以改（setSegment / setStar 再 commit）
export class FineLines {
  readonly mesh: THREE.Mesh;
  readonly fade = uniform(1); // 整批的淡入淡出
  private readonly pos: THREE.BufferAttribute;
  private readonly other: THREE.BufferAttribute;
  private readonly tint: THREE.BufferAttribute;
  private readonly extra: THREE.BufferAttribute;
  readonly segments: number;
  readonly stars: number;
  private readonly grouped: boolean;
  private readonly gs: number; // 每组几条线（不分组时 = 全部）
  private readonly gt: number; // 每组几颗星

  constructor(segments: number, stars: number, opts: FineLinesOptions = {}) {
    this.segments = segments;
    this.stars = stars;
    this.grouped = !!opts.group;
    this.gs = opts.group ? opts.group.segments : segments;
    this.gt = opts.group ? opts.group.stars : stars;
    const nv = (segments + stars) * 4;
    const pos = new Float32Array(nv * 3);
    const other = new Float32Array(nv * 3);
    const corner = new Float32Array(nv * 2);
    const kind = new Float32Array(nv);
    const tint = new Float32Array(nv * 4);
    const extra = new Float32Array(nv * 2);
    const index: number[] = [];
    for (let s = 0; s < segments; s++) {
      const v = this.segQuad(s) * 4;
      // 角：x = 往哪一边撑（±1），y = 这一端是起点（0）还是终点（1）
      corner.set([-1, 0, 1, 0, -1, 1, 1, 1], v * 2);
    }
    for (let k = 0; k < stars; k++) {
      const v = this.starQuad(k) * 4;
      corner.set([-1, -1, 1, -1, -1, 1, 1, 1], v * 2);
      kind.fill(1, v, v + 4);
    }
    // 索引按四边形的顺序（分组时一组接一组）：绘制范围只画前面几组
    for (let q = 0; q < segments + stars; q++) {
      const v = q * 4;
      index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(pos, 3);
    this.other = new THREE.BufferAttribute(other, 3);
    this.tint = new THREE.BufferAttribute(tint, 4);
    this.extra = new THREE.BufferAttribute(extra, 2);
    for (const a of [this.pos, this.other, this.tint, this.extra]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('other', this.other);
    g.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    g.setAttribute('kind', new THREE.BufferAttribute(kind, 1));
    g.setAttribute('tint', this.tint);
    g.setAttribute('extra', this.extra);
    g.setIndex(index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide });
    m.name = opts.name ?? 'fine-lines';
    if (opts.additive) m.blending = THREE.AdditiveBlending;
    if (opts.blend === 'max') {
      m.blending = THREE.CustomBlending;
      m.blendEquation = THREE.MaxEquation;
      m.blendSrc = THREE.OneFactor;
      m.blendDst = THREE.OneFactor;
      m.blendEquationAlpha = THREE.MaxEquation;
      m.blendSrcAlpha = THREE.OneFactor;
      m.blendDstAlpha = THREE.OneFactor;
    }
    const P = positionLocal;
    const O = attribute<'vec3'>('other', 'vec3');
    const C = attribute<'vec2'>('corner', 'vec2');
    const K = attribute<'float'>('kind', 'float');
    const T = attribute<'vec4'>('tint', 'vec4');
    const E = attribute<'vec2'>('extra', 'vec2'); // 线：x = 线宽（像素）；小星：x = 半径（像素），y = 相位
    // 镜头在本地坐标里的位置（物体可以整体平移、旋转、等比缩放）
    const camL = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
    const toCam = camL.sub(P);
    const dist = length(toCam).max(1e-4);
    const view = toCam.div(dist);
    // 线：终点那一头把方向反过来，两头撑开的方向一致（不拧成蝴蝶结）
    const dir = normalize(O.sub(P).add(vec3(1e-6, 0, 0))).mul(float(1).sub(C.y.mul(2)));
    const side = normalize(cross(dir, view).add(vec3(0, 1e-6, 0)));
    const halfQuad = E.x.mul(0.5).add(1); // 半个四边形宽（像素）：线宽的一半 + 1 个像素的软边
    const linePos = P.add(side.mul(C.x.mul(halfQuad).mul(PX).mul(dist)));
    // 小星：朝着镜头的四边形（镜头几乎正上方往下看时换一个辅助轴）
    const helper = select(abs(view.y).greaterThan(0.985), vec3(1, 0, 0), vec3(0, 1, 0));
    const right = normalize(cross(helper, view));
    const up = cross(view, right);
    const starPos = P.add(right.mul(C.x).add(up.mul(C.y)).mul(E.x.mul(PX).mul(dist)));
    m.positionNode = select(K.greaterThan(0.5), starPos, linePos);
    // 片元：线按到中线的像素距离做柔和的边；小星是一个亮点加十字细芒，外面一圈很淡的晕
    const across = abs(C.x).mul(halfQuad);
    const lineA = smoothstep(E.x.mul(0.5).add(0.65), E.x.mul(0.5).sub(0.35), across);
    const r = length(C);
    const core = smoothstep(0.3, 0.0, r);
    const rayX = smoothstep(0.1, 0.0, abs(C.y)).mul(smoothstep(1.0, 0.05, abs(C.x)));
    const rayY = smoothstep(0.1, 0.0, abs(C.x)).mul(smoothstep(1.0, 0.05, abs(C.y)));
    const glowR = smoothstep(1.0, 0.0, r).pow(3).mul(0.35);
    const amp = opts.twinkle ?? 0.25;
    const tw = sin(time.mul(opts.twinkleSpeed ?? 1.1).add(E.y)).mul(amp * 0.5).add(1 - amp * 0.5);
    const starA = max(core, max(rayX, rayY).mul(0.75)).add(glowR).mul(tw).clamp(0, 1);
    const a = select(K.greaterThan(0.5), starA, lineA).mul(T.w).mul(this.fade);
    // 叠加混合是 SrcAlpha · One：颜色乘一次透明度就够；取亮混合（Max）不乘因子：颜色自己先乘好透明度
    m.colorNode = opts.blend === 'max' ? vec4(T.xyz.mul(a), a) : vec4(T.xyz, a);
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.name = m.name;
    this.mesh.frustumCulled = false;
  }

  // 第 i 条线、第 i 颗星是第几个四边形
  private segQuad(i: number): number {
    return this.grouped ? Math.floor(i / this.gs) * (this.gs + this.gt) + (i % this.gs) : i;
  }

  private starQuad(i: number): number {
    return this.grouped ? Math.floor(i / this.gt) * (this.gs + this.gt) + this.gs + (i % this.gt) : this.segments + i;
  }

  setSegment(i: number, s: FineSegment): void {
    this.setSegmentRaw(i, s.a, s.b, s.width, s.color, s.alpha);
  }

  setStar(i: number, s: FineStar): void {
    this.setStarRaw(i, s.at, s.size, s.color, s.alpha, s.phase);
  }

  // 和 setSegment / setStar 一样，参数直接传（不用拼对象：每帧都要调的地方不分配内存）。
  // 直接写类型数组（不一个顶点一个顶点地调 setXYZ：没内联的调用要把浮点参数装箱，热路径里会产生垃圾）
  setSegmentRaw(i: number, a: THREE.Vector3, b: THREE.Vector3, width: number, color: THREE.Color, alpha: number): void {
    const v = this.segQuad(i) * 4;
    const P = this.pos.array as Float32Array;
    const O = this.other.array as Float32Array;
    const T = this.tint.array as Float32Array;
    const E = this.extra.array as Float32Array;
    for (let k = 0; k < 4; k++) {
      const end = k < 2 ? a : b;
      const far = k < 2 ? b : a;
      const j3 = (v + k) * 3;
      const j4 = (v + k) * 4;
      const j2 = (v + k) * 2;
      P[j3] = end.x;
      P[j3 + 1] = end.y;
      P[j3 + 2] = end.z;
      O[j3] = far.x;
      O[j3 + 1] = far.y;
      O[j3 + 2] = far.z;
      T[j4] = color.r;
      T[j4 + 1] = color.g;
      T[j4 + 2] = color.b;
      T[j4 + 3] = alpha;
      E[j2] = width;
      E[j2 + 1] = 0;
    }
  }

  setStarRaw(i: number, at: THREE.Vector3, size: number, color: THREE.Color, alpha: number, phase: number): void {
    const v = this.starQuad(i) * 4;
    const P = this.pos.array as Float32Array;
    const O = this.other.array as Float32Array;
    const T = this.tint.array as Float32Array;
    const E = this.extra.array as Float32Array;
    for (let k = 0; k < 4; k++) {
      const j3 = (v + k) * 3;
      const j4 = (v + k) * 4;
      const j2 = (v + k) * 2;
      P[j3] = at.x;
      P[j3 + 1] = at.y;
      P[j3 + 2] = at.z;
      O[j3] = at.x;
      O[j3 + 1] = at.y;
      O[j3 + 2] = at.z;
      T[j4] = color.r;
      T[j4 + 1] = color.g;
      T[j4 + 2] = color.b;
      T[j4 + 3] = alpha;
      E[j2] = size;
      E[j2 + 1] = phase;
    }
  }

  // 只改透明度（悬停变亮、一笔一笔亮起来）：i 是线的序号；star = true 时是小星的序号
  setAlpha(i: number, alpha: number, star = false): void {
    const v = (star ? this.starQuad(i) : this.segQuad(i)) * 4;
    const T = this.tint.array as Float32Array;
    for (let k = 0; k < 4; k++) T[(v + k) * 4 + 3] = alpha;
  }

  // 只画前 n 组（分组的排法；不分组时 n 组就是全部）：几何、缓冲都不换，只改绘制范围
  setDrawGroups(n: number): void {
    this.mesh.geometry.setDrawRange(0, Math.max(0, n) * (this.gs + this.gt) * 6);
  }

  get drawCount(): number {
    return this.mesh.geometry.drawRange.count;
  }

  // 用不上的线、小星：透明度 0（四边形还在，不画出东西）
  hideFrom(segment: number, star: number): void {
    for (let i = segment; i < this.segments; i++) this.setAlpha(i, 0);
    for (let i = star; i < this.stars; i++) this.setAlpha(i, 0, true);
  }

  // 改好的数据传上去（整份传：几十 KB 以内，只在真的变了的那一帧传）。
  // 不用局部上传的范围：three 传完以后把 updateRanges 清成长度 0，下一次再 push 就要重新分配数组，热路径里会分配内存
  commit(geometry = true): void {
    if (geometry) {
      this.pos.needsUpdate = true;
      this.other.needsUpdate = true;
      this.extra.needsUpdate = true;
    }
    this.tint.needsUpdate = true;
  }

  // 自查：缓冲是不是还是原来那几份（换版式时不重新分配）
  get buffers(): readonly ArrayLike<number>[] {
    return [this.pos.array, this.other.array, this.extra.array, this.tint.array];
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}
