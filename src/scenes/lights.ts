import * as THREE from 'three/webgpu';

// 灯光表：摄影棚式布光，暖色主光 + 冷色天光补光 + 背后的轮廓光，让各种风格的作品都好看。
// 方向用方位角（从 +Z 转向 +X，度）和仰角（度）表示；?tune 面板改这张表，再调 applyLights() 立刻生效。
// 默认值就是原来的灯位：主光 (40, 60, 80)、轮廓光 (-60, 20, -80)
export interface LightShot {
  intensity: number;
  azimuth: number;
  elevation: number;
}

export const LIGHTS: { sky: { intensity: number }; key: LightShot; rim: LightShot } = {
  sky: { intensity: 0.9 }, // 半球光：天空 #bfd4ff、地面 #2a2420
  key: { intensity: 2.4, azimuth: 26.565, elevation: 33.855 },
  rim: { intensity: 1.1, azimuth: -143.13, elevation: 11.31 },
};

// 方位角、仰角 → 单位方向：平行光从这个方向照向原点
export function lightDirection(azimuth: number, elevation: number): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuth);
  const el = THREE.MathUtils.degToRad(elevation);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

// 一个场景的一组灯（主画面、查看器、Museum 的每张卡片各一组）
export class StudioLights extends THREE.Group {
  readonly sky = new THREE.HemisphereLight(0xbfd4ff, 0x2a2420);
  readonly key = new THREE.DirectionalLight(0xfff1dc);
  readonly rim = new THREE.DirectionalLight(0x9fb8ff);

  constructor() {
    super();
    this.name = 'studio-lights';
    this.add(this.sky, this.key, this.rim);
    this.sync();
  }

  // 按灯光表设强度和方向（平行光只看方向，位置放在 100 外）
  sync(): void {
    this.sky.intensity = LIGHTS.sky.intensity;
    for (const [light, shot] of [[this.key, LIGHTS.key], [this.rim, LIGHTS.rim]] as const) {
      light.intensity = shot.intensity;
      light.position.copy(lightDirection(shot.azimuth, shot.elevation)).multiplyScalar(100);
    }
  }
}

// 还在用的灯组。弱引用：Museum 关掉后卡片的场景被回收，这里不拦着
const rigs = new Set<WeakRef<StudioLights>>();

export function addStudioLights(scene: THREE.Scene): StudioLights {
  const rig = new StudioLights();
  scene.add(rig);
  rigs.add(new WeakRef(rig));
  return rig;
}

// 灯光表改了：所有场景里的灯立刻更新
export function applyLights(): void {
  for (const ref of rigs) {
    const rig = ref.deref();
    if (rig) rig.sync();
    else rigs.delete(ref);
  }
}
