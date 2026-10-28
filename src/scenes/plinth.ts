import * as THREE from 'three/webgpu';
import { float, mix, positionLocal, smoothstep, uniform } from 'three/tsl';
import { mulberry32 } from '../planet/rng';
import { valueNoise3 } from '../planet/tslNoise';

// 展台：低矮的天然石板。参考图里的摆件（椅子、玫瑰、木棚）都直接立在草地上，脚下是一小块露土和几块石头；
// 高高的展台会像博物馆。所以作品立在一块只比地面高几厘米的圆润石板上：石板把作品和草分开（作品脚下不被草盖住），
// 四周一圈露土和碎石（星球遮罩的「作品空地」，地表着色器画），远看就像作品自己长在草地里。
// 石板往地下延伸 PLINTH_DEPTH：坡地上也不露缝（作品按展台下最高的地面贴地，下坡一侧靠这一段补上）

export const PLINTH_DEPTH = 0.6;

// 石板的轮廓：半径按角度起伏（两层正弦，像被水磨圆的石头），顶面中间微微鼓起，边缘倒圆
export function slabGeometry(): THREE.BufferGeometry {
  const radial = 56;
  const rng = mulberry32(612);
  const phase = [rng() * 6.28, rng() * 6.28, rng() * 6.28];
  const outline = (a: number) => 1 + 0.045 * Math.sin(a * 3 + phase[0]) + 0.03 * Math.sin(a * 5 + phase[1]) + 0.015 * Math.sin(a * 9 + phase[2]);
  // 截面（从中心到边缘再往下）：r 是半径的比例，y 是高度（顶面在 0，往下到 -PLINTH_DEPTH）
  const profile: Array<[number, number]> = [[0, 0.012], [0.55, 0.008], [0.82, 0], [0.93, -0.012], [0.985, -0.035], [1, -0.065], [1.02, -PLINTH_DEPTH]];
  const pos: number[] = [];
  const idx: number[] = [];
  for (let k = 0; k < profile.length; k++) {
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const r = profile[k][0] * outline(a);
      pos.push(Math.cos(a) * r, profile[k][1], Math.sin(a) * r);
    }
  }
  const row = radial + 1;
  for (let k = 0; k < profile.length - 1; k++) {
    for (let i = 0; i < radial; i++) {
      const a = k * row + i;
      const b = (k + 1) * row + i;
      idx.push(a, a + 1, b, a + 1, b + 1, b); // 逆时针（从外面看）：顶面朝上、侧面朝外
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

const STONE = uniform(new THREE.Color('#8e8679'));
const MOSS = uniform(new THREE.Color('#5d7a3a'));
const SPOTS = 3.2; // 噪声频率：缩放前的石板半径约 1，一块石板上约 3 块深浅斑

// 石板的颜色：灰褐色的石头，按噪声有深浅；边缘往下（侧面）带一点苔绿。所有展台共用这一个节点（着色器只编一份）
const stoneColor = (() => {
  const p = positionLocal;
  const n = valueNoise3(p.mul(SPOTS)).mul(0.6).add(valueNoise3(p.mul(SPOTS * 4.1).add(9.3)).mul(0.4));
  const side = smoothstep(-0.01, -0.06, p.y);
  return mix(STONE.mul(n.mul(0.5).add(0.72)), MOSS, side.mul(smoothstep(0.45, 0.75, n)).mul(0.6));
})();

// 展台材质：模型挂上之前半透明（spec 2.2），挂上后不透明。emissiveIntensity 从 0 开始（自发光颜色是黑的，看不出区别）：
// three 把数值属性按「是不是 0」算进着色器的缓存键，从 0 开始，换成不透明时才对得上预热过的那份（见 PlanetView 构造函数）
export function plinthMaterial(loading: boolean, glow = 0): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0, transparent: loading, opacity: loading ? 0.4 : 1, emissiveIntensity: glow });
  m.colorNode = stoneColor;
  m.roughnessNode = float(0.88);
  m.name = 'plinth-stone';
  return m;
}
