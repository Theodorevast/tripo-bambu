import * as THREE from 'three/webgpu';
import { atan, attribute, cos, exp, float, length, max, mix, positionGeometry, pow, renderGroup, select, sin, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import { mulberry32 } from '../planet/rng';

// 摆放的反馈（stage 角色）：作品落地时脚下扬起一圈尘土。和生机层的脚步扬尘同一个思路（CPU 发射、GPU 演化）：
// 落地时 CPU 往环形缓冲里写十几条（出生点、出生时间、初速度、大小、寿命），之后整个寿命都在顶点着色器里按年龄算，CPU 不逐粒更新。
// 一个网格、一次绘制；没有尘土在飞的时候整个藏起来，不画

const SLOTS = 160;

export class DustPuffs {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly a: THREE.InstancedBufferAttribute; // 出生点 xyz（世界坐标），出生时间
  private readonly b: THREE.InstancedBufferAttribute; // 初速度 xyz，随机数
  private readonly c: THREE.InstancedBufferAttribute; // 「上」xyz，寿命
  private readonly d: THREE.InstancedBufferAttribute; // 初始大小，最终大小，不透明度，阻力
  private readonly time = uniform(0).setGroup(renderGroup);
  private readonly camRight = uniform(new THREE.Vector3(1, 0, 0)).setGroup(renderGroup);
  private readonly camUp = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup);
  private readonly rng = mulberry32(4242);
  private head = 0;
  private clock = 0;
  private until = -1; // 最后一粒什么时候消失（秒）：过了就藏起来

  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.instanceCount = SLOTS;
    const dyn = () => {
      const x = new THREE.InstancedBufferAttribute(new Float32Array(SLOTS * 4), 4);
      x.setUsage(THREE.DynamicDrawUsage);
      return x;
    };
    this.a = dyn();
    this.b = dyn();
    this.c = dyn();
    this.d = dyn();
    for (let i = 0; i < SLOTS; i++) this.a.array[i * 4 + 3] = -1e4;
    g.setAttribute('aA', this.a);
    g.setAttribute('aB', this.b);
    g.setAttribute('aC', this.c);
    g.setAttribute('aD', this.d);
    this.geometry = g;

    const A = attribute<'vec4'>('aA', 'vec4');
    const B = attribute<'vec4'>('aB', 'vec4');
    const C = attribute<'vec4'>('aC', 'vec4');
    const D = attribute<'vec4'>('aD', 'vec4');
    const age = this.time.sub(A.w);
    const life = C.w;
    const k = age.div(life).clamp(0, 1);
    const alive = select(age.greaterThanEqual(0).and(age.lessThan(life)), float(1), float(0));
    const drag = D.w;
    // 往外冲、很快慢下来，同时慢慢往上飘
    const travel = float(1).sub(exp(drag.negate().mul(age))).div(drag);
    const center = A.xyz.add(B.xyz.mul(travel)).add(C.xyz.mul(age.mul(0.22).add(travel.mul(0.12))));
    const grow = float(1).sub(pow(float(1).sub(k), 2.2));
    const size = mix(D.x, D.y, grow).mul(alive);
    const rot = B.w.mul(6.283).add(age.mul(0.8));
    const corner = positionGeometry.xy;
    const cr = cos(rot);
    const sr = sin(rot);
    const rc = vec2(corner.x.mul(cr).sub(corner.y.mul(sr)), corner.x.mul(sr).add(corner.y.mul(cr)));
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    m.name = 'stage-dust';
    m.positionNode = center.add(this.camRight.mul(rc.x.mul(size))).add(this.camUp.mul(rc.y.mul(size)));
    // 团状的软边：半径按角度起伏一点（不是正圆），边缘软
    const r = length(positionGeometry.xy);
    const ang = atan(positionGeometry.y, positionGeometry.x);
    const puff = pow(float(1).sub(smoothstep(0.25, 1, r.mul(sin(ang.mul(3).add(B.w.mul(40))).mul(0.13).add(1)))), 1.4);
    const fade = smoothstep(0, 0.06, k).mul(pow(float(1).sub(k), 1.5));
    // 暖色的土：中心亮一点，像被阳光照着的尘
    m.colorNode = mix(vec3(0.66, 0.56, 0.44), vec3(0.86, 0.78, 0.66), max(float(0), float(1).sub(r)).mul(0.8).add(B.w.mul(0.2)));
    m.opacityNode = puff.mul(fade).mul(D.z);
    this.material = m;
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'stage-dust';
    mesh.frustumCulled = false; // 顶点在着色器里算，包围球不代表实际位置
    mesh.renderOrder = 11; // 画在不透明物体、天空和云海之后
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    this.mesh = mesh;
  }

  // 一圈尘土：center 是落点（世界坐标），up 是那里的「上」，radius 是展台半径（米），scale 是作品的放大倍数（大作品、星球视图里尘也大）
  puff(center: THREE.Vector3, up: THREE.Vector3, radius: number, scale: number, strength = 1): void {
    const n = Math.round(14 + 6 * strength);
    const t1 = new THREE.Vector3(Math.abs(up.y) < 0.9 ? 0 : 1, Math.abs(up.y) < 0.9 ? 1 : 0, 0).cross(up).normalize();
    const t2 = new THREE.Vector3().crossVectors(up, t1);
    const out = new THREE.Vector3();
    const pos = new THREE.Vector3();
    let longest = 0;
    for (let i = 0; i < n; i++) {
      const rng = this.rng;
      const a = (i / n) * Math.PI * 2 + rng() * 0.4;
      out.copy(t1).multiplyScalar(Math.cos(a)).addScaledVector(t2, Math.sin(a));
      pos.copy(center).addScaledVector(out, radius * (0.85 + rng() * 0.2)).addScaledVector(up, 0.04 * scale);
      const speed = (0.9 + rng() * 0.9) * scale * (0.7 + 0.3 * strength);
      const life = 0.65 + rng() * 0.45;
      longest = Math.max(longest, life);
      const s0 = (0.08 + rng() * 0.06) * scale;
      const s1 = (0.26 + rng() * 0.2) * scale * (0.8 + 0.2 * strength);
      this.emit(pos, out.multiplyScalar(speed), up, life, s0, s1, 0.5 + rng() * 0.2, 4.5 + rng() * 2);
    }
    // 中间往上冒的两三团
    for (let i = 0; i < 3; i++) {
      const rng = this.rng;
      out.copy(t1).multiplyScalar(rng() - 0.5).addScaledVector(t2, rng() - 0.5).multiplyScalar(0.5).addScaledVector(up, 0.6 + rng() * 0.4);
      pos.copy(center).addScaledVector(up, 0.05 * scale);
      const life = 0.7 + rng() * 0.3;
      longest = Math.max(longest, life);
      this.emit(pos, out.multiplyScalar(0.7 * scale), up, life, 0.1 * scale, (0.3 + rng() * 0.15) * scale, 0.32, 3.5);
    }
    this.until = Math.max(this.until, this.clock + longest + 0.05);
    this.mesh.visible = true;
  }

  private emit(pos: THREE.Vector3, vel: THREE.Vector3, up: THREE.Vector3, life: number, s0: number, s1: number, opacity: number, drag: number): void {
    const i = this.head;
    this.head = (this.head + 1) % SLOTS;
    this.a.setXYZW(i, pos.x, pos.y, pos.z, this.clock);
    this.b.setXYZW(i, vel.x, vel.y, vel.z, this.rng());
    this.c.setXYZW(i, up.x, up.y, up.z, life);
    this.d.setXYZW(i, s0, s1, opacity, drag);
    this.a.needsUpdate = this.b.needsUpdate = this.c.needsUpdate = this.d.needsUpdate = true;
  }

  // 预编译用：临时显示（编译时跳过不可见的）
  showForCompile(on: boolean): void {
    this.mesh.visible = on || this.clock < this.until;
  }

  // 每帧：推进时钟，面片朝向镜头；没有尘土在飞就藏起来
  update(dt: number, camera: THREE.Camera): void {
    this.clock += dt;
    this.time.value = this.clock;
    if (!this.mesh.visible) return;
    const e = camera.matrixWorld.elements;
    this.camRight.value.set(e[0], e[1], e[2]).normalize();
    this.camUp.value.set(e[4], e[5], e[6]).normalize();
    if (this.clock > this.until) this.mesh.visible = false;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
