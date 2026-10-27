import * as THREE from 'three/webgpu';
import { ModelLibrary } from '../src/assets/models';
import { frameModel } from '../src/museum/framing';
import { addStudioLights } from '../src/scenes/lights';

// 只渲染一个模型，给 prep-models 截缩略图：?file=<public/models 下的文件名>
const file = new URLSearchParams(location.search).get('file') ?? '';
const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
await renderer.init();
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.setPixelRatio(1);
renderer.setSize(512, 512, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#1a1b22');
addStudioLights(scene);
const model = await new ModelLibrary().load({ id: file, file });
model.object.rotation.y = -Math.PI / 6;
scene.add(model.object);
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
frameModel(camera, model.height);
renderer.setAnimationLoop(() => renderer.render(scene, camera));
requestAnimationFrame(() => requestAnimationFrame(() => { window.__thumbReady = true; }));
