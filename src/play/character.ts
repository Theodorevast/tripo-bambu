import * as THREE from 'three/webgpu';
import { tribooUrl } from '../assets/brand';
import type { ModelLibrary } from '../assets/models';
import { easeOutBack } from '../scenes/stager';
import { Gait } from './gait';
import { CHAR_HEIGHT, CHAR_RADIUS, WALK_ANIM } from './params';
import { buildTribooRig, type TribooRig } from './rig';
import { signedAngle } from './sphere';
import type { Walker } from './walker';

const APPEAR_SECONDS = 0.35; // 出场：从小长大，带一点回弹（和作品上场一样）
const LEAVE_SECONDS = 0.22;

// 找不到翠宝模型时的占位：一个胶囊体（身高、半径和碰撞体一样），正面一块黄色面罩，看得出朝哪边
export function capsuleCharacter(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'walker-capsule';
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(CHAR_RADIUS, CHAR_HEIGHT - 2 * CHAR_RADIUS, 6, 20),
    new THREE.MeshStandardNodeMaterial({ color: '#26262b', roughness: 0.4 }),
  );
  body.position.y = CHAR_HEIGHT / 2;
  const visor = new THREE.Mesh(new THREE.SphereGeometry(CHAR_RADIUS * 0.42, 20, 12), new THREE.MeshStandardNodeMaterial({ color: '#f2b705', roughness: 0.5 }));
  visor.scale.set(1, 0.55, 0.4);
  visor.position.set(0, CHAR_HEIGHT * 0.68, CHAR_RADIUS * 0.93);
  group.add(body, visor);
  return group;
}

// 角色模型：品牌的翠宝 GLB（public/brand/triboo.glb，assets/brand.ts；走作品同一套加载：meshopt 解码、各向异性），缩放到 CHAR_HEIGHT；
// 读不了就用胶囊体，不报错
export async function loadCharacter(library: ModelLibrary): Promise<{ object: THREE.Object3D; triboo: boolean }> {
  const model = await library.load({ id: 'walker-triboo', file: tribooUrl() });
  if (!model.failed) {
    model.object.scale.setScalar(CHAR_HEIGHT / model.height);
    return { object: model.object, triboo: true };
  }
  return { object: capsuleCharacter(), triboo: false };
}

// 系统的「减少动态效果」：开页时问一次，之后听变化（每帧不调 matchMedia）
let reduced = false;
let watching = false;
function reducedMotion(): boolean {
  if (!watching && typeof matchMedia === 'function') {
    watching = true;
    const q = matchMedia('(prefers-reduced-motion: reduce)');
    reduced = q.matches;
    q.addEventListener?.('change', (e) => { reduced = e.matches; });
  }
  return reduced;
}

const _x = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _d = new THREE.Vector3();
const _hip = new THREE.Vector3();
const _ankle = new THREE.Vector3();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const DOWN = new THREE.Vector3(0, -1, 0);

// 角色的 3D 外形和动作。翠宝的 GLB 拆成部件（rig.ts）：脚按步态一步一步踩（着地时钉在地上，不打滑），腿跟着脚，
// 手臂和同侧的腿反着摆，身体颠、压扁拉长、重心左右移、肩胯反向转，加速、转弯时前倾、往里倾（gait.ts 算，这里摆）。
// 胶囊体占位没有部件：只整体颠、倾、伸缩。转身跟着 Walker 的朝向
export class CharacterView {
  readonly root = new THREE.Group(); // 脚底贴地：+Y 对着球面法线，+Z 对着朝向
  readonly gait = new Gait();
  depth = 0; // 脚下的水深（米）：walkMode 每帧设，涉水时步子慢、脚抬高
  private readonly holder = new THREE.Group(); // 模型（翠宝的部件，或者胶囊体）挂在这里：预编译它
  private readonly whole = new THREE.Group(); // 胶囊体：整体的颠、倾、伸缩
  private rig: TribooRig | null = null;
  private appear = 0; // 出场进度 0..1
  private leaving = false;
  private loaded = false;

  constructor() {
    this.root.name = 'walker';
    this.root.add(this.holder);
    this.root.visible = false;
  }

  get hasModel(): boolean {
    return this.loaded;
  }

  // 预编译用的模型根节点（一直可见；root 没出场时是藏着的）
  get model(): THREE.Object3D {
    return this.holder;
  }

  // 翠宝的部件（自查脚本看拆得对不对）；胶囊体时 null
  get parts(): TribooRig | null {
    return this.rig;
  }

  setModel(object: THREE.Object3D): void {
    this.holder.clear();
    this.whole.clear();
    this.rig = object.parent ? null : buildTribooRig(object);
    const rig = this.rig;
    if (rig) {
      this.holder.add(rig.root);
      // 脚的站姿（角色本地坐标）：模型空间 → rig.root 的位置、缩放
      const s = rig.root.scale.x;
      for (let i = 0; i < 2; i++) this.gait.rest[i].copy(rig.footRest[i]).multiplyScalar(s).add(rig.root.position).setY(0);
      this.gait.toe = rig.toe * s;
      this.gait.heel = rig.heel * s;
    } else {
      this.whole.add(object);
      this.holder.add(this.whole);
    }
    this.loaded = true;
  }

  // 挂到星球上，从小长大地出场
  show(parent: THREE.Object3D): void {
    if (this.root.parent !== parent) parent.add(this.root);
    this.leaving = false;
    if (!this.root.visible) this.appear = 0;
    this.root.visible = true;
  }

  // 缩小退场；退完由 pose() 藏起来。immediately：立刻摘掉
  hide(immediately = false): void {
    this.leaving = true;
    if (!immediately) return;
    this.appear = 0;
    this.root.visible = false;
    this.root.removeFromParent();
  }

  get gone(): boolean {
    return !this.root.visible;
  }

  // 两只脚立刻站回站姿（进入漫游、瞬移之后）
  resetGait(walker: Walker): void {
    this.gait.reset(walker);
  }

  // 每帧：摆到 Walker 的位置和朝向上，再按步态摆各个部件
  pose(walker: Walker, dt: number): void {
    if (!this.root.visible) return;
    // 出场、退场
    if (this.leaving) {
      this.appear = Math.max(0, this.appear - dt / LEAVE_SECONDS);
      if (this.appear === 0) {
        this.root.visible = false;
        this.root.removeFromParent();
        return;
      }
      this.root.scale.setScalar(this.appear * this.appear);
    } else {
      this.appear = Math.min(1, this.appear + dt / APPEAR_SECONDS);
      this.root.scale.setScalar(Math.max(0.001, easeOutBack(this.appear)));
    }
    // 位置和朝向：+X = 上 × 前，+Y = 上，+Z = 前
    walker.positionInto(this.root.position);
    _x.crossVectors(walker.dir, walker.facing);
    this.root.quaternion.setFromRotationMatrix(_m.makeBasis(_x, walker.dir, walker.facing));
    const motion = reducedMotion() ? WALK_ANIM.reduced : 1;
    this.gait.update(walker, dt, this.depth, motion);
    if (this.rig) this.poseRig(this.rig, walker);
    else this.poseWhole();
  }

  // 翠宝的部件。gait 的量是角色本地坐标（米），部件在模型空间：除以 rig.root 的缩放
  private poseRig(rig: TribooRig, walker: Walker): void {
    const g = this.gait;
    const k = 1 / rig.root.scale.x;
    const o = rig.root.position;
    // 身体：平移（颠、重心左右移）+ 前倾、侧歪、肩膀转；压扁拉长、呼吸
    rig.body.position.set(rig.bodyPivot.x + g.shift * k, rig.bodyPivot.y + g.bob * k, rig.bodyPivot.z);
    rig.body.quaternion.setFromEuler(_e.set(g.pitch, g.twist, -g.roll, 'YXZ'));
    const sy = (1 + g.squash) * (1 + g.breath);
    const sxz = 1 / Math.sqrt(Math.max(0.5, sy));
    rig.squash.scale.set(sxz, sy, sxz);
    // 手臂：绕肩前后摆（绕 X 转正的是往后）、往外张（左臂绕 Z 正转往外）；手腕再甩一点
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      rig.shoulders[i].rotation.set(-g.arm[i], 0, side * g.armOut[i]);
      rig.wrists[i].rotation.set(-g.hand[i], 0, 0);
    }
    // 胯（腿的转轴）跟着身体平移、前倾、侧歪，再反着肩膀转一点
    _q.setFromEuler(_e.set(g.pitch, g.hipTwist, -g.roll, 'YXZ'));
    const up = walker.dir;
    const fwd = walker.facing;
    for (let i = 0; i < 2; i++) {
      const foot = g.feet[i];
      // 脚：星球上的位置 → 角色本地（不除 root 的缩放：出场长大时脚跟着一起缩放）→ 模型空间
      _d.copy(foot.pos).sub(this.root.position);
      const fx = (_d.dot(_x) - o.x) * k;
      const fy = (_d.dot(up) - o.y) * k;
      const fz = (_d.dot(fwd) - o.z) * k;
      const group = rig.feet[i];
      group.position.set(fx, fy, fz);
      const yaw = signedAngle(fwd, foot.fwd, up);
      group.quaternion.setFromEuler(_e.set(-foot.pitch, yaw, 0, 'YXZ'));
      // 腿：从胯指着脚踝，按距离伸缩（粗细反着变一点）
      _hip.copy(rig.hipRest[i]).sub(rig.bodyPivot).applyQuaternion(_q).add(rig.body.position);
      _ankle.copy(rig.ankle[i]).applyQuaternion(group.quaternion).add(group.position);
      _d.copy(_ankle).sub(_hip);
      const len = _d.length();
      const leg = rig.legs[i];
      leg.position.copy(_hip);
      if (len > 1e-6) leg.quaternion.setFromUnitVectors(DOWN, _d.divideScalar(len));
      const stretch = Math.min(1.7, Math.max(0.55, len / rig.legLength[i]));
      const thin = 1 / Math.sqrt(stretch);
      leg.scale.set(thin, stretch, thin);
    }
  }

  // 胶囊体：整体颠、前倾、侧歪、伸缩
  private poseWhole(): void {
    const g = this.gait;
    this.whole.position.set(g.shift, g.bob, 0);
    this.whole.quaternion.setFromEuler(_e.set(g.pitch, 0, -g.roll, 'YXZ'));
    const sy = (1 + g.squash) * (1 + g.breath);
    const sxz = 1 / Math.sqrt(Math.max(0.5, sy));
    this.whole.scale.set(sxz, sy, sxz);
  }
}
