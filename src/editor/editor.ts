import * as THREE from 'three/webgpu';
import type { App } from '../app';
import type { Placement, PlanetRecipe, Team, Work } from '../data/types';
import { footprintGroundRadius } from '../planet/footprint';
import { clampScale, faceYaw, PLINTH_HEIGHT, placementTransform, YAW_STEP } from '../planet/placement';
import { plinthRadius, type PlacedWork, type PlanetView } from '../scenes/planetView';
import { EditPanel } from '../ui/editPanel';
import type { PlanetScreen } from '../ui/planetScreen';
import { toast } from '../ui/toast';
import { checkDrop, listenForDrops } from './dropGlb';

const ghostMaterial = new THREE.MeshBasicNodeMaterial({ color: '#d9b77e', transparent: true, opacity: 0.45, depthWrite: false });

// 编辑模式：摆放、拖动、旋转、缩放、删除作品，改星球外观；每次修改都自动保存
export class Editor {
  active = false;
  private readonly app: App;
  private readonly screen: PlanetScreen;
  private readonly panel: EditPanel;
  private placing: Work | null = null;
  private ghost: THREE.Group | null = null;
  private ghostFootprint = 0; // 幽灵模型的水平半径：预览和摆上去的作品用同样的展台半径贴地
  private selected: PlacedWork | null = null;
  private dragging = false;
  private tempCount = 0;

  constructor(app: App, screen: PlanetScreen) {
    this.app = app;
    this.screen = screen;
    this.panel = new EditPanel(app.root, {
      pick: (w) => void this.pickFromTray(w),
      rotate: (deg) => this.withSelected((pw) => { pw.placement.yaw = THREE.MathUtils.degToRad(deg); }),
      scale: (v) => this.withSelected((pw) => { pw.placement.scale = clampScale(v); }),
      remove: () => this.removeSelected(),
      appearance: (patch) => this.setAppearance(patch),
      reroll: () => this.setAppearance({ seed: Math.floor(Math.random() * 1e9) }),
      reset: () => void this.resetDemo(),
    });
    const canvas = app.world.renderer.domElement;
    // 捕获阶段：赶在 OrbitControls 之前处理，点中作品时不让镜头跟着转
    canvas.addEventListener('pointerdown', (e) => this.onDown(e), { capture: true });
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    addEventListener('pointerup', () => this.onUp());
    addEventListener('keydown', (e) => this.onKey(e));
    app.world.frameHooks.add(() => this.placeBar());
    listenForDrops({
      active: () => this.active,
      drop: (file) => void this.addTempWork(file),
      hover: (on) => this.panel.setDropHover(on),
      inactiveDrop: () => toast("Open Edit on your team's planet to drop a GLB"),
    });
  }

  private get view(): PlanetView {
    return this.screen.view;
  }

  toggle(): void {
    if (this.active) this.deactivate();
    else this.activate();
  }

  activate(): void {
    const team = this.view.team;
    if (this.active || !team || team.id !== this.app.you.teamId) return;
    this.active = true;
    this.screen.setInteractive(false);
    this.app.topbar.setEditing(true);
    this.panel.show(team.planet);
    this.refreshTray();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.cancelPlacing();
    this.select(null);
    this.panel.hide();
    this.screen.setInteractive(true);
    this.app.topbar.setEditing(false);
  }

  // 拖进来的 GLB 变成临时作品：只在当前页面有效，不进存档、不进 Museum
  async addTempWork(file: File): Promise<void> {
    const check = checkDrop(file);
    if (!check.ok) {
      toast(check.reason);
      return;
    }
    const work: Work = { id: `tmp-${++this.tempCount}`, title: file.name.replace(/\.glb$/i, ''), authorId: this.app.you.memberId, file: URL.createObjectURL(file), thumb: '', tris: 0 };
    const model = await this.view.library.load(work);
    if (model.failed) {
      URL.revokeObjectURL(work.file);
      toast('Could not read that GLB');
      return;
    }
    this.view.extraWorks.set(work.id, work);
    toast(`${work.title} added. Click the planet to place it.`);
    await this.pickFromTray(work);
  }

  // —— 作品栏 ——

  private allWorks(): Work[] {
    return [...(this.view.team?.works ?? []), ...this.view.extraWorks.values()];
  }

  private refreshTray(): void {
    this.panel.setTray(this.allWorks(), new Set(this.view.placed.keys()), this.placing?.id ?? null);
  }

  private async pickFromTray(work: Work): Promise<void> {
    const pw = this.view.placed.get(work.id);
    if (pw) {
      // 已经摆上去了：选中它，镜头转过去
      this.cancelPlacing();
      this.select(pw);
      const entry = this.view.planet;
      if (entry) {
        const dir = new THREE.Vector3(...pw.placement.dir).normalize();
        await this.app.world.rig.fly({ target: entry.home.clone(), position: entry.home.clone().addScaledVector(dir, 30), minDistance: 15, maxDistance: 70, autoRotate: false }, 0.8);
      }
      return;
    }
    this.select(null);
    this.cancelPlacing();
    this.placing = work;
    this.refreshTray();
    const model = await this.view.library.load(work);
    if (this.placing !== work) return;
    model.object.position.y = PLINTH_HEIGHT;
    model.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.material = ghostMaterial;
    });
    const ghost = new THREE.Group();
    ghost.add(model.object);
    ghost.visible = false;
    this.view.planet?.planet.works.add(ghost);
    this.ghost = ghost;
    this.ghostFootprint = model.footprint;
  }

  private cancelPlacing(): void {
    this.ghost?.removeFromParent();
    this.ghost = null;
    this.placing = null;
    if (this.active) this.refreshTray();
  }

  // —— 指针和键盘 ——

  // 鼠标下的地表方向（星球本地坐标的单位向量）；没打中星球返回 null
  private surfaceDir(e: PointerEvent): [number, number, number] | null {
    const entry = this.view.planet;
    if (!entry) return null;
    const hit = this.app.world.rayFrom(e.clientX, e.clientY).intersectObject(entry.planet.terrain, false)[0];
    if (!hit) return null;
    const v = entry.planet.group.worldToLocal(hit.point.clone()).normalize();
    return [v.x, v.y, v.z];
  }

  private towardCamera(): [number, number, number] {
    const entry = this.view.planet;
    if (!entry) return [0, 1, 0];
    const v = this.app.world.rig.camera.position.clone().sub(entry.home).normalize();
    return [v.x, v.y, v.z];
  }

  private onDown(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return;
    if (this.placing) {
      const dir = this.surfaceDir(e);
      if (!dir) return;
      e.stopImmediatePropagation();
      void this.commitPlacement(this.placing, dir);
      return;
    }
    const pw = this.view.pick(e.clientX, e.clientY);
    this.select(pw);
    if (!pw) return;
    e.stopImmediatePropagation();
    this.dragging = true;
    this.app.world.renderer.domElement.style.cursor = 'grabbing';
  }

  private onMove(e: PointerEvent): void {
    if (!this.active) return;
    if (this.dragging && this.selected) {
      const dir = this.surfaceDir(e);
      if (dir) {
        this.selected.placement.dir = dir;
        this.view.updateTransform(this.selected);
      }
      return;
    }
    const entry = this.view.planet;
    if (!this.placing || !this.ghost || !entry) return;
    const dir = this.surfaceDir(e);
    this.ghost.visible = dir !== null;
    if (!dir) return;
    const { position, quaternion } = placementTransform({ workId: '', dir, yaw: faceYaw(dir, this.towardCamera()), scale: 1 }, entry.planet.height, entry.planet.sea);
    // 和 PlanetView.updateTransform 一样按展台底下最高的地面贴地，点下去时作品不会往上跳
    position.setLength(footprintGroundRadius(position.clone().normalize(), plinthRadius(this.ghostFootprint), entry.planet.height, entry.planet.sea));
    this.ghost.position.copy(position);
    this.ghost.quaternion.copy(quaternion);
  }

  private onUp(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.app.world.renderer.domElement.style.cursor = '';
    this.save();
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active || (e.target as HTMLElement | null)?.closest?.('input, textarea')) return;
    if (e.key === 'q' || e.key === 'Q') this.withSelected((pw) => { pw.placement.yaw -= YAW_STEP; });
    else if (e.key === 'e' || e.key === 'E') this.withSelected((pw) => { pw.placement.yaw += YAW_STEP; });
    else if (e.key === 'Delete' || e.key === 'Backspace') this.removeSelected();
    else if (e.key === 'Escape') {
      if (this.placing) this.cancelPlacing();
      else this.select(null);
    }
  }

  // —— 修改 ——

  private async commitPlacement(work: Work, dir: [number, number, number]): Promise<void> {
    const placement: Placement = { workId: work.id, dir, yaw: faceYaw(dir, this.towardCamera()), scale: 1 };
    this.cancelPlacing();
    const pw = await this.view.place(placement);
    this.refreshTray();
    if (!pw) return;
    this.select(pw);
    this.save();
  }

  private select(pw: PlacedWork | null): void {
    this.selected = pw;
    this.view.setHighlight(pw);
    this.panel.showBar(pw);
  }

  private withSelected(change: (pw: PlacedWork) => void): void {
    const pw = this.selected;
    if (!pw) return;
    change(pw);
    pw.placement.yaw = Math.atan2(Math.sin(pw.placement.yaw), Math.cos(pw.placement.yaw)); // 收回 (-π, π]
    this.view.updateTransform(pw);
    this.panel.showBar(pw);
    this.save();
  }

  private removeSelected(): void {
    const pw = this.selected;
    if (!pw) return;
    this.select(null);
    this.view.remove(pw.work.id);
    this.refreshTray();
    this.save();
  }

  private setAppearance(patch: Partial<Pick<PlanetRecipe, 'seed' | 'preset' | 'ring' | 'atmosphere'>>): void {
    const team = this.view.team;
    if (!team) return;
    const next: Team = { ...team, planet: { ...team.planet, ...patch, placements: this.savedPlacements() } };
    this.commit(next);
    this.view.refreshAll(); // 地形变了，作品重新贴地
    this.panel.syncAppearance(next.planet);
  }

  // 只保存正式作品的摆放；拖进来的临时作品（tmp- 开头）不进存档
  private savedPlacements(): Placement[] {
    return [...this.view.placed.values()].map((pw) => structuredClone(pw.placement)).filter((p) => !p.workId.startsWith('tmp-'));
  }

  private save(): void {
    const team = this.view.team;
    if (team) this.commit({ ...team, planet: { ...team.planet, placements: this.savedPlacements() } });
  }

  private commit(team: Team): void {
    this.view.team = team;
    this.app.replaceTeam(team);
    void this.app.store.savePlanet(team.id, team.planet);
  }

  private async resetDemo(): Promise<void> {
    if (!confirm('Reset the demo? All local changes will be lost.')) return;
    await this.app.store.reset();
    location.reload();
  }

  private placeBar(): void {
    if (this.active && this.selected) this.panel.moveBar(this.app.world.toScreen(this.view.topOf(this.selected)));
  }
}
