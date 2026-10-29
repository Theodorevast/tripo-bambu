import * as THREE from 'three/webgpu';
import { PRESETS } from '../planet/presets';
import type { ModelLibrary } from '../assets/models';
import { easeInBack, easeOutBack, smooth, span } from './ease';
import { loadMascot, type Mascot } from './mascot';
import { PEEK } from './shots';
import type { PlanetEntry } from './world';

// 开场的品牌露出（T2）：页面加载完、开场飞行落定以后，翠宝从一颗星球后面探出头、挥一下手、再缩回去（约 2.4 秒）。
// 翠宝没有骨骼：整体位移、歪头（绕视线倾斜）、身体轻轻伸缩，手臂套一个放在肩膀上的 Group 来摆。
// 它站在星球「背后」（比星球中心离镜头远一点），身体沿屏幕的上方向升降：缩着的时候整个被星球挡住，探头时上半身露出星球的上缘。
// 星球、镜头都在动（星系自转）：每帧按当前镜头重新摆。大小按画面高度的比例算（PEEK.size），离得远近都一样醒目

interface Arm {
  pivot: THREE.Object3D; // 绕本地 Z 转：正的往外抬（+X 那只往 +X，-X 那只镜像）
  side: 1 | -1;
  rest: number; // 原来的转角
}

// 找手臂、在肩膀上套一个转轴。GLB：Arm_L / Arm_R 和 Hand_L / Hand_R（L 在 +X，正面朝 +Z）；替身：挂着磨砂手臂的那两个肩膀 Group
function rigArms(root: THREE.Object3D): Arm[] {
  root.updateMatrixWorld(true);
  const arms: Arm[] = [];
  for (const [suffix, side] of [['L', 1], ['R', -1]] as const) {
    const arm = root.getObjectByName(`Arm_${suffix}`);
    if (!arm?.parent) continue;
    const hand = root.getObjectByName(`Hand_${suffix}`);
    const box = new THREE.Box3().setFromObject(arm);
    // 肩膀：手臂包围盒顶上、靠身体一侧
    const shoulder = new THREE.Vector3(side > 0 ? box.min.x : box.max.x, box.max.y, (box.min.z + box.max.z) / 2);
    const pivot = new THREE.Group();
    pivot.name = `peek-shoulder-${suffix}`;
    arm.parent.add(pivot);
    pivot.position.copy(arm.parent.worldToLocal(shoulder));
    pivot.updateMatrixWorld(true);
    pivot.attach(arm);
    if (hand) pivot.attach(hand);
    arms.push({ pivot, side, rest: 0 });
  }
  if (arms.length) return arms;
  // 替身：肩膀 Group 的子网格用磨砂材质
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh.material as THREE.Material).name !== 'triboo-frosted' || !mesh.parent || mesh.parent === root) return;
    const g = mesh.parent;
    if (arms.some((a) => a.pivot === g)) return;
    arms.push({ pivot: g, side: g.position.x >= 0 ? 1 : -1, rest: g.rotation.z });
  });
  return arms;
}

const _v = new THREE.Vector3();
const _u = new THREE.Vector3();
const _r = new THREE.Vector3();
const _z = new THREE.Vector3();
const _p = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

export class TribooPeek {
  // 模型准备好（加载完、着色器在后台编好）时 resolve；还没好时不探头
  readonly ready: Promise<Mascot | null>;
  private mascot: Mascot | null = null;
  private arms: Arm[] = [];
  private entry: PlanetEntry | null = null;
  private t = 0;
  private lean = 1; // 往哪边歪：+1 朝画面右边
  private playing = false;

  // precompile：模型挂上场景之前把贴图、着色器准备好（World 的 Stager）
  // library：从哪个模型库拿翠宝（World 共用的那个：和站桩、漫游的翠宝同一份 GLB，只下载、解析一次）
  constructor(precompile: (object: THREE.Object3D) => Promise<void>, library?: ModelLibrary) {
    this.ready = loadMascot(library)
      .then(async (m) => {
        m.object.traverse((o) => {
          o.castShadow = false;
          o.receiveShadow = false;
        });
        this.arms = rigArms(m.object);
        await precompile(m.object);
        this.mascot = m;
        return m;
      })
      .catch((err: unknown) => {
        console.warn('Triboo peek unavailable', err);
        return null;
      });
  }

  get active(): boolean {
    return this.playing;
  }

  // 在 entry 这颗星球后面探头。镜头、星球由调用方挑好（Director.peekIntro）
  play(entry: PlanetEntry, camera: THREE.PerspectiveCamera, scene: THREE.Scene): boolean {
    const mascot = this.mascot;
    if (!mascot) return false;
    this.cancel();
    this.entry = entry;
    this.t = 0;
    this.playing = true;
    // 往画面中间那一侧歪
    _p.copy(entry.home).project(camera);
    this.lean = _p.x > 0 ? -1 : 1;
    scene.add(mascot.object);
    this.place(camera);
    return true;
  }

  cancel(): void {
    if (!this.mascot) return;
    this.playing = false;
    this.entry = null;
    this.mascot.object.removeFromParent();
    for (const a of this.arms) a.pivot.rotation.z = a.rest;
  }

  // 每帧（镜头摆好之后、渲染之前）
  tick(dt: number, camera: THREE.PerspectiveCamera): void {
    if (!this.playing || !this.mascot) return;
    this.t += dt;
    if (this.t >= this.duration) {
      this.cancel();
      return;
    }
    this.place(camera);
  }

  get duration(): number {
    return PEEK.delay + PEEK.rise + PEEK.wave + PEEK.duck;
  }

  private place(camera: THREE.PerspectiveCamera): void {
    const mascot = this.mascot!;
    const entry = this.entry!;
    const o = mascot.object;
    const time = this.t - PEEK.delay;
    const tRise = PEEK.rise;
    const tWave = tRise + PEEK.wave;
    // 升降：0 = 整个藏在星球后面，1 = 探出头（回弹）；缩回去时先往上一提再加速落下（预备动作）
    let h = 0;
    if (time > 0 && time < tRise) h = easeOutBack(time / tRise, 1.9);
    else if (time >= tRise && time < tWave) h = 1;
    else if (time >= tWave) h = 1 - easeInBack(span(time, tWave, tWave + PEEK.duck), 1.6);
    // 歪头跟着升降走；挥手时身体跟着手轻轻晃
    const waveT = span(time, tRise, tWave);
    const wavePhase = Math.sin(waveT * Math.PI * 2 * PEEK.waves);
    const raise = smooth(span(waveT, 0, 0.16)) * (1 - smooth(span(waveT, 0.84, 1)));
    const leanDeg = PEEK.lean * Math.min(1, Math.max(0, h)) * this.lean + raise * wavePhase * 3;
    // 屏幕的上、右方向（垂直于看星球的视线）
    const dist = _v.copy(entry.home).sub(camera.position).length();
    _v.divideScalar(dist || 1);
    _u.set(0, 1, 0).applyQuaternion(camera.quaternion);
    _u.addScaledVector(_v, -_u.dot(_v)).normalize();
    _r.crossVectors(_v, _u);
    // 大小：画面高度的 PEEK.size
    const height = PEEK.size * 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const k = height / mascot.height;
    // 星球轮廓的半径（地形最高处，按星球现在的缩放）；翠宝站在星球中心后面一点，投影出来要再高一点才露出来
    const radius = entry.planet.radius * entry.planet.group.scale.x;
    const behind = radius * 0.35;
    const rim = radius * (1 + PRESETS[entry.planet.currentRecipe.preset].amp) * (1 + behind / Math.max(1, dist));
    const hidden = rim * 0.85 - height * 1.05; // 头顶也在轮廓下面
    const shown = rim - height * 0.43; // 身体（球）的中心比轮廓高一点：logo 露出来
    const y = hidden + (shown - hidden) * h;
    o.position.copy(entry.home).addScaledVector(_u, y).addScaledVector(_v, behind);
    // 朝向：脚底的「上」是屏幕上方歪一点，正面对着镜头
    const a = THREE.MathUtils.degToRad(leanDeg);
    _p.copy(_u).multiplyScalar(Math.cos(a)).addScaledVector(_r, Math.sin(a)); // 绕视线转：正的往画面右边歪
    _z.copy(_v).negate();
    _r.crossVectors(_p, _z);
    _m.makeBasis(_r, _p, _z);
    _q.setFromRotationMatrix(_m);
    o.quaternion.copy(_q);
    // 探头时竖着拉长一点、落定时回到原样（挤压拉伸）
    const stretch = 1 + 0.1 * Math.sin(Math.PI * Math.min(1, Math.max(0, time / tRise))) * (time < tRise ? 1 : 0);
    o.scale.set(k / Math.sqrt(stretch), k * stretch, k / Math.sqrt(stretch));
    // 挥手：歪向哪边就用另一只手（举起来的手在高的那一侧，离星球远）
    for (const arm of this.arms) {
      const waving = arm.side === -this.lean;
      const up = waving ? raise * (2.25 + THREE.MathUtils.degToRad(PEEK.swing) * wavePhase) : 0;
      arm.pivot.rotation.z = arm.rest + arm.side * up;
    }
    o.updateMatrixWorld(true);
  }
}
