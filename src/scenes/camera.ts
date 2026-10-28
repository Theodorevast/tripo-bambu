import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface Framing {
  target: THREE.Vector3; // 环绕中心：镜头绕它转，远近限制也按到它的距离算
  position: THREE.Vector3;
  minDistance: number;
  maxDistance: number;
  autoRotate: boolean;
  lift?: number; // 画面中心比环绕中心高出多少（世界单位，沿屏幕上方）；不写就是 0，正对环绕中心
  fov?: number; // 竖直视角（度）；不写就保持当前的
  minPolar?: number; // OrbitControls 的极角限制（弧度，从正上方量）：星球视图里镜头不压到云海以下；不写就是 0..π
  maxPolar?: number;
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// 镜头：OrbitControls 负责手动转动；fly() 用缓入缓出飞到新的取景（默认 1.2 秒）。
// 飞行进度按每帧的 dt 累加，不看墙上时间：标签页切到后台再回来（主循环停了），镜头接着飞，不会一下子跳到终点
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 6000);
  readonly controls: OrbitControls;
  // 外部接管镜头（漫游的跟随镜头）：设了就每帧只调它摆镜头，OrbitControls、飞行、抬头都不碰镜头
  drive: ((dt: number) => void) | null = null;
  private lift = 0;
  private flight: { fromPos: THREE.Vector3; fromTarget: THREE.Vector3; fromLift: number; fromFov: number; to: Framing; elapsed: number; seconds: number; done: () => void } | null = null;

  constructor(dom: HTMLElement) {
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.autoRotateSpeed = 0.35;
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  jump(f: Framing): void {
    this.camera.position.copy(f.position);
    this.controls.target.copy(f.target);
    this.lift = f.lift ?? 0;
    if (f.fov !== undefined) this.setFov(f.fov);
    this.apply(f);
    this.controls.update();
    this.raise();
    this.camera.updateMatrixWorld();
  }

  fly(f: Framing, duration = 1.2): Promise<void> {
    this.flight?.done();
    this.controls.enabled = false;
    this.controls.autoRotate = false;
    // 飞行时放开距离限制，否则 update() 会把镜头夹回去
    this.controls.minDistance = 0;
    this.controls.maxDistance = Infinity;
    // 扔掉 OrbitControls 阻尼里剩下的转动（星系自转、手拖留下的）：不然飞到以后镜头还会慢慢漂一两秒
    const momentum = this.controls as unknown as { _sphericalDelta?: THREE.Spherical; _panOffset?: THREE.Vector3; _scale?: number };
    momentum._sphericalDelta?.set(0, 0, 0);
    momentum._panOffset?.set(0, 0, 0);
    if (momentum._scale !== undefined) momentum._scale = 1;
    return new Promise((done) => {
      this.flight = { fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(), fromLift: this.lift, fromFov: this.camera.fov, to: f, elapsed: 0, seconds: duration, done };
    });
  }

  // 取景参数改了（?tune 面板）：飞行中就换终点，不在飞就直接跳到新的取景
  reframe(f: Framing): void {
    if (this.flight) this.flight.to = f;
    else this.jump(f);
  }

  update(dt: number): void {
    if (this.drive) {
      this.drive(dt);
      this.camera.updateMatrixWorld();
      return;
    }
    const fl = this.flight;
    if (!fl) {
      this.controls.update(dt);
    } else {
      fl.elapsed += dt;
      const k = easeInOutCubic(fl.seconds > 0 ? Math.min(1, fl.elapsed / fl.seconds) : 1);
      this.camera.position.lerpVectors(fl.fromPos, fl.to.position, k);
      this.controls.target.lerpVectors(fl.fromTarget, fl.to.target, k);
      this.lift = THREE.MathUtils.lerp(fl.fromLift, fl.to.lift ?? 0, k);
      if (fl.to.fov !== undefined) this.setFov(THREE.MathUtils.lerp(fl.fromFov, fl.to.fov, k));
      this.camera.lookAt(this.controls.target);
      if (k >= 1) {
        this.flight = null;
        this.apply(fl.to);
        this.controls.enabled = true;
        fl.done();
      }
    }
    this.raise();
    // 立刻更新矩阵：同一帧里随后算的悬浮标签位置（toScreen）用的就是这一帧的镜头，拖动时不再慢一帧
    this.camera.updateMatrixWorld();
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // 抬头：OrbitControls 每次 update 都让镜头正对环绕中心，这里再绕镜头自身的 X 轴转 atan(lift / 距离)，
  // 画面中心就落在环绕中心「屏幕上方 lift 处」。绕的仍是环绕中心，远近限制照旧；离得越远抬得越少
  private raise(): void {
    if (this.lift === 0) return;
    this.camera.rotateX(Math.atan2(this.lift, this.camera.position.distanceTo(this.controls.target)));
  }

  private setFov(fov: number): void {
    if (this.camera.fov === fov) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  private apply(f: Framing): void {
    this.controls.minDistance = f.minDistance;
    this.controls.maxDistance = f.maxDistance;
    this.controls.autoRotate = f.autoRotate;
    this.controls.minPolarAngle = f.minPolar ?? 0;
    this.controls.maxPolarAngle = f.maxPolar ?? Math.PI;
  }
}
