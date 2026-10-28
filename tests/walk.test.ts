import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { makeHeightFn, seaRadius } from '../src/planet/noise';
import { FollowCamera } from '../src/play/followCamera';
import { CHAR_RADIUS, FOLLOW, WADE_DEPTH, WALK } from '../src/play/params';
import { blendPose, signedAngle, slerpDir, turnToward, walkGround } from '../src/play/sphere';
import { collide, setObstacle, Walker, type Obstacle } from '../src/play/walker';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const R = 10;
const flat = () => R; // 平地：处处半径 10

function walkerAt(dir: THREE.Vector3, facing: THREE.Vector3, ground: (d: THREE.Vector3) => number = flat, obstacles: Obstacle[] = []): Walker {
  const w = new Walker();
  w.ground = ground;
  w.place(dir, facing, obstacles);
  return w;
}

// 一直按「前」：想要的速度沿镜头朝向（这里没有镜头，就用传进来的 heading，每帧跟着位置转）
function holdForward(w: Walker, heading: THREE.Vector3, seconds: number, fps: number, obstacles: Obstacle[] = [], each?: (w: Walker) => void): void {
  const dt = 1 / fps;
  const wish = new THREE.Vector3();
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    wish.copy(heading).multiplyScalar(WALK.speed);
    w.step(dt, wish, obstacles);
    heading.applyQuaternion(w.turned);
    heading.addScaledVector(w.dir, -heading.dot(w.dir)).normalize();
    each?.(w);
  }
}

function obstacle(center: THREE.Vector3, radius: number, groundRadius = R): Obstacle {
  const o: Obstacle = { center: new THREE.Vector3(), minAngle: 0, cosMin: 1 };
  setObstacle(o, center, (radius + CHAR_RADIUS) / groundRadius);
  return o;
}

// 按速度曲线 v(t) = V(1 − e^(−k t)) 积分出的路程
const expectedDistance = (t: number) => WALK.speed * (t - (1 - Math.exp(-WALK.accel * t)) / WALK.accel);

describe('球面移动', () => {
  it('沿大圆走：方向保持单位长度，走过的弧长等于速度曲线的积分，朝向和速度都在切平面里', () => {
    const w = walkerAt(v(1, 0, 0), v(0, 0, 1));
    holdForward(w, v(0, 0, 1), 2, 60, [], (x) => {
      expect(x.dir.length()).toBeCloseTo(1, 12);
      expect(Math.abs(x.facing.dot(x.dir))).toBeLessThan(1e-9);
      expect(Math.abs(x.velocity.dot(x.dir))).toBeLessThan(1e-9);
    });
    // 从 +X 朝 +Z 走：始终在 y = 0 的大圆上
    expect(Math.abs(w.dir.y)).toBeLessThan(1e-9);
    const arc = Math.acos(w.dir.x) * R;
    expect(arc).toBeCloseTo(expectedDistance(2), 3);
    expect(w.distance).toBeCloseTo(arc, 3);
  });

  it('一直往前走翻过北极：留在同一个大圆上，到了背面朝向还是沿着大圆往前（不会突然掉头）', () => {
    const w = walkerAt(v(1, 0, 0), v(0, 1, 0));
    const heading = v(0, 1, 0);
    let maxOffPlane = 0;
    let crossedPole = false;
    holdForward(w, heading, 14, 60, [], (x) => {
      maxOffPlane = Math.max(maxOffPlane, Math.abs(x.dir.z));
      if (x.dir.y > 0.999) crossedPole = true;
    });
    expect(crossedPole).toBe(true);
    expect(maxOffPlane).toBeLessThan(1e-9);
    // 14 秒走了约 44.5 个单位（超过半圈 31.4）：在 XY 平面的大圆上从 +X 转过 4.45 弧度（约 255°），过了 -X、正往南极走
    const angle = expectedDistance(14) / R;
    expect(w.dir.x).toBeCloseTo(Math.cos(angle), 3);
    expect(w.dir.y).toBeCloseTo(Math.sin(angle), 3);
    // 朝向和移动方向一致：沿大圆继续往前
    expect(w.facing.dot(w.velocity.clone().normalize())).toBeGreaterThan(0.999);
  });

  it('帧率无关：同样按住 3 秒，30、60、144 帧走到的位置和朝向一样', () => {
    const run = (fps: number) => {
      const w = walkerAt(v(0, 0, 1), v(0, 0, 1).cross(v(0, 1, 0)).normalize());
      // 先往前走，再往右转弯（想要的方向转 90°）：朝向的平滑也参与
      const heading = w.facing.clone();
      holdForward(w, heading, 1.5, fps);
      const right = heading.clone().cross(w.dir).normalize();
      holdForward(w, right, 1.5, fps);
      return w;
    };
    const a = run(30);
    const b = run(60);
    const c = run(144);
    expect(a.dir.distanceTo(c.dir) * R).toBeLessThan(0.02);
    expect(b.dir.distanceTo(c.dir) * R).toBeLessThan(0.01);
    expect(a.facing.angleTo(c.facing)).toBeLessThan(0.01);
  });

  it('转身是指数逼近：转一半所需的时间和帧率无关', () => {
    const half = (fps: number) => {
      const n = v(0, 1, 0);
      const f = v(0, 0, 1);
      const target = v(1, 0, 0);
      let t = 0;
      while (signedAngle(f, target, n) > Math.PI / 4) {
        turnToward(f, target, n, 1 - Math.exp(-WALK.turn / fps));
        t += 1 / fps;
      }
      return t;
    };
    const exact = Math.LN2 / WALK.turn;
    for (const fps of [30, 60, 144]) expect(Math.abs(half(fps) - exact)).toBeLessThanOrEqual(1 / fps + 1e-9);
  });
});

describe('贴地', () => {
  it('每一帧脚下的半径都等于那个方向的地面高度', () => {
    const height = makeHeightFn(7, 'volcanic');
    const ground = (d: THREE.Vector3) => walkGround(d, height, 0);
    const w = walkerAt(v(0.3, 0.2, 0.9), v(0, 1, 0), ground);
    holdForward(w, v(0, 1, 0).sub(w.dir.clone().multiplyScalar(w.dir.y)).normalize(), 6, 60, [], (x) => {
      expect(x.radius).toBe(height(x.dir.x, x.dir.y, x.dir.z));
    });
  });

  it('有海时在浅水里涉水：海底太深的地方脚下是海面以下 WADE_DEPTH，陆地上照常贴地', () => {
    // 自己造一个有深水的地形（V5 起预设里只剩很小的水塘，深到 WADE_DEPTH 以下的地方很少，不拿预设当夹具）：
    // 半径 10 的球面上起伏 ±1，水面在 10，最深处比水面低 1，比 WADE_DEPTH 深
    const height = (x: number, y: number, z: number) => R + Math.sin(x * 3.1 + 0.4) * Math.cos(z * 2.3) * 0.6 + Math.sin(y * 4.7) * 0.4;
    const sea = R;
    expect(seaRadius('verdant')).toBeGreaterThan(0); // 预设里还是有水的（小水塘）
    let wet = 0;
    let dry = 0;
    for (let i = 0; i < 2000; i++) {
      const d = v(Math.sin(i * 1.7), Math.cos(i * 0.9), Math.sin(i * 0.37)).normalize();
      const g = walkGround(d, height, sea);
      const h = height(d.x, d.y, d.z);
      expect(g).toBeGreaterThanOrEqual(sea - WADE_DEPTH - 1e-12);
      expect(g).toBeGreaterThanOrEqual(h);
      if (h < sea - WADE_DEPTH) {
        wet++;
        expect(g).toBe(sea - WADE_DEPTH);
      } else {
        dry++;
        expect(g).toBe(h);
      }
    }
    expect(wet).toBeGreaterThan(0); // 采样里两种情况都有
    expect(dry).toBeGreaterThan(0);
  });

  it('没有海的星球：就是高度函数', () => {
    const height = makeHeightFn(2, 'desert');
    const d = v(0.2, -0.4, 0.8).normalize();
    expect(walkGround(d, height, 0)).toBe(height(d.x, d.y, d.z));
  });
});

describe('圆柱碰撞', () => {
  // 作品在 +Z 方向，半径 1.2；角色从它南边（y < 0）6 个单位外出发，往北走。offset：往 +X 偏多少单位
  const center = v(0, 0, 1);
  const startAt = (offset: number) => v(0, 0, 1).applyAxisAngle(v(1, 0, 0), 6 / R).applyAxisAngle(v(0, 1, 0), offset / R);
  const north = (at: THREE.Vector3) => v(0, 1, 0).addScaledVector(at, -at.y).normalize();

  it('正面撞上去：停在圆柱边上，任何一帧都没穿进去', () => {
    const obs = [obstacle(center, 1.2)];
    const start = startAt(0);
    const toward = north(start);
    const w = walkerAt(start, toward, flat, obs);
    let minGap = Infinity;
    holdForward(w, toward.clone(), 5, 60, obs, (x) => {
      minGap = Math.min(minGap, Math.acos(Math.min(1, x.dir.dot(center))) - obs[0].minAngle);
    });
    expect(minGap).toBeGreaterThanOrEqual(-1e-9);
    // 被挡住了：贴在圆柱边上
    expect(Math.acos(w.dir.dot(center)) - obs[0].minAngle).toBeLessThan(0.01);
  });

  it('斜着撞上去：贴着圆柱滑过去，最后到了作品另一边', () => {
    const obs = [obstacle(center, 1.2)];
    const start = startAt(0.8); // 往旁边偏 0.8 个单位：路线擦着圆柱（碰撞半径约 1.86）
    const heading = north(start);
    const w = walkerAt(start, heading, flat, obs);
    let touched = false;
    let minGap = Infinity;
    holdForward(w, heading.clone(), 6, 60, obs, (x) => {
      minGap = Math.min(minGap, Math.acos(Math.min(1, x.dir.dot(center))) - obs[0].minAngle);
      if (x.bumped) touched = true;
    });
    expect(touched).toBe(true);
    expect(minGap).toBeGreaterThanOrEqual(-1e-9);
    // 起点在作品南边，滑过去以后到了北边；往有偏移的那一侧（+X）绕
    expect(start.y).toBeLessThan(-0.5);
    expect(w.dir.y).toBeGreaterThan(0.3);
  });

  it('两个圆柱挤在一起：从中间的缝撞过去也穿不进任何一个', () => {
    const a = v(0.12, 0, 1).normalize();
    const b = v(-0.12, 0, 1).normalize();
    const obs = [obstacle(a, 1), obstacle(b, 1)];
    const start = startAt(0);
    const toward = north(start);
    const w = walkerAt(start, toward, flat, obs);
    holdForward(w, toward.clone(), 6, 60, obs, (x) => {
      for (const o of obs) expect(x.dir.dot(o.center)).toBeLessThanOrEqual(o.cosMin + 1e-9);
    });
  });

  it('出生点在圆柱里（正好在作品中心上也一样）：放下时推到圆柱外面', () => {
    const obs = [obstacle(center, 1.5)];
    const w = walkerAt(center.clone(), v(1, 0, 0), flat, obs);
    expect(w.dir.dot(center)).toBeLessThanOrEqual(obs[0].cosMin + 1e-9);
    expect(Math.acos(w.dir.dot(center))).toBeCloseTo(obs[0].minAngle, 5);
  });

  it('collide 去掉速度里朝圆柱里面的分量，留下沿边的分量', () => {
    const obs = [obstacle(center, 1.2)];
    // 在圆柱里一点点，速度斜着朝里
    const dir = center.clone().applyAxisAngle(v(1, 0, 0), -(obs[0].minAngle - 0.01));
    const inward = center.clone().addScaledVector(dir, -center.dot(dir)).normalize();
    const along = inward.clone().cross(dir).normalize();
    const vel = inward.clone().add(along);
    collide(dir, vel, obs, 1, dir.clone());
    expect(Math.acos(dir.dot(center))).toBeCloseTo(obs[0].minAngle, 6);
    expect(vel.dot(inward)).toBeCloseTo(0, 2);
    expect(vel.dot(along)).toBeCloseTo(1, 2);
  });
});

describe('自动走（点地面）', () => {
  it('走到点的地方停下', () => {
    const w = walkerAt(v(0, 0, 1), v(1, 0, 0));
    const target = v(0.4, 0.3, 1).normalize();
    w.goTo(target);
    const wish = new THREE.Vector3();
    for (let i = 0; i < 60 * 6 && w.hasTarget; i++) {
      wish.set(0, 0, 0);
      w.autoWish(1 / 60, wish);
      w.step(1 / 60, wish, []);
    }
    expect(w.hasTarget).toBe(false);
    expect(w.dir.angleTo(target) * R).toBeLessThan(0.1);
  });

  it('被作品挡住、不再靠近时自己放弃', () => {
    const center = v(0, 0, 1);
    const obs = [obstacle(center, 1.5)];
    const start = center.clone().applyAxisAngle(v(1, 0, 0), -5 / R);
    const w = walkerAt(start, v(0, 1, 0), flat, obs);
    w.goTo(center.clone().applyAxisAngle(v(1, 0, 0), 4 / R)); // 正后方：直线路线穿过作品中心
    const wish = new THREE.Vector3();
    let frames = 0;
    for (; frames < 60 * 10 && w.hasTarget; frames++) {
      wish.set(0, 0, 0);
      w.autoWish(1 / 60, wish);
      w.step(1 / 60, wish, obs);
      expect(w.dir.dot(center)).toBeLessThanOrEqual(obs[0].cosMin + 1e-9);
    }
    expect(w.hasTarget).toBe(false);
    expect(frames).toBeLessThan(60 * 5);
  });
});

describe('跟随镜头：基向量连续', () => {
  // 每帧镜头的上、右、朝向和上一帧比；上方向也要一直靠近角色脚下的法线（不倒过来）
  function track(seconds: number, setup: (w: Walker, cam: FollowCamera) => void, turnEach?: (i: number) => [number, number]) {
    const w = walkerAt(v(1, 0, 0), v(0, 1, 0));
    const cam = new FollowCamera();
    cam.reset(w, w.facing);
    setup(w, cam);
    const floor = () => R + FOLLOW.clearance;
    cam.update(1 / 60, w, false, floor);
    const prev = new THREE.Quaternion().copy(cam.quaternion);
    const up = new THREE.Vector3();
    const wish = new THREE.Vector3();
    let maxStep = 0;
    let minUpDot = 1;
    let poles = 0;
    for (let i = 0; i < seconds * 60; i++) {
      if (turnEach) {
        const [dx, dy] = turnEach(i);
        cam.orbit(dx, dy);
      }
      wish.copy(cam.heading).multiplyScalar(WALK.speed);
      w.step(1 / 60, wish, []);
      cam.update(1 / 60, w, false, floor);
      maxStep = Math.max(maxStep, prev.angleTo(cam.quaternion));
      prev.copy(cam.quaternion);
      up.set(0, 1, 0).applyQuaternion(cam.quaternion);
      minUpDot = Math.min(minUpDot, up.dot(w.dir));
      if (Math.abs(w.dir.y) > 0.995) poles++;
    }
    return { maxStep, minUpDot, poles, walker: w };
  }

  it('沿经线翻过北极、走到背面、再过南极：镜头每帧最多转约 0.4°，上方向始终朝着角色的「上」', () => {
    // 走一整圈（半径 10 的平地上 62.8）再多走 4 个单位的时间：两极都经过。秒数按走路速度算（角色变成 1 米高以后速度从 3.2 改成 2.4）
    const seconds = Math.ceil((2 * Math.PI * R + 4) / WALK.speed + 0.5);
    const { maxStep, minUpDot, poles, walker } = track(seconds, () => {});
    expect(poles).toBeGreaterThan(0);
    expect(walker.distance).toBeGreaterThan(2 * Math.PI * R);
    // 速度 / 半径 10 = 每秒 0.24 弧度 ≈ 每帧 0.23°（速度 3.2 时 0.31°）
    expect(maxStep).toBeLessThan(THREE.MathUtils.degToRad(0.4));
    expect(minUpDot).toBeGreaterThan(Math.cos(FOLLOW.maxPitch) - 1e-6);
  });

  it('边走边左右拖动镜头、俯角拉到最大：照样连续、不翻', () => {
    const { maxStep, minUpDot } = track(12, () => {}, (i) => [Math.sin(i / 40) * 6, i < 300 ? 3 : -3]);
    // 拖动 6 像素 × 0.006 ≈ 2°，加上走路的 0.3°
    expect(maxStep).toBeLessThan(THREE.MathUtils.degToRad(2.6));
    expect(minUpDot).toBeGreaterThan(Math.cos(FOLLOW.maxPitch) - 1e-6);
  });

  it('镜头在角色后上方：在朝向的反方向、高过注视点', () => {
    const w = walkerAt(v(0, 0, 1), v(0, 1, 0));
    const cam = new FollowCamera();
    cam.reset(w, w.facing);
    cam.update(1 / 60, w, false, () => 0);
    const offset = cam.position.clone().sub(cam.focus);
    expect(offset.dot(cam.heading)).toBeLessThan(0);
    expect(offset.dot(cam.up)).toBeGreaterThan(0);
    expect(offset.length()).toBeCloseTo(FOLLOW.distance, 6);
  });

  it('身后是高地时镜头抬到地面以上', () => {
    const w = walkerAt(v(0, 0, 1), v(0, 1, 0));
    const cam = new FollowCamera();
    cam.reset(w, w.facing);
    cam.update(1 / 60, w, false, () => 30);
    expect(cam.position.length()).toBeGreaterThanOrEqual(30 - 1e-9);
  });
});

describe('镜头过渡', () => {
  it('两端正好是起点和终点；中途离星球中心不比两端近（不穿过星球）；每一步都很小', () => {
    const fromPos = v(0, 0, 24);
    const fromQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0, 0));
    const toPos = v(-12, 2, -4);
    const toQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-1.1, 2.4, 0.5));
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    blendPose(fromPos, fromQuat, toPos, toQuat, 0, pos, quat);
    expect(pos.distanceTo(fromPos)).toBeLessThan(1e-9);
    expect(quat.angleTo(fromQuat)).toBeLessThan(1e-6);
    blendPose(fromPos, fromQuat, toPos, toQuat, 1, pos, quat);
    expect(pos.distanceTo(toPos)).toBeLessThan(1e-9);
    expect(quat.angleTo(toQuat)).toBeLessThan(1e-6);
    const prev = fromPos.clone();
    const prevQ = fromQuat.clone();
    for (let i = 1; i <= 100; i++) {
      blendPose(fromPos, fromQuat, toPos, toQuat, i / 100, pos, quat);
      expect(pos.length()).toBeGreaterThanOrEqual(Math.min(fromPos.length(), toPos.length()) - 1e-9);
      expect(pos.distanceTo(prev)).toBeLessThan(1);
      expect(quat.angleTo(prevQ)).toBeLessThan(0.1);
      prev.copy(pos);
      prevQ.copy(quat);
    }
  });

  it('slerpDir：几乎正好相反的两个方向也能插值，结果是单位向量', () => {
    const out = new THREE.Vector3();
    for (let i = 0; i <= 10; i++) {
      slerpDir(v(0, 0, 1), v(0, 1e-9, -1).normalize(), i / 10, out);
      expect(out.length()).toBeCloseTo(1, 9);
    }
    slerpDir(v(0, 0, 1), v(1, 0, 0), 0.5, out);
    expect(out.distanceTo(v(1, 0, 1).normalize())).toBeLessThan(1e-9);
  });
});
