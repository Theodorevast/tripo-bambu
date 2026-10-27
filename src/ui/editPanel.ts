import { thumbUrl } from '../assets/models';
import type { PlanetRecipe, PresetId, Work } from '../data/types';
import { PRESET_IDS, PRESETS } from '../planet/presets';
import type { PlacedWork } from '../scenes/planetView';
import { el, initials } from './dom';

export interface EditPanelActions {
  pick(work: Work): void; // 点作品栏里的作品
  rotate(deg: number, done: boolean): void; // 旋转滑块：绝对角度；拖动中只预览（done = false），松手才保存（done = true）
  scale(value: number, done: boolean): void;
  remove(): void;
  appearance(patch: Partial<Pick<PlanetRecipe, 'preset' | 'ring' | 'atmosphere'>>): void;
  reroll(): void;
  reset(): void;
}

// 屏幕上的矩形：视口坐标，CSS 像素
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const BAR_GAP = 16; // 编辑条和作品之间的空隙
const BAR_MARGIN = 8; // 编辑条离视口边、顶栏、作品栏、外观面板至少这么远

// 编辑条放在作品旁边（spec 2.5）：右边放得下放右边，不然放左边，两边都放不下放空得多的一边；
// 竖直方向和作品的屏幕范围居中。最后整条夹进 area，area 比编辑条还小时贴着 area 的左上边
export function placeBeside(work: ScreenRect, bar: { width: number; height: number }, area: ScreenRect, gap = BAR_GAP): { x: number; y: number } {
  const right = work.right + gap;
  const left = work.left - gap - bar.width;
  let x: number;
  if (right + bar.width <= area.right) x = right;
  else if (left >= area.left) x = left;
  else x = area.right - work.right >= work.left - area.left ? right : left;
  const y = (work.top + work.bottom) / 2 - bar.height / 2;
  return { x: clamp(x, area.left, area.right - bar.width), y: clamp(y, area.top, area.bottom - bar.height) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

// 编辑模式的界面：底部作品栏、跟着选中作品走的编辑条、左侧星球外观面板
export class EditPanel {
  private readonly act: EditPanelActions;
  private readonly root: HTMLElement;
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
    this.root = root;
    this.trayRow.append(this.trayItems, this.dropZone);
    this.tray.append(el('div', { className: 'mono tray-head', textContent: "Your team's works · pick one, then click the planet" }), this.trayRow);
    // 拖滑块时 input 一直来：只预览；松手的 change 才保存
    this.rotateInput.addEventListener('input', () => act.rotate(Number(this.rotateInput.value), false));
    this.rotateInput.addEventListener('change', () => act.rotate(Number(this.rotateInput.value), true));
    this.scaleInput.addEventListener('input', () => act.scale(Number(this.scaleInput.value), false));
    this.scaleInput.addEventListener('change', () => act.scale(Number(this.scaleInput.value), true));
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
    // 编辑条排在最后：不设 z-index 也压在作品栏和外观面板上面；之后才加进来的 Members / Museum 页仍压在它上面
    root.append(this.tray, this.planetPanel, this.bar);
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
    if (pw && this.bar.hidden) this.bar.style.visibility = 'hidden'; // 刚出现：等 moveBar 摆好位置再显示，不在上次的位置闪一下
    this.bar.hidden = !pw;
    if (!pw) return;
    this.barTitle.textContent = pw.work.title;
    this.rotateInput.value = String(Math.round((pw.placement.yaw * 180) / Math.PI));
    this.scaleInput.value = String(pw.placement.scale);
  }

  // 编辑条摆在选中作品旁边。work 是作品在屏幕上的范围；null（拖动中、作品在星球背面或镜头背后）
  // 或作品整个在视口外时藏起来（visibility: hidden 也不再接鼠标）
  moveBar(work: ScreenRect | null): void {
    if (this.bar.hidden) return;
    if (!work || work.right < 0 || work.left > innerWidth || work.bottom < 0 || work.top > innerHeight) {
      this.bar.style.visibility = 'hidden';
      return;
    }
    const { x, y } = placeBeside(work, { width: this.bar.offsetWidth, height: this.bar.offsetHeight }, this.barArea());
    this.bar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.bar.style.visibility = 'visible';
  }

  // 编辑条能待的区域：视口四边留 8px，顶栏底边以下、作品栏顶边以上，外观面板右边（剩下的宽度放不下编辑条时就不管外观面板）
  private barArea(): ScreenRect {
    const topbar = this.root.querySelector('.topbar');
    const area: ScreenRect = {
      left: BAR_MARGIN,
      top: (topbar ? topbar.getBoundingClientRect().bottom : 0) + BAR_MARGIN,
      right: innerWidth - BAR_MARGIN,
      bottom: (this.tray.hidden ? innerHeight : this.tray.getBoundingClientRect().top) - BAR_MARGIN,
    };
    if (!this.planetPanel.hidden) {
      const left = this.planetPanel.getBoundingClientRect().right + BAR_MARGIN;
      if (area.right - left >= this.bar.offsetWidth) area.left = left;
    }
    return area;
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
