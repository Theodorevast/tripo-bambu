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
export const GALAXY_VIEW: Framing = { target: new THREE.Vector3(0, 0, 0), position: new THREE.Vector3(0, 170, 330), minDistance: 160, maxDistance: 620, autoRotate: true };

// 镜头从展示方向看向星球；初始作品就排在这个方向周围
export function planetFraming(home: THREE.Vector3): Framing {
  return { target: home.clone(), position: home.clone().addScaledVector(POLE, 30), minDistance: 15, maxDistance: 70, autoRotate: false };
}

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
    this.rig.jump(GALAXY_VIEW);
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
    this.rig.jump({ ...GALAXY_VIEW, position: GALAXY_VIEW.position.clone().multiplyScalar(2.6), maxDistance: Infinity });
    return this.rig.fly(GALAXY_VIEW, 2.4);
  }

  async focus(teamId: string): Promise<PlanetEntry | null> {
    const e = this.planets.get(teamId);
    if (!e) return null;
    if (this.focused && this.focused !== e) this.focused.planet.setDetail(LOD_LOW);
    this.focused = e;
    this.setHover(null);
    e.planet.setDetail(LOD_HIGH);
    await this.rig.fly(planetFraming(e.home));
    return e;
  }

  async unfocus(): Promise<void> {
    const prev = this.focused;
    this.focused = null;
    await this.rig.fly(GALAXY_VIEW);
    prev?.planet.setDetail(LOD_LOW);
  }

  private frame(time: number): void {
    this.timer.update(time);
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.rig.update(dt);
    if (this.hovered) {
      this.halo.position.copy(this.hovered.home);
      this.halo.scale.setScalar(BASE_RADIUS * 1.55);
      this.halo.quaternion.copy(this.rig.camera.quaternion);
    }
    for (const hook of this.frameHooks) hook(dt);
    if (!this.paused) this.renderer.render(this.scene, this.rig.camera);
  }

  private resize(): void {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.rig.resize(innerWidth, innerHeight);
  }
}
