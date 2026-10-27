import * as THREE from 'three/webgpu';
import type { Team } from '../data/types';
import type { World } from '../scenes/world';
import { el } from './dom';

// 星系页：悬停星球显示团队名和人数，点击（不是拖动）进入星球
export class GalaxyUi {
  private enabled = true;
  private readonly world: World;
  private readonly label = el('div', { className: 'float-label' });
  private shown: Team | null = null; // 按团队数据缓存：World.updateTeam 换掉 e.team 后标签会重建
  private down: { x: number; y: number } | null = null;

  constructor(world: World, root: HTMLElement, onPick: (teamId: string) => void) {
    this.world = world;
    this.label.hidden = true;
    root.append(this.label);
    const canvas = world.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => {
      if (!this.enabled || world.rig.flying) return;
      const hit = world.pickPlanet(e.clientX, e.clientY);
      world.setHover(hit);
      canvas.style.cursor = hit ? 'pointer' : '';
    });
    canvas.addEventListener('pointerdown', (e) => { this.down = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!this.enabled || world.rig.flying || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      const hit = world.pickPlanet(e.clientX, e.clientY);
      if (hit) onPick(hit.team.id);
    });
    world.frameHooks.add(() => this.placeLabel());
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.world.setHover(null);
      this.world.renderer.domElement.style.cursor = '';
    }
  }

  // 每帧把标签放到悬停星球的上方
  private placeLabel(): void {
    const h = this.world.hovered;
    const at = h ? this.world.toScreen(new THREE.Vector3(0, 15, 0).add(h.home)) : null;
    this.label.hidden = !at;
    if (!h || !at) return;
    if (this.shown !== h.team) {
      this.shown = h.team;
      this.label.replaceChildren(
        el('span', { className: 'display', textContent: h.team.name }),
        el('span', { className: 'mono', textContent: `${h.team.members.length} members · ${h.team.works.length} works` }),
      );
    }
    this.label.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -100%)`;
  }
}
