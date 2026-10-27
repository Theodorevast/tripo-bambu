import { thumbUrl } from '../assets/models';
import type { PlanetRecipe, PresetId, Work } from '../data/types';
import { PRESET_IDS, PRESETS } from '../planet/presets';
import type { PlacedWork } from '../scenes/planetView';
import { el, initials } from './dom';

export interface EditPanelActions {
  pick(work: Work): void; // 点作品栏里的作品
  rotate(deg: number): void; // 旋转滑块：绝对角度
  scale(value: number): void;
  remove(): void;
  appearance(patch: Partial<Pick<PlanetRecipe, 'preset' | 'ring' | 'atmosphere'>>): void;
  reroll(): void;
  reset(): void;
}

// 编辑模式的界面：底部作品栏、跟着选中作品走的编辑条、左侧星球外观面板
export class EditPanel {
  private readonly act: EditPanelActions;
  private readonly tray = el('section', { className: 'tray' });
  private readonly trayRow = el('div', { className: 'tray-row' });
  private readonly trayItems = el('div', { className: 'tray-items' });
  private readonly dropZone = el('div', { className: 'drop-zone mono', textContent: 'Drop GLB here' });
  private readonly bar = el('div', { className: 'edit-bar' });
  private readonly barTitle = el('div', { className: 'display eb-title' });
  private readonly rotateInput = el('input', { type: 'range', min: '-180', max: '180', step: '1' });
  private readonly scaleInput = el('input', { type: 'range', min: '0.5', max: '2', step: '0.05' });
  private readonly planetPanel = el('aside', { className: 'planet-panel' });
  private readonly presetButtons = new Map<PresetId, HTMLButtonElement>();
  private readonly ringButton: HTMLButtonElement;
  private readonly atmoButton: HTMLButtonElement;
  private current: PlanetRecipe | null = null;

  constructor(root: HTMLElement, act: EditPanelActions) {
    this.act = act;
    this.trayRow.append(this.trayItems, this.dropZone);
    this.tray.append(el('div', { className: 'mono tray-head', textContent: "Your team's works · pick one, then click the planet" }), this.trayRow);
    this.rotateInput.addEventListener('input', () => act.rotate(Number(this.rotateInput.value)));
    this.scaleInput.addEventListener('input', () => act.scale(Number(this.scaleInput.value)));
    this.bar.append(
      this.barTitle,
      el('label', { className: 'mono' }, 'Rotate', this.rotateInput),
      el('label', { className: 'mono' }, 'Scale', this.scaleInput),
      el('button', { className: 'danger', textContent: 'Delete', onclick: () => act.remove() }),
      el('div', { className: 'mono eb-hint', textContent: 'Drag to move · Q / E to turn · Del to remove' }),
    );
    for (const id of PRESET_IDS) {
      const b = el('button', { textContent: PRESETS[id].label, onclick: () => act.appearance({ preset: id }) });
      b.style.setProperty('--swatch', PRESETS[id].bands[1][1]);
      this.presetButtons.set(id, b);
    }
    this.ringButton = el('button', { textContent: 'Ring', onclick: () => { if (this.current) act.appearance({ ring: !this.current.ring }); } });
    this.atmoButton = el('button', { textContent: 'Atmosphere', onclick: () => { if (this.current) act.appearance({ atmosphere: !this.current.atmosphere }); } });
    this.planetPanel.append(
      el('div', { className: 'mono', textContent: 'Planet' }),
      el('div', { className: 'pp-presets' }, ...this.presetButtons.values()),
      el('div', { className: 'pp-toggles' }, this.ringButton, this.atmoButton),
      el('button', { textContent: 'Reroll terrain', onclick: () => act.reroll() }),
      el('hr'),
      el('button', { className: 'danger', textContent: 'Reset demo', onclick: () => act.reset() }),
    );
    this.tray.hidden = true;
    this.bar.hidden = true;
    this.planetPanel.hidden = true;
    root.append(this.tray, this.bar, this.planetPanel);
  }

  show(planet: PlanetRecipe): void {
    this.tray.hidden = false;
    this.planetPanel.hidden = false;
    this.syncAppearance(planet);
  }

  hide(): void {
    this.tray.hidden = true;
    this.bar.hidden = true;
    this.planetPanel.hidden = true;
  }

  setTray(works: Work[], placed: Set<string>, placingId: string | null): void {
    this.trayItems.replaceChildren(...works.map((w) => {
      const b = el('button', { className: 'tray-item', title: w.title, onclick: () => this.act.pick(w) });
      if (w.thumb) b.append(el('img', { src: thumbUrl(w.thumb), alt: '' }));
      else b.append(el('span', { className: 'ti-initials', textContent: initials(w.title) }));
      b.append(el('span', { className: 'ti-name', textContent: w.title }));
      if (placed.has(w.id)) b.append(el('span', { className: 'ti-check', textContent: '✓' }));
      if (w.id.startsWith('tmp-')) b.append(el('span', { className: 'ti-temp mono', textContent: 'temp' }));
      b.setAttribute('aria-pressed', String(w.id === placingId));
      return b;
    }));
  }

  showBar(pw: PlacedWork | null): void {
    this.bar.hidden = !pw;
    if (!pw) return;
    this.barTitle.textContent = pw.work.title;
    this.rotateInput.value = String(Math.round((pw.placement.yaw * 180) / Math.PI));
    this.scaleInput.value = String(pw.placement.scale);
  }

  // 编辑条贴在选中作品的上方；作品转到背面时隐藏
  moveBar(at: { x: number; y: number } | null): void {
    if (this.bar.hidden) return;
    this.bar.style.visibility = at ? 'visible' : 'hidden';
    if (at) this.bar.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, calc(-100% - 12px))`;
  }

  syncAppearance(planet: PlanetRecipe): void {
    this.current = planet;
    for (const [id, b] of this.presetButtons) b.setAttribute('aria-pressed', String(id === planet.preset));
    this.ringButton.setAttribute('aria-pressed', String(planet.ring));
    this.atmoButton.setAttribute('aria-pressed', String(planet.atmosphere));
  }

  setDropHover(on: boolean): void {
    this.dropZone.classList.toggle('hover', on);
  }
}
