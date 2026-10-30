import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { applyDoubleSided } from '../src/assets/models';

// 作品双面画（Tripo 模型不封口、有反面，单面画会漏洞）：只改不透明的单面材质，投影面照旧
describe('applyDoubleSided', () => {
  it('不透明的单面材质改成双面，投影写明背面（和单面时 PCF 用的一样）', () => {
    const m = new THREE.MeshStandardNodeMaterial();
    const root = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), m));
    applyDoubleSided(root);
    expect(m.side).toBe(THREE.DoubleSide);
    expect(m.shadowSide).toBe(THREE.BackSide);
  });

  it('半透明的、本来就不是单面的不动；已经指定的投影面保留', () => {
    const glass = new THREE.MeshStandardNodeMaterial({ transparent: true });
    const back = new THREE.MeshStandardNodeMaterial({ side: THREE.BackSide });
    const custom = new THREE.MeshStandardNodeMaterial();
    custom.shadowSide = THREE.FrontSide;
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), [glass, back]), new THREE.Mesh(new THREE.BoxGeometry(), custom));
    applyDoubleSided(root);
    expect(glass.side).toBe(THREE.FrontSide);
    expect(back.side).toBe(THREE.BackSide);
    expect(custom.side).toBe(THREE.DoubleSide);
    expect(custom.shadowSide).toBe(THREE.FrontSide);
  });
});
