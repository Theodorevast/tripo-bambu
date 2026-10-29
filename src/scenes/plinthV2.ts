import * as THREE from 'three/webgpu';
import { attribute, float, materialEmissive, mix, positionLocal, smoothstep, vec3 } from 'three/tsl';
import { valueNoise3 } from '../planet/tslNoise';
import { STAND_DEPTH, STAND_TOP } from './plinth';

// 第二版 [v2-world] 的展台：一块矮矮的石座，顶面靠边嵌一圈细细的香槟金（像石头里嵌的一道铜线）。
// 和第一版（plinth.ts，奶油色的玩具底座）同样的接口、同样的尺寸约定：几何半径 1（PlanetView 按展台半径缩放 x / z），顶面在 y = 0，
// 往下一直延伸到 -STAND_DEPTH（坡地上不露缝），STAND_TOP 是顶面比地面高多少。作品是主角：石座颜色是中性的暖灰，低、平、不抢戏。
// 一个网格一次绘制：金线和石头在同一份几何里，按顶点属性 gold 分金属度、粗糙度；石头的纹理（花岗岩一样的细斑、几道浅浅的纹路）在着色器里按噪声算

export { STAND_DEPTH, STAND_TOP };

// 颜色（sRGB）：顶面浅一点（作品脚下亮一些），侧面、台阶深一点，石缝更深
const TOP = new THREE.Color('#aaa59b');
const TOP_EDGE = new THREE.Color('#9d988e');
const SIDE = new THREE.Color('#8f8b84'); // Stone
const GROOVE = new THREE.Color('#5f5c58');
const BASE = new THREE.Color('#858078');
const BASE_LOW = new THREE.Color('#6e6a64');
const GOLD = new THREE.Color('#d8c08e'); // Champagne gold

// 截面：[半径比例, 高度（米，顶面 0）, 颜色, 是不是金线]。相邻两点颜色不同时中间隔 1–2 毫米，交界是清楚的一条线，法线照样平滑
type Ring = [number, number, THREE.Color, number];

function profile(): Ring[] {
  const rings: Ring[] = [
    [0, 0.004, TOP, 0],
    [0.5, 0.003, TOP, 0],
    [0.79, 0.001, TOP, 0],
    // 顶面靠边的一圈金线（宽 5%：半径 1.3 米的展台上约 6 厘米，星球视图里一两个像素）
    [0.792, 0.0012, GOLD, 1],
    [0.842, 0.0012, GOLD, 1],
    [0.844, 0.001, TOP_EDGE, 0],
    [0.92, 0.0, TOP_EDGE, 0],
  ];
  // 顶面的边：斜着削一刀再圆一点（石匠的倒角），水平 0.06、竖直 0.04
  for (let i = 1; i <= 4; i++) {
    const phi = (i / 4) * (Math.PI / 2);
    rings.push([0.92 + 0.06 * Math.sin(phi), -0.04 * (1 - Math.cos(phi)), TOP_EDGE.clone().lerp(SIDE, i / 4), 0]);
  }
  rings.push(
    [0.98, -0.075, SIDE, 0],
    // 一道收进去的石缝（上下两层石头的接缝）
    [0.966, -0.082, GROOVE, 0],
    [0.962, -0.092, GROOVE, 0],
    [0.976, -0.098, BASE, 0],
    // 下层：宽一点的台阶，往外一点再收回地面
    [1.03, -0.104, BASE, 0],
    [1.05, -0.112, BASE, 0],
    [1.056, -0.13, BASE_LOW, 0],
    [1.06, -0.16, BASE_LOW, 0],
    [1.065, -STAND_DEPTH, BASE_LOW, 0],
  );
  return rings;
}

// 车床式旋转体（顶点色是线性空间），另带一个 gold 属性（1 = 金线）
export function standGeometry(segments = 72): THREE.BufferGeometry {
  const rings = profile();
  const pos: number[] = [];
  const col: number[] = [];
  const gold: number[] = [];
  const idx: number[] = [];
  for (const [r, y, c, g] of rings) {
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      col.push(c.r, c.g, c.b); // Color 存的就是线性值
      gold.push(g);
    }
  }
  const row = segments + 1;
  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < segments; i++) {
      const a = k * row + i;
      const b = (k + 1) * row + i;
      idx.push(a, a + 1, b, a + 1, b + 1, b); // 从外面看逆时针：顶面朝上、侧面朝外
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('gold', new THREE.Float32BufferAttribute(gold, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  // 接缝（a = 0 和 2π 两列顶点重合）上的法线按两边平均：不然缝上有一条亮线
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let k = 0; k < rings.length; k++) {
    const a = k * row;
    const b = a + segments;
    v.set(n.getX(a) + n.getX(b), n.getY(a) + n.getY(b), n.getZ(a) + n.getZ(b)).normalize();
    n.setXYZ(a, v.x, v.y, v.z);
    n.setXYZ(b, v.x, v.y, v.z);
  }
  g.computeBoundingSphere();
  return g;
}

// 石头的纹理：花岗岩一样的细斑（两层噪声）+ 大块的深浅 + 几道很浅的纹路；金线不吃这些。所有展台共用这几个节点，着色器只编一份
const goldK = attribute<'float'>('gold', 'float');
const stoneTone = (() => {
  const p = positionLocal;
  const big = valueNoise3(p.mul(vec3(2.3, 5.0, 2.3)).add(3.1));
  const speck = valueNoise3(p.mul(31).add(7.3));
  const fine = valueNoise3(p.mul(73).add(1.9));
  const vein = float(1).sub(smoothstep(0.0, 0.03, valueNoise3(p.mul(vec3(4.1, 9, 4.1)).add(11.7)).sub(0.5).abs()));
  const tone = big.sub(0.5).mul(0.12).add(speck.sub(0.5).mul(0.14)).add(fine.sub(0.5).mul(0.08)).sub(vein.mul(0.07)).add(1);
  // 埋进地里的那一截（地面以下）压暗，坡上露出来时像沾了土
  const buried = smoothstep(-STAND_TOP - 0.02, -STAND_TOP - 0.12, p.y);
  return vec3(mix(tone, float(1), goldK)).mul(mix(float(1), float(0.5), buried));
})();

// 金线的金属度、粗糙度、微光：和 stoneTone 一样建一次、所有展台共用。每个展台的材质是各自一份（透明度、高亮各管各的），
// 节点要是每份都新建，three 按节点算的缓存键就对不上，进星球时每个展台（半透明、不透明、投影）都要在那几帧里重新生成一遍着色器
// （实测 4 件作品多出 50–60 毫秒的主线程时间）；节点共用就直接用现成的
const goldMetal = mix(float(0), float(0.6), goldK);
const goldRough = mix(float(0.9), float(0.42), goldK);
const goldGlow = materialEmissive.add(vec3(GOLD.r, GOLD.g, GOLD.b).mul(goldK.mul(0.28)));

// 展台材质：模型挂上之前半透明（spec 2.2），挂上后不透明。emissiveIntensity 从 0 开始（自发光颜色是黑的，看不出区别）：
// three 把数值属性按「是不是 0」算进着色器的缓存键，从 0 开始，换成不透明时才对得上预热过的那份（见 PlanetView 构造函数）。
// 石头很哑（粗糙度 0.9），金线是金属（粗糙度 0.42），再带一点点自己的微光（夜里也看得出那一圈）；选中时的高亮照旧走 emissive
export function plinthMaterial(loading: boolean, glow = 0): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, transparent: loading, opacity: loading ? 0.4 : 1, emissiveIntensity: glow });
  m.vertexColors = true;
  m.colorNode = stoneTone;
  m.metalnessNode = goldMetal;
  m.roughnessNode = goldRough;
  m.emissiveNode = goldGlow;
  m.name = 'plinth-stone';
  return m;
}
