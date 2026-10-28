import * as THREE from 'three/webgpu';
import { setModelAnisotropy } from '../assets/models';
import type { Team } from '../data/types';
import { createAtmosphere, type Atmosphere, type AtmospherePreset } from '../nature/atmosphere';
import { focusDetail, LOD_LOW } from '../planet/generate';
import { PlanetObject } from '../planet/planetObject';
import { onPlanetRadius, PLANET_RADIUS } from '../planet/presets';
import { CameraRig, type Framing } from './camera';
import { Dressing } from './dressing';
import { galaxyPositions } from './layout';
import { useLook } from './look';
import { galaxyFraming, planetFraming } from './shots';
import { compileUnculled, Stager } from './stager';

export interface PlanetEntry {
  team: Team;
  planet: PlanetObject;
  hit: THREE.Mesh; // 不可见的拾取球，比打地表网格便宜
  home: THREE.Vector3; // 星球在星系里的位置（半径滑块拖动后原地改它的值，引用它的地方都跟着变）
}

// 光环浓淡：星球视图里聚焦星球的光环压到很淡（近景里它会横穿画面），别的星球的光环也压一些；回星系全部恢复
export const RING_FOCUSED = 0.2;
export const RING_OTHERS = 0.4;
const RING_FADE = 4; // 每秒逼近目标的速率：约 1 秒淡完，和 1.2 秒的镜头飞行同时进行

// 像素预算：主画面按「总像素封顶」定像素比，以后加后处理时靠它控制开销。
// 上限取 4K（830 万像素）：常见的 2 倍屏都按原生清晰度画（用户要求模型不能糊），只有超大屏才降；再怎么降也不低于 1 倍
export const MAX_RENDER_PIXELS = 3840 * 2160;

export function budgetPixelRatio(width: number, height: number, dpr: number): number {
  return Math.min(dpr, 2, Math.max(1, Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, width * height))));
}

// 太阳的阴影：一张 2048² 的阴影贴图，正交阴影相机跟着镜头看的地方走。星球视图整个圆台都在里面；
// 漫游时只罩住角色周围一块，阴影更清楚
export const SHADOW = {
  enabled: true,
  mapSize: 2048,
  near: 14, // 漫游时阴影罩住角色周围多大（半边长，米）
};

// 3D 世界：一个渲染器、一个场景，星系里所有星球都在里面；聚焦就是把镜头飞到某颗星球前面
export class World {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly stage: Stager; // 新模型上场：贴图逐帧上传、着色器后台编译、每帧最多挂一个、缩放加淡入
  readonly planets = new Map<string, PlanetEntry>();
  readonly frameHooks = new Set<(dt: number) => void>();
  readonly atmosphere: Atmosphere; // 天空、云海、太阳和天光（nature/atmosphere.ts）
  readonly dressing: Dressing; // 聚焦星球上的草、花、石头
  focused: PlanetEntry | null = null;
  hovered: PlanetEntry | null = null;
  paused = false; // Museum 打开时主画面被盖住，停止渲染
  skyPreset: AtmospherePreset = 'day';
  private warming = false; // warmUp() 预编译期间不画：画了就会在主线程上同步编译
  private readonly halo: THREE.Mesh;
  private readonly ringGoals = new Map<PlanetObject, number>(); // 各星球光环要淡到多少，frame() 里逐帧逼近
  private readonly timer = new THREE.Timer();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly shadowCenter = new THREE.Vector3();
  private readonly sunDir = new THREE.Vector3();

  private constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
    this.rig = new CameraRig(renderer.domElement);
    this.stage = new Stager(renderer, this.scene, this.rig.camera);
    this.atmosphere = createAtmosphere(this.scene, renderer, { planetRadius: PLANET_RADIUS, preset: this.skyPreset });
    this.setupShadows();
    this.dressing = new Dressing({ renderer, scene: this.scene, precompile: (o) => this.stage.precompile(o) });
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
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    await renderer.init();
    renderer.shadowMap.enabled = SHADOW.enabled;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    useLook(renderer);
    // 模型贴图的各向异性：三个渲染器共用这个值（WebGPU 固定支持 16；WebGL2 看扩展，没有时是 0）
    setModelAnisotropy(Math.min(16, renderer.getMaxAnisotropy()));
    return new World(renderer);
  }

  setTeams(teams: Team[]): void {
    for (const e of this.planets.values()) this.scene.remove(e.planet.group, e.hit);
    this.planets.clear();
    this.ringGoals.clear();
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
    // 石头的材质所有星球共用：先拿一块编译好，进星球时撒的石头直接用
    const rock = this.dressing.kit.rocks[0];
    const sample = new THREE.InstancedMesh(rock.geometry, rock.material, 1);
    sample.castShadow = true;
    sample.receiveShadow = true;
    sample.setColorAt(0, new THREE.Color(1, 1, 1));
    try {
      await Promise.all([...this.scene.children.map((o) => compileUnculled(this.renderer, o, this.rig.camera, this.scene)), compileUnculled(this.renderer, sample, this.rig.camera, this.scene)]);
    } finally {
      this.halo.visible = this.hovered !== null;
      this.warming = false;
      sample.dispose();
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
    // 草和石头在飞过去之前就摆好（草的着色器在后台编译，编好才出现）
    this.dressing.enter(e);
    this.fadeRings(e);
    await this.rig.fly(planetFraming(e.home));
    return e;
  }

  async unfocus(): Promise<void> {
    const prev = this.focused;
    this.focused = null;
    this.fadeRings(null);
    await this.rig.fly(this.galaxyView());
    if (this.focused === null) this.dressing.leave();
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
    if (this.focused) this.dressing.rebuild();
    if (!this.rig.drive) this.applyShots();
  }

  // 定下各星球光环的目标浓淡；实际的 setRingStrength 在 frame() 里逐帧做，镜头飞行的同时慢慢淡入淡出
  private fadeRings(focused: PlanetEntry | null): void {
    for (const e of this.planets.values()) {
      this.ringGoals.set(e.planet, focused === null ? 1 : e === focused ? RING_FOCUSED : RING_OTHERS);
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
  }

  private setupShadows(): void {
    const sun = this.atmosphere.sun;
    sun.castShadow = SHADOW.enabled;
    sun.shadow.mapSize.set(SHADOW.mapSize, SHADOW.mapSize);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 2;
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
    this.atmosphere.update(dt, this.rig.camera);
    this.placeSun();
    this.dressing.update(this.rig.camera);
    if (!this.paused && !this.warming) this.renderer.render(this.scene, this.rig.camera);
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
