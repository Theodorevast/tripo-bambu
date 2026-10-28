import * as THREE from 'three/webgpu';
import { Stager, type Entrance } from './stager';

// 转场里用的 Stager：模型照常在后台准备（贴图逐帧上传、着色器后台编译），但准备好以后先不上场，
// 等转场说「可以了」（release，云层散开、镜头快落地时）再按顺序一件一件出场，每件隔 stagger 秒，复用原来的回弹出场。
// 不转场的时候（编辑器摆作品）不挡：准备好就上场。
// 拦在 prepare() 交回 Entrance 之前：PlanetView 拿到它才把模型挂上、把展台换成不透明、开始缩放淡入，
// 所以展台变实、模型弹出来都在同一刻；它的 loaded（data-planet-ready）也是在最后一件出场时才 resolve。
// 排着的时候，新来的作品晚几帧才开始准备：云层全遮住那一帧只摆展台（WebGL2 上第一次画展台就要停一下），
// 换地表细分、草和石头各占一帧（director.ts），作品的着色器编译再往后排，不挤在同一帧里
const HOLD_START_FRAMES = 3;

// 先画一次（只在 WebGL2 上）：着色器在后台编好以后，ANGLE / D3D11 第一次真正拿它来画还要停一下（实测展台约 50 ms，
// 舞台角色的花园第一次长出来 66 ms，探头的翠宝 50 ms）。所以 precompile 编完以后，再把这个东西在主场景里画一帧才算准备好：
// 挪到镜头正前方 3 米、缩到千分之一（看不见），关掉视锥剔除（主画面和阴影那一遍都画到它），画完放回原处、恢复原样。
// 只做还没挂进场景的东西（已经在场景里的，挪走一帧会闪一下）；由 drawGate 决定这一帧会不会真的画（开场预热完、Museum 没盖着）。
// 和真正画的时候是同一个场景、同样的灯、雾、阴影、缓冲，用的就是同一条管线。WebGPU 不需要（管线建好就能直接用）
const FIRST_DRAW_DISTANCE = 3;
const FIRST_DRAW_SCALE = 1e-3;
const _cam = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class GatedStager extends Stager {
  private held = false;
  private readonly waiting: Array<() => void> = [];
  private clock = 0; // 按每帧的 dt 累加（标签页在后台时不走）
  private nextAt = -Infinity; // 下一件最早什么时候出场（-Infinity：下一帧就放，并从那一刻开始排）
  private stagger = 0;
  readonly releases: number[] = []; // 最近几次放行出场的时刻（stage 的时钟，秒）：自查脚本量间隔
  private readonly later: Array<{ frames: number; resolve: () => void }> = []; // 等几帧再开始准备的
  // 先画一次（见文件开头）：排着的、这一帧正摆在镜头前面的
  private readonly firstDraws: Array<{ object: THREE.Object3D; resolve: () => void }> = [];
  private drawing: { resolve: () => void; restore: () => void } | null = null;
  // 这一帧会不会真的画出来（Director 设：开场预热完、Museum 没盖着）；不设就不做「先画一次」（单元测试）
  drawGate: (() => boolean) | null = null;
  private readonly host: { renderer: THREE.WebGPURenderer; scene: THREE.Scene; camera: THREE.Camera };

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera) {
    super(renderer, scene, camera);
    this.host = { renderer, scene, camera };
  }

  // 转场开始：准备好的先排着
  hold(): void {
    this.held = true;
  }

  // 转场说可以了：排着的按顺序出场，第一件马上，之后每件隔 stagger 秒
  release(stagger: number): void {
    this.held = false;
    this.stagger = Math.max(0, stagger);
    this.nextAt = -Infinity;
  }

  get holding(): boolean {
    return this.held;
  }

  // 排着、还没出场的有几件（自查脚本用）
  get queued(): number {
    return this.waiting.length;
  }

  // 现在的时钟（和 releases 同一个）
  get now(): number {
    return this.clock;
  }

  tick(dt: number): void {
    this.clock += dt;
    this.stepFirstDraw();
    // 等几帧再开始准备的：按来的先后放（都是同样的帧数，先来的先到点）
    for (const w of this.later) w.frames--;
    while (this.later.length && this.later[0].frames <= 0) this.later.shift()!.resolve();
    super.tick(dt);
    if (this.held || this.waiting.length === 0) return;
    const due = Number.isFinite(this.nextAt) ? this.nextAt : this.clock;
    if (this.clock < due) return;
    this.waiting.shift()?.();
    // 下一件按「这一件该出场的时刻 + stagger」排，不按实际出场的那一帧：60 Hz 下平均间隔正好是 stagger（不会每次都被帧对齐拖到 67 ms）；
    // 落后太多（模型加载完时早过了点、标签页切走过）时从现在重新排，不会一下子连着放出好几件
    this.nextAt = (due < this.clock - this.stagger ? this.clock : due) + this.stagger;
    this.releases.push(this.clock);
    if (this.releases.length > 16) this.releases.shift();
  }

  // 编完以后（WebGL2）再先画一次才算准备好
  precompile(object: THREE.Object3D): Promise<void> {
    return super.precompile(object).then(() => this.firstDraw(object));
  }

  // 排着「先画一次」的还有几个（自查脚本用）
  get firstDrawPending(): number {
    return this.firstDraws.length + (this.drawing ? 1 : 0);
  }

  private firstDraw(object: THREE.Object3D): Promise<void> {
    const backend = (this.host.renderer as { backend?: { isWebGPUBackend?: boolean } }).backend;
    if (!this.drawGate || !backend || backend.isWebGPUBackend === true) return Promise.resolve();
    return new Promise((resolve) => this.firstDraws.push({ object, resolve }));
  }

  // 每帧（渲染之前）：上一帧摆出去的已经画过了，放回原处；再摆下一个
  private stepFirstDraw(): void {
    if (this.drawing) {
      this.drawing.restore();
      this.drawing.resolve();
      this.drawing = null;
    }
    if (!this.firstDraws.length || !this.drawGate?.()) return;
    const { object, resolve } = this.firstDraws.shift()!;
    // 这期间已经挂进场景了（比如进了星球，花园摆上了）：不用再画，也不能挪
    let inScene = false;
    for (let o: THREE.Object3D | null = object; o; o = o.parent) if (o === this.host.scene) inScene = true;
    if (inScene) {
      resolve();
      return;
    }
    this.drawing = { resolve, restore: this.placeForDraw(object) };
  }

  // 摆到镜头正前方、缩得看不见，关掉视锥剔除；返回放回原样的函数
  private placeForDraw(object: THREE.Object3D): () => void {
    const parent = object.parent;
    const position = object.position.clone();
    const quaternion = object.quaternion.clone();
    const scale = object.scale.clone();
    const culled: THREE.Object3D[] = [];
    object.traverse((o) => {
      if (!o.frustumCulled) return;
      culled.push(o);
      o.frustumCulled = false;
    });
    const camera = this.host.camera;
    camera.getWorldPosition(_cam);
    camera.getWorldDirection(_dir);
    this.host.scene.add(object);
    object.position.copy(_cam).addScaledVector(_dir, FIRST_DRAW_DISTANCE);
    object.scale.setScalar(FIRST_DRAW_SCALE);
    object.updateMatrixWorld(true);
    return () => {
      // 这一帧里别人把它挂到别处了（PlanetView 进星球时摆花园）：父节点就不动了，只恢复摆放
      if (object.parent === this.host.scene) {
        if (parent) parent.add(object);
        else object.removeFromParent();
      }
      object.position.copy(position);
      object.quaternion.copy(quaternion);
      object.scale.copy(scale);
      object.updateMatrixWorld(true);
      for (const o of culled) o.frustumCulled = true;
    };
  }

  prepare(object: THREE.Object3D, alive: () => boolean = () => true): Promise<Entrance | null> {
    const start = this.held ? new Promise<void>((resolve) => this.later.push({ frames: HOLD_START_FRAMES, resolve })) : Promise.resolve();
    return start.then(() => super.prepare(object, alive)).then(async (entrance) => {
      if (!entrance) return null;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
      if (alive()) return entrance;
      entrance.cancel();
      return null;
    });
  }
}
