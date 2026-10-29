import * as THREE from 'three/webgpu';
import { clamp, dot, float, Fn, fwidth, length, max, min, mix, positionLocal, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import { tribooUrl } from '../assets/brand';
import { ModelLibrary } from '../assets/models';

// 开场探头用的翠宝（Tripo 的吉祥物）。两个来源：
// - 品牌的 GLB：public/brand/triboo.glb（assets/brand.ts，和漫游的角色、星球上站桩的同一个文件），开发和构建版都从这里读；
// - 代码拼的替身：GLB 加载失败时用。新画风的玩具 / 手办质感：亮面黑色圆球身体（清漆），胸前白色的 V 和翠宝黄的 T，
//   磨砂半透明的手臂，黄白球鞋，都是圆角。不用卡通版的平涂材质和色板

export interface Mascot {
  readonly object: THREE.Object3D; // 脚底在 y = 0，正面朝 +Z
  readonly height: number;
}

const YELLOW = '#f2b705'; // 翠宝黄
const WHITE = '#f4f1ea';
const BODY_R = 0.62;

// 线段距离场
const segment = (p: THREE.Node<'vec2'>, a: [number, number], b: [number, number]) => {
  const pa = p.sub(vec2(...a));
  const ba = vec2(b[0] - a[0], b[1] - a[1]);
  const h = clamp(dot(pa, ba).div(dot(ba, ba)), 0, 1);
  return length(pa.sub(ba.mul(h)));
};

// V/T 标志（正面投影坐标，身体半径 = 1）：x = 白色的 V，y = 黄色的 T（T 的竖笔斜着，和 V 的左笔平行）。边缘按像素抗锯齿
const tribooLogo = Fn(([p]: [THREE.Node<'vec2'>]) => {
  const v = min(segment(p, [-0.5, 0.3], [-0.03, -0.4]), segment(p, [-0.03, -0.4], [0.44, 0.1])).sub(0.085);
  const t = min(segment(p, [-0.1, 0.36], [0.46, 0.36]), segment(p, [0.05, 0.36], [-0.12, 0.05])).sub(0.07);
  const aa = (d: THREE.Node<'float'>) => float(1).sub(smoothstep(fwidth(d).negate(), fwidth(d), d));
  return vec2(aa(v), aa(t));
});

// 身体：亮面黑（带一点青，看得出体积，不是一块死黑），清漆反光像手办；标志按正面的投影坐标画在身体上
function bodyMaterial(): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial({ name: 'triboo-body', roughness: 0.32, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12 });
  const logo = tribooLogo(positionLocal.xy.div(BODY_R));
  const front = smoothstep(0.1, 0.25, positionLocal.z.div(BODY_R));
  const black = vec3(0.012, 0.018, 0.02);
  const white = vec3(new THREE.Color(WHITE).r, new THREE.Color(WHITE).g, new THREE.Color(WHITE).b);
  const yc = new THREE.Color(YELLOW);
  const yellow = vec3(yc.r, yc.g, yc.b);
  m.colorNode = mix(mix(black, white, logo.x.mul(front)), yellow, logo.y.mul(front));
  // logo 亮一下（fun/coupons 蓄力时）：自发光 = 标志的颜色 × userData.logoGlow（平时 0）
  const glow = uniform(0);
  m.emissiveNode = mix(white, yellow, logo.y).mul(max(logo.x, logo.y).mul(front)).mul(glow);
  m.userData.logoGlow = glow;
  return m;
}

// 代码拼的替身：身高约 1.55（脚底在 y = 0，正面朝 +Z）。手臂挂在肩膀的 Group 上（peek.ts 转它来挥手）
export function createStandIn(): Mascot {
  const root = new THREE.Group();
  root.name = 'triboo-stand-in';
  const body = new THREE.Mesh(new THREE.SphereGeometry(BODY_R, 48, 32), bodyMaterial());
  body.position.y = 0.42 + BODY_R;
  root.add(body);
  const leg = new THREE.MeshStandardNodeMaterial({ name: 'triboo-leg', color: '#1c1e23', roughness: 0.5 });
  const shoe = new THREE.MeshPhysicalNodeMaterial({ name: 'triboo-shoe', color: YELLOW, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.2 });
  const sole = new THREE.MeshStandardNodeMaterial({ name: 'triboo-sole', color: '#fbf7ee', roughness: 0.6 });
  for (const side of [-1, 1]) {
    const l = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.2, 4, 12), leg);
    l.position.set(side * 0.2, 0.36, 0);
    root.add(l);
    const foot = new THREE.Group();
    foot.position.set(side * 0.22, 0, 0.05);
    const upper = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 16), shoe);
    upper.scale.set(0.95, 0.72, 1.35);
    upper.position.y = 0.14;
    const toe = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 12), sole);
    toe.scale.set(1.15, 0.6, 1);
    toe.position.set(0, 0.08, 0.13);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.07, 24), sole);
    base.scale.set(1, 1, 1.42);
    base.position.y = 0.035;
    foot.add(upper, toe, base);
    root.add(foot);
  }
  // 磨砂半透明的手臂：浅灰白，半透明，粗糙
  const frosted = new THREE.MeshStandardNodeMaterial({ name: 'triboo-frosted', color: '#d9dde0', roughness: 0.55, transparent: true, opacity: 0.78 });
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * BODY_R * 0.92, 0.42 + BODY_R * 0.95, 0);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.42, 6, 12), frosted);
    arm.position.y = -0.26;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.135, 20, 14), frosted);
    hand.scale.set(0.9, 1.1, 0.75);
    hand.position.y = -0.55;
    shoulder.add(arm, hand);
    shoulder.rotation.z = side * 0.32;
    root.add(shoulder);
  }
  return { object: root, height: 0.42 + BODY_R * 2 };
}

// 用品牌的 GLB（和作品同一套加载：meshopt 解码、各向异性；缩放、居中由 ModelLibrary 做），加载失败就用替身，不报错
export async function loadMascot(): Promise<Mascot> {
  try {
    const model = await new ModelLibrary().load({ id: 'peek-triboo', file: tribooUrl() });
    if (!model.failed) return { object: model.object, height: model.height };
  } catch (err) {
    console.warn('Triboo for the intro failed, using the stand-in', err);
  }
  return createStandIn();
}
