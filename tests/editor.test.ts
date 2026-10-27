import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { dragPlacement, forwardOf } from '../src/editor/editor';
import { faceYaw } from '../src/planet/placement';

type Vec3 = [number, number, number];
const v = (a: Vec3 | THREE.Vector3) => (Array.isArray(a) ? new THREE.Vector3(...a) : a.clone());
const unit = (x: number, y: number, z: number): Vec3 => {
  const n = new THREE.Vector3(x, y, z).normalize();
  return [n.x, n.y, n.z];
};
const angle = (a: Vec3 | THREE.Vector3, b: Vec3 | THREE.Vector3) => v(a).angleTo(v(b));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

describe('forwardOf', () => {
  it('是切平面里的单位向量，faceYaw 能把它换回原来的 yaw', () => {
    for (const [dir, yaw] of [[unit(0.3, 0.8, 0.5), 0.4], [unit(-0.6, 0.1, 0.8), -2.5], [unit(0.01, -1, 0.02), 1.2]] as Array<[Vec3, number]>) {
      const f = forwardOf(dir, yaw);
      expect(f.length()).toBeCloseTo(1, 12);
      expect(f.dot(v(dir))).toBeCloseTo(0, 12);
      expect(wrap(faceYaw(dir, [f.x, f.y, f.z]) - yaw)).toBeCloseTo(0, 9);
    }
  });
});

describe('dragPlacement', () => {
  const dir0 = unit(0.2, 0.9, 0.4);
  const yaw0 = 0.7;
  const forward0 = forwardOf(dir0, yaw0);

  it('光标没动（d1 = d0）：摆放原样不变', () => {
    const d0 = unit(0.25, 0.85, 0.45);
    const r = dragPlacement(v(dir0), forward0, v(d0), v(d0));
    expect(angle(r.dir, dir0)).toBeLessThan(1e-9);
    expect(wrap(r.yaw - yaw0)).toBeCloseTo(0, 9);
  });

  it('保留抓取偏移：作品和光标之间的球面角距离不变，作品转过的角度等于光标转过的角度', () => {
    const d0 = unit(0.35, 0.85, 0.3); // 按在作品身上，光标下的地表在作品后面一点
    const d1 = unit(-0.4, 0.7, 0.6);
    const r = dragPlacement(v(dir0), forward0, v(d0), v(d1));
    expect(angle(r.dir, d1)).toBeCloseTo(angle(dir0, d0), 9);
    expect(angle(r.dir, dir0)).toBeLessThanOrEqual(angle(d0, d1) + 1e-9);
  });

  it('朝向跟着转：新摆放的正面就是起点正面转过同一段弧', () => {
    const d0 = unit(0.1, 0.95, 0.3);
    const d1 = unit(0.7, 0.2, -0.6);
    const r = dragPlacement(v(dir0), forward0, v(d0), v(d1));
    const q = new THREE.Quaternion().setFromUnitVectors(v(d0), v(d1));
    expect(angle(forwardOf(r.dir, r.yaw), forward0.clone().applyQuaternion(q))).toBeLessThan(1e-7);
  });

  it('在 -Y 附近绕一小段：朝向几乎不变（yaw 不变的旧做法会甩将近 180°）', () => {
    const eps = 0.02;
    const path = Array.from({ length: 11 }, (_, k) => {
      const phi = (k / 10) * (Math.PI / 2);
      return unit(eps * Math.cos(phi), -1, eps * Math.sin(phi)); // -Y 旁边四分之一圈，作品只挪了约 0.03 弧度
    });
    const start = path[0];
    const f0 = forwardOf(start, 0.3);
    let prev = f0;
    let oldSwing = 0;
    for (const p of path) {
      const r = dragPlacement(v(start), f0, v(start), v(p));
      expect(angle(r.dir, p)).toBeLessThan(1e-9);
      const f = forwardOf(r.dir, r.yaw);
      expect(angle(f, prev)).toBeLessThan(0.01); // 每一步都只转了一点点
      expect(angle(f, f0)).toBeLessThanOrEqual(angle(start, p) + 1e-9); // 总共不超过作品挪动的角度
      prev = f;
      oldSwing = Math.max(oldSwing, angle(forwardOf(p, 0.3), f0));
    }
    expect(oldSwing).toBeGreaterThan(Math.PI / 2); // 旧做法：同一段路上朝向甩过 90° 以上
  });
});
