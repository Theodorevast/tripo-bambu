import type * as THREE from 'three/webgpu';
import { Stager, type Entrance } from './stager';

// 转场里用的 Stager：模型照常在后台准备（贴图逐帧上传、着色器后台编译），但准备好以后先不上场，
// 等转场说「可以了」（release，云层散开、镜头快落地时）再按顺序一件一件出场，每件隔 stagger 秒，复用原来的回弹出场。
// 不转场的时候（编辑器摆作品）不挡：准备好就上场。
// 拦在 prepare() 交回 Entrance 之前：PlanetView 拿到它才把模型挂上、把展台换成不透明、开始缩放淡入，
// 所以展台变实、模型弹出来都在同一刻；它的 loaded（data-planet-ready）也是在最后一件出场时才 resolve
export class GatedStager extends Stager {
  private held = false;
  private readonly waiting: Array<() => void> = [];
  private clock = 0; // 按每帧的 dt 累加（标签页在后台时不走）
  private nextAt = -Infinity; // 下一件最早什么时候出场（-Infinity：下一帧就放，并从那一刻开始排）
  private stagger = 0;
  readonly releases: number[] = []; // 最近几次放行出场的时刻（stage 的时钟，秒）：自查脚本量间隔

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

  prepare(object: THREE.Object3D, alive: () => boolean = () => true): Promise<Entrance | null> {
    return super.prepare(object, alive).then(async (entrance) => {
      if (!entrance) return null;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
      if (alive()) return entrance;
      entrance.cancel();
      return null;
    });
  }
}
