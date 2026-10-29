import * as THREE from 'three/webgpu';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { dot, float, instanceColor, max, mix, normalize, normalWorld, positionLocal, positionWorld, renderGroup, smoothstep, uniform, vec3 } from 'three/tsl';
import { DECOR, DECOR_CENTER, type DecorKit } from '../planet/decor';
import { perturbNormal } from '../planet/ground';
import { mulberry32 } from '../planet/rng';
import { valueNoise3 } from '../planet/tslNoise';

// 石头的新样子（stage 角色）：圆润、像手捏的黏土或河里磨圆的卵石，手绘感的上色。
// 和 planet/decor.ts 的 DecorKit 接口一样（Dressing 换 kit 即可），摆法、数量、实例颜色都还是 DecorField 管。
// 形状：三类——圆滚的大卵石、方中带圆的「玩具积木石」、扁平的石板；只留低频起伏，不要碎碎的高频噪声。
// 上色：顶亮底暗的渐变（不管太阳在哪边，石头都有「被天光照着」的体积感，绘本里的画法），大块的深浅斑，
// 一点点横向的笔触，朝上的面长苔藓（「上」按星球径向算，苔藓色不被石头的实例颜色染脏）

type Style = 'round' | 'chunky' | 'slab';

// 一块圆润的石头：二十面体细分球 → 按风格变形 → 低频噪声 → 压扁、底面压平 → 归一化（最大水平半径 1，底面在 y = 0）
export function roundRockGeometry(seed: number, style: Style, detail = 3): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const noise = new SimplexNoise({ random: rng });
  const ico = new THREE.IcosahedronGeometry(1, detail);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const geo = mergeVertices(ico, 1e-6);
  ico.dispose();
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const sx = 0.85 + rng() * 0.35;
  const sz = 0.85 + rng() * 0.35;
  const sy = style === 'slab' ? 0.3 + rng() * 0.12 : style === 'chunky' ? 0.62 + rng() * 0.2 : 0.55 + rng() * 0.25;
  const amp = style === 'round' ? 0.11 : style === 'chunky' ? 0.06 : 0.08;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (style === 'chunky') {
      // 超椭球（指数 4）：方方的，但每条边都是大圆角，像玩具积木
      const n = 4;
      const k = (Math.abs(v.x) ** n + Math.abs(v.y) ** n + Math.abs(v.z) ** n) ** (1 / n);
      v.divideScalar(k || 1);
    }
    const nn = noise.noise3d(v.x * 0.9, v.y * 0.9, v.z * 0.9) * amp + noise.noise3d(v.x * 2.1 + 7, v.y * 2.1, v.z * 2.1) * amp * 0.35;
    v.multiplyScalar(1 + nn);
    v.set(v.x * sx, v.y * sy, v.z * sz);
    // 底面压平：石头坐在地上
    const floor = -0.2 * sy;
    if (v.y < floor) v.y = floor + (v.y - floor) * 0.2;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const r = Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z) || 1;
  geo.translate(0, -box.min.y, 0);
  geo.scale(1 / r, 1 / r, 1 / r);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

// 苔藓色：按 AgX 调过。第二版 [v2-world]：灰绿的 Moss（第一版是亮黄绿的玩具感）
const MOSS = uniform(new THREE.Color('#4f5c45')).setGroup(renderGroup);
const MOSS_DEEP = uniform(new THREE.Color('#2f3a2a')).setGroup(renderGroup);
// ?tune 的 moss on rocks 改的是 DECOR.moss：每次渲染照它取，不用另外接线
const MOSS_AMOUNT = uniform(DECOR.moss).setGroup(renderGroup).onRenderUpdate(() => DECOR.moss);

let material: THREE.MeshStandardNodeMaterial | null = null;

// 所有形状共用一份（DecorField 每种形状一个实例化网格，实例颜色 = 星球的 rock 色加深浅）
export function painterlyRockMaterial(): THREE.MeshStandardNodeMaterial {
  if (material) return material;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.86, metalness: 0 });
  m.name = 'decor-rock-painterly';
  const p = positionLocal;
  const up = normalize(positionWorld.sub(DECOR_CENTER));
  const facing = dot(normalize(normalWorld), up);
  const spots = valueNoise3(p.mul(2.2)).mul(0.6).add(valueNoise3(p.mul(6.3).add(3.1)).mul(0.4));
  // 横向笔触：沿高度方向频率高、水平方向低的噪声，像刷子横着扫过
  const strokes = valueNoise3(p.mul(vec3(1.4, 9.5, 1.4)).add(11.7));
  const light = mix(float(0.7), float(1.16), smoothstep(-0.35, 0.85, facing));
  const shade = light.mul(float(0.86).add(spots.mul(0.26))).mul(float(0.95).add(strokes.mul(0.1)));
  // 暖一点：照片式的冷灰不要
  const stone = vec3(1.07, 1.0, 0.9).mul(shade);
  const moss = smoothstep(0.38, 0.82, facing).mul(smoothstep(0.4, 0.66, spots.add(MOSS_AMOUNT.sub(0.5)))).mul(0.95);
  // 苔藓不被实例颜色（石头色）染：先除掉，乘回去以后就是苔藓本身的颜色
  const mossColor = mix(MOSS_DEEP, MOSS, smoothstep(0.3, 0.8, spots)).div(max(instanceColor, vec3(0.05)));
  m.colorNode = mix(stone, mossColor, moss);
  m.roughnessNode = mix(float(0.84), float(0.96), moss);
  m.normalNode = perturbNormal(valueNoise3(p.mul(5.5)).mul(0.008).add(spots.mul(0.014)));
  material = m;
  return m;
}

let kit: DecorKit | null = null;

// 5 种岩石（细分 3，1280 面）、4 种小石子（细分 1，80 面：小石子有几百颗，平滑法线下看不出棱）
export function painterlyRockKit(): DecorKit {
  if (kit) return kit;
  const m = painterlyRockMaterial();
  const rocks: Array<[number, Style]> = [[11, 'round'], [23, 'chunky'], [37, 'round'], [41, 'slab'], [59, 'chunky']];
  const pebbles: Array<[number, Style]> = [[71, 'round'], [83, 'slab'], [97, 'round'], [101, 'chunky']];
  kit = {
    rocks: rocks.map(([seed, style], i) => ({ name: `rock-${style}-${i}`, geometry: roundRockGeometry(seed, style, 3), material: m })),
    pebbles: pebbles.map(([seed, style], i) => ({ name: `pebble-${style}-${i}`, geometry: roundRockGeometry(seed, style, 1), material: m })),
  };
  return kit;
}
