import * as THREE from 'three/webgpu';

// 克隆出来的翠宝的手臂转轴（首页右下角的、云里探头的共用）。
// 开场探头（scenes/peek.ts 的 rigArms）已经在肩膀上套好了 peek-shoulder-L / R（GLB），克隆时一起带过来；替身是挂着磨砂手臂的肩膀 Group

export interface Arm {
  pivot: THREE.Object3D;
  side: 1 | -1; // +1：模型的 +X 那只（面朝镜头时在画面右边）
  rest: number;
}

export function findArms(root: THREE.Object3D): Arm[] {
  const arms: Arm[] = [];
  for (const [suffix, side] of [['L', 1], ['R', -1]] as const) {
    const pivot = root.getObjectByName(`peek-shoulder-${suffix}`);
    if (pivot) arms.push({ pivot, side, rest: pivot.rotation.z });
  }
  if (arms.length) return arms;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh.material as THREE.Material).name !== 'triboo-frosted' || !mesh.parent || mesh.parent === root) return;
    const g = mesh.parent;
    if (arms.some((a) => a.pivot === g)) return;
    arms.push({ pivot: g, side: g.position.x >= 0 ? 1 : -1, rest: g.rotation.z });
  });
  return arms;
}
