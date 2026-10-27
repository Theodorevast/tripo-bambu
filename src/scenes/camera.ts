import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface Framing {
  target: THREE.Vector3;
  position: THREE.Vector3;
  minDistance: number;
  maxDistance: number;
  autoRotate: boolean;
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// 镜头：OrbitControls 负责手动转动；fly() 用缓入缓出飞到新的取景（默认 1.2 秒）
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 6000);
  readonly controls: OrbitControls;
  private flight: { fromPos: THREE.Vector3; fromTarget: THREE.Vector3; to: Framing; start: number; ms: number; done: () => void } | null = null;

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
    this.apply(f);
    this.controls.update();
  }

  fly(f: Framing, duration = 1.2): Promise<void> {
    this.flight?.done();
    this.controls.enabled = false;
    this.controls.autoRotate = false;
    // 飞行时放开距离限制，否则 update() 会把镜头夹回去
    this.controls.minDistance = 0;
    this.controls.maxDistance = Infinity;
    return new Promise((done) => {
      this.flight = { fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(), to: f, start: performance.now(), ms: duration * 1000, done };
    });
  }

  update(dt: number): void {
    const fl = this.flight;
    if (!fl) {
      this.controls.update(dt);
      return;
    }
    const k = easeInOutCubic(Math.min(1, (performance.now() - fl.start) / fl.ms));
    this.camera.position.lerpVectors(fl.fromPos, fl.to.position, k);
    this.controls.target.lerpVectors(fl.fromTarget, fl.to.target, k);
    this.camera.lookAt(this.controls.target);
    if (k >= 1) {
      this.flight = null;
      this.apply(fl.to);
      this.controls.enabled = true;
      fl.done();
    }
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private apply(f: Framing): void {
    this.controls.minDistance = f.minDistance;
    this.controls.maxDistance = f.maxDistance;
    this.controls.autoRotate = f.autoRotate;
  }
}
