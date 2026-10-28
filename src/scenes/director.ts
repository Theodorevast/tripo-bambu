import * as THREE from 'three/webgpu';
import { blendPalette, clonePalette, PRESETS, RAIN_MIX, RAIN_PALETTE, type Palette } from '../nature/atmosphere';
import { createVeil, VEIL_U } from '../style/veil';
import type { CameraRig, Framing } from './camera';
import { easeInOutCubic } from './ease';
import { TRANSITIONS } from './shots';
import { clearVeil, moveFor, reducedMotion, Timeline, veilFrame, writeVeil, type Move, type TransitionKind } from './transition';
import type { PlanetEntry, World } from './world';

// 转场的执行者（T2 的转场搬到 int/v6）：World 的 focus / unfocus 把镜头飞行交给这里。
// - 云层：一个全屏的网格（style/veil.ts），挂在主场景里，只在转场时显示；颜色每次按当前的天空预设取云海的颜色
// - 时间线：每帧按 dt 走，到点触发事件（全遮住时换场景、作品开始依次弹出来）
// - 镜头：按分镜表的 Move 逐帧摆（预备动作、视线先转、FOV 冲击、弧线、侧倾）。镜头的「飞行」照旧交给 CameraRig.fly
//   （它负责停掉手动转动、落地时精确对准取景、交还 OrbitControls，rig.flying 也照常是 true），这里只在它每帧摆完之后
//   按 Move 重新摆一次。两边按同样的 dt 累加，同一帧落地；落地那一帧不再改，镜头正好停在 CameraRig 摆的位置上
// - 调试：时间流速（录慢动作、逐帧录屏）、现在进行到哪

// 转场中途给调用方（App）的时机
export interface TransitionCues {
  // 云层把画面全遮住的那一刻（减弱动效时是淡到最深）：撤下旧星球的作品、摆上新星球的展台。
  // 镜头正被别人接管（漫游）时在一开始就调（要先退出漫游，镜头才飞得起来）
  covered?: () => void;
}

type Vec2 = [number, number];

const _p = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// 一个取景落地后镜头正对着的点：环绕中心再沿屏幕上方抬 lift（CameraRig.raise 的做法：先看向中心，再绕镜头自己的 X 轴抬头）
function aimOf(f: Framing, out: THREE.Vector3): THREE.Vector3 {
  out.copy(f.target);
  const lift = f.lift ?? 0;
  if (lift === 0) return out;
  _f.copy(f.target).sub(f.position).normalize();
  _r.crossVectors(_f, WORLD_UP);
  if (_r.lengthSq() < 1e-10) return out;
  _r.normalize();
  return out.addScaledVector(_p.crossVectors(_r, _f), lift);
}

// 按 Move 逐帧摆镜头（见文件开头）。位置、视线（看向的点）、视角各按自己的缓动，中途加弧线、FOV 冲击、侧倾
class MoveFlight {
  readonly done: Promise<void>;
  private readonly fromPos: THREE.Vector3;
  private readonly fromAim: THREE.Vector3;
  private readonly fromFov: number;
  private readonly toPos: THREE.Vector3;
  private readonly toAim: THREE.Vector3;
  private readonly toFov: number;
  private elapsed = 0;
  private live = true;
  private readonly rig: CameraRig;
  private readonly move: Move;

  constructor(rig: CameraRig, to: Framing, move: Move) {
    this.rig = rig;
    this.move = move;
    const cam = rig.camera;
    this.fromPos = cam.position.clone();
    this.fromFov = cam.fov;
    // 起点的视线：镜头现在正对的方向上、和环绕中心一样远的那个点（抬过头的镜头也对）
    const reach = Math.max(1e-3, cam.position.distanceTo(rig.controls.target));
    this.fromAim = cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(reach).add(cam.position);
    this.toPos = to.position.clone();
    this.toAim = aimOf(to, new THREE.Vector3());
    this.toFov = to.fov ?? cam.fov;
    this.done = rig.fly(to, move.seconds).then(() => {
      this.live = false;
    });
  }

  // World.frame 里、CameraRig.update 之后调（同一个 dt）
  step(dt: number): void {
    if (!this.live || !this.rig.flying) return;
    this.elapsed += dt;
    const m = this.move;
    const t = m.seconds > 0 ? Math.min(1, this.elapsed / m.seconds) : 1;
    if (t >= 1) return; // 这一帧 CameraRig 已经落地
    const k = (m.ease ?? easeInOutCubic)(t);
    const kl = m.look ? m.look(t) : k;
    const cam = this.rig.camera;
    cam.position.lerpVectors(this.fromPos, this.toPos, k);
    if (m.arc) cam.position.y += m.arc * 4 * k * (1 - k);
    _aim.lerpVectors(this.fromAim, this.toAim, kl);
    cam.lookAt(_aim);
    if (m.roll) cam.rotateZ(m.roll(t));
    const fov = THREE.MathUtils.lerp(this.fromFov, this.toFov, k) + (m.fovKick?.(t) ?? 0);
    if (cam.fov !== fov) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }
}

interface RunOptions {
  covered: () => void;
  centerIn: () => Vec2; // iris 合拢时围着哪里（画面坐标）
  centerOut: () => Vec2; // 散开时从哪里散
  toward?: THREE.Vector3; // 甩镜甩向哪里（跳星球）
  holdWorks: boolean; // 作品先排着、云散开后依次弹出来
}

export class Director {
  readonly veil: THREE.Mesh;
  timeScale = 1; // 时间流速（调试用：录慢动作、逐帧录屏。镜头、云层、作品上场、整个场景都按它走）
  private stepOnce = 0; // 调试：时间停住（timeScale = 0）时，下一帧往前走这么多秒（逐帧录屏）
  private timeline: Timeline | null = null; // 正在进行的转场
  private kind: TransitionKind | null = null;
  private flight: MoveFlight | null = null;
  private readonly palette: Palette = clonePalette(PRESETS.day);
  private readonly world: World;
  private warmed = false; // 开场预热做完了（之前云层一直显示着，让预热把它编译好）

  constructor(world: World) {
    this.world = world;
    // 云层挂在场景里：开场预热（World.warmUp 编译场景里的每样东西、先画一帧）时它是显示的，一起编译好、先画过一次
    // （VEIL_U.on 是 0，画出来是全透明的）；预热完藏起来，只在转场时显示
    this.veil = createVeil();
    world.scene.add(this.veil);
    void world.warm.then(() => {
      this.warmed = true;
      if (!this.timeline) this.veil.visible = false;
    });
  }

  // 主循环的 dt 先过一遍时间流速（World.frame 第一行）
  dt(raw: number): number {
    const dt = raw * this.timeScale + this.stepOnce;
    this.stepOnce = 0;
    return dt;
  }

  // 每帧：CameraRig.update 之后、别的东西用到镜头之前
  tick(dt: number): void {
    this.flight?.step(dt);
    VEIL_U.clock.value += dt;
    if (this.timeline && !this.timeline.step(dt)) this.timeline = null;
    this.veil.visible = VEIL_U.on.value > 0.5 || !this.warmed;
  }

  // 调试：时间停住时让下一帧往前走 seconds 秒（逐帧录屏）
  advance(seconds: number): void {
    this.stepOnce += Math.max(0, seconds);
  }

  // 正在进行的转场（自查脚本、调参面板用）
  get transition(): { kind: TransitionKind; t: number } | null {
    const tl = this.timeline;
    return tl && this.kind ? { kind: this.kind, t: Math.min(1, tl.elapsed / Math.max(1e-6, tl.seconds)) } : null;
  }

  get busy(): boolean {
    return this.timeline !== null;
  }

  // 开场探头的翠宝正在演（peek.ts）
  get peeking(): boolean {
    return false;
  }

  // 开场的翠宝探头：飞行落定后调；探了返回 true
  peekIntro(): boolean {
    return false;
  }

  // 星系 → 星球：「穿云」；星球 → 另一颗星球：甩镜 + 云带横扫 + 沿弧线跳过去（分镜表 TRANSITIONS）。
  // 转场一开始就把新星球的作品先排着（GatedStager）：模型照常在后台加载、准备，云散开时才依次弹出来
  focus(entry: PlanetEntry, hop: boolean, to: Framing, covered: () => void): Promise<void> {
    return this.run(hop ? 'hop' : 'enter', to, {
      covered,
      centerIn: () => this.screenPoint(entry.home), // 云围着要去的星球合拢
      centerOut: () => [0, 0.04], // 落地后作品那一圈在画面中间略上
      toward: entry.home,
      holdWorks: true,
    });
  }

  // 星球 → 星系：反向，更短、更轻快。云先「噗」地合拢（这时撤作品），镜头往后拉，云围着刚离开的星球散开
  unfocus(prev: PlanetEntry | null, to: Framing, covered: () => void): Promise<void> {
    return this.run('leave', to, {
      covered,
      centerIn: () => [0, 0.05],
      centerOut: () => (prev ? this.screenPoint(prev.home) : [0, 0]),
      holdWorks: false,
    });
  }

  // 跑一次转场：时间线每帧画云层、到点触发事件；镜头按分镜表飞（leave 和减弱动效时在全遮住那一刻才起飞 / 跳过去）。
  // 云层和镜头都走完才 resolve；covered 里抛出的错误不打断转场，走完再抛给调用方（路由那边提示出错）
  private async run(kindIn: TransitionKind, to: Framing, opts: RunOptions): Promise<void> {
    const world = this.world;
    const kind: TransitionKind = reducedMotion() ? 'fade' : kindIn;
    const shot = TRANSITIONS[kind];
    const camera = world.rig.camera;
    this.syncColors();
    // 甩镜往哪边：目的地在镜头坐标里的方向。云带和画面里的东西一起往反方向走（从要转过去的那一侧涌进来）
    let dir: Vec2 = [-1, 0];
    let turn = 1;
    if (opts.toward) {
      camera.updateMatrixWorld();
      _p.copy(opts.toward).applyMatrix4(camera.matrixWorldInverse);
      const len = Math.hypot(_p.x, _p.y);
      if (len > 1e-6) dir = [-_p.x / len, -_p.y / len];
      turn = _p.x >= 0 ? 1 : -1;
    }
    const ctx = { aspect: camera.aspect, centerIn: opts.centerIn(), centerOut: opts.centerOut(), dir, spin: Math.random() * Math.PI * 2 };
    const distance = camera.position.distanceTo(to.position);
    let error: unknown = null;
    let swapped = false;
    const swap = () => {
      if (swapped) return;
      swapped = true;
      try {
        opts.covered();
      } catch (err) {
        error ??= err;
      }
    };
    let flight: Promise<void> = Promise.resolve();
    const fly = () => {
      if (kind === 'fade') {
        world.rig.jump(to);
        return;
      }
      this.flight = new MoveFlight(world.rig, to, moveFor(kind, shot, distance, turn));
      flight = this.flight.done;
    };
    const tl = new Timeline(shot.seconds, (t) => {
      ctx.aspect = camera.aspect;
      ctx.centerIn = opts.centerIn();
      ctx.centerOut = opts.centerOut();
      writeVeil(veilFrame(kind, shot, t, ctx));
    });
    if (kind === 'enter' || kind === 'hop') {
      if (world.rig.drive) swap(); // 镜头被漫游接管着：先换（退出漫游、交还镜头）才飞得起来
      fly();
      tl.at(shot.cloudFull, swap);
    } else {
      tl.at(shot.cloudFull, () => {
        swap();
        fly();
      });
    }
    if (opts.holdWorks) {
      world.stage.hold();
      tl.at(shot.popAt, () => world.stage.release(shot.stagger));
    }
    this.timeline?.flush();
    this.timeline = tl;
    this.kind = kind;
    try {
      await tl.done;
      await flight;
    } finally {
      // 时间线走完时主循环已经把它清掉了；被新的转场顶掉时那边已经换上自己的
      if (this.timeline === tl) this.timeline = null;
      if (this.timeline === null) {
        this.kind = null;
        clearVeil();
        this.veil.visible = false;
      }
      if (opts.holdWorks && world.stage.holding && this.timeline === null) world.stage.release(shot.stagger);
    }
    if (error) throw error;
  }

  // 云层的颜色：当前天空预设的云海颜色（下雨时往阴天那一套靠，和 atmosphere 的做法一样）
  private syncColors(): void {
    const atm = this.world.atmosphere;
    const pal = this.palette;
    blendPalette(pal, PRESETS[atm.preset], RAIN_PALETTE, atm.rain * RAIN_MIX);
    const set = (u: { value: THREE.Vector3 }, c: THREE.Color) => u.value.set(c.r, c.g, c.b);
    set(VEIL_U.lit, pal.cloudLit);
    set(VEIL_U.mid, pal.cloudMid);
    set(VEIL_U.shade, pal.cloudShade);
    set(VEIL_U.deep, pal.cloudDeep);
    set(VEIL_U.sky, pal.horizon);
  }

  // 世界坐标 → 云层用的画面坐标（高 = 1、原点在画面中心、y 朝上）；在镜头背后时给画面中心
  private screenPoint(p: THREE.Vector3): Vec2 {
    const camera = this.world.rig.camera;
    _p.copy(p).project(camera);
    if (_p.z > 1) return [0, 0];
    return [(THREE.MathUtils.clamp(_p.x, -1.3, 1.3) * camera.aspect) / 2, THREE.MathUtils.clamp(_p.y, -1.3, 1.3) / 2];
  }
}
