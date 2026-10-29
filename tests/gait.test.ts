import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { Gait } from '../src/play/gait';
import { WALK, WALK_ANIM } from '../src/play/params';
import { splitByX, triangleCount } from '../src/play/rig';
import { Walker } from '../src/play/walker';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const R = 30;

function walkerAt(dir: THREE.Vector3, facing: THREE.Vector3): Walker {
  const w = new Walker();
  w.ground = () => R;
  w.place(dir, facing);
  return w;
}

interface Track {
  maxSlip: number; // 着地期间脚在星球上挪了多远（最大）
  stances: number; // 落地了几次
  order: number[]; // 落地的顺序（0 左、1 右）
  maxReach: number; // 脚离身体中心（脚底那一点）最远多少
}

// 走 seconds 秒：wish(t) 给想要的速度（世界方向，每帧跟着位置转）；逐帧看两只脚
function run(w: Walker, g: Gait, seconds: number, fps: number, wish: (t: number, w: Walker, out: THREE.Vector3) => void, track?: Track): void {
  const dt = 1 / fps;
  const want = new THREE.Vector3();
  const anchors = [new THREE.Vector3(), new THREE.Vector3()];
  const planted = [g.feet[0].planted, g.feet[1].planted];
  for (let i = 0; i < 2; i++) anchors[i].copy(g.feet[i].pos);
  const n = Math.round(seconds * fps);
  for (let k = 0; k < n; k++) {
    wish(k * dt, w, want);
    want.addScaledVector(w.dir, -want.dot(w.dir));
    w.step(dt, want, []);
    g.update(w, dt);
    if (!track) continue;
    const pos = w.positionInto(new THREE.Vector3());
    for (let i = 0; i < 2; i++) {
      const f = g.feet[i];
      if (f.planted && planted[i]) track.maxSlip = Math.max(track.maxSlip, f.pos.distanceTo(anchors[i]));
      if (f.planted && !planted[i]) {
        track.stances++;
        track.order.push(i);
      }
      if (f.planted) anchors[i].copy(f.pos);
      planted[i] = f.planted;
      const d = f.pos.clone().sub(pos);
      d.addScaledVector(w.dir, -d.dot(w.dir));
      track.maxReach = Math.max(track.maxReach, d.length());
    }
  }
}

const forward = (heading: THREE.Vector3, speed = WALK.speed) => (_t: number, w: Walker, out: THREE.Vector3) => {
  heading.applyQuaternion(w.turned);
  heading.addScaledVector(w.dir, -heading.dot(w.dir)).normalize();
  out.copy(heading).multiplyScalar(speed);
};
const still = (_t: number, _w: Walker, out: THREE.Vector3) => { out.set(0, 0, 0); };

// 站姿上的脚离站姿差多少（米）
function restError(w: Walker, g: Gait): number {
  let worst = 0;
  const x = new THREE.Vector3().crossVectors(w.dir, w.facing);
  for (let i = 0; i < 2; i++) {
    const rest = w.positionInto(new THREE.Vector3()).addScaledVector(x, g.rest[i].x).addScaledVector(w.facing, g.rest[i].z);
    rest.setLength(R);
    worst = Math.max(worst, rest.distanceTo(g.feet[i].pos));
  }
  return worst;
}

describe('走路的步态', () => {
  it('直走：着地的脚钉在地上不动，左右脚轮流落地，脚不会伸到够不着的地方', () => {
    for (const fps of [30, 60, 144]) {
      const w = walkerAt(v(0, 0, 1), v(1, 0, 0));
      const g = new Gait();
      g.reset(w);
      const track: Track = { maxSlip: 0, stances: 0, order: [], maxReach: 0 };
      run(w, g, 3, fps, forward(v(1, 0, 0)), track);
      expect(track.maxSlip).toBeLessThan(1e-9);
      // 3 秒全速：每秒 4 步以上
      expect(track.stances).toBeGreaterThan(10);
      for (let i = 1; i < track.order.length; i++) expect(track.order[i]).not.toBe(track.order[i - 1]);
      expect(track.maxReach).toBeLessThan(0.5);
      expect(g.amp).toBeGreaterThan(0.8);
    }
  });

  it('身体往前走、着地的脚在角色本地坐标里往后退：落地时在前面，起脚时在后面', () => {
    const w = walkerAt(v(0, 0, 1), v(1, 0, 0));
    const g = new Gait();
    g.reset(w);
    run(w, g, 1, 60, forward(v(1, 0, 0)));
    const dt = 1 / 60;
    const wish = forward(v(1, 0, 0).applyQuaternion(new THREE.Quaternion()));
    const heading = w.facing.clone();
    const want = new THREE.Vector3();
    let landAhead = Infinity;
    let liftBehind = -Infinity;
    const was = [g.feet[0].planted, g.feet[1].planted];
    for (let k = 0; k < 120; k++) {
      void wish;
      heading.applyQuaternion(w.turned).addScaledVector(w.dir, -heading.dot(w.dir)).normalize();
      w.step(dt, want.copy(heading).multiplyScalar(WALK.speed), []);
      g.update(w, dt);
      const pos = w.positionInto(new THREE.Vector3());
      for (let i = 0; i < 2; i++) {
        const f = g.feet[i];
        const ahead = f.pos.clone().sub(pos).dot(w.facing) - g.rest[i].z;
        if (f.planted && !was[i]) landAhead = Math.min(landAhead, ahead);
        if (!f.planted && was[i]) liftBehind = Math.max(liftBehind, ahead);
        was[i] = f.planted;
      }
    }
    expect(landAhead).toBeGreaterThan(0.05);
    expect(liftBehind).toBeLessThan(-0.05);
  });

  it('停下：走完这一步，两只脚收回站姿，身体的摆动淡掉（30、60、144 帧一样）', () => {
    for (const fps of [30, 60, 144]) {
      const w = walkerAt(v(0, 0, 1), v(1, 0, 0));
      const g = new Gait();
      g.reset(w);
      run(w, g, 2, fps, forward(v(1, 0, 0)));
      const track: Track = { maxSlip: 0, stances: 0, order: [], maxReach: 0 };
      run(w, g, 2, fps, still, track);
      expect(track.maxSlip).toBeLessThan(1e-9);
      expect(g.feet[0].planted && g.feet[1].planted).toBe(true);
      expect(restError(w, g)).toBeLessThan(WALK_ANIM.settleError);
      expect(g.resting).toBe(true);
      expect(g.amp).toBeLessThan(0.02);
      expect(Math.abs(g.bob)).toBeLessThan(0.003);
      expect(Math.abs(g.pitch)).toBeLessThan(0.01);
    }
  });

  it('原地转身：速度几乎为 0、朝向在变时小碎步跟上，转完脚对齐新的朝向', () => {
    const w = walkerAt(v(0, 0, 1), v(1, 0, 0));
    const g = new Gait();
    g.reset(w);
    run(w, g, 0.5, 60, still);
    // 轻点一下往左（两帧），角色转过去、几乎不挪
    const left = v(0, 1, 0);
    const start = w.positionInto(new THREE.Vector3());
    const track: Track = { maxSlip: 0, stances: 0, order: [], maxReach: 0 };
    run(w, g, 2 / 60, 60, (_t, _w, out) => { out.copy(left).multiplyScalar(WALK.speed); }, track);
    run(w, g, 2, 60, still, track);
    expect(w.positionInto(new THREE.Vector3()).distanceTo(start)).toBeLessThan(0.15);
    expect(w.facing.dot(left)).toBeGreaterThan(0.95);
    expect(track.stances).toBeGreaterThanOrEqual(2);
    expect(track.maxSlip).toBeLessThan(1e-9);
    expect(restError(w, g)).toBeLessThan(WALK_ANIM.settleError);
    for (const f of g.feet) expect(f.fwd.dot(w.facing)).toBeGreaterThan(0.97);
  });

  it('走得越快步子越大、步频越高', () => {
    const cadence = (speed: number) => {
      const w = walkerAt(v(0, 0, 1), v(1, 0, 0));
      const g = new Gait();
      g.reset(w);
      run(w, g, 1, 60, forward(v(1, 0, 0), speed));
      const track: Track = { maxSlip: 0, stances: 0, order: [], maxReach: 0 };
      const d0 = w.distance;
      run(w, g, 3, 60, forward(v(1, 0, 0), speed), track);
      return { perSecond: track.stances / 3, stride: (w.distance - d0) / track.stances };
    };
    const slow = cadence(0.8);
    const fast = cadence(WALK.speed);
    expect(fast.perSecond).toBeGreaterThan(slow.perSecond);
    expect(fast.stride).toBeGreaterThan(slow.stride);
  });

  it('相位跟着走过的路程：同样走 2 秒，30、60、144 帧走出来的相位差不多', () => {
    const phases = [30, 60, 144].map((fps) => {
      const w = walkerAt(v(0, 0, 1), v(1, 0, 0));
      const g = new Gait();
      g.reset(w);
      let cycles = 0;
      let last = g.phase;
      const dt = 1 / fps;
      const heading = v(1, 0, 0);
      const want = new THREE.Vector3();
      for (let k = 0; k < 2 * fps; k++) {
        heading.applyQuaternion(w.turned).addScaledVector(w.dir, -heading.dot(w.dir)).normalize();
        w.step(dt, want.copy(heading).multiplyScalar(WALK.speed), []);
        g.update(w, dt);
        if (g.phase < last) cycles++;
        last = g.phase;
      }
      return cycles + g.phase;
    });
    expect(Math.abs(phases[0] - phases[1])).toBeLessThan(0.12);
    expect(Math.abs(phases[2] - phases[1])).toBeLessThan(0.12);
  });

  it('瞬移：脚直接站回新位置的站姿', () => {
    const w = walkerAt(v(0, 0, 1), v(1, 0, 0));
    const g = new Gait();
    g.reset(w);
    run(w, g, 1, 60, forward(v(1, 0, 0)));
    w.place(v(1, 0, 0), v(0, 1, 0));
    g.update(w, 1 / 60);
    expect(restError(w, g)).toBeLessThan(0.01);
  });
});

describe('鞋分成左右', () => {
  it('按三角形重心 x 的正负分开：左右的三角形数加起来等于原来的，顶点属性共用', () => {
    const a = new THREE.BoxGeometry(0.2, 0.1, 0.3, 3, 2, 4).translate(0.15, 0, 0);
    const b = new THREE.BoxGeometry(0.2, 0.1, 0.3, 2, 3, 5).translate(-0.15, 0, 0);
    // 合成一个几何（像 GLB 里的 Shoes）
    const merged = new THREE.BufferGeometry();
    const pa = a.getAttribute('position').array as Float32Array;
    const pb = b.getAttribute('position').array as Float32Array;
    const pos = new Float32Array(pa.length + pb.length);
    pos.set(pa);
    pos.set(pb, pa.length);
    merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const ia = Array.from(a.getIndex()!.array);
    const ib = Array.from(b.getIndex()!.array).map((i) => i + pa.length / 3);
    merged.setIndex([...ia, ...ib]);
    const [left, right] = splitByX(merged);
    expect(triangleCount(left) + triangleCount(right)).toBe(triangleCount(merged));
    expect(triangleCount(left)).toBe(triangleCount(a));
    expect(triangleCount(right)).toBe(triangleCount(b));
    expect(left.getAttribute('position')).toBe(merged.getAttribute('position'));
    // 左边的三角形都在 +X
    const p = merged.getAttribute('position');
    const li = left.getIndex()!;
    for (let i = 0; i < li.count; i++) expect(p.getX(li.getX(i))).toBeGreaterThan(0);
    // 原来的几何没动
    expect(merged.getIndex()!.count).toBe(ia.length + ib.length);
  });
});
