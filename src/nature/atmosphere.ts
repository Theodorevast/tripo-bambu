import * as THREE from 'three/webgpu';
import { cameraPosition, max, mix, normalize, positionWorld, pow, smoothstep, uniform } from 'three/tsl';

// 占位实现（V5 主线）：天空、云海和光照由另一位同事做，交付时整份替换这个文件，签名保持不变：
//   createAtmosphere(scene, renderer, { planetRadius, preset }) → { update(dtSec, camera), setPreset(p), sun, dispose() }
// 这里只做：淡蓝到奶白的渐变天空、地平线以下一层奶白的「云海」色、低角度的暖色太阳、天光半球光、
// 一张很小的渐变环境贴图（金属不发黑）。白天和日落两套颜色

export type AtmospherePreset = 'day' | 'sunset';

export interface AtmosphereOptions {
  planetRadius: number;
  preset: AtmospherePreset;
}

export interface Atmosphere {
  update(dtSec: number, camera: THREE.Camera): void;
  setPreset(p: AtmospherePreset): void;
  sun: THREE.DirectionalLight;
  dispose(): void;
}

interface Look {
  zenith: string;
  horizon: string;
  below: string;
  sun: string;
  sunIntensity: number;
  sky: string;
  ground: string;
  hemi: number;
  elevation: number; // 太阳仰角（度）
  azimuth: number; // 方位角（度，从 +Z 转向 +X）
}

const LOOKS: Record<AtmospherePreset, Look> = {
  day: { zenith: '#76aee3', horizon: '#f4efe4', below: '#f2ece6', sun: '#ffe6bf', sunIntensity: 3.4, sky: '#cfe2f5', ground: '#5f6b40', hemi: 0.55, elevation: 26, azimuth: -72 },
  sunset: { zenith: '#8c84c6', horizon: '#f8b48c', below: '#f0c2b6', sun: '#ffaa62', sunIntensity: 3.2, sky: '#d9b4c8', ground: '#5e5048', hemi: 0.45, elevation: 9, azimuth: -80 },
};

// 小号等距柱状渐变（上天、下云），交给 scene.environment：three 会自己做 PMREM，金属材质照得到天光
function envTexture(look: Look): THREE.DataTexture {
  const w = 64;
  const h = 32;
  const data = new Uint16Array(w * h * 4);
  const top = new THREE.Color(look.zenith);
  const mid = new THREE.Color(look.horizon);
  const low = new THREE.Color(look.below).multiplyScalar(0.85);
  const c = new THREE.Color();
  for (let j = 0; j < h; j++) {
    const v = (j + 0.5) / h; // 0 = 最下面
    const y = v * 2 - 1;
    if (y > 0) c.copy(mid).lerp(top, Math.pow(y, 0.6));
    else c.copy(mid).lerp(low, Math.pow(-y, 0.5));
    for (let i = 0; i < w; i++) {
      const k = (j * w + i) * 4;
      data[k] = THREE.DataUtils.toHalfFloat(c.r);
      data[k + 1] = THREE.DataUtils.toHalfFloat(c.g);
      data[k + 2] = THREE.DataUtils.toHalfFloat(c.b);
      data[k + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

export function createAtmosphere(scene: THREE.Scene, _renderer: THREE.WebGPURenderer, opts: AtmosphereOptions): Atmosphere {
  const zenith = uniform(new THREE.Color());
  const horizon = uniform(new THREE.Color());
  const below = uniform(new THREE.Color());
  const sunColor = uniform(new THREE.Color());
  const sunDir = uniform(new THREE.Vector3(0, 1, 0));
  const viewUp = uniform(new THREE.Vector3(0, 1, 0));

  // 天空球：跟着镜头走，按视线方向的高度角取色；太阳方向加一圈暖光晕
  const view = normalize(positionWorld.sub(cameraPosition));
  const up = view.dot(viewUp); // 「水平面」按 camera.up 算：漫游时是角色脚下的球面法线（World 设），轨道镜头是 +Y
  const sky = mix(horizon, zenith, pow(max(up, 0), 0.55));
  const cloud = mix(horizon, below, smoothstep(0, -0.25, up));
  const base = mix(cloud, sky, smoothstep(-0.02, 0.02, up));
  const toSun = max(view.dot(sunDir), 0);
  const glow = pow(toSun, 8).mul(0.35).add(pow(toSun, 900).mul(4));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false }));
  (dome.material as THREE.MeshBasicNodeMaterial).colorNode = base.add(sunColor.mul(glow));
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  dome.name = 'sky-placeholder';
  scene.add(dome);

  const sun = new THREE.DirectionalLight('#ffffff', 3);
  sun.name = 'sun';
  const hemi = new THREE.HemisphereLight('#ffffff', '#444444', 1);
  scene.add(sun, sun.target, hemi);
  let env: THREE.DataTexture | null = null;

  const setPreset = (p: AtmospherePreset) => {
    const look = LOOKS[p];
    zenith.value.set(look.zenith);
    horizon.value.set(look.horizon);
    below.value.set(look.below);
    sunColor.value.set(look.sun);
    const az = THREE.MathUtils.degToRad(look.azimuth);
    const el = THREE.MathUtils.degToRad(look.elevation);
    sunDir.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    sun.color.set(look.sun);
    sun.intensity = look.sunIntensity;
    hemi.color.set(look.sky);
    hemi.groundColor.set(look.ground);
    hemi.intensity = look.hemi;
    env?.dispose();
    env = envTexture(look);
    scene.environment = env;
    scene.environmentIntensity = 0.55;
  };
  setPreset(opts.preset);


  return {
    sun,
    setPreset,
    update: (_dt, camera) => {
      // 天空球跟着镜头，半径取镜头远平面的 0.9 倍
      const cam = camera as THREE.PerspectiveCamera;
      dome.position.copy(camera.position);
      viewUp.value.copy(camera.up).normalize();
      dome.scale.setScalar((cam.far || 1000) * 0.9);
      // 太阳：平行光只看方向。位置放在目标后面（目标由外面摆到镜头看着的地方，阴影相机跟着它）
      sun.position.copy(sun.target.position).addScaledVector(sunDir.value, 100);
    },
    dispose: () => {
      scene.remove(dome, sun, sun.target, hemi);
      dome.geometry.dispose();
      (dome.material as THREE.Material).dispose();
      env?.dispose();
      if (scene.environment === env) scene.environment = null;
    },
  };
}
