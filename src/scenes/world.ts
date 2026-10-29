import * as THREE from 'three/webgpu';
import { ModelLibrary, setModelAnisotropy } from '../assets/models';
import type { Team } from '../data/types';
import { createAtmosphere, seaCeiling, targetUp, type Atmosphere, type AtmospherePreset } from '../nature/atmosphere';
import { createLife, type Life, type LifePlanet } from '../nature/life';
import { setGalaxyHaze, updatePlanetLook } from '../nature/planetLook';
import { decorInstances } from '../planet/decor';
import { focusDetail, LOD_LOW, prewarmTerrain } from '../planet/generate';
import { PlanetObject } from '../planet/planetObject';
import { onPlanetRadius, PLANET_RADIUS } from '../planet/presets';
import { CameraRig, type Framing } from './camera';
import { Director, type TransitionCues } from './director';
import { GatedStager } from './gatedStager';
import { Dressing } from './dressing';
import { fitHomeCamera, HOME_FIT, HOME_SPIRAL, homeLayout, homeShape, type HomeCard, type HomeShape, type HomeSlot } from './homeLayout';
import { PlanetMotion } from './homeMotion';
import { GalaxyDecor } from './homeGalaxy';
import { reducedMotion } from './transition';
import { MainPost } from './post';
import { homeFraming, INTRO, planetFraming, SHOTS } from './shots';
import { compileShadowExact } from './shadowWarm';
import { compileUnculled } from './stager';

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

// 星球视图里沉进云海的邻居藏起来（F2）：最低处（中心往下 NEIGHBOR_REACH 个缩小后的半径：地形最高约 1.065 倍，后处理的冷暖按 1.1 倍算）
// 低于云海圆盘（seaCeiling）的邻居，云海会把它整颗或下半截盖住，可是云海不写深度：它的深度还留在缓冲里，
// 后处理的冷暖（post.ts 的 WASH）按深度把盖在它上面的云也染成它的明暗——日落时天上一个淡淡的圈；它的水面（半透明、画在云海之后）也会透出来。
// 整颗浮在云海上的邻居照常画（参考图 F2 角上的小星球）
export const NEIGHBOR_REACH = 1.1;
const SINK_RATE = 6; // 星球视图里（镜头压低、漫游时「上」会转）邻居沉下去 / 浮上来的速率（每秒）：约 0.5 秒缩没、长回来
const SINK_MARGIN = 0.02; // 已经藏起来的邻居要高出圆盘这么多（× 半径）才再露出来：「上」轻轻晃动时不来回闪
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _rel = new THREE.Vector3();
const _up = new THREE.Vector3();

// 邻居沉没没沉：rel 是邻居中心减聚焦星球中心，沿「上」up 量，最低处（按缩小后的大小）低于云海圆盘 ceiling 就算沉了。
// hidden：现在藏着的，要高出圆盘 SINK_MARGIN 才算浮上来
export function sunkInSea(rel: THREE.Vector3, up: THREE.Vector3, radius: number, ceiling: number, hidden: boolean): boolean {
  const bottom = rel.dot(up) - NEIGHBOR_REACH * radius * NEIGHBOR_SCALE;
  return bottom < ceiling + (hidden ? SINK_MARGIN * radius : 0);
}

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
// galaxySeaDrop：星系视图里云海压到所有星球下面（× 半径）；galaxyFog：星系视图里雾再乘的倍数（镜头离星球几百米）；
// galaxyCalm：首页（星系视图）把云海放安静多少 0..1（nature/atmosphere.ts 的 CALM，H2）
export const SKY = { fog: 0.4, galaxySeaDrop: 3.6, galaxyFog: 0.32, galaxyCalm: 1 };
const GALAXY_CENTER = new THREE.Vector3(0, 0, 0); // 星系布局的中心（homeLayout.ts：第一排正中）
const DIM_RATE = 3; // 首页后排的星球淡下去、星球视图里淡回来的速率（每秒逼近）
const GLIDE_SECONDS = 0.9; // 首页换版式（加了一颗星球）时星球挪过去、镜头飞到新取景的时长

// 傍晚系数：按太阳高度（度）在白天（22°）和日落（6°）之间插值；预设过渡时太阳高度是缓动的，傍晚系数跟着走
export function eveningFor(sunElevation: number): number {
  return THREE.MathUtils.clamp((22 - sunElevation) / 16, 0, 1) * EVENING_AT_SUNSET;
}

// 3D 世界：一个渲染器、一个场景，星系里所有星球都在里面；聚焦就是把镜头飞到某颗星球前面
export class World {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly stage: GatedStager; // 新模型上场：贴图逐帧上传、着色器后台编译、每帧最多挂一个、缩放加淡入；转场里先排着，云散开时依次弹出来
  readonly director: Director; // 转场：云层、镜头按分镜表飞、作品依次出场（director.ts）
  readonly planets = new Map<string, PlanetEntry>();
  readonly frameHooks = new Set<(dt: number) => void>();
  // 主画面共用的模型库（F2）：作品、开场探头的翠宝、站桩和漫游的翠宝都从这里拿，同一个 GLB 只下载、解析一次（原来翠宝要两次）；一次只解析一件
  readonly models = new ModelLibrary(true);
  readonly renderHooks = new Set<() => void>(); // 画完这一帧之后调（读这一帧的绘制统计：renderer.info 在下一帧开始时清零）
  readonly atmosphere: Atmosphere; // 天空、云海、太阳和天光（nature/atmosphere.ts）；色调映射和曝光也归它
  readonly life: Life; // 生机层：脚步扬尘、踩踏图、蝴蝶、飘落物、萤火虫、雨（nature/life.ts），只在聚焦的星球上
  readonly dressing: Dressing; // 聚焦星球上的草、花、石头
  readonly galaxy = new GalaxyDecor(); // 首页螺旋星系的点缀：沿臂的星尘、小云絮、你的星球后面的暖光（homeGalaxy.ts）
  private sunTurn = 0; // 首页：太阳跟着镜头左右转了多少度（星系转到背面也迎光）
  readonly post: MainPost; // 后处理：调色、接触阴影、日落光束（post.ts）
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
  private readonly ringGoals = new Map<PlanetObject, number>(); // 各星球光环要淡到多少，frame() 里逐帧逼近
  private readonly haloGoals = new Map<PlanetObject, number>(); // 各星球大气光晕要淡到多少，同上
  private readonly scaleGoals = new Map<PlanetObject, number>(); // 各星球要缩放到多大（星球视图里邻居缩小）
  // 首页（H2）：版式、每颗星球的小动作（悬停放大、慢慢转、按下回弹）、换版式时慢慢挪过去
  private you: string | null = null; // 「你的星球」的团队：放在前排正中
  private shape: HomeShape = homeShape(innerWidth / Math.max(1, innerHeight));
  private pendingLayout = false; // 宽屏 ↔ 竖屏换了、但在星球视图里：回首页时（云层全遮住的那一刻）再重排
  private readonly slots = new Map<PlanetEntry, HomeSlot>();
  private readonly motions = new Map<PlanetEntry, PlanetMotion>();
  private readonly homeBase = new Map<PlanetEntry, number>(); // 版式的大小（逐帧逼近：首页按槽位，星球视图里 1）
  private readonly homeK = new Map<PlanetEntry, number>(); // 这一帧乘在星球组缩放上的系数（下一帧先除掉）
  // 星球视图里沉进云海的邻居（F2）：沉没系数 1 照常、0 整颗藏起来（没有记录就是 1），和首页的系数一起乘在星球组的缩放上（stepHome）
  private readonly sink = new Map<PlanetEntry, number>();
  private readonly sinkGoals = new Map<PlanetEntry, number>();
  private sinkLive = false; // 星球视图里转场的云层全遮住过了：每帧跟着云海重新判定哪些邻居沉在云里
  private sinkToken = 0; // 每次聚焦 / 离开加一：被新转场顶掉的那次，全遮住时的判定不再生效
  private readonly glides = new Map<PlanetEntry, { from: THREE.Vector3; to: THREE.Vector3 }>();
  private glideT = 1;
  private homeCard: HomeCard | null = null; // 首页标题卡片在画面上占的地方（NDC）：取景躲开它
  private homeYawGoal = 0; // 首页取景时镜头往左转多少（弧度）：星系在画面里往右挪、躲开标题卡片
  private homeYaw = 0; // 现在转了多少（离开首页时慢慢回到 0）
  private readonly layoutMeta = { rotation: 0 }; // 版式把星系在平面里转了多少（星尘跟着转）
  private readonly canvasRect = { left: 0, top: 0, width: 1, height: 1 }; // 画布在页面上的位置（铺满窗口：resize 时更新，每帧不读布局）
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
    this.post = new MainPost(renderer, this.scene, this.rig.camera);
    this.stage = new GatedStager(renderer, this.scene, this.rig.camera);
    this.director = new Director(this);
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
    this.buildGalaxy();
    this.scene.add(this.galaxy.group); // 开场前就在场景里：warmUp 一起编译
    // 悬停：首页（H2）不再画黄色的光圈，星球自己放大、慢慢转，名牌弹出来（stepHome、ui/galaxyUi.ts）
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
    this.slots.clear();
    this.motions.clear();
    this.homeBase.clear();
    this.homeK.clear();
    this.glides.clear();
    this.sink.clear();
    this.sinkGoals.clear();
    teams.forEach((team) => {
      const planet = new PlanetObject(team.planet, team.color, team.status === 'under-construction'); // planet：团队色给星球染一点；建设中的有工地
      // 拾取球：单位球，按星球半径（和首页的大小）缩放（半径滑块拖动后只改缩放）
      const hit = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicNodeMaterial());
      hit.visible = false; // Raycaster 照样能打中不可见的物体
      hit.userData.teamId = team.id;
      this.scene.add(planet.group, hit);
      const entry: PlanetEntry = { team, planet, hit, home: new THREE.Vector3() };
      this.planets.set(team.id, entry);
      this.motions.set(entry, new PlanetMotion());
    });
    this.applySlots(this.computeSlots(), true); // 位置、大小、淡不淡按首页的版式（homeLayout.ts）
  }

  // 「你的星球」（main.ts 在开场前调一次）：首页把它放在前排正中、大一点，重新排。
  // glide（P3：刚建好的星球成了你的）：别的星球慢慢挪过去、不跳，镜头不动（建星球的动画接着管镜头）
  setYou(teamId: string | null, glide = false): void {
    if (this.you === teamId) return;
    this.you = teamId;
    if (this.focused || this.director.busy) {
      this.pendingLayout = true;
      return;
    }
    this.applySlots(this.computeSlots(), !glide, glide);
    if (!glide && !this.rig.flying && !this.rig.drive) this.rig.jump(this.galaxyView());
  }

  // 首页的版式：按团队、「你的星球」、宽屏 / 竖屏、星球半径算每颗星球的槽位（和 planets 同样的顺序）
  private computeSlots(): HomeSlot[] {
    const entries = [...this.planets.values()];
    return homeLayout(entries.map((e) => ({ id: e.team.id, built: e.team.status !== 'under-construction' })), this.you, this.shape, PLANET_RADIUS, HOME_SPIRAL, this.layoutMeta);
  }

  // 摆上去：原地改 home（引用它的地方都跟着变）；jump：大小、淡不淡直接到位（开场、换团队列表），否则 frame() 里慢慢变过去；
  // glide：在首页时星球从现在的位置慢慢挪过去（加了一颗星球），不然直接到位
  private applySlots(slots: HomeSlot[], jump: boolean, glide = false): void {
    let i = 0;
    const moving = glide && !this.focused && !this.director.busy;
    if (!moving) this.glides.clear();
    for (const e of this.planets.values()) {
      const s = slots[i++];
      if (!s) continue;
      this.slots.set(e, s);
      e.hit.scale.setScalar(PLANET_RADIUS * 1.3 * s.scale);
      if (moving && e.planet.group.parent && e.home.distanceToSquared(new THREE.Vector3(...s.pos)) > 1e-6) {
        this.glides.set(e, { from: e.home.clone(), to: new THREE.Vector3(...s.pos) });
      } else {
        this.glides.delete(e);
        e.home.set(...s.pos);
        e.planet.group.position.copy(e.home);
        e.hit.position.copy(e.home);
      }
      if (jump) {
        this.homeBase.set(e, this.focused ? 1 : s.scale);
        e.planet.look.dim.value = this.focused ? 0 : s.dim;
      }
    }
    if (this.glides.size) this.glideT = 0;
    this.pendingLayout = false;
    this.buildGalaxy();
  }

  // 螺旋臂上的星尘按星系的大小撒（臂一直延伸到最外那颗星球外面）；手机竖屏沿纵深拉长
  private buildGalaxy(): void {
    const stretch = this.shape === 'tall' ? Math.max(1, HOME_SPIRAL.tallStretch) : 1;
    let maxR = 0;
    for (const s of this.slots.values()) maxR = Math.max(maxR, Math.hypot(s.pos[0], s.pos[2] / stretch));
    this.galaxy.build(PLANET_RADIUS, { maxR, stretch, rotation: this.layoutMeta.rotation });
  }

  // 运行时加一颗星球（「Create a planet」建好以后）：马上登记（路由、名牌都找得到它），着色器在后台编好以后才挂进场景、从小弹出来；
  // 首页的版式跟着重排：别的星球慢慢挪到新位置，镜头慢慢飞到新的取景。已经有这个团队时只更新数据
  addPlanet(team: Team): PlanetEntry {
    const old = this.planets.get(team.id);
    if (old) {
      this.updateTeam(team);
      return old;
    }
    const planet = new PlanetObject(team.planet, team.color, team.status === 'under-construction');
    const hit = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicNodeMaterial());
    hit.visible = false;
    hit.userData.teamId = team.id;
    this.scene.add(hit);
    const entry: PlanetEntry = { team, planet, hit, home: new THREE.Vector3() };
    this.planets.set(team.id, entry);
    const motion = new PlanetMotion();
    this.motions.set(entry, motion);
    this.applySlots(this.computeSlots(), false, true);
    this.homeBase.set(entry, this.slots.get(entry)?.scale ?? 1);
    planet.look.dim.value = this.slots.get(entry)?.dim ?? 0;
    const show = () => {
      if (this.planets.get(team.id) !== entry || planet.group.parent) return;
      this.scene.add(planet.group);
      motion.press = -0.85; // 从小弹出来：回弹的弹簧冲过头再回来
      motion.pressV = 0;
    };
    void this.stage.precompile(planet.group).then(show, show);
    if (!this.focused && !this.director.busy && !this.rig.drive) void this.rig.fly(this.galaxyView(), GLIDE_SECONDS);
    return entry;
  }

  // 首页的槽位（名牌按它分大小、显示「You」）
  slotOf(e: PlanetEntry): HomeSlot | null {
    return this.slots.get(e) ?? null;
  }

  get homeShape(): HomeShape {
    return this.shape;
  }

  // 首页：按下 / 松开一颗星球（画布、名牌都走这里）。按下去压扁一点，松开时回弹；null：全部松开（指针移走了、取消了）
  pressPlanet(e: PlanetEntry | null, down: boolean): void {
    for (const [entry, m] of this.motions) m.pressed = down && entry === e;
  }

  // 首页：一颗星球在画面上的圆（CSS 像素，含悬停放大）；在镜头背后时返回 false。名牌摆在它下面
  planetOnScreen(e: PlanetEntry, out: { x: number; y: number; r: number }): boolean {
    const cam = this.rig.camera;
    _scr.copy(e.home).project(cam);
    if (_scr.z > 1) return false;
    const r = this.canvasRect;
    out.x = r.left + ((_scr.x + 1) / 2) * r.width;
    out.y = r.top + ((1 - _scr.y) / 2) * r.height;
    const d = cam.position.distanceTo(e.home);
    const rad = e.planet.radius * e.planet.group.scale.x;
    out.r = (rad / Math.sqrt(Math.max(1e-6, d * d - rad * rad)) / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) * (r.height / 2);
    return true;
  }

  // 开场前把场景里所有东西（星球、天空、石头）的着色器在后台编译好。编译期间不画（画布保持黑色，界面照常能点）；
  // 不预编译的话第一帧在主线程上同步编译：实测 WebGL2 一个任务约 0.5 秒，WebGPU 约 0.15 秒、画面停约 0.4 秒。
  // 每颗星球（和天空）各调一次 compileAsync、同时进行：一次 compileAsync 里的着色器是一个编完再编下一个，
  // 二十多个排队在 WebGL2 上要 0.6–2 秒；分开同时编，驱动在后台并行编译。几颗星球共用的着色器可能各编一遍，结果一样
  async warmUp(): Promise<void> {
    this.warming = true;
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
      // 先画一帧（阴影贴图这时才建出来），再在后台编石头投影那一遍的管线：按真正画阴影时的状态编（shadowWarm.ts）。
      // 原来的 compileShadow 编出来的剔除方向不对，第一次进星球时圆石（rock-round-2）的投影管线在出帧时同步建（F2 实测每次进星球一条）
      this.primeShadows();
      await compileShadowExact(this.renderer, rocks.group, SHADOW.enabled ? this.atmosphere.sun : null, this.scene);
      await this.post.compile();
    } finally {
      this.scene.remove(rocks.group, grass);
      this.life.prewarm(false);
      this.life.object.visible = this.focused !== null;
      rocks.showOneEach(false);
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
    // 从同一个方向、INTRO.distance 倍远的地方开始（首页看的点不一定在原点：按看的点放大）
    const from = view.position.clone().sub(view.target).multiplyScalar(INTRO.distance).add(view.target);
    this.rig.jump({ ...view, position: from, maxDistance: Infinity });
    return this.rig.fly(view, INTRO.seconds);
  }

  // 星系 → 星球（穿云）、星球 → 另一颗星球（甩镜跳过去）：转场见 director.ts。
  // 云海马上开始跟着聚焦的星球升上来（1.2 秒缓动）；换地表细分、草和石头、生机层在云层全遮住的那一刻做（看不见，
  // 跳星球时旧星球的东西一直留到那时），cues.covered 同时撤旧作品、摆新作品（App）
  async focus(teamId: string, cues: TransitionCues = {}): Promise<PlanetEntry | null> {
    const e = this.planets.get(teamId);
    if (!e) return null;
    const prev = this.focused;
    this.focused = e;
    this.setHover(null);
    // 首页还在挪（刚加了星球）：直接到位；刚加的、着色器还没编好的星球现在就挂上（星球视图要画它）
    this.finishGlide();
    if (!e.planet.group.parent) this.scene.add(e.planet.group);
    this.atmosphere.setPlanet(e.home, PLANET_RADIUS);
    this.fadeRings(e);
    const sink = this.beginSink(e);
    // 全遮住以后分三帧：先撤旧作品、摆新展台（App，作品最早开始准备）→ 换地表细分 → 草、石头、生机层。
    // 首页的小动作（悬停转过的角度、回弹）在全遮住的那一刻归零：星球视图按「星球不旋转」算；
    // 沉在新星球云海里的邻居也在这一刻藏起来（看不见它们消失）
    await this.director.focus(e, prev !== null && prev !== e, planetFraming(e.home), [
      () => {
        sink();
        for (const m of this.motions.values()) m.reset();
        cues.covered?.();
      },
      () => {
        if (prev && prev !== e) prev.planet.setDetail(LOD_LOW);
        e.planet.setDetail(focusDetail());
      },
      () => {
        this.dressing.enter(e);
        this.life.setPlanet(this.lifePlanet(e));
        this.life.object.visible = true;
      },
    ]);
    return e;
  }

  // 星球 → 星系：云「噗」地合拢，全遮住时撤作品（cues.covered），镜头才往后拉
  async unfocus(cues: TransitionCues = {}): Promise<void> {
    const prev = this.focused;
    this.focused = null;
    // 在星球视图里换过宽屏 / 竖屏（或换了「你的星球」）：取景现在就按新的版式算，星球在云层全遮住的那一刻才挪过去
    const slots = this.pendingLayout ? this.computeSlots() : null;
    this.fadeRings(null);
    // 星系视图里云海压到所有星球下面（别的星球会穿过云层，云海只对聚焦的那颗做了解析剔除）：马上开始（1.2 秒缓动，云散开时已经快到位）
    this.galaxySky();
    this.setWalker(null);
    const sink = this.beginSink(null); // 沉在云海里藏着的邻居等云层全遮住才露出来
    await this.director.unfocus(prev, this.galaxyView(slots ?? undefined), [() => {
      sink();
      if (slots) this.applySlots(slots, false);
      cues.covered?.();
    }]);
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
    this.applySlots(this.computeSlots(), false);
    this.buildGalaxy();
    for (const e of this.planets.values()) {
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

  // 星系视图的天空：云海中心放在星系中心、压到所有星球下面，雾淡一些；首页把云海放安静（H2：起伏平、云团大、对比小）
  private galaxySky(): void {
    this.atmosphere.setPlanet(GALAXY_CENTER, PLANET_RADIUS, { seaDrop: SKY.galaxySeaDrop, fog: SKY.galaxyFog, calm: SKY.galaxyCalm });
  }

  // ?tune 改了 SKY（星系视图的云海、雾）：在星系视图里就立刻按新值重摆
  applySky(): void {
    if (!this.focused) this.galaxySky();
  }

  // ?tune → Home 改了版式、取景：在首页时立刻重排、按新的取景摆镜头；在星球视图里时等回首页再排
  applyHome(): void {
    if (this.focused || this.director.busy) {
      this.pendingLayout = true;
      return;
    }
    this.applySlots(this.computeSlots(), false);
    this.buildGalaxy();
    if (!this.rig.flying && !this.rig.drive) this.rig.reframe(this.galaxyView());
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

  // —— 首页（H2）的大小、小动作、淡 ——
  // 版式的大小（建设中的小一些、你的星球大一点）、悬停放大、按下回弹合成一个系数，乘在星球组的缩放上；悬停时绕竖轴慢慢转。
  // 每帧 stepRings 之前先除掉上一帧乘上的（removeHomeScale），之后再乘这一帧的（stepHome）：stepRings、fadeRings 照旧只管
  // 星球视图的大小（聚焦的原大小、邻居缩小），不用知道首页。星球视图里系数回到 1，转过的角度很快转回 0（云层全遮住时 focus() 再归零），淡的也淡回来
  private removeHomeScale(): void {
    for (const [e, k] of this.homeK) if (k !== 1) e.planet.group.scale.divideScalar(k);
  }

  private stepHome(dt: number): void {
    const kb = 1 - Math.exp(-8 * dt);
    const kd = 1 - Math.exp(-DIM_RATE * dt);
    const settle = this.focused !== null;
    this.stepGlide(dt);
    for (const e of this.planets.values()) {
      const slot = this.slots.get(e);
      const goal = settle ? 1 : slot?.scale ?? 1;
      const now = this.homeBase.get(e) ?? goal;
      const base = Math.abs(goal - now) < 0.002 ? goal : now + (goal - now) * kb;
      this.homeBase.set(e, base);
      const m = this.motions.get(e);
      let k = base;
      let spin = 0;
      if (m) {
        m.step(dt, e === this.hovered, settle);
        if (!m.resting) k *= m.scale;
        spin = m.spin;
      }
      const g = e.planet.group;
      const sunk = this.stepSink(e, dt); // 星球视图里沉进云海的邻居：缩没、整颗藏起来（F2）
      if (sunk > 0) k *= sunk;
      if (k !== 1) g.scale.multiplyScalar(k);
      this.homeK.set(e, k);
      if (g.rotation.y !== spin) g.rotation.y = spin;
      const dimGoal = settle ? 0 : slot?.dim ?? 0;
      const d = e.planet.look.dim.value;
      if (d !== dimGoal) e.planet.look.dim.value = Math.abs(dimGoal - d) < 0.004 ? dimGoal : d + (dimGoal - d) * kd;
    }
  }

  // —— 星球视图里沉进云海的邻居（F2，见 NEIGHBOR_REACH）——
  // 沉没系数逐帧逼近目标，返回这一帧的系数（stepHome 把它乘进首页的系数里，下一帧 removeHomeScale 一起除掉）。
  // 到 0 就整颗不画（不画就不留深度）；藏着时不乘 0，不出现缩放为 0 的矩阵
  private stepSink(e: PlanetEntry, dt: number): number {
    let s = this.sink.get(e) ?? 1;
    const goal = this.sinkGoals.get(e);
    if (goal !== undefined) {
      const k = 1 - Math.exp(-SINK_RATE * dt);
      s = Math.abs(goal - s) < 0.01 ? goal : s + (goal - s) * k;
      if (s === goal) this.sinkGoals.delete(e);
      if (s === 1) this.sink.delete(e);
      else this.sink.set(e, s);
    }
    const g = e.planet.group;
    if (g.visible !== s > 0) g.visible = s > 0;
    return s;
  }

  // 转场开始：云层全遮住之前不重新判定（邻居不在画面里突然消失）；新聚焦的那颗要是沉着就浮上来。
  // 返回全遮住时调的函数：进星球按镜头落地后的「上」一次判定好、立刻生效，之后每帧跟着云海判定；回星系时全部露出来
  private beginSink(focus: PlanetEntry | null): () => void {
    this.sinkLive = false;
    const token = ++this.sinkToken;
    if (focus && (this.sink.get(focus) ?? 1) < 1) this.sinkGoals.set(focus, 1);
    return () => {
      if (token !== this.sinkToken) return; // 又开始了新的转场：这一次的不算
      const f = this.focused;
      if (f) {
        targetUp(_up, planetFraming(f.home).position, f.home, PLANET_RADIUS, WORLD_UP);
        this.judgeSink(_up, true);
        this.sinkLive = true;
        return;
      }
      this.sink.clear();
      this.sinkGoals.clear();
    };
  }

  // 按「上」方向 up 判定每个邻居沉没沉（最低处低于云海圆盘，sunkInSea）。按缩小后的大小判定，不看正在缩放的大小：
  // 缩没的过程中判定不会翻回来。instant：立刻生效（云层盖着时，这一帧的 stepHome 就按它画），否则慢慢缩没 / 长回来
  private judgeSink(up: THREE.Vector3, instant: boolean): void {
    const f = this.focused;
    if (!f) return;
    const ceiling = seaCeiling(this.atmosphere.params, PLANET_RADIUS);
    for (const e of this.planets.values()) {
      const was = this.sinkGoals.get(e) ?? this.sink.get(e) ?? 1;
      const goal = e !== f && sunkInSea(_rel.subVectors(e.home, f.home), up, e.planet.radius, ceiling, was < 0.5) ? 0 : 1;
      if (instant) {
        this.sinkGoals.delete(e);
        if (goal === 1) this.sink.delete(e);
        else this.sink.set(e, 0);
      } else if (goal !== was) this.sinkGoals.set(e, goal);
    }
  }

  // 换了版式时星球慢慢挪到新位置（加了一颗星球）：原地改 home，星球组、拾取球跟着走
  private stepGlide(dt: number): void {
    if (!this.glides.size) return;
    this.glideT = Math.min(1, this.glideT + dt / GLIDE_SECONDS);
    const k = this.glideT < 0.5 ? 4 * this.glideT ** 3 : 1 - (-2 * this.glideT + 2) ** 3 / 2;
    for (const [e, g] of this.glides) {
      e.home.lerpVectors(g.from, g.to, k);
      e.planet.group.position.copy(e.home);
      e.hit.position.copy(e.home);
    }
    if (this.glideT >= 1) this.glides.clear();
  }

  // 挪到一半就要进星球了：直接到位（星球视图按 home 取景）
  private finishGlide(): void {
    this.glideT = 1;
    this.stepGlide(0);
    this.glides.clear();
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
    const dt = this.director.dt(THREE.MathUtils.clamp(this.timer.getDelta(), 0, 0.1));
    this.limitOrbit();
    this.rig.update(dt);
    this.director.tick(dt); // 转场：按分镜表摆镜头、画云层、到点换场景
    this.turnForCard(dt);
    this.removeHomeScale(); // 首页的大小系数：stepRings 之前除掉、之后再乘上（见 stepHome）
    this.stepRings(dt);
    this.stepHome(dt);
    this.stage.tick(dt);
    setGalaxyHaze(this.atmosphere.horizon); // 首页后排的星球往地平线的雾色里淡（跟着天空预设）
    for (const hook of this.frameHooks) hook(dt);
    const camera = this.rig.camera;
    // 漫游时地平线的「上」是 camera.up（角色脚下的球面法线，进出漫游时和 +Y 之间插值）；轨道镜头时按镜头位置推算
    this.atmosphere.setHorizonUp(this.rig.drive ? camera.up : null);
    this.turnSun(dt);
    this.atmosphere.update(dt, camera);
    const you = this.you ? this.planets.get(this.you) : undefined;
    this.galaxy.update(dt, !this.focused, you ? { pos: you.home, size: PLANET_RADIUS * you.planet.group.scale.x } : null, this.atmosphere.seaTop);
    // 星球视图落定以后（不在转场、镜头不在飞）：邻居跟着云海判定沉没（轨道镜头压得很低、漫游时「上」会转，云海圆盘跟着斜）
    if (this.sinkLive && this.focused && !this.director.busy && !this.rig.flying) this.judgeSink(this.atmosphere.up, false);
    this.placeSun();
    // 太阳和傍晚系数：方向按 sun.position − sun.target.position 算（placeSun 每帧挪 target，不能只看 position）；
    // 傍晚系数跟着天空预设的太阳高度走（?tune 可以手动定）
    const sun = this.atmosphere.sun;
    const light = this.light;
    light.sunDir.copy(sun.position).sub(sun.target.position).normalize();
    light.sunColor.copy(sun.color);
    light.sunIntensity = sun.intensity;
    light.evening = WEATHER.evening ?? eveningFor(this.atmosphere.params.sunElevation);
    updatePlanetLook(dt, light.sunDir, camera, this.focused?.planet.look ?? null, this.atmosphere); // planet：远看的大气、云层跟着太阳转，镜头近了、看别的星球时藏起来
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
    this.post.render(this);
    for (const hook of this.renderHooks) hook();
  }

  // 首页现在的取景（P3：造星的转场落定以后镜头飞回首页用）
  homeFraming(): Framing {
    return this.galaxyView();
  }

  // 首页的取景：按版式（homeLayout.ts）和当前窗口算，所有星球连同名牌都在画面的安全区里。slots：按这套槽位算（还没摆上去的新版式）
  private galaxyView(slots?: HomeSlot[]): Framing {
    const stretch = this.shape === 'tall' ? Math.max(1, HOME_SPIRAL.tallStretch) : 1;
    const cam = fitHomeCamera(slots ?? [...this.slots.values()], PLANET_RADIUS, innerWidth, innerHeight, HOME_FIT[this.shape], this.homeCard, stretch);
    this.homeYawGoal = cam.yaw;
    return homeFraming(cam);
  }

  // 首页标题卡片的右边、下边（CSS 像素，ui/home.ts 量了告诉这里）：取景躲开它（星系太大时往右下挪）。在首页时立刻重新取景
  // （开场飞行中就换飞行的终点；转场里、星球视图里不管，回首页时按新值取景）
  setHomeCard(rightPx: number, bottomPx: number): void {
    const W = Math.max(1, innerWidth);
    const H = Math.max(1, innerHeight);
    const card = { right: (2 * (rightPx + 12)) / W - 1, bottom: 1 - (2 * (bottomPx + 12)) / H };
    if (this.homeCard && Math.abs(card.right - this.homeCard.right) < 0.004 && Math.abs(card.bottom - this.homeCard.bottom) < 0.004) return;
    this.homeCard = card;
    if (!this.focused && !this.director.busy && !this.rig.drive && this.planets.size) this.rig.reframe(this.galaxyView());
  }

  // 首页：镜头再往左转一点（取景算好的 yaw），星系在画面里往右挪、躲开标题卡片。在 rig.update、转场摆好镜头以后转；
  // 镜头每帧都按环绕中心重新摆，不会越转越多。离开首页（聚焦星球）时慢慢回到 0
  private turnForCard(dt: number): void {
    // 镜头被别人接管着（rig.drive：P3 造星的冲出转场、漫游）：不转。接管的人不一定每帧重新摆镜头，转了会越转越多；
    // 转过的角度慢慢回到 0，交还以后再从 0 慢慢转回来（不会一下子跳过去）
    const goal = this.focused || this.rig.drive ? 0 : this.homeYawGoal;
    const d = goal - this.homeYaw;
    this.homeYaw = Math.abs(d) < 1e-4 ? goal : this.homeYaw + d * (1 - Math.exp(-5 * dt));
    if (this.homeYaw === 0 || this.rig.drive) return;
    this.rig.camera.rotateY(this.homeYaw);
    this.rig.camera.updateMatrixWorld();
  }

  // 首页：左右随便转（SHOTS.galaxy.orbit ≥ 180 = 不限；带惯性：OrbitControls 的阻尼），整个星系慢慢自转（spin，每分钟几圈）：
  // 指着星球、名牌，或者在拖的时候停；减弱动效时不转。离开首页（转场、星球视图、漫游、镜头在飞）时放开、不转。
  // 在 rig.update 之前设：OrbitControls 在 update 里按它夹住方位角、自转
  private limitOrbit(): void {
    const home = !this.focused && !this.director.busy && !this.rig.flying && !this.rig.drive;
    const deg = SHOTS.galaxy.orbit;
    const orbit = home && deg < 180 ? THREE.MathUtils.degToRad(deg) : Infinity;
    const c = this.rig.controls;
    if (c.maxAzimuthAngle !== orbit) {
      c.minAzimuthAngle = -orbit;
      c.maxAzimuthAngle = orbit;
    }
    const spin = home && SHOTS.galaxy.spin > 0 && this.hovered === null && !reducedMotion();
    c.autoRotate = spin;
    c.autoRotateSpeed = SHOTS.galaxy.spin;
  }

  // 首页：太阳跟着镜头的方位角转（镜头在 +Z 那一侧时是 0）：转到背面看也是迎光。只改太阳的方向（uniform），不加灯、不多画阴影。
  // 离开首页时慢慢转回 0（星球视图照原来的光）
  private turnSun(dt: number): void {
    const cam = this.rig.camera.position;
    const t = this.rig.controls.target;
    const home = !this.focused && !this.director.busy && !this.rig.drive;
    const az = THREE.MathUtils.radToDeg(Math.atan2(cam.x - t.x, cam.z - t.z));
    const goal = home ? az : 0;
    let d = ((goal - this.sunTurn + 540) % 360) - 180; // 走近的那一边
    if (home) this.sunTurn = goal;
    else this.sunTurn += Math.abs(d) < 0.05 ? d : d * (1 - Math.exp(-4 * dt));
    d = 0;
    this.atmosphere.setSunTurn(this.sunTurn);
  }

  private resize(): void {
    this.renderer.setPixelRatio(budgetPixelRatio(innerWidth, innerHeight, devicePixelRatio || 1));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.rig.resize(innerWidth, innerHeight);
    this.canvasRect.width = innerWidth;
    this.canvasRect.height = innerHeight;
    // 首页：宽屏 ↔ 竖屏换了就重排（在星球视图、转场里时等回首页再排）；在首页、镜头没在飞时按新的窗口重新取景
    const shape = homeShape(innerWidth / Math.max(1, innerHeight));
    if (shape !== this.shape) {
      this.shape = shape;
      if (this.focused || this.director.busy) this.pendingLayout = true;
      else this.applySlots(this.computeSlots(), true);
    }
    if (this.planets.size && !this.focused && !this.director.busy && !this.rig.flying && !this.rig.drive) this.rig.jump(this.galaxyView());
  }
}

const _scr = new THREE.Vector3();
