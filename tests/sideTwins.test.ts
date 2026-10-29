import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { compileShadowExact, compileSides, splitsSides } from '../src/scenes/shadowWarm';
import { Stager } from '../src/scenes/stager';

// F2：three r186 把「半透明 + 双面」拆成背面、正面两遍画（material.side 临时改成 BackSide / FrontSide），
// compileAsync 排队时也拆，可是做到的时候 side 已经改回 DoubleSide：两遍的管线都没编到，第一次画时在出帧时同步建。
// 预编译时换成 side 定死的背面、正面副本各编一遍；投影那一遍同样（替身也要两份）

// 假渲染器：compileAsync 在调用的当下（three 也是在第一个 await 之前排好队）记下可见的网格当时用的材质、投影的替换材质
interface Seen {
  name: string;
  material: THREE.Material;
  side: THREE.Side;
  override: THREE.Side | null;
}

function fakeRenderer() {
  const compiles: Seen[][] = [];
  const renderer = {
    shadowMap: { type: THREE.PCFShadowMap },
    _getShadowNodes: () => ({ colorNode: null, depthNode: null, positionNode: null }),
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    getMRT: () => null,
    setMRT: () => {},
    initTexture: () => {},
    compileAsync: vi.fn(async (object: THREE.Object3D, _camera: THREE.Camera, scene: THREE.Scene) => {
      const seen: Seen[] = [];
      object.traverseVisible((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const m = mesh.material as THREE.Material;
        seen.push({ name: mesh.name, material: m, side: m.side, override: scene.overrideMaterial?.side ?? null });
      });
      compiles.push(seen);
    }),
  };
  return { renderer: renderer as unknown as THREE.WebGPURenderer, compiles };
}

function mesh(name: string, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(), material);
  m.name = name;
  m.castShadow = true;
  return m;
}

describe('哪些材质会被拆成两遍画（splitsSides）', () => {
  it('只有「半透明 + 双面 + 没设 forceSinglePass」的', () => {
    expect(splitsSides(new THREE.MeshStandardMaterial({ transparent: true, side: THREE.DoubleSide }))).toBe(true);
    expect(splitsSides(new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }))).toBe(false); // 不透明的双面：一遍画完
    expect(splitsSides(new THREE.MeshStandardMaterial({ transparent: true }))).toBe(false);
    expect(splitsSides(new THREE.MeshStandardMaterial({ transparent: true, side: THREE.DoubleSide, forceSinglePass: true }))).toBe(false);
  });
});

describe('主画面那一遍（compileSides）', () => {
  it('双面半透明的换成正面、背面副本各编一遍，别的照常编一次；编完材质、可见性都换回来', async () => {
    const { renderer, compiles } = fakeRenderer();
    const map = new THREE.Texture();
    const hair = new THREE.MeshStandardMaterial({ map, transparent: true, side: THREE.DoubleSide });
    const body = new THREE.MeshStandardMaterial({ map });
    const root = new THREE.Group();
    root.add(mesh('hair', hair), mesh('body', body));
    await compileSides(renderer, root, new THREE.PerspectiveCamera(), new THREE.Scene());
    expect(compiles.length).toBe(2);
    const [first, second] = compiles;
    expect(first.map((s) => [s.name, s.side])).toEqual([['hair', THREE.FrontSide], ['body', THREE.FrontSide]]);
    expect(second.map((s) => [s.name, s.side])).toEqual([['hair', THREE.BackSide]]); // 第二遍只留拆两遍的
    const front = first[0].material as THREE.MeshStandardMaterial;
    const back = second[0].material as THREE.MeshStandardMaterial;
    expect(front).not.toBe(hair);
    expect(back).not.toBe(hair);
    expect(front.map).toBe(map); // 同一份贴图（和节点）：缓存键只差 side
    expect(back.transparent).toBe(true);
    expect(first[1].material).toBe(body);
    expect(root.children.map((c) => (c as THREE.Mesh).material)).toEqual([hair, body]);
    expect(root.children.every((c) => c.visible)).toBe(true);
  });

  it('副本一直留着（dispose 会让 three 连管线一起扔掉）：再编一次用的是同一对副本；源材质改过才换一份新的、旧的扔掉', async () => {
    const { renderer, compiles } = fakeRenderer();
    const hair = new THREE.MeshStandardMaterial({ transparent: true, side: THREE.DoubleSide });
    const root = new THREE.Group();
    root.add(mesh('hair', hair));
    await compileSides(renderer, root, new THREE.PerspectiveCamera(), new THREE.Scene());
    await compileSides(renderer, root, new THREE.PerspectiveCamera(), new THREE.Scene());
    const [front, back] = [compiles[0][0].material, compiles[1][0].material];
    expect(compiles[2][0].material).toBe(front);
    expect(compiles[3][0].material).toBe(back);
    const disposed: THREE.Material[] = [];
    for (const c of [front, back]) c.addEventListener('dispose', () => disposed.push(c));
    hair.needsUpdate = true;
    await compileSides(renderer, root, new THREE.PerspectiveCamera(), new THREE.Scene());
    expect(compiles[4][0].material).not.toBe(front);
    expect(disposed).toEqual([back, front]);
  });

  it('没有双面半透明的：和原来一样只编一次', async () => {
    const { renderer, compiles } = fakeRenderer();
    const root = new THREE.Group();
    root.add(mesh('a', new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })));
    await compileSides(renderer, root, new THREE.PerspectiveCamera(), new THREE.Scene());
    expect(compiles.length).toBe(1);
  });

  it('Stager：模型本来双面的材质，淡入用的半透明克隆一遍画完（forceSinglePass，不拆），编到的就是画的那一份', async () => {
    const { renderer, compiles } = fakeRenderer();
    const stager = new Stager(renderer, new THREE.Scene(), new THREE.PerspectiveCamera());
    const golem = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
    const root = new THREE.Group();
    root.add(mesh('golem', golem));
    void stager.prepare(root);
    for (let i = 0; i < 4; i++) {
      stager.tick(1 / 60);
      await new Promise((r) => setTimeout(r, 0));
    }
    // 原材质一遍（不透明双面，不拆）；淡入的克隆也是一遍（半透明、双面、一遍画完）
    expect(compiles.map((c) => c.map((s) => `${s.material === golem ? 'orig' : 'clone'}:${s.side}${s.material.transparent ? ':t' : ''}`))).toEqual([
      [`orig:${THREE.DoubleSide}`],
      [`clone:${THREE.DoubleSide}:t`],
    ]);
    const fade = compiles[1][0].material;
    expect(fade.forceSinglePass).toBe(true);
    expect(splitsSides(fade)).toBe(false);
  });

  it('投影那一遍：淡入的克隆（半透明、双面）替换材质照样拆，替身背面、正面两份', async () => {
    const { renderer, compiles } = fakeRenderer();
    const l = new THREE.DirectionalLight();
    l.castShadow = true;
    (l.shadow as unknown as { map: THREE.RenderTarget }).map = new THREE.RenderTarget(4, 4);
    const fade = new THREE.MeshStandardMaterial({ transparent: true, side: THREE.DoubleSide, forceSinglePass: true });
    const root = new THREE.Group();
    root.add(mesh('golem', fade));
    await compileShadowExact(renderer, root, l, new THREE.Scene());
    expect(compiles.map((c) => c[0].override)).toEqual([THREE.BackSide, THREE.FrontSide]);
  });
});

describe('投影那一遍（compileShadowExact）', () => {
  const light = () => {
    const l = new THREE.DirectionalLight();
    l.castShadow = true;
    (l.shadow as unknown as { map: THREE.RenderTarget }).map = new THREE.RenderTarget(4, 4);
    return l;
  };

  it('半透明双面的源材质：替身两份，替换材质的 side 定成背面、正面各编一遍', async () => {
    const { renderer, compiles } = fakeRenderer();
    const root = new THREE.Group();
    root.add(mesh('hair', new THREE.MeshStandardMaterial({ transparent: true, side: THREE.DoubleSide })));
    await compileShadowExact(renderer, root, light(), new THREE.Scene());
    expect(compiles.map((c) => c[0].override)).toEqual([THREE.BackSide, THREE.FrontSide]);
  });

  it('普通的源材质：替身一份，side 是投影时翻过来的那一面（PCF：正面 → 背面）', async () => {
    const { renderer, compiles } = fakeRenderer();
    const root = new THREE.Group();
    root.add(mesh('body', new THREE.MeshStandardMaterial()), mesh('golem', new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })));
    await compileShadowExact(renderer, root, light(), new THREE.Scene());
    expect(compiles.map((c) => [c[0].name, c[0].override])).toEqual([['body', THREE.BackSide], ['golem', THREE.DoubleSide]]);
  });
});
