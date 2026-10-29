import * as THREE from 'three/webgpu';

// 把翠宝的 GLB（没有骨骼）拆成能分开动的部件：肩（手臂和手一起绕肩转）、手腕（手再晚一点甩）、胯（腿绕胯转、跟着脚伸缩）、脚。
// 翠宝的几何和材质是共用的（World.models 里的同一份，ModelLibrary 给的是克隆：节点是新的，几何、材质是同一个对象；
// 首页、开场探头、站桩的翠宝都在用），这里一律不改它们：只把克隆出来的节点挪到新建的转轴下面，
// 两只鞋（GLB 里是一个网格）按三角形重心 x 的正负分成左右两个新几何：顶点属性和原来的共用，各建一份索引。
// 新几何不 dispose：three 释放几何时会连它的顶点属性的 GPU 缓冲一起删，别处的翠宝还在用

// 模型空间（GLB 的米，+X 是翠宝的左边，+Z 朝前）里转轴放在哪
const HIP_ABOVE = 0.12; // 腿的转轴在腿顶上方这么高（藏在身体里）：腿摆起来像玩具的腿，伸缩得少
const SHOULDER_BELOW = 0.04; // 肩的转轴在手臂顶下面这么多
const WRIST_BELOW = 0.02; // 手腕在手的顶上往下这么多

// 两只鞋分开：重心 x ≥ 0 的三角形归左脚（+X），其余归右脚。返回 [左, 右]
export function splitByX(geometry: THREE.BufferGeometry): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = index ? index.count : pos.count;
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i + 2 < count; i += 3) {
    const a = index ? index.getX(i) : i;
    const b = index ? index.getX(i + 1) : i + 1;
    const c = index ? index.getX(i + 2) : i + 2;
    const list = pos.getX(a) + pos.getX(b) + pos.getX(c) >= 0 ? left : right;
    list.push(a, b, c);
  }
  const make = (list: number[], name: string) => {
    const g = new THREE.BufferGeometry();
    g.name = name;
    for (const key of Object.keys(geometry.attributes)) g.setAttribute(key, geometry.getAttribute(key));
    g.setIndex(list);
    // 包围球、包围盒拿原来的（两只鞋一起的，大一点没关系）：不用再遍历一遍顶点
    if (geometry.boundingSphere) g.boundingSphere = geometry.boundingSphere.clone();
    if (geometry.boundingBox) g.boundingBox = geometry.boundingBox.clone();
    return g;
  };
  return [make(left, 'Shoe_L'), make(right, 'Shoe_R')];
}

// 三角形数（有索引按索引，没有按顶点）
export function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  return Math.floor((index ? index.count : geometry.getAttribute('position').count) / 3);
}

// 网格在 space 坐标系里的包围盒（只算 indices 用到的顶点；不给就是全部），写进 out。不碰几何本身
function boxIn(mesh: THREE.Mesh, toSpace: THREE.Matrix4, out: THREE.Box3, geometry: THREE.BufferGeometry = mesh.geometry): THREE.Box3 {
  out.makeEmpty();
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const v = new THREE.Vector3();
  const n = index ? index.count : pos.count;
  // 顶点很多（鞋 2.5 万）：隔几个取一个就够找边界了（索引里每个顶点出现好几次）
  const stride = n > 30000 ? 3 : 1;
  for (let i = 0; i < n; i += stride) {
    const k = index ? index.getX(i) : i;
    out.expandByPoint(v.fromBufferAttribute(pos, k).applyMatrix4(toSpace));
  }
  return out;
}

export interface TribooRig {
  readonly root: THREE.Group; // 模型空间：position、scale 把它摆进角色的本地坐标（脚底原点，+Z 朝前）
  readonly body: THREE.Group; // 身体（颠、前倾、侧歪、肩膀转）：转轴在两腿中间、身体底部
  readonly squash: THREE.Group; // 压扁拉长、呼吸
  readonly shoulders: readonly [THREE.Group, THREE.Group]; // [左, 右]：绕 X 前后摆，绕 Z 往外张
  readonly wrists: readonly [THREE.Group, THREE.Group];
  readonly legs: readonly [THREE.Group, THREE.Group]; // 转轴在胯上：指着脚踝、按距离伸缩
  readonly feet: readonly [THREE.Group, THREE.Group]; // 脚底转轴（脚踝正下方）
  readonly bodyPivot: THREE.Vector3; // 以下都是模型空间
  readonly hipRest: readonly [THREE.Vector3, THREE.Vector3];
  readonly footRest: readonly [THREE.Vector3, THREE.Vector3];
  readonly ankle: readonly [THREE.Vector3, THREE.Vector3]; // 脚踝相对脚底转轴
  readonly legLength: readonly [number, number]; // 胯到脚踝（站着时）
  readonly toe: number; // 脚尖、脚跟离脚底转轴多远
  readonly heel: number;
  readonly shoeTris: readonly [number, number, number]; // 左、右、原来
}

// 按节点名找部件、搭转轴。缺部件（不是翠宝的模型）返回 null，调用方照旧整体动。object 不能挂在别的节点下面（刚从 ModelLibrary 拿来的）
export function buildTribooRig(object: THREE.Object3D): TribooRig | null {
  const mesh = (name: string) => {
    const o = object.getObjectByName(name) as THREE.Mesh | undefined;
    return o?.isMesh ? o : null;
  };
  const bodyMesh = mesh('Body');
  const shoes = mesh('Shoes');
  const arms = [mesh('Arm_L'), mesh('Arm_R')] as const;
  const hands = [mesh('Hand_L'), mesh('Hand_R')] as const;
  const legMeshes = [mesh('Leg_L'), mesh('Leg_R')] as const;
  if (!bodyMesh?.parent || !shoes || !arms[0] || !arms[1] || !hands[0] || !hands[1] || !legMeshes[0] || !legMeshes[1]) return null;
  const space = bodyMesh.parent; // GLB 的 Triboo 节点：模型空间
  object.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4().copy(object.parent ? object.parent.matrixWorld : new THREE.Matrix4()).invert().multiply(space.matrixWorld);
  const spaceInv = new THREE.Matrix4().copy(space.matrixWorld).invert();
  const inSpace = (m: THREE.Object3D) => new THREE.Matrix4().multiplyMatrices(spaceInv, m.matrixWorld);

  const root = new THREE.Group();
  root.name = 'triboo-rig';
  toLocal.decompose(root.position, root.quaternion, root.scale);
  // 挪节点：放到 parent（模型空间里在 at，站姿时不转不缩）下面，看起来和原来一模一样
  const adopt = (m: THREE.Object3D, parent: THREE.Object3D, at: THREE.Vector3, matrix = inSpace(m)) => {
    matrix.decompose(m.position, m.quaternion, m.scale);
    m.position.sub(at);
    parent.add(m);
  };
  const zero = new THREE.Vector3();
  const box = new THREE.Box3();
  const center = new THREE.Vector3();

  // 腿：转轴在腿顶上方（身体里），脚底转轴在腿的正下方、鞋底的高度
  const legBoxes = legMeshes.map((m) => boxIn(m!, inSpace(m!), new THREE.Box3()));
  const bodyPivot = new THREE.Vector3(0, (legBoxes[0].max.y + legBoxes[1].max.y) / 2 - 0.02, 0);
  bodyPivot.z = (legBoxes[0].getCenter(center).z + legBoxes[1].getCenter(center).z) / 2;
  const body = new THREE.Group();
  body.name = 'triboo-body';
  body.position.copy(bodyPivot);
  const squash = new THREE.Group();
  squash.name = 'triboo-squash';
  const upper = new THREE.Group();
  upper.name = 'triboo-upper';
  upper.position.copy(bodyPivot).negate();
  body.add(squash);
  squash.add(upper);
  root.add(body);

  // 鞋：分成左右两个网格（共用顶点属性和材质）
  const shoeMatrix = inSpace(shoes);
  const halves = splitByX(shoes.geometry);
  const shoeBoxes = halves.map((g) => boxIn(shoes, shoeMatrix, new THREE.Box3(), g));
  const sole = Math.min(shoeBoxes[0].min.y, shoeBoxes[1].min.y);

  const shoulders: THREE.Group[] = [];
  const wrists: THREE.Group[] = [];
  const legs: THREE.Group[] = [];
  const feet: THREE.Group[] = [];
  const hipRest: THREE.Vector3[] = [];
  const footRest: THREE.Vector3[] = [];
  const ankle: THREE.Vector3[] = [];
  const legLength: number[] = [];
  let toe = 0;
  let heel = 0;
  for (let i = 0; i < 2; i++) {
    const suffix = i === 0 ? 'L' : 'R';
    // 肩、手腕
    const arm = arms[i]!;
    const hand = hands[i]!;
    boxIn(arm, inSpace(arm), box).getCenter(center);
    const shoulderAt = new THREE.Vector3(center.x, box.max.y - SHOULDER_BELOW, center.z);
    boxIn(hand, inSpace(hand), box).getCenter(center);
    const wristAt = new THREE.Vector3(center.x, box.max.y - WRIST_BELOW, center.z);
    const shoulder = new THREE.Group();
    shoulder.name = `triboo-shoulder-${suffix}`;
    shoulder.position.copy(shoulderAt);
    const wrist = new THREE.Group();
    wrist.name = `triboo-wrist-${suffix}`;
    wrist.position.copy(wristAt).sub(shoulderAt);
    upper.add(shoulder);
    adopt(arm, shoulder, shoulderAt);
    const handMatrix = inSpace(hand);
    shoulder.add(wrist);
    adopt(hand, wrist, wristAt, handMatrix);
    shoulders.push(shoulder);
    wrists.push(wrist);
    // 腿
    const legBox = legBoxes[i];
    legBox.getCenter(center);
    const hip = new THREE.Vector3(center.x, legBox.max.y + HIP_ABOVE, center.z);
    const foot = new THREE.Vector3(center.x, sole, center.z);
    const leg = new THREE.Group();
    leg.name = `triboo-leg-${suffix}`;
    leg.position.copy(hip);
    root.add(leg);
    adopt(legMeshes[i]!, leg, hip);
    legs.push(leg);
    hipRest.push(hip);
    footRest.push(foot);
    ankle.push(new THREE.Vector3(0, legBox.min.y - sole, 0));
    legLength.push(hip.y - legBox.min.y);
    // 脚
    const footGroup = new THREE.Group();
    footGroup.name = `triboo-foot-${suffix}`;
    footGroup.position.copy(foot);
    root.add(footGroup);
    const shoe = new THREE.Mesh(halves[i], shoes.material);
    shoe.name = `Shoe_${suffix}`;
    shoe.castShadow = shoes.castShadow;
    shoe.receiveShadow = shoes.receiveShadow;
    shoe.frustumCulled = shoes.frustumCulled;
    shoe.renderOrder = shoes.renderOrder;
    adopt(shoe, footGroup, foot, shoeMatrix.clone());
    feet.push(footGroup);
    toe = Math.max(toe, shoeBoxes[i].max.z - foot.z);
    heel = Math.max(heel, foot.z - shoeBoxes[i].min.z);
  }
  // 身体、logo 和其他没认出来的部件：跟着身体动
  for (const child of [...space.children]) {
    if (child === shoes || (child as THREE.Mesh).isMesh !== true) continue;
    adopt(child, upper, zero);
  }
  return {
    root, body, squash,
    shoulders: shoulders as [THREE.Group, THREE.Group],
    wrists: wrists as [THREE.Group, THREE.Group],
    legs: legs as [THREE.Group, THREE.Group],
    feet: feet as [THREE.Group, THREE.Group],
    bodyPivot,
    hipRest: hipRest as [THREE.Vector3, THREE.Vector3],
    footRest: footRest as [THREE.Vector3, THREE.Vector3],
    ankle: ankle as [THREE.Vector3, THREE.Vector3],
    legLength: legLength as [number, number],
    toe, heel,
    shoeTris: [triangleCount(halves[0]), triangleCount(halves[1]), triangleCount(shoes.geometry)],
  };
}
