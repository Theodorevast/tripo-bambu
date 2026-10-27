import * as THREE from 'three/webgpu';
import { LOD_HIGH } from '../src/planet/generate';
import { SHOWCASE_POLE } from '../src/planet/placement';
import { PlanetObject } from '../src/planet/planetObject';
import { PRESET_IDS } from '../src/planet/presets';
import { addStudioLights } from '../src/scenes/lights';

// 5 套预设排成一行，偶数位带光环。
// ?close=<序号>：镜头放到该星球 30 单位外、沿展示方向 (0, 0.45, 1) 看它，视角 45°，和星球视图的近景一样
const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
await renderer.init();
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#07080d');
addStudioLights(scene);
const planets = PRESET_IDS.map((preset, i) => {
  const p = new PlanetObject({ seed: 1000 + i, preset, ring: i % 2 === 0, atmosphere: true, placements: [] });
  p.setDetail(LOD_HIGH);
  p.group.position.set((i - 2) * 48, 0, 0);
  scene.add(p.group);
  return p;
});

const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 1000);
const closeArg = new URLSearchParams(location.search).get('close') ?? '';
const close = /^\d+$/.test(closeArg) ? Number(closeArg) : -1;
if (close >= 0 && close < planets.length) {
  const center = planets[close].group.position;
  camera.fov = 45;
  camera.updateProjectionMatrix();
  camera.position.copy(center).addScaledVector(new THREE.Vector3(...SHOWCASE_POLE), 30);
  camera.lookAt(center);
} else {
  // 1440×900 下 5 颗星球连同光环都在画面里
  camera.position.set(0, 18, 245);
  camera.lookAt(0, 0, 0);
}
renderer.setAnimationLoop(() => renderer.render(scene, camera));
requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true; }));
