import * as THREE from 'three/webgpu';
import type { Team } from '../data/types';
import { LOD_HIGH, LOD_LOW } from '../planet/generate';
import { SHOWCASE_POLE } from '../planet/placement';
import { PlanetObject } from '../planet/planetObject';
import { BASE_RADIUS } from '../planet/presets';
import { CameraRig, type Framing } from './camera';
import { galaxyPositions } from './layout';
import { addStudioLights } from './lights';
import { createSky } from './sky';

export interface PlanetEntry {
  team: Team;
  planet: PlanetObject;
  hit: THREE.Mesh; // 不可见的拾取球，比打地表网格便宜
  home: THREE.Vector3; // 星球在星系里的位置
}

const POLE = new THREE.Vector3(...SHOWCASE_POLE);

// 星系全景：离中心 270、仰角 30°，画面中心压到星系中心下方 25（lift 为负）——
// 离镜头近的星球在画面里偏低，整片星系往上提一点，上下才匀称。
// 按 1440×900（宽高比 1.6）算：自转一整圈里 14 颗星球连光环都在画面里，横向约占 104–1336 px、纵向约占 107–858 px
export const GALAXY_VIEW: Framing = {
  target: new THREE.Vector3(0, 0, 0),
  position: new THREE.Vector3(0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)).multiplyScalar(270),
  lift: -25,
  minDistance: 140,
  maxDistance: 500,
  autoRotate: true,
};
const GALAXY_ASPECT = 1.6; // GALAXY_VIEW 是按这个宽高比调的；更窄的窗口把镜头按比例拉远，左右两边的星球才不出画

export function galaxyFraming(aspect: number): Framing {
  const k = Math.max(1, GALAXY_ASPECT / aspect);
  const v = GALAXY_VIEW;
  return { ...v, position: v.position.clone().multiplyScalar(k), minDistance: v.minDistance * k, maxDistance: v.maxDistance * k };
}

// 星球视图（小王子式取景）：镜头沿展示方向、离星球中心 PLANET_DISTANCE，平视星球再抬头 PLANET_LIFT，
// 星球的上缘落在画面中上部，初始作品（showcaseDirs）就站在这道地平线上、衬着星空，星球下半部分可以出画。
// 镜头仍绕星球中心转，远近限制按到星球中心的距离算
export const PLANET_DISTANCE = 24;
export const PLANET_LIFT = 8.5;
export function planetFraming(home: THREE.Vector3): Framing {
  return { target: home.clone(), position: home.clone().addScaledVector(POLE, PLANET_DISTANCE), lift: PLANET_LIFT, minDistance: 15, maxDistance: 70, autoRotate: false };
}

// 光环浓淡：星球视图里聚焦星球的光环压到很淡（近景里它会横穿画面），别的星球的光环也压一些；回星系全部恢复
export const RING_FOCUSED = 0.2;
export const RING_OTHERS = 0.4;
const RING_FADE = 4; // 每秒逼近目标的速率：约 1 秒淡完，和 1.2 秒的镜头飞行同时进行

// 3D 世界：一个渲染器、一个场景，星系里所有星球都在里面；聚焦就是把镜头飞到某颗星球前面
export class World {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly planets = new Map<string, PlanetEntry>();
  readonly frameHooks = new Set<(dt: number) => void>();
  focused: PlanetEntry | null = null;
  hovered: PlanetEntry | null = null;
  paused = false; // Museum 打开时主画面被盖住，停止渲染
  private readonly halo: THREE.Mesh;
  private readonly ringGoals = new Map<PlanetObject, number>(); // 各星球光环要淡到多少，frame() 里逐帧逼近
  private readonly timer = new THREE.Timer();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  private constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
    this.rig = new CameraRig(renderer.domElement);
    this.scene.add(createSky());
    addStudioLights(this.scene);
    // 悬停光圈：每帧转到正对镜头
    this.halo = new THREE.Mesh(
      new THREE.RingGeometry(1, 1.04, 96),
      new THREE.MeshBasicNodeMaterial({ color: '#d9b77e', transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.halo.visible = false;
    this.scene.add(this.halo);
    this.rig.jump(this.galaxyView());
    this.resize();
    addEventListener('resize', () => this.resize());
    renderer.setAnimationLoop((t) => this.frame(t));
  }

  static async create(canvas: HTMLCanvasElement): Promise<World> {
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    await renderer.init();
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
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
      const hit = new THREE.Mesh(new THREE.SphereGeometry(BASE_RADIUS * 1.3, 16, 12), new THREE.MeshBasicNodeMaterial());
      hit.visible = false; // Raycaster 照样能打中不可见的物体
      hit.position.copy(home);
      hit.userData.teamId = team.id;
      this.scene.add(planet.group, hit);
      this.planets.set(team.id, { team, planet, hit, home });
    });
  }

  updateTeam(team: Team): void {
    const e = this.planets.get(team.id);
    if (!e) return;
    e.team = team;
    e.planet.setRecipe(team.planet);
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
    e.planet.setDetail(LOD_HIGH);
    this.fadeRings(e);
    await this.rig.fly(planetFraming(e.home));
    return e;
  }

  async unfocus(): Promise<void> {
    const prev = this.focused;
    this.focused = null;
    this.fadeRings(null);
    await this.rig.fly(this.galaxyView());
    prev?.planet.setDetail(LOD_LOW);
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

  private frame(time: number): void {
    this.timer.update(time);
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.rig.update(dt);
    this.stepRings(dt);
    if (this.hovered) {
      this.halo.position.copy(this.hovered.home);
      this.halo.scale.setScalar(BASE_RADIUS * 1.55);
      this.halo.quaternion.copy(this.rig.camera.quaternion);
    }
    for (const hook of this.frameHooks) hook(dt);
    if (!this.paused) this.renderer.render(this.scene, this.rig.camera);
  }

  // 按当前窗口的宽高比取星系全景（窗口变化后下一次回星系才生效，不在用户拖动、缩放时挪镜头）
  private galaxyView(): Framing {
    return galaxyFraming(innerWidth / Math.max(1, innerHeight));
  }

  private resize(): void {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.rig.resize(innerWidth, innerHeight);
  }
}
