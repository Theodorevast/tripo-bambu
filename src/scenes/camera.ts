import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface Framing {
  target: THREE.Vector3; // 环绕中心：镜头绕它转，远近限制也按到它的距离算
  position: THREE.Vector3;
  minDistance: number;
  maxDistance: number;
  autoRotate: boolean;
  lift?: number; // 画面中心比环绕中心高出多少（世界单位，沿屏幕上方）；不写就是 0，正对环绕中心
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// 镜头：OrbitControls 负责手动转动；fly() 用缓入缓出飞到新的取景（默认 1.2 秒）
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 6000);
  readonly controls: OrbitControls;
  private lift = 0;
  private flight: { fromPos: THREE.Vector3; fromTarget: THREE.Vector3; fromLift: number; to: Framing; start: number; ms: number; done: () => void } | null = null;

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
    return new Promise((done) => {
      this.flight = { fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(), fromLift: this.lift, to: f, start: performance.now(), ms: duration * 1000, done };
    });
  }

  update(dt: number): void {
    const fl = this.flight;
    if (!fl) {
      this.controls.update(dt);
    } else {
      const k = easeInOutCubic(Math.min(1, (performance.now() - fl.start) / fl.ms));
      this.camera.position.lerpVectors(fl.fromPos, fl.to.position, k);
      this.controls.target.lerpVectors(fl.fromTarget, fl.to.target, k);
      this.lift = THREE.MathUtils.lerp(fl.fromLift, fl.to.lift ?? 0, k);
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

  private apply(f: Framing): void {
    this.controls.minDistance = f.minDistance;
    this.controls.maxDistance = f.maxDistance;
    this.controls.autoRotate = f.autoRotate;
  }
}
