import * as THREE from 'three/webgpu';
import type { PresetId } from '../data/types';
import { PlanetObject } from '../planet/planetObject';
import { PLANET_RADIUS, PRESET_IDS } from '../planet/presets';
import { compileUnculled } from '../scenes/stager';
import type { World } from '../scenes/world';
import { el } from './dom';
import { animate, reducedMotion } from './motion';

// 造星窗口右边的实时预览（P3）：一颗慢慢转的小星球，复用 PlanetObject（和星系里那颗一模一样的地形、配色、云、石头带）。
// 单独一个小画布、自己的渲染器（同查看器的做法），主画面照常跑。环境光直接借主场景的解析天空（scene.environmentNode），
// 太阳的方向、颜色、强度、曝光每帧跟着主画面走：预览里的样子和它飞进星系以后一样。
// 换样子：每种「预设 + 地形 + 石头带」一颗星球，建好先在后台编译（compileAsync，不在主线程上同步编），编好才换上；
// 换的时候旧的转快、缩下去，新的从小弹出来（减弱动效时画布淡出淡入）。第一颗编好以后，别的预设按同样的地形在后台一颗颗备好，
// 之后切预设是立刻的。团队色是地表的 uniform：直接在现在这颗上渐变过去（大气、石头带的那一点染色下次重建时跟上）

export interface PreviewLook {
  preset: PresetId;
  color: string;
  seed: number;
  ring: boolean;
}

// 预览的地表细分：16 → 5780 面（星系里的 2420 面放在 300 像素的小窗里看得出棱角；超过 6000 面会建小溪，多编一个着色器）
const DETAIL = 16;
const CAMERA_DISTANCE = 12; // 镜头离星球中心几个半径：10 个半径以外地表是星系里的样子（团队色的花田、轮廓光），和飞进星系后一致
const SPIN = 0.22; // 每秒转多少弧度
const MAX_SLOTS = 7; // 最多留几颗（每种预设一颗 + 刚换掉的）

interface Slot {
  key: string;
  look: PreviewLook;
  planet: PlanetObject;
  ready: Promise<void>;
  compiled: boolean;
  used: number; // 最近一次用到（淘汰最久没用的）
}

type Phase = 'idle' | 'out' | 'wait' | 'in';

const keyOf = (l: PreviewLook) => `${l.preset}|${l.seed}|${l.ring ? 1 : 0}`;

export class PlanetPreview {
  readonly element = el('div', { className: 'cp-porthole', dataset: { state: 'loading' } });
  private readonly canvas = el('canvas', { className: 'cp-canvas' });
  private readonly poof = el('div', { className: 'cp-poof', ariaHidden: 'true' }); // 换地形时冒的一团云
  private readonly world: World;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(22, 1, 1, 4000);
  private readonly sun = new THREE.DirectionalLight();
  private readonly holder = new THREE.Group(); // 现在这颗星球挂在这里：换样子的缩放、转快都动它，不碰星球自己的变换
  private rendererReady: Promise<THREE.WebGPURenderer> | null = null;
  private renderer: THREE.WebGPURenderer | null = null;
  private readonly slots = new Map<string, Slot>();
  private current: Slot | null = null;
  private wanted: PreviewLook | null = null;
  private phase: Phase = 'idle';
  private phaseT = 0;
  private spinBoost = 0; // 换样子时多转的速度（弧度 / 秒），慢慢回落
  private accentFrom = new THREE.Color();
  private accentTo = new THREE.Color();
  private accentT = 1;
  private running = false;
  private disposed = false;
  private pendingDt = 0; // 主画面这几帧走过的时间（World.frameHooks 的 dt：跟着转场调试的时间流速、逐帧录屏走）
  private uses = 0;
  private warming = false;
  private frozen = false; // Launch 以后不再在后台备别的预设
  private paused = false; // 离开「选样子」那一步时不在后台备别的预设（主画面这时要编新星球的着色器，WebGL2 上两边抢 GPU 进程）
  private inflight = 0; // 正在编译的有几颗
  private fit = 1.95; // 画面里要装下多大（× 半径）：有石头带时大一些，渐变过去（舷窗是圆的，石头带两头、浮岛被圆边裁一点没关系）
  private fitGoal = 1.95;
  private readonly size = new THREE.Vector2();
  private readonly timed = typeof location !== 'undefined' && new URLSearchParams(location.search).has('gputime'); // ?gputime：量预览每帧的 GPU 时间
  // 开销（自查脚本读 window.__createPreview）：画了几帧、每帧主线程花多少毫秒、GPU 时间（地址带 ?gputime 时）
  readonly stats = { backend: '', frames: 0, cpuMs: 0, cpuMax: 0, gpu: [] as number[], builds: 0, compileMs: [] as number[] };

  constructor(world: World) {
    this.world = world;
    this.element.append(
      el('div', { className: 'cp-sky' }),
      this.canvas,
      el('div', { className: 'cp-loading' }, el('span', { className: 'dots' }, el('i'), el('i'), el('i')), el('span', { textContent: 'Shaping your planet…' })),
      this.poof,
    );
    this.canvas.setAttribute('aria-hidden', 'true');
    this.scene.add(this.sun, this.sun.target, this.holder);
    // 预览的时间跟着主画面走（主画面在预览开着时照常跑）：转场调试的慢放、逐帧录屏时两边一起慢、一起一帧一帧走
    world.frameHooks.add((dt) => { if (this.running) this.pendingDt += dt; });
    // 环境光：借主场景的解析天空（和天空、主画面的 PBR 物体同一套颜色）。节点只是算式，两个渲染器各编各的
    (this.scene as THREE.Scene & { environmentNode?: unknown }).environmentNode = (world.scene as THREE.Scene & { environmentNode?: unknown }).environmentNode;
  }

  get ready(): boolean {
    return this.current?.compiled === true && this.phase === 'idle';
  }

  // 打开窗口：建渲染器（第一次）、开始画
  start(): void {
    if (this.disposed) return;
    this.running = true;
    this.rendererReady ??= this.createRenderer();
    void this.rendererReady.then((r) => {
      if (!this.running || this.disposed) return;
      this.pendingDt = 0;
      r.setAnimationLoop(() => this.frame());
      if (this.wanted) this.apply();
    });
  }

  // 关窗口：停下来（星球、渲染器留着，再打开时不用重新编译）
  stop(): void {
    this.running = false;
    void this.rendererReady?.then((r) => { if (!this.running) r.setAnimationLoop(null); });
  }

  // 要显示的样子。同一颗（只改了颜色）：团队色渐变过去；换了预设、地形或石头带：换一颗（见文件开头）
  set(look: PreviewLook): void {
    const prev = this.wanted;
    this.wanted = { ...look };
    if (prev && prev.color !== look.color) this.tweenAccent(look.color);
    this.fitGoal = look.ring ? 1.95 : 1.55;
    if (this.renderer) this.apply();
  }

  // 换完、显示着的这颗（Launch 时窗口收起来，星球「掉进云里」用它的画面位置）
  get canvasRect(): DOMRect {
    return this.canvas.getBoundingClientRect();
  }

  // Launch 一开始：不再在后台备别的预设（建星球、编着色器都占主线程），现在这颗照常转着画（窗口收起时它往下掉进云里）
  freeze(): void {
    this.frozen = true;
  }

  // 在别的步骤（名字、邀请、Launch）时不在后台备别的预设；回到「选样子」再接着备
  pauseWarm(on: boolean): void {
    if (this.paused === on) return;
    this.paused = on;
    if (!on && this.ready) void this.warmOthers();
  }

  // 没有正在编的（最多等 cap 毫秒）：Launch 前等一下，WebGL2 上预览的链接不和主画面抢 GPU 进程
  settled(cap = 1200): Promise<void> {
    const t0 = performance.now();
    return new Promise((resolve) => {
      const poll = () => (this.inflight === 0 || performance.now() - t0 > cap ? resolve() : setTimeout(poll, 50));
      poll();
    });
  }

  // Launch 以后（每个浏览器只建一颗，预览不会再用）：停下来，星球一颗一颗放掉（每隔一会儿放一颗，不挤在一帧里）。
  // 渲染器本身不销毁：实测销毁 WebGPU 设备时 GPU 进程停 380 ms 左右，主画面跟着停一帧（Launch 以后的动画要求每帧 ≤ 50 ms）；
  // 空着的设备不占什么，留到页面关掉
  release(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frozen = true;
    this.running = false;
    void this.rendererReady?.then((r) => r.setAnimationLoop(null));
    const rest = [...this.slots.values()];
    this.slots.clear();
    this.current = null;
    const next = () => {
      const s = rest.shift();
      if (!s) return;
      void s.ready.then(() => {
        this.drop(s);
        setTimeout(next, 120);
      });
    };
    next();
  }

  // —— 内部 ——

  private async createRenderer(): Promise<THREE.WebGPURenderer> {
    const renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true, alpha: true, trackTimestamp: this.timed });
    await renderer.init();
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.stats.backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
    this.renderer = renderer;
    // 标签页切到后台：主循环停了，这里也停；回来时窗口还开着就接着画
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) renderer.setAnimationLoop(null);
      else if (this.running && !this.disposed) {
        this.pendingDt = 0;
        renderer.setAnimationLoop(() => this.frame());
      }
    });
    return renderer;
  }

  // 按 wanted 决定换不换：要的那颗已经显示着就什么都不做；不然开始换（在换的途中又改了，换到最新的那个）
  private apply(): void {
    const look = this.wanted;
    if (!look) return;
    const slot = this.slot(look);
    if (this.current === slot && this.phase === 'idle') return;
    if (!this.current) {
      // 第一颗：编好直接弹出来（编好之前不挂进场景：没编过的东西一画就在主线程上同步编译）
      if (this.phase === 'idle') {
        this.phase = 'wait';
        this.phaseT = 0;
        this.holder.scale.setScalar(0.001);
        this.element.dataset.state = 'loading';
      }
      return;
    }
    if (this.phase === 'idle' || this.phase === 'in') {
      this.phase = 'out';
      this.phaseT = 0;
      this.spinBoost = reducedMotion() ? 0 : 5;
    }
  }

  // 换地形（Reroll）时窗口里冒一团云（CSS），新星球从云里弹出来
  puff(): void {
    if (reducedMotion()) return;
    animate(this.poof, [{ opacity: 0, transform: 'scale(0.35)' }, { opacity: 1, transform: 'scale(1.05)', offset: 0.3 }, { opacity: 0, transform: 'scale(1.6)' }], { duration: 760, easing: 'ease-out' });
  }

  // 拿到（或新建）某个样子的那颗星球；新建的在后台编译
  private slot(look: PreviewLook): Slot {
    const key = keyOf(look);
    let s = this.slots.get(key);
    if (!s) {
      const planet = new PlanetObject({ seed: look.seed, preset: look.preset, ring: look.ring, atmosphere: true, placements: [] }, look.color, false);
      planet.setDetail(DETAIL);
      // 云海上的影子平时第一帧才建（updatePlanetLook）：先建出来，一起编译（不然第一次画时在主线程上同步编）
      planet.look.placeShadow(null, this.world.light.sunDir);
      s = { key, look: { ...look }, planet, compiled: false, used: ++this.uses, ready: Promise.resolve() };
      const made = s;
      made.ready = this.compile(made);
      this.slots.set(key, made);
      this.stats.builds++;
      this.trim();
    } else {
      s.used = ++this.uses;
    }
    // 团队色：建的时候的颜色可能是旧的，换上去之前对齐（现在显示着的那颗由渐变管）
    if (s !== this.current) s.planet.look.accent.value.set(look.color);
    return s;
  }

  private async compile(s: Slot): Promise<void> {
    this.inflight++;
    const renderer = await this.rendererReady!;
    const t0 = performance.now();
    const hidden: THREE.Object3D[] = [];
    s.planet.group.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true; // compileAsync 跳过不显示的（云海上的影子平时藏着）
      }
    });
    try {
      await compileUnculled(renderer, s.planet.group, this.camera, this.scene);
    } catch (err) {
      console.warn('preview compile failed', err);
    } finally {
      for (const o of hidden) o.visible = false;
      this.inflight--;
    }
    s.compiled = true;
    this.stats.compileMs.push(Math.round(performance.now() - t0));
  }

  // 太多了：扔掉最久没用的（不是现在这颗、也不是要换上的那颗）
  private trim(): void {
    if (this.slots.size <= MAX_SLOTS) return;
    const keep = new Set([this.current?.key, this.wanted && keyOf(this.wanted)]);
    const victims = [...this.slots.values()].filter((s) => !keep.has(s.key) && s.compiled).sort((a, b) => a.used - b.used);
    for (const s of victims.slice(0, this.slots.size - MAX_SLOTS)) {
      this.slots.delete(s.key);
      this.drop(s);
    }
  }

  // 只放掉这颗自己的东西：远看部件（从全局列表里摘掉）、地表的几何和材质。石头带、浮岛的几何和材质是所有星球共用的，不能动
  private drop(s: Slot): void {
    s.planet.group.removeFromParent();
    s.planet.look.dispose();
    s.planet.terrain.geometry.dispose();
    (s.planet.terrain.material as THREE.Material).dispose();
  }

  // 第一颗编好、窗口空闲时：别的预设按同一个地形、石头带一颗颗在后台备好（一次一颗，编完再下一颗）
  private async warmOthers(): Promise<void> {
    if (this.warming) return;
    this.warming = true;
    try {
      for (const preset of PRESET_IDS) {
        const look = this.wanted;
        if (!look || this.disposed || this.frozen || this.paused || !this.running) return;
        const s = this.slot({ ...look, preset });
        await s.ready;
        await new Promise((r) => setTimeout(r, 120)); // 中间歇一下：主画面、输入框都顺
      }
    } finally {
      this.warming = false;
    }
  }

  private tweenAccent(hex: string): void {
    const cur = this.current?.planet.look.accent.value;
    this.accentFrom.copy(cur ?? new THREE.Color(hex));
    this.accentTo.set(hex);
    this.accentT = reducedMotion() ? 1 : 0;
    if (this.accentT === 1 && cur) cur.copy(this.accentTo);
  }

  private frame(): void {
    const renderer = this.renderer;
    if (!renderer || !this.running) return;
    const dt = Math.min(0.1, this.pendingDt);
    this.pendingDt = 0;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    renderer.getSize(this.size);
    if (this.size.x !== w || this.size.y !== h) renderer.setSize(w, h, false);
    this.step(dt);
    this.place(w / h, dt);
    const t0 = performance.now();
    renderer.render(this.scene, this.camera);
    const ms = performance.now() - t0;
    this.stats.frames++;
    this.stats.cpuMs += ms;
    this.stats.cpuMax = Math.max(this.stats.cpuMax, ms);
    if (this.timed) {
      void renderer.resolveTimestampsAsync('render').then((g) => {
        if (typeof g === 'number' && g > 0) {
          this.stats.gpu.push(g);
          if (this.stats.gpu.length > 600) this.stats.gpu.shift();
        }
      }, () => {});
    }
  }

  // 换样子的几个阶段：out（旧的转快、缩下去）→ wait（等新的编好）→ in（新的从小弹出来，带一点回弹）
  private step(dt: number): void {
    const reduce = reducedMotion();
    this.phaseT += dt;
    const look = this.wanted;
    const want = look ? this.slots.get(keyOf(look)) ?? null : null;
    if (this.phase === 'out') {
      const d = reduce ? 0.15 : 0.22;
      const k = Math.min(1, this.phaseT / d);
      if (reduce) this.canvas.style.opacity = String(1 - k);
      else this.holder.scale.setScalar(Math.max(0.001, 1 - k * k * (3 - 2 * k)));
      if (k >= 1) {
        this.phase = 'wait';
        this.phaseT = 0;
      }
    }
    if (this.phase === 'wait') {
      // 要的那颗编好了才换上；没编好之前旧的那颗缩着不动（还没有就空着），等久了显示 Shaping…
      if (want?.compiled) {
        if (want !== this.current) this.swapTo(want);
        this.phase = 'in';
        this.phaseT = 0;
        this.element.dataset.state = 'ready';
      } else if (this.phaseT > 0.25) this.element.dataset.state = 'loading';
    }
    if (this.phase === 'in') {
      const d = reduce ? 0.18 : 0.62;
      const k = Math.min(1, this.phaseT / d);
      if (reduce) {
        this.canvas.style.opacity = String(k);
        this.holder.scale.setScalar(1);
      } else {
        this.canvas.style.opacity = '1';
        this.holder.scale.setScalar(Math.max(0.001, springOut(k)));
      }
      if (k >= 1) {
        this.phase = 'idle';
        this.holder.scale.setScalar(1);
        // 要的已经不是这颗了（换的途中又改了）：接着换
        if (look && keyOf(look) !== this.current?.key) this.apply();
        else void this.warmOthers();
      }
    }
    // 团队色渐变
    if (this.accentT < 1 && this.current) {
      this.accentT = Math.min(1, this.accentT + dt / 0.35);
      const e = this.accentT * this.accentT * (3 - 2 * this.accentT);
      this.current.planet.look.accent.value.copy(this.accentFrom).lerp(this.accentTo, e);
    }
    this.spinBoost *= Math.exp(-3.2 * dt);
    this.holder.rotation.y += dt * (SPIN + this.spinBoost);
  }

  private swapTo(s: Slot): void {
    if (this.current && this.current !== s) this.current.planet.group.removeFromParent();
    this.current = s;
    s.used = ++this.uses;
    if (this.wanted) s.planet.look.accent.value.set(this.wanted.color);
    this.accentT = 1;
    if (s.planet.group.parent !== this.holder) this.holder.add(s.planet.group);
    this.trim();
  }

  // 镜头、太阳：太阳跟着主画面（方向、颜色、强度、曝光），镜头从太阳那一侧偏开一点看过去（亮面多、带一点明暗交界）
  private place(aspect: number, dt: number): void {
    const R = PLANET_RADIUS;
    const light = this.world.light;
    this.sun.color.copy(light.sunColor);
    this.sun.intensity = light.sunIntensity;
    this.sun.position.copy(light.sunDir).multiplyScalar(R * 6);
    this.renderer!.toneMappingExposure = this.world.renderer.toneMappingExposure;
    const az = Math.atan2(light.sunDir.x, light.sunDir.z) - 0.75;
    const el = 0.32;
    this.camera.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(R * CAMERA_DISTANCE);
    this.camera.lookAt(0, 0, 0);
    this.fit += (this.fitGoal - this.fit) * (1 - Math.exp(-6 * dt));
    // 竖直视角：画面短的那一边装下 fit 个半径（再留一点边）
    const half = Math.atan((this.fit * 1.08) / CAMERA_DISTANCE);
    const vHalf = aspect >= 1 ? half : Math.atan(Math.tan(half) / aspect);
    this.camera.aspect = aspect;
    this.camera.fov = THREE.MathUtils.radToDeg(vHalf * 2);
    this.camera.updateProjectionMatrix();
  }
}

// 弹出来：快速放大、冲过头约 8% 再落回（阻尼振子的近似）
function springOut(t: number): number {
  if (t >= 1) return 1;
  return 1 - Math.exp(-6.5 * t) * Math.cos(9.5 * t);
}
