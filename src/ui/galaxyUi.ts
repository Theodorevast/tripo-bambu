import type { PlanetEntry, World } from '../scenes/world';
import { HOME_MOTION } from '../scenes/homeMotion';
import { el } from './dom';
import { iconSvg } from './icons';

// 首页（星系视图，H2）：每颗星球下面一张圆角小名牌（团队名、团队色的小星球、作品数；「你的星球」带一个 You，建设中的写 building），
// 悬停星球或名牌时星球轻轻放大、慢慢转（World），名牌弹出来；按下去压扁、松开回弹，然后进现有的穿云转场。
// 名牌是按钮：Tab 能一颗颗选到，回车进去。镜头在飞、转场时名牌收起来，落定以后依次弹出来。
// 名牌叠在一起（窄屏、后排）时，排在后面的先藏：你的星球 > 建好的 > 建设中的；悬停的那张一直显示

const HAMMER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M13.5 6.5l4 4"/><path d="M11 9L4.2 15.8a1.9 1.9 0 0 0 2.7 2.7L13.7 11.7"/><path d="M10.5 5.2l3-2.2 6.2 6.2-2.2 3z" fill="currentColor" fill-opacity=".25"/></svg>';

interface Tag {
  entry: PlanetEntry;
  el: HTMLButtonElement;
  team: PlanetEntry['team']; // 按团队数据缓存：World.updateTeam 换掉 e.team 后名牌重建
  w: number; // 量好的大小（CSS 像素；字体换了、窗口变了重量）
  h: number;
  x: number; // 这一帧的位置（名牌顶边的中点）
  y: number;
  tx: number; // 上一次写进 transform 的位置（没动就不再写，静止时不触发样式重算）
  ty: number;
  shown: boolean;
  rank: number; // 叠在一起时谁先藏：越小越优先
}

export interface TagSnapshot {
  id: string;
  x: number;
  y: number;
  shown: boolean;
  hover: boolean;
  you: boolean;
  text: string;
}

const _c = { x: 0, y: 0, r: 0 };

export class GalaxyUi {
  // 指针在别的东西上（首页右边的翠宝）：星球不接这一下（悬停、点击都让给它）
  blocker: ((x: number, y: number) => boolean) | null = null;
  private enabled = true;
  private readonly world: World;
  private readonly onPick: (teamId: string) => void;
  private readonly layer = el('div', { className: 'planet-tags' });
  private readonly tags = new Map<string, Tag>();
  private order: Tag[] = []; // 按优先级排好（你的星球、建好的、建设中的）：Tab 的顺序、叠在一起时谁先藏
  private readonly placed: Tag[] = []; // 每帧复用
  private down: { x: number; y: number; entry: PlanetEntry | null } | null = null;
  private you: string | null = null;
  private leaving = false; // 松开了、正等回弹放完去转场：这期间不再接点击
  private shown = false; // 名牌现在是不是显示着（镜头落定、在首页）
  private measured = false;
  private pointerHover: PlanetEntry | null = null; // 画布上指着的
  private tagHover: PlanetEntry | null = null; // 名牌上指着的 / 键盘选中的
  private ctaHover: string | null = null; // 「Visit your planet」上指着：你的星球跟着亮

  constructor(world: World, root: HTMLElement, onPick: (teamId: string) => void) {
    this.world = world;
    this.onPick = onPick;
    this.layer.setAttribute('aria-label', 'Planets');
    root.append(this.layer);
    const canvas = world.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => {
      if (!this.enabled || world.rig.flying) return;
      if (this.blocker?.(e.clientX, e.clientY)) {
        this.setPointerHover(null);
        return;
      }
      const hit = world.pickPlanet(e.clientX, e.clientY);
      this.setPointerHover(hit);
      canvas.style.cursor = hit ? 'pointer' : '';
      // 按着拖动（转镜头）：松开不算点击，回弹
      if (this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5) {
        world.pressPlanet(null, false);
        this.down.entry = null;
      }
    });
    // 指针移到顶栏上或移出窗口时画布收不到 pointermove：在这里清掉悬停，名牌才不会一直弹着
    // 只在星系页处理：星球页的光标归 PlanetScreen 管
    canvas.addEventListener('pointerleave', () => {
      if (!this.enabled) return;
      this.setPointerHover(null);
      world.pressPlanet(null, false);
      if (this.down) this.down.entry = null;
      canvas.style.cursor = '';
    });
    // 只认左键（主键）单击进星球：右键、中键不算。按下去星球先压扁一点
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.enabled || world.rig.flying || this.blocker?.(e.clientX, e.clientY)) {
        this.down = null;
        return;
      }
      const hit = world.pickPlanet(e.clientX, e.clientY);
      this.down = { x: e.clientX, y: e.clientY, entry: hit };
      if (hit) world.pressPlanet(hit, true);
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!this.enabled || world.rig.flying || !d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || this.blocker?.(e.clientX, e.clientY)) {
        world.pressPlanet(null, false);
        return;
      }
      const hit = world.pickPlanet(e.clientX, e.clientY);
      if (hit) this.visit(hit, d.entry === hit);
      else world.pressPlanet(null, false);
    });
    canvas.addEventListener('pointercancel', () => {
      this.down = null;
      world.pressPlanet(null, false);
    });
    void document.fonts?.ready.then(() => { this.measured = false; });
    addEventListener('resize', () => { this.measured = false; });
    world.frameHooks.add(() => this.place());
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.setPointerHover(null);
      this.tagHover = null;
      this.ctaHover = null;
      this.world.setHover(null);
      this.world.renderer.domElement.style.cursor = '';
    }
  }

  // 「你的星球」：名牌上写 You，排在最前面
  setYou(teamId: string | null): void {
    this.you = teamId;
    for (const t of this.tags.values()) this.fill(t);
    this.sortTags();
  }

  // 「Visit your planet」等按钮：指着时那颗星球跟着放大、名牌弹出来
  hoverTeam(teamId: string | null): void {
    this.ctaHover = teamId;
    this.syncHover();
  }

  // 去某颗星球（按钮、名牌、键盘都走这里）：先压一下、回弹，再穿云
  visitTeam(teamId: string): void {
    const e = this.world.planets.get(teamId);
    if (e) this.visit(e, false);
    else this.onPick(teamId);
  }

  snapshot(): TagSnapshot[] {
    return [...this.tags.values()].map((t) => ({
      id: t.entry.team.id,
      x: t.x,
      y: t.y,
      shown: this.shown && t.shown,
      hover: t.el.classList.contains('is-hover'),
      you: t.entry.team.id === this.you,
      text: t.el.querySelector('.pt-name')?.textContent ?? '',
    }));
  }

  // pressed：之前已经按下去压扁了（指针按住再松开）；没有（键盘、按钮）就补一下「压」
  private visit(e: PlanetEntry, pressed: boolean): void {
    if (this.leaving || !this.enabled) return;
    this.leaving = true;
    const world = this.world;
    const go = () => {
      world.pressPlanet(null, false); // 松开：弹簧冲过头再回来
      setTimeout(() => {
        this.leaving = false;
        this.onPick(e.team.id);
      }, HOME_MOTION.delay * 1000);
    };
    if (pressed) go();
    else {
      world.pressPlanet(e, true);
      setTimeout(go, 70);
    }
  }

  private setPointerHover(e: PlanetEntry | null): void {
    if (this.pointerHover === e) return;
    this.pointerHover = e;
    this.syncHover();
  }

  // 悬停的来源：画布上指着的 > 名牌上的 > 按钮指着的。World 只认一个（放大、慢慢转、光圈）
  private syncHover(): void {
    if (!this.enabled) return;
    const cta = this.ctaHover ? this.world.planets.get(this.ctaHover) ?? null : null;
    const e = this.pointerHover ?? this.tagHover ?? cta;
    if (this.world.hovered !== e) this.world.setHover(e);
  }

  private build(entry: PlanetEntry): Tag {
    const button = el('button', { className: 'planet-tag', type: 'button' });
    const tag: Tag = { entry, el: button, team: entry.team, w: 0, h: 0, x: 0, y: 0, tx: NaN, ty: NaN, shown: true, rank: 0 };
    button.addEventListener('pointerenter', () => {
      this.tagHover = tag.entry;
      this.syncHover();
    });
    button.addEventListener('pointerleave', () => {
      if (this.tagHover === tag.entry) this.tagHover = null;
      this.world.pressPlanet(null, false);
      this.syncHover();
    });
    button.addEventListener('focus', () => {
      this.tagHover = tag.entry;
      this.syncHover();
    });
    button.addEventListener('blur', () => {
      if (this.tagHover === tag.entry) this.tagHover = null;
      this.syncHover();
    });
    button.addEventListener('pointerdown', (ev) => {
      if (ev.button === 0) this.world.pressPlanet(tag.entry, true);
    });
    button.addEventListener('click', (ev) => {
      // 指针点的（detail > 0）已经按下去了；键盘回车、空格（detail = 0）补一下
      this.visit(tag.entry, ev.detail > 0);
    });
    this.fill(tag);
    this.layer.append(button);
    return tag;
  }

  private fill(tag: Tag): void {
    const team = tag.entry.team;
    tag.team = team;
    const slot = this.world.slotOf(tag.entry);
    const you = team.id === this.you;
    const building = team.status === 'under-construction';
    const card = el('span', { className: 'pt-card' });
    const dot = el('span', { className: 'pt-dot' });
    dot.setAttribute('aria-hidden', 'true');
    card.append(dot, el('span', { className: 'pt-name', textContent: team.name }));
    if (building) {
      const soon = el('span', { className: 'pt-soon' });
      soon.innerHTML = HAMMER;
      soon.append(el('span', { className: 'pt-soon-text', textContent: 'building' }));
      card.append(soon);
    } else {
      const count = el('span', { className: 'pt-count' });
      count.innerHTML = iconSvg('cube');
      count.append(String(team.works.length));
      count.title = `${team.works.length} ${team.works.length === 1 ? 'work' : 'works'}`;
      card.append(count);
    }
    if (you) card.append(el('span', { className: 'pt-you', textContent: 'You' }));
    tag.el.replaceChildren(card);
    tag.el.dataset.tier = you ? 'you' : building ? 'building' : 'built';
    tag.el.style.setProperty('--team', team.color);
    const works = `${team.works.length} ${team.works.length === 1 ? 'work' : 'works'}`;
    tag.el.setAttribute('aria-label', `${team.name}${you ? ', your planet' : ''}, ${building ? 'under construction' : works}. Visit planet`);
    tag.rank = you ? 0 : building ? 2 + (slot?.row ?? 0) * 0.01 : 1 + (slot?.row ?? 0) * 0.01;
    this.measured = false;
  }

  private sortTags(): void {
    this.order = [...this.tags.values()].sort((a, b) => a.rank - b.rank);
    this.order.forEach((t, i) => t.el.style.setProperty('--i', String(i)));
    if (this.order.some((t, i) => this.layer.children[i] !== t.el)) this.layer.append(...this.order.map((t) => t.el));
    this.measured = false;
  }

  // 每帧：名牌摆到星球下面；镜头在飞、转场、在星球视图时收起来
  private place(): void {
    const world = this.world;
    // 团队列表变了（编辑器存了、换了数据）：增删名牌，团队数据换了就重填
    let changed = false;
    for (const e of world.planets.values()) {
      const tag = this.tags.get(e.team.id);
      if (!tag) {
        this.tags.set(e.team.id, this.build(e));
        changed = true;
      } else if (tag.team !== e.team || tag.entry !== e) {
        tag.entry = e;
        this.fill(tag);
        changed = true;
      }
    }
    for (const [id, tag] of this.tags) {
      if (world.planets.get(id) !== tag.entry) {
        tag.el.remove();
        this.tags.delete(id);
        changed = true;
      }
    }
    if (changed) this.sortTags();
    const show = this.enabled && !world.focused && !world.rig.flying && !world.director.busy;
    if (show !== this.shown) {
      this.shown = show;
      this.layer.classList.toggle('is-shown', show);
    }
    if (!show) return;
    if (!this.measured) {
      this.measured = true;
      // 量一次大小（只在字体到了、窗口变了、名牌重填以后）：读布局放在写 transform 之前
      for (const t of this.order) {
        t.w = t.el.offsetWidth;
        t.h = t.el.offsetHeight;
      }
    }
    const hovered = world.hovered;
    const placed = this.placed;
    placed.length = 0;
    // 悬停的那张先摆（一直显示），其余按优先级：叠在一起时排在后面的藏起来
    const first = hovered ? this.tags.get(hovered.team.id) : undefined;
    if (first) this.put(first, true, placed);
    for (const t of this.order) if (t !== first) this.put(t, false, placed);
  }

  private put(t: Tag, hover: boolean, placed: Tag[]): void {
    const ok = this.world.planetOnScreen(t.entry, _c);
    t.x = _c.x;
    t.y = _c.y + _c.r * 1.02 + 6;
    let free = ok;
    if (free && !hover) {
      for (const o of placed) {
        if (Math.abs(o.x - t.x) < (o.w + t.w) / 2 + 4 && Math.abs(o.y - t.y) < (o.h + t.h) / 2 + 2) {
          free = false;
          break;
        }
      }
    }
    if (free) placed.push(t);
    if (t.shown !== free) {
      t.shown = free;
      t.el.classList.toggle('is-off', !free);
    }
    if (t.el.classList.contains('is-hover') !== hover) t.el.classList.toggle('is-hover', hover);
    const x = Math.round((t.x - t.w / 2) * 10) / 10;
    const y = Math.round(t.y * 10) / 10;
    if (x !== t.tx || y !== t.ty) {
      t.tx = x;
      t.ty = y;
      t.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
  }
}
