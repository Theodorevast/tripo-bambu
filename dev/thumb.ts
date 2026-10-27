import * as THREE from 'three/webgpu';
import { ModelLibrary } from '../src/assets/models';
import { frameModel } from '../src/museum/framing';
import { addStudioLights } from '../src/scenes/lights';

// 只渲染一个模型，给 prep-models 截缩略图：?file=<public/models 下的文件名>
// 背景透明（canvas 带 alpha、场景不设 background），缩略图放在哪种底色的卡片上都融得进去；
// 场景背景色还会被色调映射压暗（#1a1b22 出来约 rgb(1,4,19)），比卡片还暗
const file = new URLSearchParams(location.search).get('file') ?? '';
const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
await renderer.init();
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.setPixelRatio(1);
renderer.setSize(512, 512, false);
const scene = new THREE.Scene();
addStudioLights(scene);
const model = await new ModelLibrary().load({ id: file, file });
canvas.dataset.failed = String(model.failed); // GLTFLoader 读不了时画的是灰色占位方块：prep-models 读这个属性记进报告
model.object.rotation.y = -Math.PI / 6;
scene.add(model.object);
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
frameModel(camera, model.height);
renderer.setAnimationLoop(() => renderer.render(scene, camera));
requestAnimationFrame(() => requestAnimationFrame(() => { window.__thumbReady = true; }));
