import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { centerOrder, fitHomeCamera, HOME_FIT, HOME_LAYOUT, homeLayout, homeShape, splitRows, type HomeShape, type HomeTeam } from '../src/scenes/homeLayout';
import { HOME_MOTION, PlanetMotion, wrapAngle } from '../src/scenes/homeMotion';

const R = 30;
// 种子数据的样子：前 4 个建好了，后面 10 个建设中
const teams = (built: number, building: number): HomeTeam[] => [
  ...Array.from({ length: built }, (_, i) => ({ id: `b${i}`, built: true })),
  ...Array.from({ length: building }, (_, i) => ({ id: `u${i}`, built: false })),
];

describe('首页版式（homeLayout）', () => {
  it('分排：每排不超过上限，各排尽量一样多；前面的排多放', () => {
    expect(splitRows(0, 5)).toEqual([]);
    expect(splitRows(4, 5)).toEqual([4]);
    expect(splitRows(10, 6)).toEqual([5, 5]);
    expect(splitRows(7, 3)).toEqual([3, 2, 2]);
  });

  it('一排里「你的星球」在正中，别的从中间往两边填（右、左、右……）', () => {
    expect(centerOrder('you', ['a', 'b', 'c', 'd'], 5)).toEqual(['d', 'b', 'you', 'a', 'c']);
    expect(centerOrder(null, ['a', 'b', 'c'], 3)).toEqual(['c', 'a', 'b']);
    expect(centerOrder('you', ['a', 'b', 'c'], 4)).toEqual(['b', 'you', 'a', 'c']);
  });

  for (const shape of ['wide', 'tall'] as HomeShape[]) {
    it(`${shape}：结果确定；你的星球在最前面正中、最大；建好的在建设中的前面，建设中的更小、更淡`, () => {
      const list = teams(4, 10);
      const slots = homeLayout(list, 'b1', shape, R);
      expect(homeLayout(list, 'b1', shape, R)).toEqual(slots);
      expect(slots.map((s) => s.id)).toEqual(list.map((t) => t.id)); // 和输入同样的顺序
      const you = slots.find((s) => s.id === 'b1')!;
      expect(you.tier).toBe('you');
      expect(you.pos[0]).toBeCloseTo(0, 9);
      for (const s of slots) if (s !== you) expect(you.pos[2]).toBeGreaterThan(s.pos[2]); // 离镜头（+Z）最近
      expect(you.scale).toBe(Math.max(...slots.map((s) => s.scale)));
      const built = slots.filter((s) => s.tier === 'built');
      const building = slots.filter((s) => s.tier === 'building');
      const minBuiltZ = Math.min(...built.map((s) => s.pos[2]));
      for (const s of building) {
        expect(s.pos[2]).toBeLessThan(minBuiltZ);
        expect(s.scale).toBe(HOME_LAYOUT.backScale);
        expect(s.dim).toBe(HOME_LAYOUT.backDim);
        expect(s.scale).toBeLessThan(1);
      }
      for (const s of built) expect([s.scale, s.dim]).toEqual([1, 0]);
    });
  }

  it('团队数从 1 到 16（建好的、建设中的各种比例）：两颗星球之间不重叠，每一排左右对称', () => {
    for (const shape of ['wide', 'tall'] as HomeShape[]) {
      for (let n = 1; n <= 16; n++) {
        for (const built of new Set([0, 1, Math.min(n, 4), Math.min(n, 6), n])) {
          const list = teams(built, n - built);
          const slots = homeLayout(list, list[0].id, shape, R);
          for (let i = 0; i < slots.length; i++) {
            for (let j = i + 1; j < slots.length; j++) {
              const a = slots[i];
              const b = slots[j];
              const d = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
              expect(d, `${shape} ${n} 个（${built} 个建好）：${a.id} 和 ${b.id}`).toBeGreaterThan((a.scale + b.scale) * R * 1.15);
            }
          }
          // 左右对称：所有星球横坐标的和接近 0（建设中两排一样多时左右各错开 1/4 个间距，仍然对称）
          const sum = slots.reduce((s, x) => s + x.pos[0], 0);
          expect(Math.abs(sum), `${shape} ${n} 个（${built} 个建好）`).toBeLessThan(R * 1e-6 + 1e-6);
        }
      }
    }
  });

  it('按星球半径整体缩放：半径 60 的位置正好是半径 30 的 2 倍', () => {
    const a = homeLayout(teams(4, 10), 'b0', 'wide', 30);
    const b = homeLayout(teams(4, 10), 'b0', 'wide', 60);
    a.forEach((s, i) => s.pos.forEach((v, k) => expect(b[i].pos[k]).toBeCloseTo(v * 2, 9)));
  });

  it('没有「你的星球」（或者它在建设中）时照样排；你的星球在建设中也站在最前面', () => {
    expect(homeLayout(teams(3, 2), null, 'wide', R).every((s) => s.tier !== 'you')).toBe(true);
    const list = teams(3, 2);
    const slots = homeLayout(list, 'u1', 'wide', R);
    const you = slots.find((s) => s.id === 'u1')!;
    expect([you.tier, you.dim, you.pos[0]]).toEqual(['you', 0, 0]);
  });

  it('竖屏用竖排：宽高比小于 0.95', () => {
    expect(homeShape(390 / 844)).toBe('tall');
    expect(homeShape(1440 / 900)).toBe('wide');
  });

  it('取景：所有星球连同下面的名牌都落在画面的安全区里，看的点在版式附近', () => {
    for (const [w, h] of [[1440, 900], [1280, 800], [1024, 900], [390, 844], [820, 1180]]) {
      const shape = homeShape(w / h);
      const fit = HOME_FIT[shape];
      const slots = homeLayout(teams(4, 10), 'b0', shape, R);
      const cam = fitHomeCamera(slots, R, w, h, fit);
      const camera = new THREE.PerspectiveCamera(fit.fov, w / h, 0.1, 1e5);
      camera.position.copy(cam.position);
      camera.lookAt(cam.target);
      camera.updateMatrixWorld();
      const tag = (fit.tagPx / h) * 2;
      for (const s of slots) {
        const p = new THREE.Vector3(...s.pos).project(camera);
        expect(p.x, `${w}×${h} ${s.id}`).toBeGreaterThan(fit.left - 0.02);
        expect(p.x, `${w}×${h} ${s.id}`).toBeLessThan(fit.right + 0.02);
        expect(p.y, `${w}×${h} ${s.id}`).toBeLessThan(fit.top + 0.02);
        expect(p.y - tag, `${w}×${h} ${s.id}`).toBeGreaterThan(fit.bottom - 0.05);
      }
      // 镜头在版式前上方、按仰角看下去
      const dir = cam.position.clone().sub(cam.target).normalize();
      expect(THREE.MathUtils.radToDeg(Math.asin(dir.y))).toBeCloseTo(fit.elevation, 6);
      expect(cam.distance).toBeGreaterThan(R * 2);
    }
  });
});

describe('首页星球的小动作（homeMotion）', () => {
  it('悬停：慢慢放大到 1 + hoverScale、绕竖轴转起来；不悬停了转速停下来，角度留在原处', () => {
    const m = new PlanetMotion();
    for (let i = 0; i < 120; i++) m.step(1 / 60, true, false);
    expect(m.scale).toBeCloseTo(1 + HOME_MOTION.hoverScale, 2);
    expect(m.spinV).toBeGreaterThan(HOME_MOTION.spin * 0.9);
    for (let i = 0; i < 300; i++) m.step(1 / 60, false, false);
    expect(m.scale).toBeCloseTo(1, 3);
    expect(Math.abs(m.spinV)).toBeLessThan(1e-3);
    expect(Math.abs(m.spin)).toBeGreaterThan(0.3); // 没有倒着转回去
    expect(m.resting).toBe(true);
  });

  it('按下去压扁，松开时回弹：冲过原大小再回来', () => {
    const m = new PlanetMotion();
    m.pressed = true;
    for (let i = 0; i < 30; i++) m.step(1 / 60, false, false);
    expect(m.scale).toBeCloseTo(1 - HOME_MOTION.press, 2);
    m.pressed = false;
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      m.step(1 / 60, false, false);
      peak = Math.max(peak, m.scale);
    }
    expect(peak).toBeGreaterThan(1.01); // 冲过头
    for (let i = 0; i < 120; i++) m.step(1 / 60, false, false);
    expect(m.scale).toBeCloseTo(1, 3);
  });

  it('要进这颗星球时很快转回原来的朝向（半秒内），卡了一大帧也不会弹飞', () => {
    const m = new PlanetMotion();
    m.spin = 2.5;
    m.spinV = 0.4;
    for (let i = 0; i < 30; i++) m.step(1 / 60, false, true);
    expect(Math.abs(m.spin)).toBeLessThan(0.05);
    m.pressed = true;
    m.step(0.1, false, true);
    expect(Number.isFinite(m.press) && Math.abs(m.press) < 0.2).toBe(true);
  });

  it('角度收到 (-π, π]', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(7)).toBeCloseTo(7 - Math.PI * 2, 9);
  });
});
