import * as THREE from 'three/webgpu';
import { vec4 } from 'three/tsl';
import { compileUnculled } from './stager';

// 按 three r186 真正画的时候的状态预编译（stage 角色：展台、花园、作品的投影那一遍；F2：双面半透明拆开的两遍）。
//
// 为什么不能照常换上阴影材质编（原来的 Stager.compileShadow，已删）：three r186 的 compileAsync 只在调用的当下把物体排进队列，真正建渲染对象、生成着色器、建管线
// 是在第一个 await 之后一个一个做的。three 画阴影时是按每个物体临时改共用的替换材质：side 翻面（正面剔除改成背面剔除）、
// positionNode 换成源材质的（风吹的花草）、colorNode 换成按源材质算透明度的那个……画完马上改回去。排在队列里的编译做到的时候，
// 替换材质早就改回原样了：编出来的阴影管线剔除方向不对、着色器也不是那一份，真正画阴影时又在那一帧同步建一遍（GPU 进程停几十毫秒；
// 实测进星球时花园的小旗、路牌各卡一下，最长一帧 50–83 ms）。
//
// 这里给每种源材质各做一份「替身」替换材质：把 three 会临时改的那几项预先设成它会改成的值，颜色、深度、位置节点直接用 three 自己缓存的那一份
// （renderer._getShadowNodes，按材质版本缓存：真正画阴影时取到的是同一批节点，生成的着色器一字不差）。three 画完「改回去」的时候改回的就是这些值，
// 排在后面的编译读到的也对
//
// 双面半透明（F2）：three r186 画「半透明 + 双面」的东西（transparent、side = DoubleSide、forceSinglePass = false）时拆成背面、正面两遍，
// 每一遍把 material.side 临时改成 BackSide / FrontSide（Renderer.renderObject 的最后一段；投影那一遍的替换材质也一样拆）。
// compileAsync 排队时同样拆成两遍，可是做到的时候 side 已经改回 DoubleSide：编出来的是双面的着色器和管线，两遍都用不上，
// 第一次画的时候在出帧时同步建（主画面背面、正面各一条，投影一条：GPU 进程当场编译，第一次进星球偶尔一帧 50 ms）。
// 作品淡入时换上的半透明克隆（stager.ts 的 makeSwaps）原来也是这样：模型本来双面的材质（冰魔像、南瓜女孩……）淡入那 0.35 秒变成「半透明 + 双面」；
// 现在淡入的克隆一遍画完（forceSinglePass，和淡完以后不透明的原材质一样），主画面不再拆，可是投影那一遍的替换材质照样拆（three 只看替换材质自己的 forceSinglePass）。
// 做法：编译时换成 side 定死成 BackSide、FrontSide 的两个副本（主画面：原材质的克隆；投影：两份替身）各编一遍，
// 真正画的时候缓存键和副本一字不差，着色器、管线都是现成的

type ShadowNodes = { colorNode: THREE.Node<'vec4'> | null; depthNode: THREE.Node<'float'> | null; positionNode: THREE.Node<'vec3'> | null };
type NodeSource = THREE.Material & {
  positionNode?: THREE.Node<'vec3'> | null;
  shadowSide: THREE.Side | null;
  transmission?: number;
  transmissionNode?: THREE.Node | null;
  backdropNode?: THREE.Node | null;
};

const SHADOW_SIDE: Record<THREE.Side, THREE.Side> = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };

// three r186 画的时候会拆成背面、正面两遍的材质
export function splitsSides(m: THREE.Material): boolean {
  return m.transparent === true && m.side === THREE.DoubleSide && m.forceSinglePass === false;
}

// 副本（替身）一直留着、不 dispose：dispose 会让 three 扔掉用它建的渲染对象，管线没人用了也一起从缓存里删掉，预编译就白做了（实测）；
// 留着的副本让管线一直在缓存里，下一颗星球上同样的材质直接用上。按源材质的版本缓存：源材质改过（needsUpdate）就换一份新的，旧的扔掉
type Kept = { version: number; mats: THREE.Material[] };

function keep(cache: WeakMap<THREE.Material, Kept>, source: THREE.Material, make: () => THREE.Material[]): THREE.Material[] {
  const have = cache.get(source);
  if (have && have.version === source.version) return have.mats;
  if (have) for (const m of have.mats) m.dispose();
  const mats = make();
  cache.set(source, { version: source.version, mats });
  return mats;
}

const shadowTwins = new WeakMap<THREE.Material, Kept>();
const sideTwins = new WeakMap<THREE.Material, Kept>();

// 投影那一遍的替身：一般一份；源材质半透明、替换材质会是双面（three 会拆两遍）时是背面、正面两份
function shadowTwinsOf(renderer: THREE.WebGPURenderer, source: NodeSource): THREE.NodeMaterial[] {
  return keep(shadowTwins, source, () => {
    const nodes = (renderer as unknown as { _getShadowNodes(m: THREE.Material): ShadowNodes })._getShadowNodes(source);
    // 画阴影时按源材质临时改的几项（Renderer.renderObject 里 materialOverride 那一段，PCF 阴影）
    const vsm = renderer.shadowMap.type === THREE.VSMShadowMap;
    const side = source.shadowSide ?? (vsm ? source.side : SHADOW_SIDE[source.side]);
    const transparent = source.transparent || (source.transmission ?? 0) > 0 || !!source.transmissionNode?.isNode || !!source.backdropNode?.isNode;
    const sides = transparent && side === THREE.DoubleSide ? [THREE.BackSide, THREE.FrontSide] : [side];
    return sides.map((s) => {
      const m = new THREE.NodeMaterial();
      // three 的阴影材质（ShadowBaseNode 的 _getShadowMaterial）原样的几项
      m.colorNode = nodes.colorNode ?? vec4(0, 0, 0, 1);
      (m as THREE.NodeMaterial & { isShadowPassMaterial: boolean }).isShadowPassMaterial = true;
      m.name = 'ShadowMaterial';
      m.blending = THREE.NoBlending;
      m.fog = false;
      // side：编译时 three 先按源材质改成双面、拆两遍排队，再改回这里设的值；做到的时候读到的是这个（拆开的那一遍的值）
      m.side = s;
      m.positionNode = nodes.positionNode ?? (source.positionNode?.isNode ? source.positionNode : null);
      m.depthNode = nodes.depthNode;
      m.transparent = transparent;
      m.alphaTest = source.alphaTest;
      return m;
    });
  }) as THREE.NodeMaterial[];
}

// 主画面那一遍的副本：side 定死成 BackSide、FrontSide（克隆：节点、贴图都是同一份）
function sideTwinsOf(source: THREE.Material): THREE.Material[] {
  return keep(sideTwins, source, () =>
    [THREE.BackSide, THREE.FrontSide].map((s) => {
      const m = source.clone();
      m.side = s;
      return m;
    }),
  );
}

// 预编译 object 主画面那一遍（同 compileUnculled），「半透明 + 双面」的材质换成它的背面、正面副本各编一遍（见文件开头）。
// 只在调用 compileAsync 的那一下（第一个 await 之前它就排好队了）换材质、藏东西，马上换回来，不影响这期间画的帧
export async function compileSides(renderer: THREE.WebGPURenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
  const split: THREE.Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (list.some(splitsSides)) split.push(mesh);
  });
  if (!split.length) return compileUnculled(renderer, root, camera, scene);
  const originals = split.map((mesh) => mesh.material);
  const wear = (k: number) => split.forEach((mesh, i) => {
    const o = originals[i];
    mesh.material = Array.isArray(o) ? o.map((m) => (splitsSides(m) ? sideTwinsOf(m)[k] : m)) : sideTwinsOf(o)[k];
  });
  const undo = () => split.forEach((mesh, i) => {
    mesh.material = originals[i];
  });
  // 第一遍：别的照常编，这些换成正面副本；第二遍：只留这些（别的刚编过），换成背面副本
  for (const k of [1, 0]) {
    const hidden: THREE.Object3D[] = [];
    if (k === 0) {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.visible && !split.includes(mesh)) {
          mesh.visible = false;
          hidden.push(mesh);
        }
      });
    }
    let done: Promise<void>;
    wear(k);
    try {
      done = compileUnculled(renderer, root, camera, scene);
    } finally {
      undo();
      for (const o of hidden) o.visible = true;
    }
    await done;
  }
}

// 在后台编译 meshes 投影那一遍的管线：按源材质分组，每组换上自己的替身各编一次。meshes 要么不在场景里，要么这期间不画。
// light.shadow.map 要在阴影画过一次之后才有（World.warmUp 先画一帧）；还没有就跳过
export async function compileShadowExact(renderer: THREE.WebGPURenderer, root: THREE.Object3D, light: THREE.DirectionalLight | null, scene: THREE.Scene): Promise<void> {
  const map = light?.castShadow ? (light.shadow.map as THREE.RenderTarget | null) : null;
  if (!light || !map) return;
  const groups = new Map<THREE.Material, THREE.Mesh[]>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.castShadow || !mesh.visible || Array.isArray(mesh.material)) return;
    const list = groups.get(mesh.material) ?? [];
    list.push(mesh);
    groups.set(mesh.material, list);
  });
  for (const [source, meshes] of groups) {
    for (const twin of shadowTwinsOf(renderer, source as NodeSource)) {
      // 只让这一组可见：compileAsync 在调用的当下（第一个 await 之前）就把可见的物体排进队列，排完马上恢复
      const hidden: THREE.Object3D[] = [];
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.visible && !meshes.includes(mesh)) {
          mesh.visible = false;
          hidden.push(mesh);
        }
      });
      const target = renderer.getRenderTarget();
      const mrt = renderer.getMRT();
      const override = scene.overrideMaterial;
      let done: Promise<void>;
      renderer.setRenderTarget(map);
      renderer.setMRT(null);
      scene.overrideMaterial = twin;
      try {
        done = compileUnculled(renderer, root, light.shadow.camera, scene);
      } finally {
        scene.overrideMaterial = override;
        renderer.setMRT(mrt);
        renderer.setRenderTarget(target);
        for (const o of hidden) o.visible = true;
      }
      await done;
    }
  }
}
