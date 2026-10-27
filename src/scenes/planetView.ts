import * as THREE from 'three/webgpu';
import { ModelLibrary, type LoadedModel } from '../assets/models';
import type { Placement, Team, Work } from '../data/types';
import { footprintGroundRadius } from '../planet/footprint';
import { PLINTH_HEIGHT, placementTransform } from '../planet/placement';
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

// 聚焦星球上的作品：放展台和拾取盒，模型加载完再挂上；地形变了重新贴地
export class PlanetView {
  readonly library = new ModelLibrary();
  readonly placed = new Map<string, PlacedWork>();
  readonly extraWorks = new Map<string, Work>(); // 拖进来的临时作品
  team: Team | null = null;
  private entry: PlanetEntry | null = null;
  private readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  get planet(): PlanetEntry | null {
    return this.entry;
  }

  async enter(team: Team): Promise<void> {
    this.team = team;
    this.entry = this.world.planets.get(team.id) ?? null;
    await Promise.all(team.planet.placements.map((p) => this.place(p)));
  }

  leave(): void {
    for (const id of [...this.placed.keys()]) this.remove(id);
    this.team = null;
    this.entry = null;
  }

  findWork(workId: string): Work | undefined {
    return this.team?.works.find((w) => w.id === workId) ?? this.extraWorks.get(workId);
  }

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
    if (this.placed.get(work.id) !== pw) return null; // 加载期间被移除了
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
    const proxies = [...this.placed.values()].map((pw) => pw.proxy);
    const hit = this.world.rayFrom(clientX, clientY).intersectObjects(proxies, false)[0];
    return hit ? this.placed.get(hit.object.userData.workId as string) ?? null : null;
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
    const r = Math.max(0.55, footprint * 0.95);
    pw.plinth.scale.set(r, 1, r);
    const w = Math.max(0.6, footprint * 2);
    pw.proxy.scale.set(w, height, w);
    pw.proxy.position.y = PLINTH_HEIGHT + height / 2;
  }
}
