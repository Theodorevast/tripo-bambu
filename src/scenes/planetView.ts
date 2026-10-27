import * as THREE from 'three/webgpu';
import { ModelLibrary, type LoadedModel } from '../assets/models';
import type { Placement, Team, Work } from '../data/types';
import { footprintGroundRadius } from '../planet/footprint';
import { PLINTH_HEIGHT, placementTransform } from '../planet/placement';
import { BASE_RADIUS, PRESETS } from '../planet/presets';
import type { PlanetEntry, World } from './world';

export interface PlacedWork {
  work: Work;
  placement: Placement;
  root: THREE.Group; // 贴地、对准法线、绕法线转 yaw
  scaler: THREE.Group; // 按 placement.scale 缩放；展台、模型、拾取盒都在里面
  plinth: THREE.Mesh;
  proxy: THREE.Mesh; // 不可见的拾取盒：拾取只打它，高面数模型也不卡
  model: LoadedModel | null;
}

const PLINTH_DEPTH = 2.0; // 展台往地下延伸，坡地上也不露缝：作品按展台下最高的地面贴地，下坡一侧靠这一段补上

// 展台顶面半径（缩放前）：比模型的水平半径略收一点，再保底。编辑器的摆放预览也用它，和摆上去的作品贴地方式一致
export function plinthRadius(footprint: number): number {
  return Math.max(0.55, footprint * 0.95);
}

// 射线从起点到进入星球遮挡球的距离，打不中为 Infinity。遮挡球以星球中心为心、半径取最低可能的地形，
// 比这个距离更远的东西一定在地表背后
function occluderDistance(ray: THREE.Ray, entry: PlanetEntry): number {
  const sphere = new THREE.Sphere(entry.home, BASE_RADIUS * (1 - PRESETS[entry.planet.currentRecipe.preset].amp));
  const p = ray.intersectSphere(sphere, new THREE.Vector3());
  return p ? p.distanceTo(ray.origin) : Infinity;
}

// 聚焦星球上的作品：放展台和拾取盒，模型加载完再挂上；地形变了重新贴地
export class PlanetView {
  readonly library = new ModelLibrary();
  readonly placed = new Map<string, PlacedWork>();
  readonly extraWorks = new Map<string, Work>(); // 拖进来的临时作品
  team: Team | null = null;
  private entry: PlanetEntry | null = null;
  private loading: Promise<void> = Promise.resolve();
  private readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  get planet(): PlanetEntry | null {
    return this.entry;
  }

  // 最近一次 enter 摆的作品都有了结果（模型挂好，或者中途离开、换团队而作废）时 resolve。
  // 只给「模型都加载完了」的信号用，路由不要等它
  get loaded(): Promise<void> {
    return this.loading;
  }

  // 立即摆好全部展台（模型加载完之前半透明，spec 2.2）就返回，模型在后台加载，不等它们。
  // 加载期间离开、换团队、又回到这个团队都没关系：迟到的模型由 place() 认出来丢掉
  enter(team: Team): void {
    this.team = team;
    this.entry = this.world.planets.get(team.id) ?? null;
    this.loading = Promise.all(team.planet.placements.map((p) => this.place(p))).then(() => {});
  }

  leave(): void {
    for (const id of [...this.placed.keys()]) this.remove(id);
    this.team = null;
    this.entry = null;
  }

  findWork(workId: string): Work | undefined {
    return this.team?.works.find((w) => w.id === workId) ?? this.extraWorks.get(workId);
  }

  // 展台和拾取盒当场摆上（在第一个 await 之前），模型加载完才挂；返回的 Promise 等模型挂好。
  // 编辑器摆一件作品时会 await 它
  async place(p: Placement): Promise<PlacedWork | null> {
    const work = this.findWork(p.workId);
    const entry = this.entry;
    if (!work || !entry || this.placed.has(work.id)) return null;
    const root = new THREE.Group();
    const scaler = new THREE.Group();
    // 模型加载完之前展台是半透明的（spec 2.2）
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1.06, PLINTH_DEPTH, 40),
      new THREE.MeshStandardNodeMaterial({ color: this.team?.color ?? '#d9b77e', roughness: 0.55, metalness: 0.15, transparent: true, opacity: 0.4 }),
    );
    plinth.position.y = PLINTH_HEIGHT - PLINTH_DEPTH / 2;
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicNodeMaterial());
    proxy.visible = false;
    proxy.userData.workId = work.id;
    scaler.add(plinth, proxy);
    root.add(scaler);
    entry.planet.works.add(root);
    const pw: PlacedWork = { work, placement: structuredClone(p), root, scaler, plinth, proxy, model: null };
    this.placed.set(work.id, pw);
    this.sizeParts(pw, 1, 0.8);
    this.updateTransform(pw);
    const model = await this.library.load(work);
    // 加载期间被移除了（编辑器删掉、离开星球、换了团队，或者离开后又回来、这件已经重新摆过）：按对象比，不按 id 找，
    // 迟到的模型就不会挂到别的团队或者同一件作品的新展台上
    if (this.placed.get(work.id) !== pw) return null;
    pw.model = model;
    model.object.position.y = PLINTH_HEIGHT;
    scaler.add(model.object);
    this.sizeParts(pw, model.height, model.footprint);
    this.updateTransform(pw); // 展台半径要等模型加载完才知道，重新贴地
    const plinthMaterial = plinth.material as THREE.MeshStandardNodeMaterial;
    plinthMaterial.opacity = 1;
    plinthMaterial.transparent = false;
    plinthMaterial.needsUpdate = true;
    return pw;
  }

  remove(workId: string): void {
    const pw = this.placed.get(workId);
    if (!pw) return;
    pw.root.removeFromParent();
    pw.plinth.geometry.dispose();
    (pw.plinth.material as THREE.Material).dispose();
    pw.proxy.geometry.dispose();
    (pw.proxy.material as THREE.Material).dispose();
    this.placed.delete(workId);
  }

  updateTransform(pw: PlacedWork): void {
    const entry = this.entry;
    if (!entry) return;
    const { position, quaternion } = placementTransform(pw.placement, entry.planet.height, entry.planet.sea);
    // 按展台底下最高的地面贴地；展台半径随模型和缩放变，每次都重算
    position.setLength(footprintGroundRadius(position.clone().normalize(), pw.plinth.scale.x * pw.placement.scale, entry.planet.height, entry.planet.sea));
    pw.root.position.copy(position);
    pw.root.quaternion.copy(quaternion);
    pw.scaler.scale.setScalar(pw.placement.scale);
  }

  refreshAll(): void {
    for (const pw of this.placed.values()) this.updateTransform(pw);
  }

  pick(clientX: number, clientY: number): PlacedWork | null {
    const entry = this.entry;
    if (!entry) return null;
    const raycaster = this.world.rayFrom(clientX, clientY);
    const proxies = [...this.placed.values()].map((pw) => pw.proxy);
    const hit = raycaster.intersectObjects(proxies, false)[0];
    // 拾取盒在射线进入星球之后才打中，说明它在星球背面：看不见，也不该选中
    if (!hit || hit.distance >= occluderDistance(raycaster.ray, entry)) return null;
    return this.placed.get(hit.object.userData.workId as string) ?? null;
  }

  // 从 eye 看 point，中间是否隔着聚焦的星球（作品转到背面时藏起悬浮标签）
  occluded(eye: THREE.Vector3, point: THREE.Vector3): boolean {
    const entry = this.entry;
    if (!entry) return false;
    const to = point.clone().sub(eye);
    const dist = to.length();
    return occluderDistance(new THREE.Ray(eye.clone(), to.divideScalar(dist || 1)), entry) < dist;
  }

  // 作品顶上一点的世界坐标，给悬浮标签和编辑条用
  topOf(pw: PlacedWork): THREE.Vector3 {
    const h = (PLINTH_HEIGHT + (pw.model?.height ?? 1) + 0.4) * pw.placement.scale;
    return pw.root.localToWorld(new THREE.Vector3(0, h, 0));
  }

  setHighlight(target: PlacedWork | null): void {
    for (const pw of this.placed.values()) {
      const m = pw.plinth.material as THREE.MeshStandardNodeMaterial;
      m.emissive.set(pw === target ? (this.team?.color ?? '#d9b77e') : '#000000');
      m.emissiveIntensity = pw === target ? 0.6 : 0;
    }
  }

  private sizeParts(pw: PlacedWork, height: number, footprint: number): void {
    const r = plinthRadius(footprint);
    pw.plinth.scale.set(r, 1, r);
    const w = Math.max(0.6, footprint * 2);
    pw.proxy.scale.set(w, height, w);
    pw.proxy.position.y = PLINTH_HEIGHT + height / 2;
  }
}
