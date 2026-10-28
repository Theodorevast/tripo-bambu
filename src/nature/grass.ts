import * as THREE from 'three/webgpu';
import { mulberry32 } from '../planet/rng';

// 占位实现（V5 主线）：草和花由另一位同事做，交付时整份替换这个文件，签名保持不变：
//   createGrassField(opts) → { object, update(camera, timeSec), setDensity(n), dispose() }
// 这里只在整颗星球上撒一些静态的小草丛（不随风、不分远近），用来看 exclude 遮罩和尺度对不对

export interface GrassPlanet {
  radius: number; // 星球半径（米）
  center: THREE.Vector3; // 星球中心（世界坐标）
  height(dir: THREE.Vector3): number; // 单位方向 → 地面到球心的距离（米）
  sea: number; // 水面半径；0 = 没有水
}

export interface GrassOptions {
  renderer: THREE.WebGPURenderer;
  planet: GrassPlanet;
  exclude(dir: THREE.Vector3): number; // 0..1：1 = 这里不长草（土路、展台、作品）
  density: number; // 草量倍数（1 = 默认）
}

export interface GrassField {
  object: THREE.Object3D; // 世界坐标：直接挂到场景上
  update(camera: THREE.Camera, timeSec: number): void;
  setDensity(n: number): void;
  dispose(): void;
}

const BASE_TUFTS = 6000;

// 一丛草：三片交叉的细长三角形
function tuftGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI;
    const x = Math.cos(a) * 0.06;
    const z = Math.sin(a) * 0.06;
    pos.push(-x, 0, -z, x, 0, z, 0, 0.32, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export function createGrassField(opts: GrassOptions): GrassField {
  const group = new THREE.Group();
  group.name = 'grass-placeholder';
  const geometry = tuftGeometry();
  const material = new THREE.MeshStandardNodeMaterial({ color: '#6f9a3e', roughness: 0.9, side: THREE.DoubleSide });
  let mesh: THREE.InstancedMesh | null = null;

  const build = (density: number) => {
    if (mesh) {
      group.remove(mesh);
      mesh.dispose();
    }
    const count = Math.max(0, Math.round(BASE_TUFTS * density * (opts.planet.radius / 30) ** 2));
    mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
    const rng = mulberry32(7);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const d = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    let n = 0;
    for (let i = 0; i < count; i++) {
      const u = rng() * 2 - 1;
      const phi = rng() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      d.set(Math.cos(phi) * r, u, Math.sin(phi) * r);
      if (rng() < opts.exclude(d)) continue;
      const h = opts.planet.height(d);
      if (opts.planet.sea > 0 && h < opts.planet.sea) continue;
      p.copy(d).multiplyScalar(h - 0.02).add(opts.planet.center);
      q.setFromUnitVectors(up, d);
      s.setScalar(0.7 + rng() * 0.8);
      mesh.setMatrixAt(n++, m.compose(p, q, s));
    }
    mesh.count = n;
    mesh.frustumCulled = false;
    group.add(mesh);
  };
  build(opts.density);

  return {
    object: group,
    update: () => {},
    setDensity: (k) => build(k),
    dispose: () => {
      mesh?.dispose();
      geometry.dispose();
      material.dispose();
      group.removeFromParent();
    },
  };
}
