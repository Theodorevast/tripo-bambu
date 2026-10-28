import * as THREE from 'three/webgpu';
import { vec4 } from 'three/tsl';
import { compileUnculled } from './stager';

// 阴影那一遍的预编译（stage 角色：展台、花园用；作品的模型也能用，见报告）。
//
// 为什么不用 Stager.compileShadow：three r186 的 compileAsync 只在调用的当下把物体排进队列，真正建渲染对象、生成着色器、建管线
// 是在第一个 await 之后一个一个做的。three 画阴影时是按每个物体临时改共用的替换材质：side 翻面（正面剔除改成背面剔除）、
// positionNode 换成源材质的（风吹的花草）、colorNode 换成按源材质算透明度的那个……画完马上改回去。排在队列里的编译做到的时候，
// 替换材质早就改回原样了：编出来的阴影管线剔除方向不对、着色器也不是那一份，真正画阴影时又在那一帧同步建一遍（GPU 进程停几十毫秒；
// 实测进星球时花园的小旗、路牌各卡一下，最长一帧 50–83 ms）。
//
// 这里给每种源材质各做一份「替身」替换材质：把 three 会临时改的那几项预先设成它会改成的值，颜色、深度、位置节点直接用 three 自己缓存的那一份
// （renderer._getShadowNodes，按材质版本缓存：真正画阴影时取到的是同一批节点，生成的着色器一字不差）。three 画完「改回去」的时候改回的就是这些值，
// 排在后面的编译读到的也对

type ShadowNodes = { colorNode: THREE.Node<'vec4'> | null; depthNode: THREE.Node<'float'> | null; positionNode: THREE.Node<'vec3'> | null };
type NodeSource = THREE.Material & { positionNode?: THREE.Node<'vec3'> | null; shadowSide: THREE.Side | null; transmission?: number };

const SHADOW_SIDE: Record<THREE.Side, THREE.Side> = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };

// 替身一直留着、不 dispose：dispose 会让 three 扔掉用它建的渲染对象，管线没人用了也一起从缓存里删掉，预编译就白做了（实测）。
// 按源材质的版本缓存：源材质改过（needsUpdate）就重做一份
const twins = new WeakMap<THREE.Material, { version: number; twin: THREE.NodeMaterial }>();

function shadowTwin(renderer: THREE.WebGPURenderer, source: NodeSource): THREE.NodeMaterial {
  const have = twins.get(source);
  if (have && have.version === source.version) return have.twin;
  const nodes = (renderer as unknown as { _getShadowNodes(m: THREE.Material): ShadowNodes })._getShadowNodes(source);
  const m = new THREE.NodeMaterial();
  // three 的阴影材质（ShadowBaseNode 的 _getShadowMaterial）原样的几项
  m.colorNode = nodes.colorNode ?? vec4(0, 0, 0, 1);
  (m as THREE.NodeMaterial & { isShadowPassMaterial: boolean }).isShadowPassMaterial = true;
  m.name = 'ShadowMaterial';
  m.blending = THREE.NoBlending;
  m.fog = false;
  // 画阴影时按源材质临时改的几项（Renderer.renderObject 里 materialOverride 那一段，PCF 阴影）
  const vsm = renderer.shadowMap.type === THREE.VSMShadowMap;
  m.side = source.shadowSide ?? (vsm ? source.side : SHADOW_SIDE[source.side]);
  m.positionNode = nodes.positionNode ?? (source.positionNode?.isNode ? source.positionNode : null);
  m.depthNode = nodes.depthNode;
  m.transparent = source.transparent || (source.transmission ?? 0) > 0;
  m.alphaTest = source.alphaTest;
  twins.set(source, { version: source.version, twin: m });
  return m;
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
    const twin = shadowTwin(renderer, source as NodeSource);
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
