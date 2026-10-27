import * as THREE from 'three/webgpu';
import { LOD_HIGH } from '../src/planet/generate';
import { PlanetObject } from '../src/planet/planetObject';
import { PRESET_IDS } from '../src/planet/presets';
import { addStudioLights } from '../src/scenes/lights';

// 5 套预设排成一行，偶数位带光环
const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
await renderer.init();
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#07080d');
addStudioLights(scene);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 18, 150);
camera.lookAt(0, 0, 0);
PRESET_IDS.forEach((preset, i) => {
  const p = new PlanetObject({ seed: 1000 + i, preset, ring: i % 2 === 0, atmosphere: true, placements: [] });
  p.setDetail(LOD_HIGH);
  p.group.position.set((i - 2) * 48, 0, 0);
  scene.add(p.group);
});
renderer.setAnimationLoop(() => renderer.render(scene, camera));
requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true; }));
