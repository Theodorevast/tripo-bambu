import * as THREE from 'three/webgpu';
import { setModelAnisotropy } from '../assets/models';
import type { Team } from '../data/types';
import { createAtmosphere, type Atmosphere, type AtmospherePreset } from '../nature/atmosphere';
import { createLife, type Life, type LifePlanet } from '../nature/life';
import { decorInstances } from '../planet/decor';
import { focusDetail, LOD_LOW, prewarmTerrain } from '../planet/generate';
import { PlanetObject } from '../planet/planetObject';
import { onPlanetRadius, PLANET_RADIUS } from '../planet/presets';
import { CameraRig, type Framing } from './camera';
import { Dressing } from './dressing';
import { galaxyPositions } from './layout';
import { galaxyFraming, planetFraming } from './shots';
import { compileShadow, compileUnculled, Stager } from './stager';

export interface PlanetEntry {
  team: Team;
  planet: PlanetObject;
  hit: THREE.Mesh; // 不可见的拾取球，比打地表网格便宜
  home: THREE.Vector3; // 星球在星系里的位置（半径滑块拖动后原地改它的值，引用它的地方都跟着变）
}

// 光环浓淡：星球视图里聚焦星球的光环压到很淡（近景里它会横穿画面），别的星球的光环也压一些；回星系全部恢复
export const RING_FOCUSED = 0.2;
export const RING_OTHERS = 0.4;
export const HALO_FOCUSED = 0.15; // 星球视图里聚焦星球的大气光晕：压淡（和云海叠在一起会多出一圈白光）
export const NEIGHBOR_SCALE = 0.45; // 星球视图里别的星球缩到多大
const RING_FADE = 4; // 每秒逼近目标的速率：约 1 秒淡完，和 1.2 秒的镜头飞行同时进行

// 像素预算：主画面按「总像素封顶」定像素比，以后加后处理时靠它控制开销。
// 上限取 4K（830 万像素）：常见的 2 倍屏都按原生清晰度画（用户要求模型不能糊），只有超大屏才降；再怎么降也不低于 1 倍
export const MAX_RENDER_PIXELS = 3840 * 2160;

export function budgetPixelRatio(width: number, height: number, dpr: number): number {
  return Math.min(dpr, 2, Math.max(1, Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, width * height))));
}

// 太阳的阴影：一张 2048² 的阴影贴图，正交阴影相机跟着镜头看的地方走。星球视图整个圆台都在里面；
// 漫游时只罩住角色周围一块，阴影更清楚
export const SHADOW_LAYER = 7; // 只有阴影相机看得见的图层（预热阴影管线用）
export const SHADOW = {
  enabled: typeof location === 'undefined' || new URLSearchParams(location.search).get('shadows') !== '0', // ?shadows=0：关掉阴影（低画质档）
  mapSize: 2048,
  near: 14, // 漫游时阴影罩住角色周围多大（半边长，米）
};

// 天气（?tune → Life 改这里）：雨、风 0..1；evening 是生机层的傍晚系数（萤火虫、粒子的受光），
// null 表示跟着天空预设走（太阳高度 22° 白天 → 0，6° 日落 → EVENING_AT_SUNSET）
export const WEATHER: { rain: number; wind: number; evening: number | null } = { rain: 0, wind: 0.35, evening: null };
export const EVENING_AT_SUNSET = 0.6;

// 天空在游戏里的取值（集成时定的，?tune → Sky & light 可调）：
// fog：距离雾的倍数。atmosphere 演示页的默认 1 在星球视图里把草地蒙上一层灰白（镜头离地面 50 米，3% 的亮雾色叠在很暗的草色上，
// 饱和度掉一半），云海的空气透视也跟着它，压低以后远处云海的明暗对比也更接近参考图
// galaxySeaDrop：星系视图里云海压到所有星球下面（× 半径）；galaxyFog：星系视图里雾再乘的倍数（镜头离星球几百米）
export const SKY = { fog: 0.4, galaxySeaDrop: 3, galaxyFog: 0.5 };
const GALAXY_CENTER = new THREE.Vector3(0, 0, 0); // 星系布局的中心（layout.ts）

// 傍晚系数：按太阳高度（度）在白天（22°）和日落（6°）之间插值；预设过渡时太阳高度是缓动的，傍晚系数跟着走
export function eveningFor(sunElevation: number): number {
  return THREE.MathUtils.clamp((22 - sunElevation) / 16, 0, 1) * EVENING_AT_SUNSET;
}

// 3D 世界：一个渲染器、一个场景，星系里所有星球都在里面；聚焦就是把镜头飞到某颗星球前面
export class World {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly stage: Stager; // 新模型上场：贴图逐帧上传、着色器后台编译、每帧最多挂一个、缩放加淡入
  readonly planets = new Map<string, PlanetEntry>();
  readonly frameHooks = new Set<(dt: number) => void>();
  readonly renderHooks = new Set<() => void>(); // 画完这一帧之后调（读这一帧的绘制统计：renderer.info 在下一帧开始时清零）
  readonly atmosphere: Atmosphere; // 天空、云海、太阳和天光（nature/atmosphere.ts）；色调映射和曝光也归它
  readonly life: Life; // 生机层：脚步扬尘、踩踏图、蝴蝶、飘落物、萤火虫、雨（nature/life.ts），只在聚焦的星球上
  readonly dressing: Dressing; // 聚焦星球上的草、花、石头
  focused: PlanetEntry | null = null;
  hovered: PlanetEntry | null = null;
  paused = false; // Museum 打开时主画面被盖住，停止渲染
  skyPreset: AtmospherePreset = 'day';
  // warmUp() 做完时 resolve：阴影贴图这时才有，要连投影那一遍一起预编译的东西（展台）等它
  readonly warm: Promise<void>;
  private warmed: () => void = () => {};
  // warmUp() 完成之前不画：画了就会在主线程上同步编译。从构造时就开始等（主循环在构造函数里就启动了，
  // main.ts 在 warmUp 之前还要等存储、装配页面，这期间画出来的帧会把星球的着色器同步编译一遍）
  private warming = true;
  private readonly halo: THREE.Mesh;
  private readonly ringGoals = new Map<PlanetObject, number>(); // 各星球光环要淡到多少，frame() 里逐帧逼近
  private readonly haloGoals = new Map<PlanetObject, number>(); // 各星球大气光晕要淡到多少，同上
  private readonly scaleGoals = new Map<PlanetObject, number>(); // 各星球要缩放到多大（星球视图里邻居缩小）
  private readonly timer = new THREE.Timer();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly shadowCenter = new THREE.Vector3();
  private readonly sunDir = new THREE.Vector3();
  private readonly walkerPos = new THREE.Vector3();
  private readonly walkerVel = new THREE.Vector3();
  private walkerOn = false;
  private walkerGrounded = true;
  readonly light = { sunDir: new THREE.Vector3(0, 1, 0), sunColor: new THREE.Color(), sunIntensity: 1, evening: 0 }; // 每帧从 atmosphere 取：给草、生机层
  private readonly weatherArgs = { rain: 0, wind: 0.35, evening: 0, sunDir: this.light.sunDir }; // 每帧传给生机层（复用，不新建对象）

  private constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
    this.warm = new Promise((resolve) => { this.warmed = resolve; });
    this.rig = new CameraRig(renderer.domElement);
    this.stage = new Stager(renderer, this.scene, this.rig.camera);
    this.stage.shadowLight = () => (SHADOW.enabled ? this.atmosphere.sun : null);
    // 天空、云海、光：色调映射（AgX）和曝光由它设，World 不再调 useLook（Museum、查看器的渲染器照旧用 look.ts）。
    // 阴影相机 World 自己摆（placeSun：跟着镜头看的地方）
    this.atmosphere = createAtmosphere(this.scene, renderer, { planetRadius: PLANET_RADIUS, preset: this.skyPreset, frameShadow: false });
    this.atmosphere.params.fog = SKY.fog;
    this.galaxySky(); // 开场是星系全景：云海压到所有星球下面
    this.setupShadows();
    // 生机层：一份，跟着聚焦的星球换（setPlanet）。没有聚焦的星球时整个藏起来、不更新。
    // 雨量（平滑过的）交给天空：光变冷变暗
    this.life = createLife(this.scene, renderer, { radius: PLANET_RADIUS, center: new THREE.Vector3(0, -1e5, 0), height: () => PLANET_RADIUS, sea: null });
    this.life.object.visible = false;
    this.life.onRain((r) => this.atmosphere.setRain(r));
    this.dressing = new Dressing({ renderer, scene: this.scene, life: this.life, precompile: (o) => this.stage.precompile(o) });
    // 悬停光圈：每帧转到正对镜头
    this.halo = new THREE.Mesh(
      new THREE.RingGeometry(1, 1.04, 96),
      new THREE.MeshBasicNodeMaterial({ color: '#f3d48a', transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.halo.visible = false;
    this.scene.add(this.halo);
    this.rig.jump(this.galaxyView());
    this.resize();
    addEventListener('resize', () => this.resize());
    // 星球半径（?tune 滑块）变了：所有星球按新半径重建、星系按比例重新排、镜头按新尺寸取景
    onPlanetRadius(() => this.applyRadius());
    // 标签页切到后台：停掉主循环；回来时重新开始，计时器从这一刻算起，第一帧的 dt 不会把后台那段时间补上
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        renderer.setAnimationLoop(null);
        return;
      }
      this.timer.reset();
      renderer.setAnimationLoop((t) => this.frame(t));
    });
    renderer.setAnimationLoop((t) => this.frame(t));
  }

  static async create(canvas: HTMLCanvasElement): Promise<World> {
    // ?gputime：打开 GPU 时间戳查询（测性能的脚本用，scripts/perf-gpu.mjs）；平时不开，省掉每帧的查询
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, trackTimestamp: new URLSearchParams(location.search).has('gputime') });
    await renderer.init();
    renderer.shadowMap.enabled = SHADOW.enabled;
    renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap 在 WebGPURenderer 里已经去掉了（会退回 PCF 并打警告）
    // 色调映射和曝光不走 look.ts 了：主画面由 atmosphere 管（AgX，曝光 = 预设 × params.exposure）
    // 模型贴图的各向异性：三个渲染器共用这个值（WebGPU 固定支持 16；WebGL2 看扩展，没有时是 0）
    setModelAnisotropy(Math.min(16, renderer.getMaxAnisotropy()));
    return new World(renderer);
  }

  setTeams(teams: Team[]): void {
    for (const e of this.planets.values()) this.scene.remove(e.planet.group, e.hit);
    this.planets.clear();
    this.ringGoals.clear();
    this.haloGoals.clear();
    this.scaleGoals.clear();
    const homes = galaxyPositions(teams.length);
    teams.forEach((team, i) => {
      const home = new THREE.Vector3(...homes[i]);
      const planet = new PlanetObject(team.planet);
      planet.group.position.copy(home);
      // 拾取球：单位球，按星球半径缩放（半径滑块拖动后只改缩放）
      const hit = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicNodeMaterial());
      hit.scale.setScalar(PLANET_RADIUS * 1.3);
      hit.visible = false; // Raycaster 照样能打中不可见的物体
      hit.position.copy(home);
      hit.userData.teamId = team.id;
      this.scene.add(planet.group, hit);
      this.planets.set(team.id, { team, planet, hit, home });
    });
  }

  // 开场前把场景里所有东西（星球、天空、悬停光圈、石头）的着色器在后台编译好。编译期间不画（画布保持黑色，界面照常能点）；
  // 不预编译的话第一帧在主线程上同步编译：实测 WebGL2 一个任务约 0.5 秒，WebGPU 约 0.15 秒、画面停约 0.4 秒。
  // 每颗星球（和天空、光圈）各调一次 compileAsync、同时进行：一次 compileAsync 里的着色器是一个编完再编下一个，
  // 二十多个排队在 WebGL2 上要 0.6–2 秒；分开同时编，驱动在后台并行编译。几颗星球共用的着色器可能各编一遍，结果一样
  async warmUp(): Promise<void> {
    this.warming = true;
    this.halo.visible = true; // 悬停光圈平时藏着，第一次悬停才画：一起编译
    // 石头的网格一直留着（Dressing.field），开场就编译好：主画面那一遍和投影那一遍。每种形状先放 1 个（数量 0 的网格编译时会跳过）
    prewarmTerrain();
    const rocks = this.dressing.field;
    rocks.showOneEach(true);
    this.scene.add(rocks.group);
    // 草场也开场就建好（按当前半径），和别的东西一起编译：进星球时只换星球数据，不再生成着色器。
    // 生机层所有效果的网格临时都显示（compileAsync 跳过不可见的），踩踏图的盖章 / 恢复两个离屏 pass 各画一次空的
    const grass = this.dressing.prepareGrass();
    this.scene.add(grass);
    this.life.object.visible = true;
    this.life.prewarm(true);
    try {
      await Promise.all(this.scene.children.map((o) => compileUnculled(this.renderer, o, this.rig.camera, this.scene)));
      // 先画一帧（阴影贴图这时才建出来），再在后台编石头和展台投影那一遍的管线
      this.primeShadows();
      await compileShadow(this.renderer, rocks.group, SHADOW.enabled ? this.atmosphere.sun : null, this.scene);
    } finally {
      this.scene.remove(rocks.group, grass);
      this.life.prewarm(false);
      this.life.object.visible = this.focused !== null;
      rocks.showOneEach(false);
      this.halo.visible = this.hovered !== null;
      this.warming = false;
      this.warmed();
    }
  }

  // 太阳阴影那一遍的管线：compileAsync 只编主画面那一遍，阴影贴图第一次画到某种东西（实例化的石头、普通网格、双面、半透明）时
  // 才同步建管线，进星球时一下子卡 0.3–0.6 秒。开场前把每种各拿一个，放在只有阴影相机看得见的图层（SHADOW_LAYER）上画一帧：
  // 管线在这里建好（画布还没露出来），以后同类的东西投影就不卡
  private primeShadows(): void {
    if (!SHADOW.enabled) return;
    const group = new THREE.Group();
    const box = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    const variants: THREE.Object3D[] = [
      new THREE.Mesh(box, new THREE.MeshStandardNodeMaterial()),
      new THREE.Mesh(box, new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide })),
      new THREE.Mesh(box, new THREE.MeshStandardNodeMaterial({ transparent: true, opacity: 0.5 })),
      new THREE.Mesh(box, new THREE.MeshStandardNodeMaterial({ transparent: true, opacity: 0.5, side: THREE.DoubleSide })),
      decorInstances(box, this.dressing.kit.rocks[0].material, 1),
    ];
    for (const o of variants) {
      o.castShadow = true;
      o.layers.set(SHADOW_LAYER);
      group.add(o);
    }
    this.placeSun();
    group.position.copy(this.atmosphere.sun.target.position);
    this.scene.add(group);
    try {
      this.renderer.render(this.scene, this.rig.camera);
    } finally {
      this.scene.remove(group);
      box.dispose();
      for (const o of variants) {
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
        else ((o as THREE.Mesh).material as THREE.Material).dispose();
      }
    }
  }

  updateTeam(team: Team): void {
    const e = this.planets.get(team.id);
    if (!e) return;
    e.team = team;
    e.planet.setRecipe(team.planet);
  }

  setSkyPreset(p: AtmospherePreset): void {
    this.skyPreset = p;
    this.atmosphere.setPreset(p);
  }

  // 漫游的角色（WalkMode 每帧调）：脚底的世界坐标、世界坐标下的速度（米/秒）、是否着地。pos = null：没有角色
  setWalker(pos: THREE.Vector3 | null, velocity?: THREE.Vector3, grounded = true): void {
    this.walkerOn = pos !== null;
    if (pos) this.walkerPos.copy(pos);
    if (velocity) this.walkerVel.copy(velocity);
    else this.walkerVel.set(0, 0, 0);
    this.walkerGrounded = grounded;
  }

  // 生机层要的星球数据：高度、海面每次现取；bare 是 V5 给草的「不长草」遮罩（土路、作品空地）：土路上扬黄土
  private lifePlanet(e: PlanetEntry): LifePlanet {
    const planet = e.planet;
    return {
      radius: planet.radius,
      center: e.home,
      height: (d) => planet.height(d.x, d.y, d.z),
      get sea() {
        return planet.sea > 0 ? planet.sea : null;
      },
      bare: (d) => planet.mask.exclude(d),
    };
  }

  // 屏幕坐标 → 射线；各处拾取共用
  rayFrom(clientX: number, clientY: number): THREE.Raycaster {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.rig.camera);
    return this.raycaster;
  }

  pickPlanet(clientX: number, clientY: number): PlanetEntry | null {
    const hit = this.rayFrom(clientX, clientY).intersectObjects([...this.planets.values()].map((e) => e.hit), false)[0];
    return hit ? this.planets.get(hit.object.userData.teamId as string) ?? null : null;
  }

  setHover(e: PlanetEntry | null): void {
    this.hovered = e;
    this.halo.visible = e !== null;
  }

  // 世界坐标 → 屏幕像素坐标；在镜头背后时返回 null
  toScreen(p: THREE.Vector3): { x: number; y: number } | null {
    const v = p.clone().project(this.rig.camera);
    if (v.z > 1) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  // 打开页面时从远处缓缓推进到星系全景
  intro(): Promise<void> {
    const view = this.galaxyView();
    this.rig.jump({ ...view, position: view.position.clone().multiplyScalar(2.6), maxDistance: Infinity });
    return this.rig.fly(view, 2.4);
  }

  async focus(teamId: string): Promise<PlanetEntry | null> {
    const e = this.planets.get(teamId);
    if (!e) return null;
    if (this.focused && this.focused !== e) this.focused.planet.setDetail(LOD_LOW);
    this.focused = e;
    this.setHover(null);
    e.planet.setDetail(focusDetail());
    // 草和石头在飞过去之前就摆好（草场开场就编译好了，这里只换星球数据）
    this.dressing.enter(e);
    // 云海跟着聚焦的星球，从星系视图里压在下面的位置升上来（1.2 秒缓动，和镜头飞行一样长）；生机层搬到这颗星球
    this.atmosphere.setPlanet(e.home, PLANET_RADIUS);
    this.life.setPlanet(this.lifePlanet(e));
    this.life.object.visible = true;
    this.fadeRings(e);
    await this.rig.fly(planetFraming(e.home));
    return e;
  }

  async unfocus(): Promise<void> {
    const prev = this.focused;
    this.focused = null;
    this.fadeRings(null);
    // 星系视图里云海压到所有星球下面（别的星球会穿过云层，云海只对聚焦的那颗做了解析剔除）
    this.galaxySky();
    this.setWalker(null);
    await this.rig.fly(this.galaxyView());
    if (this.focused === null) {
      this.dressing.leave();
      this.life.object.visible = false;
    }
    prev?.planet.setDetail(LOD_LOW);
  }

  // 镜头表（shots.ts）改了（?tune 面板）：当前视图按新参数重新取景，立刻生效
  applyShots(): void {
    this.rig.reframe(this.focused ? planetFraming(this.focused.home) : this.galaxyView());
  }

  // 星球半径变了：每颗星球按新半径重建，星系按比例重新排（原地改 home），聚焦的星球加细分，点缀重新摆，镜头重新取景。
  // 作品贴地由 PlanetView 自己登记的监听处理（在这之后调用）
  private applyRadius(): void {
    const homes = galaxyPositions(this.planets.size);
    let i = 0;
    for (const e of this.planets.values()) {
      e.home.set(...homes[i++]);
      e.planet.group.position.copy(e.home);
      e.hit.position.copy(e.home);
      e.hit.scale.setScalar(PLANET_RADIUS * 1.3);
      e.planet.rebuildForRadius();
      if (e === this.focused) e.planet.setDetail(focusDetail());
    }
    if (this.focused) {
      this.dressing.rebuild();
      this.atmosphere.setPlanet(this.focused.home, PLANET_RADIUS);
      this.life.setPlanet(this.lifePlanet(this.focused));
    } else this.galaxySky();
    if (!this.rig.drive) this.applyShots();
  }

  // 星系视图的天空：云海中心放在星系中心、压到所有星球下面，雾淡一些
  private galaxySky(): void {
    this.atmosphere.setPlanet(GALAXY_CENTER, PLANET_RADIUS, { seaDrop: SKY.galaxySeaDrop, fog: SKY.galaxyFog });
  }

  // ?tune 改了 SKY（星系视图的云海、雾）：在星系视图里就立刻按新值重摆
  applySky(): void {
    if (!this.focused) this.galaxySky();
  }

  // 定下各星球光环的目标浓淡和大小；实际的变化在 frame() 里逐帧做，镜头飞行的同时慢慢淡入淡出。
  // 星球视图里别的星球缩成 NEIGHBOR_SCALE：星球大了以后邻居在画面角上又大又近，缩小以后像远处的小星球（参考图 F2 的角上），
  // 不抢聚焦星球的戏；回星系恢复原样
  private fadeRings(focused: PlanetEntry | null): void {
    for (const e of this.planets.values()) {
      this.ringGoals.set(e.planet, focused === null ? 1 : e === focused ? RING_FOCUSED : RING_OTHERS);
      this.haloGoals.set(e.planet, e === focused ? HALO_FOCUSED : 1);
      this.scaleGoals.set(e.planet, focused === null || e === focused ? 1 : NEIGHBOR_SCALE);
    }
  }

  private stepRings(dt: number): void {
    const k = 1 - Math.exp(-RING_FADE * dt);
    for (const [planet, goal] of this.ringGoals) {
      const now = planet.ringStrength;
      const next = Math.abs(goal - now) < 0.01 ? goal : now + (goal - now) * k;
      planet.setRingStrength(next);
      if (next === goal) this.ringGoals.delete(planet);
    }
    for (const [obj, goal] of this.haloGoals) {
      const now = obj.haloStrength;
      const next = Math.abs(goal - now) < 0.01 ? goal : now + (goal - now) * k;
      obj.setHaloStrength(next);
      if (next === goal) this.haloGoals.delete(obj);
    }
    // 大小变得比光环快（每秒 8）：0.7 秒内到位，比 1.2 秒的镜头飞行先完成，飞到时聚焦的星球已经是原大小（漫游、编辑都按原大小算）
    const ks = 1 - Math.exp(-8 * dt);
    for (const [planet, goal] of this.scaleGoals) {
      const now = planet.group.scale.x;
      const next = Math.abs(goal - now) < 0.002 ? goal : now + (goal - now) * ks;
      planet.group.scale.setScalar(next);
      if (next === goal) this.scaleGoals.delete(planet);
    }
  }

  private setupShadows(): void {
    const sun = this.atmosphere.sun;
    sun.castShadow = SHADOW.enabled;
    sun.shadow.mapSize.set(SHADOW.mapSize, SHADOW.mapSize);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 2;
    // 阴影相机多看一个图层：开场预热时只给阴影那一遍画的东西放在这层（主镜头只看第 0 层）。
    // 阴影相机的图层掩码除了第 0 层还有别的位时，three 就用它自己的，不再照抄主镜头的
    sun.shadow.camera.layers.enable(SHADOW_LAYER);
  }

  // 阴影相机跟着镜头看的地方：镜头离地面远（星球视图、星系）时罩住聚焦星球朝镜头的整个半球；
  // 贴近地面（漫游）时只罩角色周围 SHADOW.near 米，阴影更清楚。太阳方向由 atmosphere 定，这里只挪目标和位置
  private placeSun(): void {
    const sun = this.atmosphere.sun;
    this.sunDir.copy(sun.position).sub(sun.target.position);
    if (this.sunDir.lengthSq() < 1e-8) this.sunDir.set(0, 1, 0);
    this.sunDir.normalize();
    const cam = this.rig.camera;
    const e = this.focused;
    const R = PLANET_RADIUS;
    let half = R * 1.1;
    if (e) {
      const toCam = cam.position.clone().sub(e.home);
      const above = toCam.length() - R;
      if (above < R * 0.45) {
        // 漫游、贴近地面：镜头正下方的地面往前一点
        half = SHADOW.near;
        const fwd = cam.getWorldDirection(new THREE.Vector3());
        this.shadowCenter.copy(toCam).setLength(R).addScaledVector(fwd, half * 0.5).setLength(R).add(e.home);
      } else {
        this.shadowCenter.copy(e.home);
      }
    } else {
      this.shadowCenter.copy(this.rig.controls.target);
    }
    sun.target.position.copy(this.shadowCenter);
    sun.position.copy(this.shadowCenter).addScaledVector(this.sunDir, R * 3);
    sun.target.updateMatrixWorld();
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    if (sc.right !== half) {
      sc.left = -half;
      sc.right = half;
      sc.top = half;
      sc.bottom = -half;
      sc.near = R * 0.5;
      sc.far = R * 5.5;
      sc.updateProjectionMatrix();
    }
  }

  private frame(time: number): void {
    this.timer.update(time);
    // 夹到 0–0.1 秒：卡了一下也不让动画一步跳太远。切回标签页时计时器已经重置，第一帧的 dt 很小（偶尔是负的，夹成 0）
    const dt = THREE.MathUtils.clamp(this.timer.getDelta(), 0, 0.1);
    this.rig.update(dt);
    this.stepRings(dt);
    this.stage.tick(dt);
    if (this.hovered) {
      this.halo.position.copy(this.hovered.home);
      this.halo.scale.setScalar(PLANET_RADIUS * 1.55);
      this.halo.quaternion.copy(this.rig.camera.quaternion);
    }
    for (const hook of this.frameHooks) hook(dt);
    const camera = this.rig.camera;
    // 漫游时地平线的「上」是 camera.up（角色脚下的球面法线，进出漫游时和 +Y 之间插值）；轨道镜头时按镜头位置推算
    this.atmosphere.setHorizonUp(this.rig.drive ? camera.up : null);
    this.atmosphere.update(dt, camera);
    this.placeSun();
    // 太阳和傍晚系数：方向按 sun.position − sun.target.position 算（placeSun 每帧挪 target，不能只看 position）；
    // 傍晚系数跟着天空预设的太阳高度走（?tune 可以手动定）
    const sun = this.atmosphere.sun;
    const light = this.light;
    light.sunDir.copy(sun.position).sub(sun.target.position).normalize();
    light.sunColor.copy(sun.color);
    light.sunIntensity = sun.intensity;
    light.evening = WEATHER.evening ?? eveningFor(this.atmosphere.params.sunElevation);
    if (this.life.object.visible) {
      this.life.setWalker(this.walkerOn ? this.walkerPos : null, this.walkerVel, this.walkerGrounded);
      const w = this.weatherArgs;
      w.rain = WEATHER.rain;
      w.wind = WEATHER.wind;
      w.evening = light.evening;
      this.life.setWeather(w);
      this.life.update(dt, camera);
    }
    this.dressing.update(camera, light);
    if (this.paused || this.warming) return;
    this.renderer.render(this.scene, this.rig.camera);
    for (const hook of this.renderHooks) hook();
  }

  // 按当前窗口的宽高比取星系全景（窗口变化后下一次回星系才生效，不在用户拖动、缩放时挪镜头）
  private galaxyView(): Framing {
    return galaxyFraming(innerWidth / Math.max(1, innerHeight));
  }

  private resize(): void {
    this.renderer.setPixelRatio(budgetPixelRatio(innerWidth, innerHeight, devicePixelRatio || 1));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.rig.resize(innerWidth, innerHeight);
  }
}
