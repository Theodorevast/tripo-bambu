import { dot, floor, fract, Fn, mix, vec3 } from 'three/tsl';
import type * as THREE from 'three/webgpu';

// 着色器里用的便宜 3D 值噪声：8 个格点各取一个哈希（不用 sin 的哈希，float32 下稳定），按 smoothstep 曲线三线性插值，输出 0..1。
// 不用 MaterialX 的 Perlin（mx_noise_float）：那个函数生成的着色器大好几倍，WebGL2（ANGLE / D3D11）上第一次画时驱动编译很久。
// 写成 Fn + setLayout：着色器里只生成一个函数，各处调用不会把 8 个哈希展开好几遍

type V3 = THREE.Node<'vec3'>;

// Dave Hoskins 的 hash13（hash without sine）
function hash13(p: V3): THREE.Node<'float'> {
  const p3 = fract(p.mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.zyx.add(31.32)));
  return fract(p3.x.add(p3.y).mul(p3.z));
}

export const valueNoise3 = Fn(([p]: [V3]) => {
  // 不把坐标折回一个周期：格点哈希不是周期的，折回会在坐标轴平面（x = 0 等）上断开一条缝。
  // 用到的坐标都在几千以内（星球半径最多 60 米，频率最高约 10 / 米），float32 的哈希够用
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const c = (x: number, y: number, z: number) => hash13(i.add(vec3(x, y, z)));
  const x00 = mix(c(0, 0, 0), c(1, 0, 0), u.x);
  const x10 = mix(c(0, 1, 0), c(1, 1, 0), u.x);
  const x01 = mix(c(0, 0, 1), c(1, 0, 1), u.x);
  const x11 = mix(c(0, 1, 1), c(1, 1, 1), u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}).setLayout({ name: 'valueNoise3', type: 'float', inputs: [{ name: 'p', type: 'vec3' }] }) as unknown as (p: V3) => THREE.Node<'float'>;

// 两层叠加（第二层频率 2.03 倍、权重一半），0..1
export function fbm2(p: V3): THREE.Node<'float'> {
  return valueNoise3(p).mul(0.667).add(valueNoise3(p.mul(2.03).add(17.3)).mul(0.333));
}
