import './createPlanet.css';
import type { App, CreatorLayer } from '../app';
import type { PlanetStore } from '../data/store';
import type { PresetId, Team } from '../data/types';
import { PRESETS, PRESET_IDS } from '../planet/presets';
import { BURST, BurstFx } from './createPlanetBurst';
import { LaunchWarmer, replayBurst, riseIntoGalaxy, worldDelay, type LaunchState } from './createPlanetLaunch';
import { setBurstReplay } from './createPlanetTune';
import { buildTeam, charCount, checkFriend, checkMotto, checkName, DEFAULT_MOTTO, inviteLink, LIMITS, newDraft, PRESET_BLURBS, randomSeed, teamIdFor, TEAM_COLORS, type Captain, type Check, type Draft } from './createPlanetModel';
import { PlanetPreview } from './createPlanetPreview';
import { el, initials } from './dom';
import { setCreatePlanet } from './home';
import { icon } from './icons';
import { activeElement, animate, curve, EASE_IN, EASE_OUT, finished, focusQuietly, Presence, reducedMotion } from './motion';
import { inkOn } from './sheet';
import { toast } from './toast';

// 「建一颗星球」（P3）：首页的「Create a planet」按钮、#/create 地址、分四步的造星窗口（起名 → 选样子 → 邀请朋友 → Launch）。
// 窗口盖在星系上（主画面照常跑），右边一个小画布实时预览这颗星球（createPlanetPreview.ts）。点 Launch：存进本地（LocalStore.createTeam）、
// 窗口收起、小星球「掉进云里」，主画面里新星球从云海升起来、镜头跟过去，然后进这颗星球（createPlanetLaunch.ts）。
// 每个浏览器只能建一颗：建过以后按钮变成「Visit your planet」，#/create 直接带你去那颗星球。
// 动效只动 transform / opacity；减弱动效时一律淡入淡出。整个窗口只用键盘也能走完（Tab 在窗口里循环、Enter 下一步、Esc 关）。
// 入口是首页标题卡片里的「Create a planet」（H2 的按钮，ui/home.ts 的 setCreatePlanet 接到 openCreatePlanet）；建过以后藏起来，
// 「Visit your planet」去你建的那颗（App.addTeam 把它设成你的星球）。
// 给脚本的：窗口 section.creator，window.__create（状态、预览的开销）

const STEPS = [
  { id: 'name', label: 'Name', title: 'Name your planet', lead: 'This is how your team shows up in the galaxy.' },
  { id: 'look', label: 'Look', title: 'Pick its look', lead: 'Choose a world, a team colour, and roll the terrain until it feels like home.' },
  { id: 'crew', label: 'Friends', title: 'Invite your crew', lead: 'Share the link, or add friends by nickname. Flying solo is fine too.' },
  { id: 'launch', label: 'Launch', title: 'Ready for liftoff', lead: 'Your planet rises out of the clouds and takes its place in the galaxy. Then it is yours to decorate.' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

const NAME_IDEAS = ['Star Sprouts', 'Pebble Party', 'Moonlit Makers', 'Tiny Orbit Co.', 'Cloud Carvers', 'Lantern Bay', 'Mossy Moons', 'Polygon Picnic', 'Comet Crafts', 'Sleepy Volcano'];

// 自查脚本用（scripts/check-create.mjs）
declare global {
  interface Window {
    __create?: {
      state(): { open: boolean; step: string; launching: boolean; launch: LaunchState; previewReady: boolean; twinReady: boolean };
      preview(): PlanetPreview['stats'];
    };
  }
}

let installed: CreatePlanet | null = null;

// 打开造星窗口（首页的按钮、别的入口都调它）：建过星球的直接去那颗星球
export function openCreatePlanet(): void {
  installed?.request();
}

// main.ts 调一次（在 installHome 之后）：装上窗口，接到 App（#/create）和首页的「Create a planet」。队长就是演示身份（seed.you）那个成员
export function installCreatePlanet(app: App, store: PlanetStore): CreatePlanet {
  const me = app.teams.flatMap((t) => t.members).find((m) => m.id === app.you.memberId);
  installed = new CreatePlanet(app, store, { memberId: app.you.memberId, handle: me?.handle ?? 'you', displayName: me?.displayName ?? 'You' });
  app.creator = installed;
  setCreatePlanet(openCreatePlanet); // 首页标题卡片里的「Create a planet」（H2，ui/home.ts）点了走这里
  return installed;
}

export class CreatePlanet implements CreatorLayer {
  private readonly app: App;
  private readonly store: PlanetStore;
  private readonly captain: Captain;
  private readonly node = el('section', { className: 'creator' });
  private readonly presence = new Presence(this.node);
  private readonly backdrop = el('div', { className: 'cp-backdrop' });
  private readonly card = el('div', { className: 'cp-card' });
  private readonly stepButtons: HTMLButtonElement[] = [];
  private readonly pages: HTMLElement[] = [];
  private readonly stage = el('aside', { className: 'cp-stage' });
  private readonly plate = el('div', { className: 'cp-plate' });
  private readonly plateName = el('span', { className: 'cp-plate-name display' });
  private readonly plateMotto = el('span', { className: 'cp-plate-motto' });
  private readonly backButton = el('button', { className: 'cp-back', type: 'button' }, icon('arrow', 'cp-back-icon'), 'Back');
  private readonly nextButton = el('button', { className: 'primary cp-next', type: 'button' });
  private readonly counter = el('span', { className: 'cp-progress mono' });
  private readonly live = el('p', { className: 'cp-live' });
  private readonly preview: PlanetPreview;
  private readonly burst = new BurstFx(); // 星球冲出来时的云、光、冲击环、星星（createPlanetBurst.ts）
  private readonly warmer: LaunchWarmer; // 样子定下来以后，主画面的渲染器里先把新星球独有的着色器备好（Launch 时不卡）
  private burstReady: Promise<void> | null = null;
  // 第一步
  private readonly nameInput = el('input', { className: 'cp-input', id: 'cp-name', type: 'text', maxLength: LIMITS.nameMax, autocomplete: 'off', spellcheck: false, placeholder: 'e.g. Star Sprouts' });
  private readonly nameCount = el('span', { className: 'cp-count' });
  private readonly nameHint = el('p', { className: 'cp-hint', id: 'cp-name-hint' });
  private readonly mottoInput = el('input', { className: 'cp-input', id: 'cp-motto', type: 'text', maxLength: LIMITS.mottoMax, autocomplete: 'off', placeholder: DEFAULT_MOTTO });
  private readonly mottoCount = el('span', { className: 'cp-count' });
  private readonly mottoHint = el('p', { className: 'cp-hint', id: 'cp-motto-hint' });
  private readonly ideas = el('div', { className: 'cp-ideas' });
  // 第二步
  private readonly presetInputs = new Map<PresetId, HTMLInputElement>();
  private readonly colorInputs = new Map<string, HTMLInputElement>();
  private readonly customColor = el('input', { type: 'color', className: 'cp-custom-input' });
  private readonly customRadio = el('input', { type: 'radio', name: 'cp-color', value: 'custom', className: 'cp-radio' });
  private readonly ringInput = el('input', { type: 'checkbox', className: 'cp-switch-input' });
  private readonly rerollButton = el('button', { className: 'cp-reroll', type: 'button' }, icon('flip'), 'Reroll terrain');
  // 第三步
  private readonly linkInput = el('input', { className: 'cp-input cp-link-input', type: 'text', readOnly: true });
  private readonly copyButton = el('button', { className: 'cp-copy', type: 'button' });
  private readonly friendInput = el('input', { className: 'cp-input', id: 'cp-friend', type: 'text', maxLength: LIMITS.friendMax, autocomplete: 'off', placeholder: 'Nickname' });
  private readonly friendHint = el('p', { className: 'cp-hint', id: 'cp-friend-hint' });
  private readonly crewList = el('ul', { className: 'cp-crew' });
  // 第四步
  private readonly summary = el('div', { className: 'cp-summary' });

  private draft: Draft = newDraft();
  private step = 0;
  private tried = [false, false, false, false]; // 这一步点过 Next：之后才显示错误（打字过程中不催）
  private open_ = false;
  private launching = false;
  private returnFocus: HTMLElement | null = null;
  private copyToken = 0; // 复制后「Copied!」过一会儿变回去：每复制一次加一，晚到的不算
  readonly launchState: LaunchState = { phase: 'wait', t: 0 };
  private readonly onKey = (e: KeyboardEvent) => this.key(e);

  constructor(app: App, store: PlanetStore, captain: Captain) {
    this.app = app;
    this.store = store;
    this.captain = captain;
    this.preview = new PlanetPreview(app.world);
    this.warmer = new LaunchWarmer(app.world);
    // ?tune → Create → Replay：你的星球在首页上再冲出来一次（调手感用）
    setBurstReplay(() => void replayBurst(app, this.burst, this.launchState).then((ok) => { if (!ok) toast('Replay works on the galaxy view'); }));
    this.buildWindow();
    app.root.append(this.node);
    this.syncCreateButton();
    window.__create = {
      state: () => ({ open: this.open_, step: STEPS[this.step].id, launching: this.launching, launch: { ...this.launchState }, previewReady: this.preview.ready, twinReady: this.warmer.ready }),
      preview: () => ({ ...this.preview.stats, gpu: [...this.preview.stats.gpu], twin: { ...this.warmer.stats } }),
    };
  }

  // —— 入口 ——

  private mine(): Team | undefined {
    return this.app.teams.find((t) => t.createdByYou);
  }

  // 首页标题卡片里的「Create a planet」（H2 的按钮）：建过以后藏起来——每个浏览器只能建一颗，「Visit your planet」已经去你建的那颗了
  private syncCreateButton(): void {
    const bar = this.app.topbar;
    if (!this.mine() || !bar.onCreate) return;
    bar.onCreate = null;
    bar.refreshVisit();
  }

  // 按钮、openCreatePlanet：建过的直接去那颗星球，没建过开 #/create
  request(): void {
    const mine = this.mine();
    if (mine) this.app.navigate({ view: 'planet', teamId: mine.id });
    else this.app.navigate({ view: 'create' });
  }

  // —— App 调：#/create 打开，别的地址关掉 ——

  open(): void {
    if (this.launching) return;
    const mine = this.mine();
    if (mine) {
      // 已经有一颗了（每个浏览器只能建一颗）：直接带去那颗星球
      toast(`You already have a planet: ${mine.name}`);
      this.app.navigate({ view: 'planet', teamId: mine.id }, { replace: true });
      return;
    }
    if (this.open_) return;
    this.open_ = true;
    this.returnFocus = activeElement();
    this.node.dataset.step = STEPS[this.step].id;
    this.refreshAll();
    this.preview.start();
    this.presence.show(() => this.enter());
    addEventListener('keydown', this.onKey);
    this.focusStep();
  }

  close(): void {
    if (!this.open_ || this.launching) return;
    this.open_ = false;
    removeEventListener('keydown', this.onKey);
    const back = this.returnFocus;
    this.returnFocus = null;
    void this.presence.hide(() => this.exit()).then(() => { if (!this.open_) this.preview.stop(); });
    focusQuietly(back?.isConnected ? back : null);
  }

  // 用户点关闭、按 Esc、点窗口外面：回星系（换掉 #/create 这条记录，后退不会又弹出来）。草稿留着，下次打开接着填
  private requestClose(): void {
    if (this.launching) return;
    this.app.navigate({ view: 'galaxy' }, { replace: true });
  }

  // —— 窗口 ——

  private buildWindow(): void {
    this.node.hidden = true;
    this.node.setAttribute('role', 'dialog');
    this.node.setAttribute('aria-modal', 'true');
    this.node.setAttribute('aria-labelledby', 'cp-title');
    this.backdrop.addEventListener('click', () => this.requestClose());
    const close = el('button', { className: 'cp-close', type: 'button', title: 'Close (Esc)' }, icon('close'));
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.requestClose());
    const head = el('header', { className: 'cp-head' },
      el('div', { className: 'cp-titles' }, el('span', { className: 'cp-tag', textContent: 'New planet' }), el('h1', { className: 'display', id: 'cp-title', textContent: 'Build a planet' })),
      close,
    );
    const steps = el('ol', { className: 'cp-steps' });
    steps.setAttribute('aria-label', 'Steps');
    STEPS.forEach((s, i) => {
      const b = el('button', { className: 'cp-step', type: 'button', dataset: { step: s.id } }, el('span', { className: 'cp-step-dot' }), el('span', { className: 'cp-step-label', textContent: s.label }));
      b.addEventListener('click', () => this.jump(i));
      this.stepButtons.push(b);
      steps.append(el('li', {}, b));
    });
    this.pages.push(this.namePage(), this.lookPage(), this.crewPage(), this.launchPage());
    for (const p of this.pages) p.hidden = true;
    this.stage.append(this.preview.element, this.plate, this.rerollButton);
    this.plate.append(el('i', { className: 'cp-plate-dot' }), el('span', { className: 'cp-plate-text' }, this.plateName, this.plateMotto));
    this.rerollButton.addEventListener('click', () => this.reroll());
    this.backButton.addEventListener('click', () => this.go(this.step - 1));
    this.nextButton.addEventListener('click', () => (this.step === STEPS.length - 1 ? void this.launch() : this.next()));
    this.live.setAttribute('aria-live', 'polite');
    this.card.append(
      head,
      steps,
      el('div', { className: 'cp-body' }, el('div', { className: 'cp-pages' }, ...this.pages), this.stage),
      el('footer', { className: 'cp-foot' }, this.backButton, this.counter, this.nextButton),
      this.live,
    );
    this.node.append(this.backdrop, this.card);
  }

  private page(id: StepId, ...content: Array<Node | string>): HTMLElement {
    const s = STEPS.find((x) => x.id === id)!;
    const h = el('h2', { className: 'cp-h display', textContent: s.title, id: `cp-h-${id}` });
    const sec = el('section', { className: 'cp-page', dataset: { page: id } }, h, el('p', { className: 'cp-lead', textContent: s.lead }), ...content);
    sec.setAttribute('aria-labelledby', h.id);
    return sec;
  }

  // 第一步：团队名 + 口号（字数、提示），没想好名字时给几个点子
  private namePage(): HTMLElement {
    const field = (label: string, input: HTMLInputElement, count: HTMLElement, hint: HTMLElement, optional = false) => {
      input.setAttribute('aria-describedby', hint.id);
      const l = el('label', { className: 'cp-label', htmlFor: input.id }, label);
      if (optional) l.append(el('span', { className: 'cp-optional', textContent: 'optional' }));
      return el('div', { className: 'cp-field' }, l, el('div', { className: 'cp-input-wrap' }, input, count), hint);
    };
    this.nameInput.addEventListener('input', () => {
      this.draft.name = this.nameInput.value;
      this.refreshName();
    });
    this.mottoInput.addEventListener('input', () => {
      this.draft.motto = this.mottoInput.value;
      this.refreshName();
    });
    for (const input of [this.nameInput, this.mottoInput]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          if (input === this.nameInput && this.draft.name.trim() && !this.mottoInput.value) focusQuietly(this.mottoInput);
          else this.next();
        }
      });
    }
    return this.page('name',
      field('Team name', this.nameInput, this.nameCount, this.nameHint),
      field('Motto', this.mottoInput, this.mottoCount, this.mottoHint, true),
      this.ideas,
    );
  }

  // 没想好名字：三个点子，点一下填进去
  private refreshIdeas(): void {
    const taken = this.app.teams.map((t) => t.name);
    const pool = NAME_IDEAS.filter((n) => checkName(n, taken).ok).sort(() => Math.random() - 0.5).slice(0, 3);
    this.ideas.replaceChildren(el('span', { className: 'cp-ideas-label', textContent: 'Need ideas?' }), ...pool.map((n, i) => {
      const b = el('button', { className: 'cp-idea', type: 'button', textContent: n });
      b.style.setProperty('--i', String(i));
      b.addEventListener('click', () => {
        this.nameInput.value = n;
        this.draft.name = n;
        this.refreshName();
        this.bump(this.plate);
        focusQuietly(this.nameInput);
      });
      return b;
    }));
  }

  // 第二步：五种星球、团队色（八种 + 自选）、石头带；右边的 Reroll 换地形
  private lookPage(): HTMLElement {
    const presets = el('div', { className: 'cp-presets', role: 'radiogroup' });
    presets.setAttribute('aria-label', 'Planet type');
    for (const id of PRESET_IDS) {
      const input = el('input', { type: 'radio', name: 'cp-preset', value: id, className: 'cp-radio' });
      input.addEventListener('change', () => { if (input.checked) this.setLook({ preset: id }); });
      this.presetInputs.set(id, input);
      const g = PRESETS[id].ground;
      const swatch = el('span', { className: 'cp-preset-swatch' });
      swatch.style.setProperty('--a', g.field);
      swatch.style.setProperty('--b', g.far);
      swatch.style.setProperty('--c', PRESETS[id].water === '#000000' ? g.sand : PRESETS[id].water);
      presets.append(el('label', { className: 'cp-preset' }, input, swatch, el('span', { className: 'cp-preset-text' }, el('b', { textContent: PRESETS[id].label }), el('small', { textContent: PRESET_BLURBS[id] }))));
    }
    const colors = el('div', { className: 'cp-colors', role: 'radiogroup' });
    colors.setAttribute('aria-label', 'Team colour');
    for (const c of TEAM_COLORS) {
      const input = el('input', { type: 'radio', name: 'cp-color', value: c.hex, className: 'cp-radio' });
      input.setAttribute('aria-label', c.name);
      input.addEventListener('change', () => { if (input.checked) this.setLook({ color: c.hex }); });
      this.colorInputs.set(c.hex, input);
      const dot = el('span', { className: 'cp-color-dot' });
      dot.style.setProperty('--c', c.hex);
      colors.append(el('label', { className: 'cp-color', title: c.name }, input, dot));
    }
    // 自选颜色：一个圆点（选中自选时显示选的颜色），点它弹出系统的取色器
    this.customRadio.setAttribute('aria-label', 'Custom colour');
    this.customColor.setAttribute('aria-label', 'Pick a custom colour');
    const customDot = el('span', { className: 'cp-color-dot custom' }, icon('palette'));
    this.customRadio.addEventListener('change', () => { if (this.customRadio.checked) this.setLook({ color: this.customColor.value }); });
    this.customColor.addEventListener('input', () => {
      this.customRadio.checked = true;
      this.setLook({ color: this.customColor.value });
    });
    colors.append(el('label', { className: 'cp-color', title: 'Custom' }, this.customRadio, customDot, this.customColor));
    this.ringInput.addEventListener('change', () => this.setLook({ ring: this.ringInput.checked }));
    const ring = el('label', { className: 'cp-switch' }, this.ringInput, el('span', { className: 'cp-switch-track' }, el('i')), el('span', { textContent: 'Rock ring' }));
    return this.page('look',
      el('div', { className: 'cp-group' }, el('div', { className: 'cp-label', textContent: 'Planet type' }), presets),
      el('div', { className: 'cp-group' }, el('div', { className: 'cp-label', textContent: 'Team colour' }), colors),
      el('div', { className: 'cp-group cp-row' }, ring),
    );
  }

  // 第三步：邀请链接（假的）+ 复制；按昵称加好友（可以不加）
  private crewPage(): HTMLElement {
    this.copyButton.addEventListener('click', () => void this.copyLink());
    this.linkInput.setAttribute('aria-label', 'Invite link');
    this.linkInput.addEventListener('focus', () => this.linkInput.select());
    this.friendInput.setAttribute('aria-describedby', this.friendHint.id);
    const add = el('button', { className: 'cp-add', type: 'button' }, icon('star'), 'Add');
    add.addEventListener('click', () => this.addFriend());
    this.friendInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        if (this.friendInput.value.trim()) this.addFriend();
        else this.next();
      }
    });
    this.friendInput.addEventListener('input', () => { this.friendHint.textContent = ''; delete this.friendHint.dataset.tone; });
    const friendLabel = el('label', { className: 'cp-label', htmlFor: 'cp-friend' }, 'Add friends by nickname', el('span', { className: 'cp-optional', textContent: 'optional' }));
    return this.page('crew',
      el('div', { className: 'cp-field' },
        el('div', { className: 'cp-label', textContent: 'Invite link' }),
        el('div', { className: 'cp-link' }, this.linkInput, this.copyButton),
        el('p', { className: 'cp-hint', textContent: 'A demo link: planets live in this browser for now, so it only opens here.' }),
      ),
      el('div', { className: 'cp-field' }, friendLabel, el('div', { className: 'cp-add-row' }, this.friendInput, add), this.friendHint),
      this.crewList,
    );
  }

  // 第四步：总结一下，Launch
  private launchPage(): HTMLElement {
    return this.page('launch', this.summary);
  }

  // —— 每一步的内容 ——

  private refreshAll(): void {
    this.nameInput.value = this.draft.name;
    this.mottoInput.value = this.draft.motto;
    this.refreshIdeas();
    this.refreshName();
    this.presetInputs.get(this.draft.preset)!.checked = true;
    const known = this.colorInputs.get(this.draft.color);
    if (known) known.checked = true;
    else {
      this.customColor.value = this.draft.color;
      this.customRadio.checked = true;
    }
    this.ringInput.checked = this.draft.ring;
    this.refreshLookUi();
    this.refreshCrew();
    this.refreshStepper();
    this.preview.set(this.look());
    for (const [i, p] of this.pages.entries()) p.hidden = i !== this.step;
  }

  private look() {
    const d = this.draft;
    return { preset: d.preset, color: d.color, seed: d.seed, ring: d.ring };
  }

  private nameCheck(): Check {
    return checkName(this.draft.name, this.app.teams.map((t) => t.name));
  }

  // 名字、口号：字数、提示（点过 Next 以后才显示错误）、预览下面的名牌
  private refreshName(): void {
    const name = this.nameCheck();
    const motto = checkMotto(this.draft.motto);
    const nLen = charCount(this.draft.name.trim());
    this.nameCount.textContent = `${nLen}/${LIMITS.nameMax}`;
    this.nameCount.dataset.tone = nLen > LIMITS.nameMax - 4 ? 'near' : '';
    this.mottoCount.textContent = `${charCount(this.draft.motto.trim())}/${LIMITS.mottoMax}`;
    const showName = this.tried[0] || (!name.ok && nLen >= LIMITS.nameMin);
    this.hint(this.nameHint, name.ok ? `Short and sweet reads best on your name plate. ${LIMITS.nameMin}–${LIMITS.nameMax} characters.` : name.message, !name.ok && showName);
    this.hint(this.mottoHint, motto.ok ? 'One line about what your team makes.' : motto.message, !motto.ok);
    this.nameInput.setAttribute('aria-invalid', String(!name.ok && showName));
    this.plateName.textContent = this.draft.name.trim() || 'Your planet';
    this.plateMotto.textContent = this.draft.motto.trim() || DEFAULT_MOTTO;
    this.plate.dataset.empty = String(!this.draft.name.trim());
    this.syncPlate();
  }

  private hint(node: HTMLElement, text: string, error: boolean): void {
    node.textContent = text;
    if (error) node.dataset.tone = 'error';
    else delete node.dataset.tone;
  }

  private syncPlate(): void {
    this.plate.style.setProperty('--team', this.draft.color);
    this.stage.style.setProperty('--team', this.draft.color);
    this.stage.style.setProperty('--team-ink', inkOn(this.draft.color));
  }

  // 选样子：草稿改了，预览跟着换（同一颗只改颜色时是渐变）
  private setLook(patch: Partial<Pick<Draft, 'preset' | 'color' | 'ring' | 'seed'>>): void {
    Object.assign(this.draft, patch);
    this.refreshLookUi();
    this.syncPlate();
    this.preview.set(this.look());
    if (patch.color) this.bump(this.plate.querySelector('.cp-plate-dot'));
    if (patch.preset) this.bump(this.presetInputs.get(patch.preset)?.parentElement ?? null);
  }

  private refreshLookUi(): void {
    for (const [hex, input] of this.colorInputs) input.parentElement!.dataset.on = String(hex === this.draft.color && input.checked);
    this.customRadio.parentElement!.dataset.on = String(this.customRadio.checked);
    this.customRadio.parentElement!.style.setProperty('--c', this.customColor.value);
  }

  private reroll(): void {
    this.preview.puff();
    this.setLook({ seed: randomSeed() });
    this.say('New terrain rolled');
    if (!reducedMotion()) animate(this.rerollButton.querySelector('.icon'), [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-360deg)' }], { duration: 600, easing: EASE_OUT });
  }

  private teamId(): string {
    return teamIdFor(this.draft.name, this.app.teams.map((t) => t.id));
  }

  private link(): string {
    return inviteLink(`${location.origin}${location.pathname}`, this.teamId(), this.draft.invite);
  }

  private refreshCrew(): void {
    this.linkInput.value = this.link();
    this.setCopyLabel(false);
    const you = el('li', { className: 'cp-member you' }, this.avatar(this.captain.displayName), el('span', { className: 'cp-member-name' }, el('b', { textContent: this.captain.displayName }), el('small', { textContent: 'Captain · you' })));
    const friends = this.draft.friends.map((f, i) => {
      const remove = el('button', { className: 'cp-remove', type: 'button', title: `Remove ${f}` }, icon('close'));
      remove.setAttribute('aria-label', `Remove ${f}`);
      remove.addEventListener('click', () => this.removeFriend(i));
      return el('li', { className: 'cp-member', dataset: { friend: f } }, this.avatar(f), el('span', { className: 'cp-member-name' }, el('b', { textContent: f }), el('small', { textContent: 'Builder' })), remove);
    });
    this.crewList.replaceChildren(you, ...friends);
    this.crewList.setAttribute('aria-label', `Crew: ${1 + this.draft.friends.length} ${this.draft.friends.length ? 'members' : 'member'}`);
  }

  private avatar(name: string): HTMLElement {
    const a = el('span', { className: 'cp-avatar', textContent: initials(name.replace(/^@/, '')) });
    a.style.background = this.draft.color;
    a.style.color = inkOn(this.draft.color);
    return a;
  }

  private addFriend(): void {
    const nick = this.friendInput.value;
    const c = checkFriend(nick, this.draft.friends, this.captain.handle);
    if (!c.ok) {
      this.hint(this.friendHint, c.message, true);
      this.shake(this.friendInput);
      return;
    }
    const name = nick.trim().replace(/\s+/g, ' ');
    this.draft.friends.push(name);
    this.friendInput.value = '';
    this.hint(this.friendHint, `${name} is on the crew.`, false);
    this.refreshCrew();
    this.say(`${name} added to your crew`);
    const li = this.crewList.lastElementChild;
    if (li && !reducedMotion()) animate(li, [{ opacity: 0, transform: 'translateY(10px) scale(0.8) rotate(-3deg)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: curve('bounce') });
    focusQuietly(this.friendInput);
  }

  private removeFriend(i: number): void {
    const name = this.draft.friends[i];
    const li = this.crewList.children[i + 1] as HTMLElement | undefined;
    const done = () => {
      this.draft.friends.splice(i, 1);
      this.refreshCrew();
      this.say(`${name} removed`);
      focusQuietly(this.friendInput);
    };
    const a = li && !reducedMotion() ? animate(li, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.7)' }], { duration: 160, easing: EASE_IN, fill: 'forwards' }) : null;
    if (a) void finished([a]).then(done);
    else done();
  }

  private setCopyLabel(copied: boolean): void {
    this.copyButton.replaceChildren(icon(copied ? 'check' : 'clipboard'), copied ? 'Copied!' : 'Copy link');
    this.copyButton.dataset.copied = String(copied);
  }

  // 复制邀请链接：剪贴板接口不能用时（权限、不安全的地址）选中文字、试一下旧的 execCommand，都不行就提示按 Ctrl+C
  private async copyLink(): Promise<void> {
    const text = this.linkInput.value;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      this.linkInput.focus();
      this.linkInput.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
    }
    const token = ++this.copyToken;
    if (ok) {
      this.setCopyLabel(true);
      this.say('Invite link copied');
      if (!reducedMotion()) animate(this.copyButton, [{ transform: 'scale(1)' }, { transform: 'scale(1.12) rotate(-3deg)', offset: 0.35 }, { transform: 'scale(1)' }], { duration: 480, easing: EASE_OUT });
      void worldDelay(this.app.world, 2.2).then(() => { if (token === this.copyToken) this.setCopyLabel(false); });
    } else {
      this.say('Press Ctrl+C to copy the link');
      toast('Press Ctrl+C (or Cmd+C) to copy the link');
    }
  }

  private refreshSummary(): void {
    const d = this.draft;
    const colorName = TEAM_COLORS.find((c) => c.hex === d.color)?.name ?? 'Custom';
    const crew = 1 + d.friends.length;
    const swatch = el('i', { className: 'cp-fact-swatch' });
    swatch.style.setProperty('--c', d.color);
    const card = el('div', { className: 'cp-ticket' },
      el('span', { className: 'cp-ticket-tag', textContent: 'Boarding pass' }),
      el('div', { className: 'cp-ticket-name display', textContent: d.name.trim() }),
      el('div', { className: 'cp-ticket-motto', textContent: d.motto.trim() || DEFAULT_MOTTO }),
      el('ul', { className: 'cp-facts' },
        el('li', {}, icon('planet'), `${PRESETS[d.preset].label} planet`),
        el('li', {}, swatch, `${colorName} team colour`),
        el('li', {}, icon('orbit'), d.ring ? 'Rock ring' : 'No ring'),
        el('li', {}, icon('star'), `${crew} ${crew === 1 ? 'crew member' : 'crew members'}`),
      ),
      el('div', { className: 'cp-ticket-crew' }, ...[this.captain.displayName, ...d.friends].map((n) => this.avatar(n))),
    );
    card.style.setProperty('--team', d.color);
    this.summary.replaceChildren(card, el('p', { className: 'cp-hint', textContent: 'Tip: after landing, press Edit and drop a .glb file onto the page to place your own work.' }));
  }

  // —— 换步 ——

  private valid(i: number): Check {
    if (i === 0) {
      const n = this.nameCheck();
      return n.ok ? checkMotto(this.draft.motto) : n;
    }
    return { ok: true, message: '' };
  }

  private next(): void {
    const c = this.valid(this.step);
    if (!c.ok) {
      this.tried[this.step] = true;
      this.refreshName();
      const bad = this.nameCheck().ok ? this.mottoInput : this.nameInput;
      this.shake(bad);
      focusQuietly(bad);
      this.say(c.message);
      return;
    }
    this.go(this.step + 1);
  }

  // 点上面的步骤：往回随便点，往前要前面的都填好
  private jump(i: number): void {
    if (i === this.step || this.launching) return;
    for (let k = 0; k < i; k++) {
      if (!this.valid(k).ok) {
        if (k !== this.step) this.go(k);
        this.next();
        return;
      }
    }
    this.go(i);
  }

  private go(i: number): void {
    if (i < 0 || i >= STEPS.length || i === this.step || this.launching) return;
    const from = this.pages[this.step];
    const to = this.pages[i];
    const forward = i > this.step;
    this.step = i;
    this.node.dataset.step = STEPS[i].id;
    if (STEPS[i].id === 'crew') this.refreshCrew();
    // 离开「选样子」：预览不再在后台备别的预设；样子定了，主画面里先把这颗星球的着色器备好（见 LaunchWarmer）
    this.preview.pauseWarm(i !== 1);
    // 冲出来用的云团、光、冲击环、星星：第二、三步时在主画面的渲染器里预编译（不挤在打开窗口那一下）
    if (i >= 1) this.burstReady ??= this.burst.prepare(this.app.world).catch(() => {});
    if (i >= 2) void this.warmer.warm(this.look());
    if (STEPS[i].id === 'launch') this.refreshSummary();
    this.refreshStepper();
    this.swapPages(from, to, forward);
    this.say(`Step ${i + 1} of ${STEPS.length}: ${STEPS[i].title}`);
    this.focusStep();
  }

  // 换页：旧的一页往外滑走、新的从另一边带一点弹性滑进来（减弱动效时淡入淡出）。只动 transform / opacity
  private swapPages(from: HTMLElement, to: HTMLElement, forward: boolean): void {
    const reduce = reducedMotion();
    for (const a of from.getAnimations?.() ?? []) a.cancel();
    from.hidden = true;
    to.hidden = false;
    const dx = forward ? 1 : -1;
    animate(to, reduce
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, transform: `translateX(${46 * dx}px) rotate(${1.2 * dx}deg)` }, { opacity: 1, transform: 'none' }],
    { duration: reduce ? 180 : 560, easing: reduce ? 'ease-out' : curve('spring') });
    if (!reduce) {
      // 这一页的内容依次跟进来（标题、说明、各个字段）
      [...to.children].forEach((c, k) => {
        if (k === 0) return;
        animate(c, [{ opacity: 0, transform: `translateX(${22 * dx}px)` }, { opacity: 1, transform: 'none' }], { duration: 480, delay: 50 + k * 45, easing: EASE_OUT, fill: 'backwards' });
      });
    }
  }

  private refreshStepper(): void {
    const last = this.step === STEPS.length - 1;
    this.stepButtons.forEach((b, i) => {
      const done = i < this.step;
      b.dataset.state = i === this.step ? 'now' : done ? 'done' : 'todo';
      if (i === this.step) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
      b.setAttribute('aria-label', `Step ${i + 1}: ${STEPS[i].label}${done ? ' (done)' : ''}`);
      b.querySelector('.cp-step-dot')!.replaceChildren(done ? icon('check') : String(i + 1));
    });
    const now = this.stepButtons[this.step];
    if (now && this.open_ && !reducedMotion()) animate(now.querySelector('.cp-step-dot'), [{ transform: 'scale(0.6)' }, { transform: 'scale(1)' }], { duration: 520, easing: curve('bounce') });
    this.backButton.hidden = this.step === 0;
    this.counter.textContent = `Step ${this.step + 1} of ${STEPS.length}`;
    this.nextButton.replaceChildren(...(last ? [icon('sparkle'), 'Launch'] : ['Next', icon('arrow')]));
    this.nextButton.dataset.launch = String(last);
  }

  // 这一步该先拿到焦点的东西
  private focusStep(): void {
    const id = STEPS[this.step].id;
    const target =
      id === 'name' ? this.nameInput
      : id === 'look' ? this.presetInputs.get(this.draft.preset) ?? null
      : id === 'crew' ? this.copyButton
      : this.nextButton;
    // 马上给：这一页已经显示出来了（进场动画只动 transform / opacity）。晚一帧再给的话，紧跟着的按键会落到上一步的按钮上
    focusQuietly(target);
  }

  // —— 键盘：Esc 关，Tab 在窗口里循环 ——
  private key(e: KeyboardEvent): void {
    if (!this.open_) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.requestClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...this.card.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.closest('[hidden]') && !(x as HTMLButtonElement).disabled && x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const a = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (a === first || !this.card.contains(a))) {
      e.preventDefault();
      focusQuietly(last);
    } else if (!e.shiftKey && (a === last || !this.card.contains(a))) {
      e.preventDefault();
      focusQuietly(first);
    }
  }

  // —— 动效小工具 ——
  private bump(n: Element | null): void {
    if (!n || reducedMotion()) return;
    animate(n, [{ transform: 'scale(1)' }, { transform: 'scale(1.16)', offset: 0.3 }, { transform: 'scale(1)' }], { duration: 420, easing: EASE_OUT, composite: 'add' });
  }

  private shake(n: Element): void {
    if (reducedMotion()) return;
    animate(n, [{ transform: 'none' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(2px)' }, { transform: 'none' }], { duration: 380, easing: 'ease-out' });
  }

  private say(text: string): void {
    this.live.textContent = text;
  }

  // 进场：背景淡入，纸卡从下面带一点倾斜弹上来，步骤贴纸、预览依次跟上
  private enter(): Array<Animation | null> {
    const list: Array<Animation | null> = [animate(this.backdrop, [{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' })];
    if (reducedMotion()) {
      list.push(animate(this.card, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' }));
      return list;
    }
    list.push(
      animate(this.card, [{ opacity: 0, transform: 'translateY(42px) scale(0.92) rotate(-1.5deg)' }, { opacity: 1, transform: 'none' }], { duration: 640, easing: curve('spring') }),
      animate(this.stage, [{ opacity: 0, transform: 'scale(0.85) rotate(4deg)' }, { opacity: 1, transform: 'none' }], { duration: 700, delay: 160, easing: curve('spring'), fill: 'backwards' }),
      ...this.stepButtons.map((b, i) => animate(b, [{ opacity: 0, transform: 'translateY(-10px) scale(0.8)' }, { opacity: 1, transform: 'none' }], { duration: 480, delay: 220 + i * 60, easing: curve('bounce'), fill: 'backwards' })),
    );
    return list;
  }

  private exit(): Array<Animation | null> {
    const reduce = reducedMotion();
    return [
      animate(this.backdrop, [{ opacity: 1 }, { opacity: 0 }], { duration: reduce ? 180 : 300, easing: 'ease-in', fill: 'forwards' }),
      animate(this.card, reduce ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(26px) scale(0.95)' }], { duration: reduce ? 180 : 260, easing: EASE_IN, fill: 'forwards' }),
    ];
  }

  // —— Launch ——

  private async launch(): Promise<void> {
    if (this.launching) return;
    for (let i = 0; i < STEPS.length - 1; i++) {
      if (!this.valid(i).ok) {
        this.go(i);
        this.next();
        return;
      }
    }
    const id = this.teamId();
    const team = buildTeam(this.draft, id, this.captain);
    let saved = true;
    let created: Team;
    try {
      const r = await this.store.createTeam(team);
      created = r.team;
      saved = r.saved;
    } catch (err) {
      console.warn(err);
      toast('This browser already has a planet. Taking you there.');
      const mine = await this.store.createdTeam();
      if (mine) {
        this.app.addTeam(mine);
        this.syncCreateButton();
        this.app.navigate({ view: 'planet', teamId: mine.id }, { replace: true });
      }
      return;
    }
    this.launching = true;
    this.launchState.phase = 'wait';
    this.say(`${created.name} is launching`);
    removeEventListener('keydown', this.onKey);
    this.preview.freeze();
    await (this.burstReady ??= this.burst.prepare(this.app.world).catch(() => {}));
    const collapse = this.collapse();
    // 替身一般进第三步时就备好了；还在编（很快就点了 Launch）就先等它编完（最多 1.5 秒，窗口照常收起），
    // 真的星球再加进来：两边的着色器不挤在一起编。镜头等窗口收得差不多、预览手上正在编的也编完了才起飞
    // （WebGL2 上预览的链接会和主画面抢 GPU 进程）
    const collapsed = worldDelay(this.app.world, reducedMotion() ? 0 : 0.36);
    await Promise.race([this.warmer.warm(this.look()), new Promise((r) => setTimeout(r, 1500))]);
    const hold = Promise.all([collapsed, this.preview.settled()]);
    const rise = riseIntoGalaxy(this.app, created, reducedMotion() ? null : this.burst, this.launchState, hold);
    this.syncCreateButton();
    await collapse;
    this.node.hidden = true;
    this.open_ = false;
    this.preview.release(); // 每个浏览器只建一颗：预览不会再用，星球一颗颗放掉（渲染器不销毁，见 release）
    await rise;
    setTimeout(() => this.warmer.release(), 2500); // 真的星球画上了：替身放掉
    this.launching = false;
    const where = BURST.after >= 0.5 ? 'Press Edit to decorate it.' : 'Click it to land and decorate.';
    toast(saved ? `${created.name} is in the sky! ${where}` : `${created.name} is in the sky! This browser can't save it, so it lasts until you close the tab.`, 4200);
  }

  // 窗口收起：纸卡往下缩、淡掉，预览的小窗从卡里「拿出来」（钉在屏幕上原来的位置），转着往下掉进云里。减弱动效时一起淡掉
  private collapse(): Promise<void> {
    const reduce = reducedMotion();
    if (reduce) return finished([animate(this.node, [{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-in', fill: 'forwards' })]);
    const porthole = this.preview.element;
    const r = porthole.getBoundingClientRect();
    Object.assign(porthole.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, margin: '0', zIndex: '13' });
    this.node.append(porthole);
    porthole.dataset.diving = '';
    const fall = Math.max(240, innerHeight - r.top);
    return finished([
      animate(this.backdrop, [{ opacity: 1 }, { opacity: 0 }], { duration: 420, easing: 'ease-in', fill: 'forwards' }),
      animate(this.card, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(30px) scale(0.9) rotate(-1.5deg)' }], { duration: 340, easing: EASE_IN, fill: 'forwards' }),
      animate(porthole, [
        { transform: 'none', opacity: 1 },
        { transform: 'translateY(-18px) scale(1.04)', opacity: 1, offset: 0.25 },
        { transform: `translateY(${fall}px) scale(0.45) rotate(14deg)`, opacity: 0 },
      ], { duration: 760, easing: 'cubic-bezier(0.55, 0, 0.75, 0.25)', fill: 'forwards' }),
    ]);
  }
}
