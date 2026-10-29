import * as THREE from 'three/webgpu';
import { tribooUrl } from '../assets/brand';
import type { ModelLibrary } from '../assets/models';
import { easeOutBack } from '../scenes/stager';
import { CHAR_HEIGHT, CHAR_RADIUS, WALK } from './params';
import { damp } from './sphere';
import type { Walker } from './walker';

// 整体动作的幅度（翠宝没有骨骼，只动整个身体）
const BOB = 0.045 * CHAR_HEIGHT; // 每一步往上颠多高
const SWAY = 0.11; // 左右摇（弧度）
const LEAN = 0.08; // 走路时身体前倾（弧度）
const BREATH_SECONDS = 3.4; // 站着时一次呼吸
const BREATH = 0.022; // 呼吸时身体竖着伸缩的比例
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

const _x = new THREE.Vector3();
const _m = new THREE.Matrix4();

// 角色的 3D 外形和整体动作：走路时上下颠、左右轻摇、身体前倾，站着时轻轻呼吸；转身跟着 Walker 的朝向
export class CharacterView {
  readonly root = new THREE.Group(); // 脚底贴地：+Y 对着球面法线，+Z 对着朝向
  private readonly sway = new THREE.Group(); // 颠、摇、前倾，绕脚底转
  private readonly breath = new THREE.Group(); // 呼吸：竖着伸缩
  private walkWeight = 0; // 0 站着 … 1 全速走
  private time = 0;
  private appear = 0; // 出场进度 0..1
  private leaving = false;

  constructor() {
    this.root.name = 'walker';
    this.root.add(this.sway);
    this.sway.add(this.breath);
    this.root.visible = false;
  }

  get hasModel(): boolean {
    return this.breath.children.length > 0;
  }

  setModel(object: THREE.Object3D): void {
    this.breath.clear();
    this.breath.add(object);
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

  // 每帧：摆到 Walker 的位置和朝向上，再叠上整体动作
  pose(walker: Walker, dt: number): void {
    if (!this.root.visible) return;
    this.time += dt;
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
    // 走路的分量跟着速度平滑过渡，起步和停下时动作不跳
    this.walkWeight += (Math.min(1, walker.speed / WALK.speed) - this.walkWeight) * damp(8, dt);
    const w = this.walkWeight;
    // 每走一步（stride）是半个正弦周期：|sin| 每步颠一下，sin 让身体一步往左一步往右
    const phase = (walker.distance / WALK.stride) * Math.PI;
    this.sway.position.y = Math.abs(Math.sin(phase)) * BOB * w;
    this.sway.rotation.set(LEAN * w, 0, Math.sin(phase) * SWAY * w);
    // 呼吸：站着时竖着伸缩、横向略收，走起来就淡掉
    const b = Math.sin((this.time / BREATH_SECONDS) * Math.PI * 2) * BREATH * (1 - w);
    this.breath.scale.set(1 - b * 0.5, 1 + b, 1 - b * 0.5);
  }
}
