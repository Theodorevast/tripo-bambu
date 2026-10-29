import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { fitHomeCamera, HOME_FIT, homeLayout, homeShape, type HomeShape, type HomeTeam } from '../src/scenes/homeLayout';
import { HOME_MOTION, PlanetMotion, wrapAngle } from '../src/scenes/homeMotion';

const R = 30;
// 种子数据的样子：前 4 个建好了，后面 10 个建设中
const teams = (built: number, building: number): HomeTeam[] => [
  ...Array.from({ length: built }, (_, i) => ({ id: `b${i}`, built: true })),
  ...Array.from({ length: building }, (_, i) => ({ id: `u${i}`, built: false })),
];

describe('首页版式：螺旋星系（homeLayout）', () => {
  it('你的星球在正中、最大；建好的在里圈、建设中的在外圈，越往外越小、越淡；结果确定', () => {
    const list = teams(6, 10);
    const slots = homeLayout(list, 'b0', 'wide', R);
    expect(homeLayout(list, 'b0', 'wide', R)).toEqual(slots);
    expect(slots.map((s) => s.id)).toEqual(list.map((t) => t.id));
    const you = slots.find((s) => s.id === 'b0')!;
    expect([you.tier, you.pos[0], you.pos[2]]).toEqual(['you', 0, 0]);
    for (const s of slots) if (s !== you) expect(you.scale).toBeGreaterThan(s.scale);
    const r = (s: (typeof slots)[number]) => Math.hypot(s.pos[0], s.pos[2]);
    const built = slots.filter((s) => s.tier === 'built');
    const building = slots.filter((s) => s.tier === 'building');
    expect(Math.min(...building.map(r))).toBeGreaterThan(Math.max(...built.map(r)));
    for (const s of building) expect(s.dim).toBeGreaterThan(0);
    for (const s of built) expect(s.dim).toBe(0);
    // 越往外越小：最外的比最里的小
    const sorted = [...built, ...building].sort((x, y) => r(x) - r(y));
    expect(sorted.at(-1)!.scale).toBeLessThan(sorted[0].scale);
  });

  it('两条螺旋臂：星球交替排在两条臂上，从里往外转', () => {
    const slots = homeLayout(teams(8, 0), 'b0', 'wide', R).filter((s) => s.tier !== 'you');
    const angle = (s: (typeof slots)[number]) => Math.atan2(s.pos[2], s.pos[0]);
    // 第 0、1 颗（两条臂的第一颗）大致在相对的两边
    const d = Math.abs(((angle(slots[0]) - angle(slots[1]) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    expect(Math.PI - d).toBeLessThan(0.9);
    // 同一条臂上往外越来越远
    const arm0 = slots.filter((_, i) => i % 2 === 0).map((s) => Math.hypot(s.pos[0], s.pos[2]));
    arm0.forEach((v, i) => { if (i) expect(v).toBeGreaterThan(arm0[i - 1]); });
  });

  it('团队数从 1 到 20（建好的、建设中的各种比例）：两颗星球之间不重叠', () => {
    for (let n = 1; n <= 20; n++) {
      for (const built of new Set([0, 1, Math.min(n, 4), Math.min(n, 7), n])) {
        const list = teams(built, n - built);
        const slots = homeLayout(list, list[0].id, 'wide', R);
        for (let i = 0; i < slots.length; i++) {
          for (let j = i + 1; j < slots.length; j++) {
            const a = slots[i];
            const b = slots[j];
            const d = Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]);
            expect(d, `${n} 个（${built} 个建好）：${a.id} 和 ${b.id}`).toBeGreaterThan((a.scale + b.scale) * R * 1.1);
          }
        }
      }
    }
  });

  it('加一颗星球：别的星球的随机偏移不变（按团队 id 定），版式照样排得下', () => {
    const a = homeLayout(teams(6, 10), 'b0', 'wide', R);
    const b = homeLayout([...teams(6, 10), { id: 'new', built: true }], 'new', 'wide', R);
    expect(b.find((s) => s.id === 'new')!.tier).toBe('you');
    expect(b.find((s) => s.id === 'b0')!.tier).toBe('built'); // 原来的你的星球滑到螺旋臂上
    expect(a.find((s) => s.id === 'b0')!.tier).toBe('you');
  });

  it('按星球半径整体缩放：半径 60 的位置正好是半径 30 的 2 倍', () => {
    const a = homeLayout(teams(6, 10), 'b0', 'wide', 30);
    const b = homeLayout(teams(6, 10), 'b0', 'wide', 60);
    a.forEach((s, i) => s.pos.forEach((v, k) => expect(b[i].pos[k]).toBeCloseTo(v * 2, 6)));
  });

  it('竖屏用竖屏的镜头：宽高比小于 0.95；竖屏的仰角更高（更接近俯视）', () => {
    expect(homeShape(390 / 844)).toBe('tall');
    expect(homeShape(1440 / 900)).toBe('wide');
    expect(HOME_FIT.tall.elevation).toBeGreaterThan(HOME_FIT.wide.elevation);
  });

  it('取景：看向星系中心；左右转到哪个角度，所有星球都在画面的安全区里', () => {
    for (const [w, h] of [[1440, 900], [1280, 800], [390, 844], [820, 1180]]) {
      const shape: HomeShape = homeShape(w / h);
      const fit = HOME_FIT[shape];
      const slots = homeLayout(teams(6, 10), 'b0', shape, R);
      const cam = fitHomeCamera(slots, R, w, h, fit);
      expect(cam.target.length()).toBe(0);
      const dir = cam.position.clone().sub(cam.target).normalize();
      expect(THREE.MathUtils.radToDeg(Math.asin(dir.y))).toBeCloseTo(fit.elevation, 6);
      for (const turn of [0, 90, 180, 270]) {
        const camera = new THREE.PerspectiveCamera(fit.fov, w / h, 0.1, 1e5);
        camera.position.copy(cam.position).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(turn));
        camera.lookAt(cam.target);
        camera.rotateX(Math.atan2(cam.lift, cam.distance));
        camera.updateMatrixWorld();
        for (const s of slots) {
          const p = new THREE.Vector3(...s.pos).project(camera);
          expect(Math.abs(p.x), `${w}×${h} 转 ${turn}° ${s.id}`).toBeLessThan(1);
          expect(p.y, `${w}×${h} 转 ${turn}° ${s.id}`).toBeLessThan(fit.top + 0.05);
          expect(p.y, `${w}×${h} 转 ${turn}° ${s.id}`).toBeGreaterThan(fit.bottom - 0.05);
        }
      }
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
