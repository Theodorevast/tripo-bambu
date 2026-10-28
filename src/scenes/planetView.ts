import * as THREE from 'three/webgpu';
import { ModelLibrary, type LoadedModel } from '../assets/models';
import type { Placement, Team, Work } from '../data/types';
import { DustPuffs } from '../nature/decorFx';
import { Gardens, type GardenWork } from '../nature/decorGarden';
import { footprintGroundRadius } from '../planet/footprint';
import { MAX_PLINTH_RADIUS, placementTransform, plinthRadius } from '../planet/placement';
import { onPlanetRadius, PLANET_RADIUS, PRESETS } from '../planet/presets';
import { plinthMaterial, STAND_TOP, standGeometry } from './plinth';
import type { PlanetEntry, World } from './world';

export { plinthRadius };

// 作品是主角（stage 角色）：圆润的玩具底座、四周自己长出来的小花园、远看也认得出的地标、摆放时的落地反馈。
//
// 地标缩放和间距的规则：
// - 放大倍数按镜头离地面的高度定：低于 near × R（漫游、贴近看）原大；高于 far × R（星球视图）放大到 overview 倍。
//   overview 按半径 30 定，星球大了等比放大（镜头按半径拉远，作品在画面里一样大），最多 max 倍。
//   作品、展台、整座花园绕作品中心一起放大，花园的零件按放大后的位置重新贴地；作品的位置（root）不动
// - 间距：每件作品最多放大到不压上土路（展台最多压进路边 pathIntrude 米）、不和邻居的花园互相压上；挤在一起的作品放大得少
// - 漫游（镜头贴地）时永远是原大：碰撞、标签距离都按原大算，和 walkMode 一致

export const STAGE = {
  overview: 2.2, // 星球视图里作品放大到几倍（星球半径 30 时；按半径等比）
  max: 3, // 最多放大到几倍
  near: 0.3, // 镜头离地面低于 near × R：原大
  far: 1.4, // 镜头离地面高于 far × R：放大到 overview 倍
  pathIntrude: 0.35, // 放大后展台最多压进土路的边多少米
  drop: 0.9, // 摆放时从多高落下（米，原大时）
  gardens: true, // 花园开关（性能对比用）
  slowmo: 1, // 落地、长花园、扬尘的时间倍数（样张脚本放慢了拍；?tune 也能看慢动作）
};

// 石头（Dressing）离作品中心至少多远（米）：花园在星球视图里放大以后，范围里的石头会戳进灌木、栅栏
export function gardenRockClearance(scale: number): number {
  return (MAX_PLINTH_RADIUS + 1.5) * Math.max(1, scale) * Math.min(STAGE.max, Math.max(1, STAGE.overview * (PLANET_RADIUS / 30)));
}

export interface PlacedWork {
  work: Work;
  placement: Placement;
  root: THREE.Group; // 贴地、对准法线、绕法线转 yaw
  stand: THREE.Group; // 地标放大、落地的弹跳、拖起来的悬浮都在这一层（root 和 scaler 之间）
  scaler: THREE.Group; // 按 placement.scale 缩放；展台、模型、拾取盒都在里面
  plinth: THREE.Mesh;
  proxy: THREE.Mesh; // 不可见的拾取盒：拾取只打它，高面数模型也不卡
  model: LoadedModel | null;
  hero: number; // 当前的地标放大倍数（1 = 原大）
}

// 落下（摆上去、拖完放下）和提起（拖动开始）
interface Motion {
  kind: 'drop' | 'lift';
  t: number;
  from: number; // drop：从多高落下（米，原大时）；lift：开始时的高度
  dust: boolean;
  landed: boolean;
}

const GRAVITY = 14; // 落下的加速度（米 / 秒²，原大时）：比真实的小一点，玩具落下来「软」一些
const LIFT = 0.22; // 拖动时作品悬在地面上多高（米）
const EXIT_SECONDS = 0.2; // 删掉时缩没的时长

// 所有展台共用一份底座几何（按展台半径缩放）
let standGeo: THREE.BufferGeometry | null = null;
const plinthGeometry = () => (standGeo ??= standGeometry());

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// 射线从起点到进入星球遮挡球的距离，打不中为 Infinity。遮挡球以星球中心为心、半径取最低可能的地形，
// 比这个距离更远的东西一定在地表背后
function occluderDistance(ray: THREE.Ray, entry: PlanetEntry): number {
  const sphere = new THREE.Sphere(entry.home, entry.planet.radius * (1 - PRESETS[entry.planet.currentRecipe.preset].amp));
  const p = ray.intersectSphere(sphere, new THREE.Vector3());
  return p ? p.distanceTo(ray.origin) : Infinity;
}

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();

// 聚焦星球上的作品：放展台和拾取盒，模型加载完再挂上；地形变了重新贴地
export class PlanetView {
  static active: PlanetView | null = null; // 页面里正在用的那一个（?tune 的 Works & gardens 组找它）
  readonly library = new ModelLibrary();
  readonly placed = new Map<string, PlacedWork>();
  readonly extraWorks = new Map<string, Work>(); // 拖进来的临时作品
  readonly gardens: Gardens;
  team: Team | null = null;
  private entry: PlanetEntry | null = null;
  private loading: Promise<void> = Promise.resolve();
  private readonly world: World;
  // 展台的三种状态（加载中半透明、不透明、不透明且高亮）各编译一份管线，这组网格一直留着、不挂上场景：
  // 进星球时摆出的展台、模型挂上时换成不透明的展台都直接用现成的，不在那一帧同步编译
  private readonly warmPlinths = new THREE.Group();
  private readonly dust: DustPuffs | null;
  private readonly motions = new Map<PlacedWork, Motion>();
  private readonly caps = new Map<string, number>(); // 每件作品最多放大到几倍（间距规则）
  private readonly layoutKeys = new Map<string, string>(); // 花园按哪一版摆放布置的：摆放变了才重新布置
  private exits: Array<{ pw: PlacedWork; t: number }> = []; // 删掉的作品：缩没以后再拿走
  private unlisten: (() => void) | null = null;
  private present = 1; // 不考虑间距时，这一帧的放大倍数（编辑器的摆放预览用）

  constructor(world: World) {
    this.world = world;
    PlanetView.active = this;
    for (const [loading, glow] of [[true, 0], [false, 0], [false, 0.6]] as const) {
      // 和真的展台一样投影、接受阴影：接受阴影的着色器不一样，不设的话预热的是另一份
      const warm = new THREE.Mesh(plinthGeometry(), plinthMaterial(loading, glow));
      warm.castShadow = true;
      warm.receiveShadow = true;
      this.warmPlinths.add(warm);
    }
    this.gardens = new Gardens(world.life?.influence);
    this.dust = world.scene ? new DustPuffs() : null;
    if (this.dust) world.scene.add(this.dust.mesh);
    // 等开场预热做完（阴影贴图建好）再编：主画面和投影那一遍都编好。花园每种零件先放一个、尘土先显示（编译跳过数量 0 和不可见的）
    (world.warm ?? Promise.resolve())
      .then(async () => {
        await world.stage.precompile(this.warmPlinths);
        this.gardens.showOneEach(true);
        try {
          await world.stage.precompile(this.gardens.group);
        } finally {
          this.gardens.showOneEach(false);
        }
        if (this.dust) {
          this.dust.showForCompile(true);
          try {
            await world.stage.precompile(this.dust.mesh);
          } finally {
            this.dust.showForCompile(false);
          }
        }
      })
      .catch((err: unknown) => console.error(err));
    world.frameHooks?.add((dt) => this.tick(dt));
    // 星球半径变了：地形已经重建（World 先收到通知），作品按新地面重新贴地
    onPlanetRadius(() => this.refreshAll());
  }

  get planet(): PlanetEntry | null {
    return this.entry;
  }

  // 最近一次 enter 摆的作品都有了结果（模型挂好，或者中途离开、换团队而作废）时 resolve。
  // 只给「模型都加载完了」的信号用，路由不要等它
  get loaded(): Promise<void> {
    return this.loading;
  }

  // 这一帧的地标放大倍数（不算间距限制）：编辑器的摆放预览按它放大，和摆上去以后一样大
  get presentScale(): number {
    return this.present;
  }

  // 立即摆好全部展台（模型加载完之前半透明，spec 2.2）就返回，模型在后台加载，不等它们。
  // 加载期间离开、换团队、又回到这个团队都没关系：迟到的模型由 place() 认出来丢掉
  enter(team: Team): void {
    this.team = team;
    this.entry = this.world.planets.get(team.id) ?? null;
    this.bindPlanet();
    this.loading = Promise.all(team.planet.placements.map((p) => this.place(p))).then(() => {});
  }

  leave(): void {
    for (const id of [...this.placed.keys()]) this.discard(id);
    for (const e of this.exits) this.dispose(e.pw);
    this.exits = [];
    this.motions.clear();
    this.caps.clear();
    this.layoutKeys.clear();
    this.unlisten?.();
    this.unlisten = null;
    this.gardens.clear();
    this.gardens.setGround(null);
    this.gardens.group.removeFromParent();
    this.team = null;
    this.entry = null;
  }

  findWork(workId: string): Work | undefined {
    return this.team?.works.find((w) => w.id === workId) ?? this.extraWorks.get(workId);
  }

  // 展台和拾取盒当场摆上（在第一个 await 之前），模型加载完才挂；返回的 Promise 等模型挂好。
  // 编辑器摆一件作品时会 await 它；drop = true：模型挂上时从半空落下、扬起尘土、花园长出来（摆放的反馈）
  async place(p: Placement, opts: { drop?: boolean } = {}): Promise<PlacedWork | null> {
    const work = this.findWork(p.workId);
    const entry = this.entry;
    if (!work || !entry || this.placed.has(work.id)) return null;
    const root = new THREE.Group();
    const stand = new THREE.Group();
    const scaler = new THREE.Group();
    // 模型加载完之前展台是半透明的（spec 2.2）
    const plinth = new THREE.Mesh(plinthGeometry(), plinthMaterial(true));
    plinth.position.y = STAND_TOP; // 底座顶面在几何的 y = 0，往下延伸 STAND_DEPTH
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicNodeMaterial());
    proxy.visible = false;
    proxy.userData.workId = work.id;
    scaler.add(plinth, proxy);
    stand.add(scaler);
    root.add(stand);
    entry.planet.works.add(root);
    const pw: PlacedWork = { work, placement: structuredClone(p), root, stand, scaler, plinth, proxy, model: null, hero: 1 };
    this.placed.set(work.id, pw);
    this.sizeParts(pw, 1, 0.8);
    this.updateTransform(pw);
    pw.hero = Math.max(1, this.present); // 一摆上就是这一帧的放大倍数，不从原大慢慢长
    this.pose(pw, 0);
    const model = await this.library.load(work);
    // 加载期间被移除了（编辑器删掉、离开星球、换了团队，或者离开后又回来、这件已经重新摆过）：按对象比，不按 id 找，
    // 迟到的模型就不会挂到别的团队或者同一件作品的新展台上
    const current = () => this.placed.get(work.id) === pw;
    if (!current()) return null;
    // 投影、接受阴影要在预编译之前设好：接受阴影的着色器不一样，挂上以后再改就要在那一帧同步编译
    model.object.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    // 挂上之前：贴图逐帧上传、着色器在后台编译好，再排队（每帧最多挂一个）。准备期间被移除了就到此为止
    const entrance = await this.world.stage.prepare(model.object, current);
    if (!entrance) return null;
    if (!current()) {
      entrance.cancel();
      return null;
    }
    pw.model = model;
    model.object.position.y = STAND_TOP;
    scaler.add(model.object);
    this.sizeParts(pw, model.height, model.footprint);
    this.updateTransform(pw); // 展台半径要等模型加载完才知道，重新贴地
    const solid = plinth.material as THREE.MeshStandardNodeMaterial;
    solid.opacity = 1;
    solid.transparent = false;
    solid.needsUpdate = true;
    entrance.start(); // 缩放加淡入
    this.arrive(pw, opts.drop === true);
    return pw;
  }

  // 编辑器删掉一件：尘土一扬、花园缩回去，作品很快缩没（缩的那一下挪到 decor 组里做，works 组里马上就没有它）
  remove(workId: string): void {
    const pw = this.placed.get(workId);
    if (!pw) return;
    this.placed.delete(workId);
    this.motions.delete(pw);
    this.caps.delete(workId);
    this.layoutKeys.delete(workId);
    this.gardens.remove(workId, true);
    const entry = this.entry;
    if (!entry || !this.world.frameHooks) {
      this.dispose(pw);
      return;
    }
    this.puffAt(pw, 1.3);
    entry.planet.decor.add(pw.root); // works 和 decor 都直接挂在星球的 group 下，局部坐标不变
    this.exits.push({ pw, t: 0 });
  }

  updateTransform(pw: PlacedWork): void {
    const entry = this.entry;
    if (!entry) return;
    const { position, quaternion } = placementTransform(pw.placement, entry.planet.height, entry.planet.sea);
    // 按展台底下最高的地面贴地；展台半径随模型和缩放变，每次都重算。不算地标放大：作品的位置不随镜头远近变
    position.setLength(footprintGroundRadius(position.clone().normalize(), pw.plinth.scale.x * pw.placement.scale, entry.planet.height, entry.planet.sea));
    pw.root.position.copy(position);
    pw.root.quaternion.copy(quaternion);
    pw.scaler.scale.setScalar(pw.placement.scale);
    // 摆放变了（旋转、缩放滑块）：花园跟着重新布置。拖动中花园收着，放下时再长
    if (pw.model && this.motions.get(pw)?.kind !== 'lift' && this.layoutKey(pw) !== this.layoutKeys.get(pw.work.id)) {
      this.computeCaps();
      this.layoutGarden(pw, {});
    }
  }

  refreshAll(): void {
    for (const pw of this.placed.values()) this.updateTransform(pw);
    this.relayoutAll();
  }

  // 编辑器开始拖动：作品提起来悬在半空，花园先收起来
  pickUp(pw: PlacedWork): void {
    if (this.placed.get(pw.work.id) !== pw) return;
    this.motions.set(pw, { kind: 'lift', t: 0, from: this.heightOf(pw), dust: false, landed: false });
    this.gardens.tuck(pw.work.id);
  }

  // 编辑器松手（包括 Esc 撤回）：从悬着的高度落下，落地时扬尘、花园在新位置长出来
  putDown(pw: PlacedWork): void {
    if (this.placed.get(pw.work.id) !== pw) return;
    this.motions.set(pw, { kind: 'drop', t: 0, from: Math.max(0.12, this.heightOf(pw)), dust: true, landed: false });
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

  // 作品顶上一点的世界坐标，给悬浮标签和编辑条用（算上地标放大）
  topOf(pw: PlacedWork): THREE.Vector3 {
    const h = (STAND_TOP + (pw.model?.height ?? 1) + 0.4) * pw.placement.scale * pw.hero;
    return pw.root.localToWorld(new THREE.Vector3(0, h, 0));
  }

  setHighlight(target: PlacedWork | null): void {
    for (const pw of this.placed.values()) {
      const m = pw.plinth.material as THREE.MeshStandardNodeMaterial;
      m.emissive.set(pw === target ? (this.team?.color ?? '#d9b77e') : '#000000');
      m.emissiveIntensity = pw === target ? 0.6 : 0;
    }
  }

  // ?tune、性能脚本：花园的零件数、绘制调用、三角形
  gardenStats(): { items: number; drawCalls: number; triangles: number } {
    return this.gardens.stats();
  }

  // ?tune 改了 STAGE：间距上限、花园按新参数重算
  applyStage(): void {
    this.relayoutAll();
  }

  private sizeParts(pw: PlacedWork, height: number, footprint: number): void {
    const r = plinthRadius(footprint);
    pw.plinth.scale.set(r, 1, r);
    const w = Math.max(0.6, footprint * 2);
    pw.proxy.scale.set(w, height, w);
    pw.proxy.position.y = STAND_TOP + height / 2;
  }

  // —— 星球、花园 ——

  private bindPlanet(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.gardens.clear();
    this.gardens.group.removeFromParent();
    const entry = this.entry;
    if (!entry) {
      this.gardens.setGround(null);
      return;
    }
    const planet = entry.planet;
    this.gardens.setGround({
      get radius() {
        return planet.radius;
      },
      height: (d) => planet.height(d.x, d.y, d.z),
      get sea() {
        return planet.sea;
      },
      path: (d) => planet.mask.sample(d, 0),
    });
    planet.decor.add(this.gardens.group);
    // 摆放变了（土路改道）：间距上限、花园的过滤都重算；已经长好的零件留着，新出现的长出来，压到路上的缩回去
    this.unlisten = planet.onMaskChange(() => this.relayoutAll());
  }

  // 模型挂上了：知道展台多大了，布置花园。drop：从半空落下，落地时花园才长；否则（进星球）跟着作品上场一起长
  private arrive(pw: PlacedWork, drop: boolean): void {
    this.computeCaps();
    if (drop) {
      this.motions.set(pw, { kind: 'drop', t: 0, from: STAGE.drop, dust: true, landed: false });
      this.layoutGarden(pw, { tucked: true });
    } else {
      this.layoutGarden(pw, { sprout: true, delay: 0.08 });
    }
  }

  private relayoutAll(): void {
    this.computeCaps();
    for (const pw of this.placed.values()) {
      if (!pw.model || this.motions.get(pw)?.kind === 'lift') continue;
      this.layoutGarden(pw, {});
    }
  }

  private layoutKey(pw: PlacedWork): string {
    const p = pw.placement;
    return `${p.dir.join(',')}|${p.yaw}|${p.scale}|${pw.plinth.scale.x}|${STAGE.gardens}`;
  }

  private layoutGarden(pw: PlacedWork, opts: { sprout?: boolean; tucked?: boolean; delay?: number }): void {
    if (!pw.model || !this.entry) return;
    this.layoutKeys.set(pw.work.id, this.layoutKey(pw));
    if (!STAGE.gardens) {
      this.gardens.remove(pw.work.id, false);
      return;
    }
    const others = [...this.placed.values()].filter((o) => o !== pw).map((o) => this.gardenWork(o));
    this.gardens.layout(this.gardenWork(pw), others, this.caps.get(pw.work.id) ?? 1, opts);
  }

  private gardenWork(pw: PlacedWork): GardenWork {
    const p = pw.placement;
    const dir = new THREE.Vector3(...p.dir).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, p.yaw));
    const front = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const team = this.team;
    const handle = team?.members.find((m) => m.id === pw.work.authorId)?.handle;
    return {
      id: pw.work.id,
      dir,
      front,
      plinth: pw.plinth.scale.x * p.scale,
      scale: p.scale,
      label: handle ? `@${handle}` : null,
      accent: new THREE.Color(team?.color ?? '#d9b77e'),
    };
  }

  // 间距规则：每件作品最多放大到多少。1）展台放大后最多压进土路的边 pathIntrude 米：沿 16 个方向找最近的路；
  // 2）和每个邻居：两座花园放大后不互相压上
  private computeCaps(): void {
    const entry = this.entry;
    if (!entry) return;
    const R = entry.planet.radius;
    const mask = entry.planet.mask;
    const list = [...this.placed.values()];
    const dirs = list.map((pw) => new THREE.Vector3(...pw.placement.dir).normalize());
    const reach = list.map((pw) => this.gardens.reachOf(pw.work.id) || pw.plinth.scale.x * pw.placement.scale + 1.4);
    list.forEach((pw, i) => {
      const dir = dirs[i];
      const outer = Math.max(pw.plinth.scale.x * 1.065, pw.model?.footprint ?? 0) * pw.placement.scale;
      _t1.set(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0).cross(dir).normalize();
      _t2.crossVectors(dir, _t1);
      let near = Infinity;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        for (let r = 0.2; r < Math.min(near, 8); r += 0.1) {
          const ang = r / R;
          _v.copy(_t1).multiplyScalar(Math.cos(a)).addScaledVector(_t2, Math.sin(a));
          _v.multiplyScalar(Math.sin(ang)).addScaledVector(dir, Math.cos(ang)).normalize();
          if (mask.sample(_v, 0) > 0.5) {
            near = r;
            break;
          }
        }
      }
      let cap = (near + STAGE.pathIntrude) / Math.max(outer, 0.1);
      for (let j = 0; j < list.length; j++) {
        if (j !== i) cap = Math.min(cap, (dir.angleTo(dirs[j]) * R) / (reach[i] + reach[j]));
      }
      this.caps.set(pw.work.id, Math.max(1, Math.min(STAGE.max, cap)));
    });
  }

  // —— 每帧：地标放大、落下 / 提起、删掉时缩没、花园和尘土 ——

  private tick(frameDt: number): void {
    const dt = frameDt * STAGE.slowmo;
    const entry = this.entry;
    const camera = this.world.rig?.camera;
    let g = 1;
    if (entry && camera) {
      const R = entry.planet.radius;
      const h = camera.position.distanceTo(entry.home) - R;
      const top = Math.min(STAGE.max, Math.max(1, (STAGE.overview * R) / 30));
      g = 1 + (top - 1) * smooth(STAGE.near * R, STAGE.far * R, h);
    }
    this.present = g;
    // 放大倍数朝目标指数逼近（每秒 10）：镜头飞行时跟得上，土路改道、间距变了也不会一下子跳
    const k = 1 - Math.exp(-10 * dt);
    for (const pw of this.placed.values()) {
      const goal = Math.max(1, Math.min(g, this.caps.get(pw.work.id) ?? g));
      const next = Math.abs(goal - pw.hero) < 0.002 ? goal : pw.hero + (goal - pw.hero) * k;
      if (next !== pw.hero) pw.hero = next;
      this.gardens.setHero(pw.work.id, pw.hero);
      this.pose(pw, dt);
    }
    if (this.exits.length) {
      this.exits = this.exits.filter((e) => {
        e.t += dt;
        const s = Math.max(0, 1 - e.t / EXIT_SECONDS);
        e.pw.stand.scale.setScalar(e.pw.hero * (s * s * (3 - 2 * s)));
        if (e.t < EXIT_SECONDS) return true;
        this.dispose(e.pw);
        return false;
      });
    }
    this.gardens.group.visible = STAGE.gardens;
    this.gardens.update(dt);
    if (camera) this.dust?.update(dt, camera);
  }

  // stand 这一层：地标放大 × 落下 / 提起时的位移和压扁拉长
  private pose(pw: PlacedWork, dt: number): void {
    const s = pw.hero;
    const m = this.motions.get(pw);
    let y = 0;
    let sy = 1;
    let sxz = 1;
    if (m) {
      m.t += dt;
      if (m.kind === 'lift') {
        // 0.16 秒提到 LIFT，之后轻轻上下浮
        const u = Math.min(1, m.t / 0.16);
        const e = 1 - (1 - u) ** 3;
        y = m.from + (LIFT - m.from) * e + 0.015 * Math.sin(m.t * 5.5) * Math.min(1, m.t / 0.3);
        sy = 1 + 0.05 * Math.sin(u * Math.PI);
        sxz = 1 - 0.02 * Math.sin(u * Math.PI);
      } else {
        const fall = Math.sqrt((2 * m.from) / GRAVITY);
        if (m.t < fall) {
          // 下落：越落越快，身子拉长一点
          const u = m.t / fall;
          y = m.from * (1 - u * u);
          sy = 1 + 0.1 * u * u;
          sxz = 1 - 0.04 * u * u;
        } else {
          if (!m.landed) {
            m.landed = true;
            this.land(pw, m);
          }
          // 落地：压扁再弹回（衰减的振荡），顺带小小地跳一下
          const t = m.t - fall;
          const wob = Math.exp(-8 * t) * Math.cos(17 * t);
          sy = 1 - 0.2 * wob;
          sxz = 1 + 0.1 * wob;
          const hop = Math.min(0.07, 0.08 * m.from);
          y = t < 0.24 ? hop * Math.sin((Math.PI * t) / 0.24) * Math.exp(-3 * t) : 0;
          if (t > 0.7) {
            this.motions.delete(pw);
            sy = 1;
            sxz = 1;
            y = 0;
          }
        }
      }
    }
    pw.stand.position.set(0, y * s, 0);
    pw.stand.scale.set(s * sxz, s * sy, s * sxz);
  }

  private land(pw: PlacedWork, m: Motion): void {
    if (m.dust) this.puffAt(pw, Math.min(1.4, 0.7 + m.from));
    // 花园在落点重新布置，从零长出来（拖动时摆放变了；新摆上的本来就收着）
    this.computeCaps();
    this.layoutGarden(pw, { sprout: true, delay: 0.04 });
  }

  // 作品脚下扬一圈尘
  private puffAt(pw: PlacedWork, strength: number): void {
    const entry = this.entry;
    if (!this.dust || !entry) return;
    pw.root.updateWorldMatrix(true, false);
    const at = pw.root.getWorldPosition(new THREE.Vector3());
    const up = at.clone().sub(entry.home).normalize();
    const radius = pw.plinth.scale.x * 1.06 * pw.placement.scale * pw.hero;
    this.dust.puff(at, up, radius, pw.hero * Math.min(1.5, Math.max(0.8, pw.placement.scale)), strength);
  }

  // 当前 stand 离地多高（米，原大时）：拖动开始、松手时从这个高度接着动
  private heightOf(pw: PlacedWork): number {
    return pw.stand.position.y / Math.max(pw.hero, 1e-3);
  }

  // 立刻拿掉（离开星球）：不扬尘、不缩
  private discard(workId: string): void {
    const pw = this.placed.get(workId);
    if (!pw) return;
    this.placed.delete(workId);
    this.motions.delete(pw);
    this.gardens.remove(workId, false);
    this.dispose(pw);
  }

  private dispose(pw: PlacedWork): void {
    pw.root.removeFromParent();
    (pw.plinth.material as THREE.Material).dispose();
    pw.proxy.geometry.dispose();
    (pw.proxy.material as THREE.Material).dispose();
  }
}
