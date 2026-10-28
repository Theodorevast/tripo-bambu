import * as THREE from 'three/webgpu';
import { float, positionLocal, smoothstep, mix, vec3 } from 'three/tsl';
import { valueNoise3 } from '../planet/tslNoise';

// 展台（stage 角色）：圆润的玩具底座，像手办、扭蛋公仔脚下那块厚厚的圆台（Astro Bot、翠宝那种手感）。
// 上下两层：上层奶油色、顶面边上一圈翠宝黄的描线，下层暖砂色；两层之间一道浅槽，边缘都倒成大圆角。
// 远看是草地上一个个亮色的小圆点，作品站在上面像被摆出来的手办，也就成了星球上的地标。
// 几何的半径是 1（PlanetView 按展台半径缩放 x / z），顶面在 y = 0；STAND_TOP 是顶面比地面高多少，往下一直延伸到 -STAND_DEPTH，坡地上不露缝

export const STAND_TOP = 0.15; // 顶面比地面高多少（米）：脚踝高，作品被托起来一点，不像博物馆的高台
export const STAND_DEPTH = 0.65; // 从顶面往下延伸多深（米）：下坡一侧靠它补上

// 颜色（线性空间以外的 sRGB 写法，?tune 不调：展台是固定的玩具配色）
const CREAM = new THREE.Color('#ecd9b2');
const CREAM_EDGE = new THREE.Color('#dec59a');
const GROOVE = new THREE.Color('#9c7c55');
const SAND = new THREE.Color('#cba878');
const SAND_LOW = new THREE.Color('#a98862');
const ACCENT = new THREE.Color('#F2B705'); // 翠宝黄：顶面边上一圈细线

// 截面：[半径比例, 高度（米，顶面 0）, 颜色]。相邻两点颜色不同时中间隔 1 毫米，颜色交界是清楚的一条线，法线照样平滑
type Ring = [number, number, THREE.Color];

function profile(): Ring[] {
  const rings: Ring[] = [
    [0, 0.006, CREAM],
    [0.45, 0.005, CREAM],
    [0.74, 0.002, CREAM],
    [0.8, 0.0, CREAM],
    [0.801, 0.0, ACCENT],
    [0.86, -0.001, ACCENT],
    [0.861, -0.001, CREAM],
  ];
  // 上层的边：四分之一椭圆倒角，水平 0.1、竖直 0.055
  const e0 = 0.9;
  const ey = -0.058;
  for (let i = 0; i <= 6; i++) {
    const phi = (i / 6) * (Math.PI / 2);
    const c = CREAM.clone().lerp(CREAM_EDGE, i / 6);
    rings.push([e0 + 0.1 * Math.sin(phi), ey + 0.056 * Math.cos(phi), c]);
  }
  rings.push(
    [1.0, -0.078, CREAM_EDGE],
    // 两层之间的浅槽
    [0.985, -0.088, GROOVE],
    [0.975, -0.095, GROOVE],
    [0.99, -0.101, GROOVE],
    [1.0, -0.103, SAND],
  );
  // 下层：往外鼓出一点再收回地面，圆角
  for (let i = 1; i <= 5; i++) {
    const phi = (i / 5) * (Math.PI / 2);
    rings.push([1.0 + 0.055 * Math.sin(phi), -0.103 - 0.03 * (1 - Math.cos(phi)), SAND]);
  }
  rings.push([1.06, -0.15, SAND_LOW], [1.065, -STAND_DEPTH, SAND_LOW]);
  return rings;
}

// 车床式旋转体（顶点色是线性空间）
export function standGeometry(segments = 72): THREE.BufferGeometry {
  const rings = profile();
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const lin = new THREE.Color();
  for (const [r, y, c] of rings) {
    lin.copy(c); // Color 存的就是线性值（ColorManagement 打开时 set('#...') 会从 sRGB 转过来）
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      col.push(lin.r, lin.g, lin.b);
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

// 手绘感：很淡的一层大斑（±4%），像刷过一层漆。所有展台共用这一个节点，着色器只编一份
const paint = (() => {
  const n = valueNoise3(positionLocal.mul(vec3(3.1, 7.0, 3.1))).mul(0.6).add(valueNoise3(positionLocal.mul(11.3).add(4.7)).mul(0.4));
  // 埋进地里的那一截（地面以下）压暗，坡上露出来时像沾了土
  const buried = smoothstep(-STAND_TOP - 0.02, -STAND_TOP - 0.12, positionLocal.y);
  return vec3(float(0.96).add(n.mul(0.08))).mul(mix(float(1), float(0.55), buried));
})();

// 展台材质：模型挂上之前半透明（spec 2.2），挂上后不透明。emissiveIntensity 从 0 开始（自发光颜色是黑的，看不出区别）：
// three 把数值属性按「是不是 0」算进着色器的缓存键，从 0 开始，换成不透明时才对得上预热过的那份（见 PlanetView 构造函数）。
// 略带光泽（粗糙度 0.55）：像上过漆的搪胶玩具，不是石头
export function plinthMaterial(loading: boolean, glow = 0): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0, transparent: loading, opacity: loading ? 0.4 : 1, emissiveIntensity: glow });
  m.vertexColors = true;
  m.colorNode = paint;
  m.name = 'plinth-toy';
  return m;
}
