import './genai.css';
import type { App } from '../app';
import type { Work } from '../data/types';
import { TripoError } from '../genai/api';
import { ImagePrepError, PICK_MAX_BYTES, prepareUploadImage } from '../genai/images';
import type { GenJobs } from '../genai/jobs';
import { describeError, phaseLabel, STALLED_HINT, titleFromFile, titleFromPrompt } from '../genai/messages';
import { ACTIVE_PHASES, type GenError, type GenJob, type GenMode, type GenOptions, type JobEvent, type TripoApi } from '../genai/types';
import { checkImportFile } from '../works/importCheck';
import { importModelFile } from '../works/importClient';
import { IMPORT_LIMITS, ImportError, type ImportProgress, type ImportResult } from '../works/importTypes';
import { ModelStage, thumbnailOf } from '../works/modelStage';
import { newUserWorkId, type UserWork } from '../works/userWorks';
import type { UserWorksRegistry } from '../works/userWorksTeams';
import { tripoMark } from './badge';
import { el } from './dom';
import { icon, type IconName } from './icons';
import { activeElement, animate, curve, EASE_IN, focusQuietly, Presence, reducedMotion } from './motion';
import { toast } from './toast';
import { tripoNote } from './workCard';

// 「Add a work」窗口：作品栏的「Upload」「Create with Tripo」打开它。四个标签：
// - Upload：拖进来或选一个 .glb / .gltf（内嵌资源），导入管线在 Worker 里清理、必要时简化到 30 万面、贴图缩到 2048（works/importClient.ts）；
//   右边预览（拖动旋转），能改名，「Add to planet」存进本地（IndexedDB）、进入摆放
// - Text / Image / Multi-view：用 Tripo 生成（genai/jobs.ts 管任务：上传图片 → 建任务 → 轮询 → 下载 → 同一条导入管线 → 加进作品）。
//   生成中显示排队、生成中、百分比；可以关掉窗口，后台继续；完成时右下角弹提示（genaiNotice.ts），点它回到这里看结果，确认后「Add to planet」
// 窗口盖在星球上，主画面照常跑。键盘：标签用方向键切换，Tab 在窗口里循环，Esc 关；减弱动效时只淡入淡出；手机竖屏时上下排。
// 给脚本的：section.genai，window.__genai（install.ts）

type Tab = 'upload' | GenMode;

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'upload', label: 'Upload', icon: 'upload' },
  { id: 'text', label: 'Text', icon: 'pencil' },
  { id: 'image', label: 'Image', icon: 'frame' },
  { id: 'multiview', label: 'Multi-view', icon: 'views' },
];

export const PROMPT_MAX = 500; // 提示词最多几个字（中转的上限更宽，界面收紧一点：一两句话就够）
// 选图收这几种（浏览器解得开的）；上传前统一转成中转收的 PNG / JPEG、≤ 10 MB（genai/images.ts）
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'];
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
const MIN_VIEWS = 2; // 多视图至少几张（前视图 + 至少一张别的角度；Tripo v3 的要求）
const VIEW_NAMES = ['Front', 'Left', 'Back', 'Right'] as const;
const EXAMPLES = [
  'A cozy mushroom cottage with a round red door',
  'A tiny robot gardener holding a watering can',
  'A stone lighthouse with a striped roof',
  'A friendly dragon made of autumn leaves',
];
const MODE_ICON: Record<GenMode, IconName> = { text: 'pencil', image: 'frame', multiview: 'views' };
const STAGE_TEXT: Record<ImportProgress['stage'], string> = {
  reading: 'Reading the file…',
  cleaning: 'Cleaning up the mesh…',
  simplifying: 'Simplifying…',
  textures: 'Resizing textures…',
  compressing: 'Packing it up…',
  done: 'Almost there…',
};

const nf = new Intl.NumberFormat('en-US');
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;

// 上传标签的状态
interface Upload {
  token: number;
  file: File;
  phase: 'processing' | 'ready' | 'saving' | 'failed';
  progress: ImportProgress | null;
  result: ImportResult | null;
  thumb: Promise<Blob | null> | null;
  title: string;
  error: string | null;
}

// 右边舞台要显示什么
type Side =
  | { kind: 'empty'; text: string }
  | { kind: 'busy'; label: string; ratio: number | null; cancel?: () => void }
  | { kind: 'error'; message: string; action?: { label: string; run: () => void } }
  | { kind: 'model'; key: string; load: () => Promise<ArrayBuffer | Uint8Array | Blob>; title: string; onTitle: (t: string) => void; facts: string[]; work: Work | null; adding: boolean; add: () => void };

export interface DialogDeps {
  app: App;
  registry: UserWorksRegistry;
  jobs: GenJobs;
  api: TripoApi;
  attach(work: Work, teamId: string): void; // 作品加进团队（App、作品栏）
  place(workId: string, teamId: string): void; // 关掉窗口，进入摆放（不在那颗星球上时先过去）
}

export class AddWorkDialog {
  private readonly deps: DialogDeps;
  private readonly node = el('section', { className: 'genai' });
  private readonly presence = new Presence(this.node);
  private readonly backdrop = el('div', { className: 'ga-backdrop' });
  private readonly card = el('div', { className: 'ga-card' });
  private readonly tag = el('span', { className: 'ga-tag' });
  private readonly credits = el('span', { className: 'ga-credits' });
  private readonly mockChip = el('span', { className: 'ga-mock', textContent: 'Demo mode', title: 'Tripo is simulated on this page (?tripo=mock)' });
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private readonly panels = new Map<Tab, HTMLElement>();
  private readonly stageBox = el('div', { className: 'ga-stage', dataset: { state: 'empty' } });
  private readonly stageCanvas = el('canvas', { className: 'ga-canvas' });
  private readonly stageEmpty = el('div', { className: 'ga-stage-empty' });
  private readonly stageBusy = el('div', { className: 'ga-stage-busy' });
  private readonly stageError = el('div', { className: 'ga-stage-error' });
  private readonly result = el('div', { className: 'ga-result' });
  private readonly nameInput = el('input', { className: 'ga-input ga-name', id: 'ga-name', type: 'text', maxLength: 60, autocomplete: 'off', spellcheck: false });
  private readonly facts = el('ul', { className: 'ga-facts' });
  private readonly note = el('div', { className: 'ga-note' });
  private readonly addButton = el('button', { className: 'primary ga-add', type: 'button' }, icon('planet'), 'Add to planet');
  private readonly jobsBox = el('section', { className: 'ga-jobs' });
  private readonly jobList = el('ul', { className: 'ga-job-list' });
  private readonly live = el('p', { className: 'ga-live' });
  private readonly stage: ModelStage;
  // 上传
  private readonly modelInput = el('input', { className: 'ga-file ga-file-model', type: 'file', accept: '.glb,.gltf,model/gltf-binary,model/gltf+json' });
  private readonly uploadDrop = el('div', { className: 'ga-drop ga-drop-model' });
  private readonly uploadSteps = el('ol', { className: 'ga-steps' });
  private upload: Upload | null = null;
  private uploadToken = 0;
  // 文字
  private readonly promptInput = el('textarea', { className: 'ga-input ga-prompt', id: 'ga-prompt', maxLength: PROMPT_MAX, rows: 4, placeholder: `e.g. ${EXAMPLES[0]}` });
  private readonly promptCount = el('span', { className: 'ga-count' });
  private readonly promptHint = el('p', { className: 'ga-hint', id: 'ga-prompt-hint' });
  // 图片
  private readonly imageInput = el('input', { className: 'ga-file ga-file-image', type: 'file', accept: IMAGE_TYPES.join(',') });
  private readonly imageDrop = el('div', { className: 'ga-drop ga-drop-image' });
  private image: { file: File; url: string } | null = null;
  // 多视图
  private readonly viewSlots: HTMLElement[] = [];
  private views: Array<{ file: File; url: string } | null> = [null, null, null, null];
  private pickingView = 0;
  // 选项（三种生成方式共用）：只有「贴图」一个开关（Tripo v3 开 PBR 时强制带贴图，关掉贴图时中转把 PBR 一起关掉）。
  // 模型版本不露出来，用中转的默认（v3.1）
  private readonly options: Required<Pick<GenOptions, 'texture'>> = { texture: true };
  private readonly optionInputs: HTMLInputElement[] = [];
  private readonly generateButtons = new Map<GenMode, HTMLButtonElement>();
  private preparing: GenMode | null = null; // 正在整理图片（转格式、缩小），Generate 先按不了
  private readonly offline = new Map<GenMode, HTMLElement>();
  // 状态
  private tab: Tab = 'upload';
  private open_ = false;
  private returnFocus: HTMLElement | null = null;
  private readonly selected: Record<GenMode, string | null> = { text: null, image: null, multiview: null };
  private readonly jobTitles = new Map<string, string>(); // 生成结果改过的名字（Add to planet 时存）
  private readonly adding = new Set<string>();
  private tripo: { ok: boolean; mock: boolean; error: GenError | null; checked: boolean } = { ok: false, mock: false, error: null, checked: false };
  private balance: number | null = null;
  private stageKey: string | null = null; // 舞台上现在是哪件（或正在载入哪件）
  private stageReady = false;
  private side: Side | null = null;
  private lastSaid = '';
  private readonly onKey = (e: KeyboardEvent) => { if (!this.node.contains(e.target as Node | null)) this.key(e); };

  constructor(deps: DialogDeps) {
    this.deps = deps;
    this.stage = new ModelStage(this.stageCanvas);
    this.build();
    deps.app.root.append(this.node);
    deps.jobs.subscribe((e) => this.onJob(e));
  }

  get isOpen(): boolean {
    return this.open_;
  }

  // 这个任务的结果此刻就摆在窗口里（完成提示就不用再弹了）
  isShowing(jobId: string): boolean {
    return this.open_ && this.tab !== 'upload' && this.selected[this.tab] === jobId;
  }

  // 打开：tab 给了就切过去；jobId 给了就切到那个任务的标签、显示它（完成提示、任务列表点进来）
  open(tab?: Tab, jobId?: string): void {
    const job = jobId ? this.deps.jobs.get(jobId) : undefined;
    if (job) {
      this.selected[job.mode] = job.id;
      tab = job.mode;
    }
    if (tab) this.tab = tab;
    if (!this.open_) {
      this.open_ = true;
      this.returnFocus = activeElement();
      this.node.dataset.tab = this.tab;
      this.node.style.pointerEvents = '';
      this.presence.show(() => this.enter());
      addEventListener('keydown', this.onKey);
    }
    this.refreshTeamTag();
    this.syncTabs();
    this.renderJobs();
    this.renderSide();
    this.checkTripo();
    this.focusTab();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    removeEventListener('keydown', this.onKey);
    // 预览的模型拿掉（GPU 上不攒着），下次打开时重新载入；正在处理的上传、生成照常继续
    this.stage.clear();
    this.stageKey = null;
    this.stageReady = false;
    const back = this.returnFocus;
    this.returnFocus = null;
    // 收起的动画期间就不再接鼠标：点完 Add to planet 马上点星球也点得到
    this.node.style.pointerEvents = 'none';
    void this.presence.hide(() => this.exit());
    focusQuietly(back?.isConnected ? back : null);
  }

  // —— 搭窗口 ——

  private build(): void {
    this.node.hidden = true;
    this.node.setAttribute('role', 'dialog');
    this.node.setAttribute('aria-modal', 'true');
    this.node.setAttribute('aria-labelledby', 'ga-title');
    this.backdrop.addEventListener('click', () => this.close());
    const close = el('button', { className: 'ga-close', type: 'button', title: 'Close (Esc)' }, icon('close'));
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.close());
    const status = el('div', { className: 'ga-status' }, this.mockChip, this.credits);
    this.mockChip.hidden = true;
    this.credits.hidden = true;
    const head = el('header', { className: 'ga-head' },
      el('div', { className: 'ga-titles' }, this.tag, el('h1', { className: 'display', id: 'ga-title', textContent: 'Add a work' })),
      status,
      close,
    );
    // 标签：Upload 一个，Tripo 三个（前面一个「Create with Tripo」的小标记）
    const tablist = el('div', { className: 'ga-tabs', role: 'tablist' });
    tablist.setAttribute('aria-label', 'How to add a work');
    for (const t of TABS) {
      const b = el('button', { className: 'ga-tab', type: 'button', id: `ga-tab-${t.id}`, role: 'tab', dataset: { tab: t.id } }, icon(t.icon), t.label);
      b.setAttribute('aria-controls', `ga-panel-${t.id}`);
      b.addEventListener('click', () => this.setTab(t.id, true));
      this.tabButtons.set(t.id, b);
      if (t.id === 'text') tablist.append(el('span', { className: 'ga-tab-group', ariaHidden: 'true' }, tripoMark('tripo-mark'), 'Create with Tripo'));
      tablist.append(b);
    }
    tablist.addEventListener('keydown', (e) => this.tabKey(e));
    this.panels.set('upload', this.uploadPanel());
    this.panels.set('text', this.textPanel());
    this.panels.set('image', this.imagePanel());
    this.panels.set('multiview', this.viewsPanel());
    for (const [id, p] of this.panels) {
      p.id = `ga-panel-${id}`;
      p.setAttribute('role', 'tabpanel');
      p.setAttribute('aria-labelledby', `ga-tab-${id}`);
      p.tabIndex = -1;
    }
    // 右边：舞台（模型预览 / 进度 / 出错）+ 结果（名字、面数、Add to planet）
    this.stageBox.append(el('div', { className: 'ga-spot' }), this.stageCanvas, this.stageEmpty, this.stageBusy, this.stageError);
    this.nameInput.addEventListener('input', () => { if (this.side?.kind === 'model') this.side.onTitle(this.nameInput.value); });
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.addButton.click();
      }
    });
    this.addButton.addEventListener('click', () => { if (this.side?.kind === 'model' && !this.side.adding) this.side.add(); });
    this.result.append(
      el('label', { className: 'ga-label', htmlFor: 'ga-name' }, 'Name'),
      this.nameInput,
      this.facts,
      this.note,
      this.addButton,
    );
    this.result.hidden = true;
    const side = el('aside', { className: 'ga-side' }, this.stageBox, this.result);
    this.jobsBox.append(el('h2', { className: 'ga-jobs-title', textContent: 'Your Tripo models' }), this.jobList);
    this.jobsBox.hidden = true;
    this.live.setAttribute('aria-live', 'polite');
    this.card.append(
      head,
      tablist,
      el('div', { className: 'ga-body' }, el('div', { className: 'ga-panels' }, ...this.panels.values(), this.jobsBox), side),
      this.live,
      this.modelInput,
      this.imageInput,
    );
    this.node.append(this.backdrop, this.card);
    // 窗口里的按键在这里处理（Esc 关、Tab 循环），然后不往外传：编辑器的 Delete、Q / E、Esc 都不会接到。
    // 焦点不在窗口里时（很少见）由 window 上的 onKey 接。拖放同样不往外传：整页的拖放（临时作品）接不到
    this.node.addEventListener('keydown', (e) => {
      this.key(e);
      e.stopPropagation();
    });
    this.node.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.node.dataset.drag = 'on';
    });
    this.node.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !this.node.contains(e.relatedTarget as Node)) delete this.node.dataset.drag; });
    this.node.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      delete this.node.dataset.drag;
      this.takeFiles([...(e.dataTransfer?.files ?? [])], e.target as HTMLElement | null);
    });
    this.modelInput.addEventListener('change', () => {
      const f = this.modelInput.files?.[0];
      this.modelInput.value = '';
      if (f) this.startUpload(f);
    });
    this.imageInput.addEventListener('change', () => {
      const f = this.imageInput.files?.[0];
      this.imageInput.value = '';
      if (!f) return;
      if (this.tab === 'multiview') this.setView(this.pickingView, f);
      else this.setImage(f);
    });
  }

  private panel(id: Tab, title: string, lead: string, ...content: Array<Node | string>): HTMLElement {
    return el('section', { className: 'ga-panel', dataset: { panel: id } }, el('h2', { className: 'ga-h display', textContent: title }), el('p', { className: 'ga-lead', textContent: lead }), ...content);
  }

  // 拖放区：整块是按钮（回车、空格打开选文件），也接拖进来的文件
  private dropZone(box: HTMLElement, label: string, sub: string, glyph: IconName, pick: () => void): HTMLElement {
    box.tabIndex = 0;
    box.setAttribute('role', 'button');
    box.setAttribute('aria-label', `${label}. ${sub}`);
    box.replaceChildren(el('span', { className: 'ga-drop-icon' }, icon(glyph)), el('b', { textContent: label }), el('span', { textContent: sub }));
    box.addEventListener('click', pick);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    });
    return box;
  }

  private uploadPanel(): HTMLElement {
    this.dropZone(this.uploadDrop, 'Drop a .glb or .gltf here', 'or click to choose a file', 'upload', () => this.modelInput.click());
    this.uploadSteps.hidden = true;
    return this.panel('upload', 'Upload a 3D model',
      `A .glb, or a .gltf with its files embedded, up to ${IMPORT_LIMITS.maxBytes / 1048576} MB. Big models are simplified to ${nf.format(IMPORT_LIMITS.maxTriangles)} triangles so the planet stays smooth.`,
      this.uploadDrop,
      this.uploadSteps,
      el('p', { className: 'ga-hint', textContent: 'Your models are saved in this browser and show up in the tray and the Museum.' }),
    );
  }

  // 上传的处理步骤：文件名、大小，下面一串打勾的步骤（读文件 → 清理 → 简化（需要时）→ 贴图 → 打包）
  private renderUploadSteps(): void {
    const up = this.upload;
    this.uploadSteps.hidden = !up;
    if (!up) return;
    const order: Array<ImportProgress['stage']> = ['reading', 'cleaning', 'simplifying', 'textures', 'compressing'];
    const labels: Record<string, string> = { reading: 'Read the file', cleaning: 'Clean up the mesh', simplifying: 'Simplify if needed', textures: 'Resize big textures', compressing: 'Pack it up' };
    const at = up.phase === 'processing' ? order.indexOf(up.progress?.stage === 'done' ? 'compressing' : up.progress?.stage ?? 'reading') : order.length;
    const items = order.map((stage, i) => {
      let state = i < at ? 'done' : i === at ? 'now' : 'todo';
      if (up.phase === 'failed') state = i < at ? 'done' : 'todo';
      let text = labels[stage];
      if (stage === 'simplifying' && up.result) text = up.result.simplified ? `Simplified to ${nf.format(up.result.triangles)} triangles` : 'No simplifying needed';
      const li = el('li', { dataset: { state } }, el('i', {}, state === 'done' ? icon('check') : ''), text);
      if (state === 'now') li.setAttribute('aria-current', 'step');
      return li;
    });
    this.uploadSteps.replaceChildren(el('li', { className: 'ga-steps-file' }, el('b', { textContent: up.file.name }), ` · ${mb(up.file.size)}`), ...items);
  }

  private textPanel(): HTMLElement {
    this.promptInput.setAttribute('aria-describedby', 'ga-prompt-hint');
    this.promptInput.addEventListener('input', () => this.refreshPrompt());
    this.promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        void this.generate('text');
      }
    });
    const examples = el('div', { className: 'ga-examples' }, el('span', { className: 'ga-examples-label', textContent: 'Try:' }), ...EXAMPLES.map((x, i) => {
      const b = el('button', { className: 'ga-example', type: 'button', textContent: x });
      b.style.setProperty('--i', String(i));
      b.addEventListener('click', () => {
        this.promptInput.value = x;
        this.refreshPrompt();
        focusQuietly(this.promptInput);
      });
      return b;
    }));
    return this.panel('text', 'Describe your model', 'Tripo turns one sentence into a 3D model. Name a single object and say what it looks like.',
      el('div', { className: 'ga-field' },
        el('label', { className: 'ga-label', htmlFor: 'ga-prompt' }, 'Prompt'),
        el('div', { className: 'ga-input-wrap' }, this.promptInput, this.promptCount),
        this.promptHint,
      ),
      examples,
      ...this.genControls('text'),
    );
  }

  private imagePanel(): HTMLElement {
    this.dropZone(this.imageDrop, 'Drop a picture here', 'or click to choose one · PNG or JPG work best (WebP is converted)', 'frame', () => this.imageInput.click());
    return this.panel('image', 'Turn a picture into 3D', 'One clear picture of a single object works best: plain background, the whole object in view.',
      this.imageDrop,
      ...this.genControls('image'),
    );
  }

  private viewsPanel(): HTMLElement {
    const grid = el('div', { className: 'ga-views' });
    VIEW_NAMES.forEach((_name, i) => {
      const slot = el('div', { className: 'ga-view', dataset: { slot: String(i) } });
      this.viewSlots.push(slot);
      grid.append(slot);
      this.renderView(i);
    });
    return this.panel('multiview', 'Front, left, back, right', 'Add pictures of the same object from different sides: the front view plus at least one more angle. More sides help Tripo get the shape right.',
      grid,
      ...this.genControls('multiview'),
    );
  }

  // 三种生成方式共用的：贴图开关，Tripo 不可用时的提示，Generate 按钮
  private genControls(mode: GenMode): HTMLElement[] {
    const toggle = (key: 'texture', label: string, hint: string) => {
      const input = el('input', { type: 'checkbox', className: 'ga-switch-input', checked: this.options[key] });
      input.dataset.option = key;
      input.addEventListener('change', () => {
        this.options[key] = input.checked;
        for (const other of this.optionInputs) if (other.dataset.option === key) other.checked = input.checked;
      });
      this.optionInputs.push(input);
      return el('label', { className: 'ga-switch', title: hint }, input, el('span', { className: 'ga-switch-track' }, el('i')), el('span', { textContent: label }));
    };
    const offline = el('p', { className: 'ga-offline', role: 'status' });
    offline.hidden = true;
    this.offline.set(mode, offline);
    const go = el('button', { className: 'primary ga-generate', type: 'button' }, icon('sparkle'), 'Generate');
    go.addEventListener('click', () => void this.generate(mode));
    this.generateButtons.set(mode, go);
    const hint = mode === 'multiview' ? el('p', { className: 'ga-hint ga-views-hint', textContent: 'Add the front view and at least one more side.' }) : null;
    return [
      ...(hint ? [hint] : []),
      el('div', { className: 'ga-options' }, toggle('texture', 'Texture', 'Paint colours, details and realistic materials onto the model. Off: plain grey clay')),
      offline,
      el('div', { className: 'ga-go' }, go, el('span', { className: 'ga-cost', textContent: 'Uses credits from the demo’s Tripo account' })),
    ];
  }

  // —— 标签 ——

  private setTab(tab: Tab, focusPanel = false): void {
    if (tab === this.tab) return;
    const from = this.panels.get(this.tab);
    this.tab = tab;
    this.node.dataset.tab = tab;
    this.syncTabs();
    this.renderSide();
    const to = this.panels.get(tab);
    if (to && from !== to && !reducedMotion()) animate(to, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: curve('settle') });
    if (focusPanel) this.focusTab(false);
  }

  private syncTabs(): void {
    for (const [id, b] of this.tabButtons) {
      const on = id === this.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const [id, p] of this.panels) p.hidden = id !== this.tab;
    this.refreshPrompt();
    this.refreshGenerate();
  }

  // 方向键在标签之间移动并切换（WAI-ARIA tabs，自动激活）
  private tabKey(e: KeyboardEvent): void {
    const ids = TABS.map((t) => t.id);
    const i = ids.indexOf(this.tab);
    const next = e.key === 'ArrowRight' ? ids[(i + 1) % ids.length] : e.key === 'ArrowLeft' ? ids[(i + ids.length - 1) % ids.length] : e.key === 'Home' ? ids[0] : e.key === 'End' ? ids[ids.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    this.setTab(next);
    focusQuietly(this.tabButtons.get(next));
  }

  // 打开、切换后先给焦点的地方：选中的标签（键盘用户接着按方向键）；panel = false 时给这一页的第一个输入
  private focusTab(onTab = true): void {
    if (onTab) {
      focusQuietly(this.tabButtons.get(this.tab));
      return;
    }
    const target = this.tab === 'text' ? this.promptInput : this.tab === 'upload' ? this.uploadDrop : this.tab === 'image' ? this.imageDrop : this.viewSlots[0]?.querySelector<HTMLElement>('.ga-view-pick');
    focusQuietly(target ?? this.panels.get(this.tab));
  }

  private refreshTeamTag(): void {
    const team = this.team();
    this.tag.textContent = team ? `For ${team.name}` : 'New work';
    if (team) this.tag.style.setProperty('--team', team.color);
  }

  private team() {
    const app = this.deps.app;
    return app.currentTeam ?? app.teams.find((t) => t.id === app.you.teamId) ?? null;
  }

  // —— 拖进来的文件：按标签和文件类型分 ——

  private takeFiles(files: File[], target: HTMLElement | null): void {
    if (!files.length) return;
    const model = files.find((f) => /\.(glb|gltf)$/i.test(f.name));
    const images = files.filter((f) => IMAGE_TYPES.includes(f.type) || IMAGE_EXT.test(f.name));
    if (model && (this.tab === 'upload' || !images.length)) {
      this.setTab('upload');
      this.startUpload(model);
      return;
    }
    if (!images.length) {
      this.say('Drop a .glb, a .gltf or a picture');
      toast('Drop a .glb or .gltf model, or a PNG, JPG or WebP picture');
      return;
    }
    if (this.tab === 'multiview') {
      const slot = target?.closest<HTMLElement>('.ga-view');
      let i = slot ? Number(slot.dataset.slot) : this.views.findIndex((v) => !v);
      for (const f of images) {
        if (i < 0 || i > 3) break;
        this.setView(i, f);
        i = this.views.findIndex((v, k) => !v && k > i);
      }
      return;
    }
    this.setTab('image');
    this.setImage(images[0]);
  }

  // —— 上传 ——

  private startUpload(file: File): void {
    const token = ++this.uploadToken;
    const check = checkImportFile(file);
    const up: Upload = { token, file, phase: 'processing', progress: null, result: null, thumb: null, title: titleFromFile(file.name), error: null };
    this.upload = up;
    if (!check.ok) {
      up.phase = 'failed';
      up.error = check.error.message;
      this.renderSide();
      this.say(check.error.message);
      return;
    }
    this.renderSide();
    this.say(`Processing ${file.name}`);
    importModelFile(file, file.name, {
      onProgress: (p) => {
        if (this.upload?.token !== token) return;
        up.progress = p;
        if (this.tab === 'upload') this.renderSide();
      },
    }).then((result) => {
      if (this.upload?.token !== token) return;
      up.result = result;
      up.phase = 'ready';
      this.renderSide();
      this.say(`${up.title} is ready: ${nf.format(result.triangles)} triangles${result.simplified ? ', simplified' : ''}`);
    }, (err: unknown) => {
      if (this.upload?.token !== token) return;
      up.phase = 'failed';
      up.error = err instanceof ImportError ? err.message : 'Something went wrong while reading this file. Please try again.';
      if (!(err instanceof ImportError)) console.error(err);
      this.renderSide();
      this.say(up.error);
    });
  }

  private async addUpload(up: Upload): Promise<void> {
    const result = up.result;
    const team = this.team();
    if (!result || !team || up.phase !== 'ready') return;
    up.phase = 'saving';
    this.renderSide();
    const title = up.title.trim() || titleFromFile(up.file.name);
    try {
      const thumb = await (up.thumb ?? thumbnailOf(result.glb));
      const record: UserWork = {
        id: newUserWorkId(),
        title,
        author: this.deps.app.you.memberId,
        source: 'upload',
        createdAt: Date.now(),
        triangles: result.triangles,
        bytes: result.bytes,
        teamId: team.id,
        glb: new Blob([result.glb as Uint8Array<ArrayBuffer>], { type: 'model/gltf-binary' }),
        thumb,
      };
      const handle = this.handle();
      if (handle) record.authorHandle = handle;
      const { work, saved } = await this.deps.registry.add(record);
      this.deps.attach(work, team.id);
      if (this.upload === up) this.upload = null;
      this.stageKey = null;
      this.deps.place(work.id, team.id);
      if (!saved) toast(`${title} added. This browser can't save it, so it lasts until you close the tab.`, 4200);
    } catch (err) {
      console.error(err);
      up.phase = 'ready';
      this.renderSide();
      toast('Could not save this model in the browser (storage may be full). Please try again.');
    }
  }

  private handle(): string | undefined {
    const app = this.deps.app;
    return app.teams.flatMap((t) => t.members).find((m) => m.id === app.you.memberId)?.handle;
  }

  // —— 图片、多视图 ——

  private checkImage(file: File): string | null {
    if (!(IMAGE_TYPES.includes(file.type) || IMAGE_EXT.test(file.name))) return 'Use a PNG or JPG picture (WebP works too).';
    if (file.size > PICK_MAX_BYTES) return 'That picture is too big. Use one under 10 MB.';
    return null;
  }

  private setImage(file: File): void {
    const bad = this.checkImage(file);
    if (bad) {
      toast(bad);
      this.say(bad);
      return;
    }
    if (this.image) URL.revokeObjectURL(this.image.url);
    this.image = { file, url: URL.createObjectURL(file) };
    this.imageDrop.replaceChildren(
      el('img', { className: 'ga-picked', src: this.image.url, alt: `Selected picture: ${file.name}` }),
      el('span', { className: 'ga-picked-name', textContent: file.name }),
      el('span', { className: 'ga-picked-change', textContent: 'Click to change' }),
    );
    this.imageDrop.dataset.filled = 'true';
    this.refreshGenerate();
    this.say(`Picture selected: ${file.name}`);
  }

  private setView(i: number, file: File | null): void {
    if (file) {
      const bad = this.checkImage(file);
      if (bad) {
        toast(bad);
        this.say(bad);
        return;
      }
    }
    const old = this.views[i];
    if (old) URL.revokeObjectURL(old.url);
    this.views[i] = file ? { file, url: URL.createObjectURL(file) } : null;
    this.renderView(i);
    this.refreshGenerate();
    this.say(file ? `${VIEW_NAMES[i]} view: ${file.name}` : `${VIEW_NAMES[i]} view removed`);
  }

  private renderView(i: number): void {
    const slot = this.viewSlots[i];
    const v = this.views[i];
    const name = VIEW_NAMES[i];
    const pick = el('button', { className: 'ga-view-pick', type: 'button' });
    pick.setAttribute('aria-label', v ? `${name} view: ${v.file.name}. Click to change` : `Add the ${name.toLowerCase()} view${i === 0 ? ' (required)' : ''}`);
    pick.addEventListener('click', () => {
      this.pickingView = i;
      this.imageInput.click();
    });
    if (v) pick.append(el('img', { src: v.url, alt: '' }));
    else pick.append(el('span', { className: 'ga-view-plus' }, icon('frame')));
    const label = el('span', { className: 'ga-view-label' }, name);
    if (i === 0) label.append(el('em', { textContent: 'required' }));
    slot.replaceChildren(pick, label);
    slot.dataset.filled = String(!!v);
    if (v) {
      const remove = el('button', { className: 'ga-view-x', type: 'button', title: `Remove the ${name.toLowerCase()} view` }, icon('close'));
      remove.setAttribute('aria-label', `Remove the ${name.toLowerCase()} view`);
      remove.addEventListener('click', () => this.setView(i, null));
      slot.append(remove);
    }
  }

  // —— 文字 ——

  private refreshPrompt(): void {
    const n = [...this.promptInput.value].length;
    this.promptCount.textContent = `${n}/${PROMPT_MAX}`;
    this.promptCount.dataset.tone = n > PROMPT_MAX - 40 ? 'near' : '';
    this.promptHint.textContent = 'One object, a few words about its shape, colour and style. Ctrl+Enter to generate.';
    this.refreshGenerate();
  }

  // Generate 能不能点：Tripo 连得上、这一页的输入齐了
  private refreshGenerate(): void {
    const ready: Record<GenMode, boolean> = {
      text: this.promptInput.value.trim().length > 0,
      image: this.image !== null,
      multiview: this.views[0] !== null && this.views.filter(Boolean).length >= MIN_VIEWS,
    };
    for (const [mode, b] of this.generateButtons) {
      const ok = this.tripo.ok || !this.tripo.checked;
      b.disabled = !ok || !ready[mode] || this.preparing === mode;
      const off = this.offline.get(mode);
      if (off) {
        off.hidden = ok;
        off.replaceChildren(icon('alert'), this.tripo.error?.message ?? describeError('unavailable'));
      }
    }
  }

  // —— 生成 ——

  private async generate(mode: GenMode): Promise<void> {
    const team = this.team();
    const button = this.generateButtons.get(mode);
    if (!team || !button || button.disabled) return;
    const options: GenOptions = { texture: this.options.texture };
    let job: GenJob;
    if (mode === 'text') {
      const prompt = this.promptInput.value.trim();
      if (!prompt) return;
      job = this.deps.jobs.submit({ mode: 'text', prompt, title: titleFromPrompt(prompt), teamId: team.id, options });
    } else {
      // 图片先整理成中转收的格式（PNG / JPEG、≤ 10 MB）：转格式、缩小在这里做，几百毫秒
      const picked = mode === 'image' ? [this.image?.file ?? null] : this.views.map((v) => v?.file ?? null);
      if (!picked[0]) return;
      this.preparing = mode;
      this.refreshGenerate();
      let files: Array<File | null>;
      try {
        files = await Promise.all(picked.map((f) => (f ? prepareUploadImage(f) : null)));
      } catch (err) {
        const message = err instanceof ImagePrepError ? err.message : 'Could not read one of the pictures. Try another one.';
        if (!(err instanceof ImagePrepError)) console.error(err);
        toast(message);
        this.say(message);
        return;
      } finally {
        this.preparing = null;
        this.refreshGenerate();
      }
      const first = files[0]!;
      const title = titleFromFile(picked[0].name);
      job = mode === 'image'
        ? this.deps.jobs.submit({ mode: 'image', image: first, title, teamId: team.id, options })
        : this.deps.jobs.submit({ mode: 'multiview', views: files, title, teamId: team.id, options });
    }
    this.selected[mode] = job.id;
    this.renderSide();
    this.renderJobs();
    this.say(`${job.title}: ${phaseLabel(job)}`);
    if (!reducedMotion()) animate(button, [{ transform: 'scale(1)' }, { transform: 'scale(0.94)', offset: 0.3 }, { transform: 'scale(1)' }], { duration: 360, easing: curve('bounce') });
  }

  private onJob(e: JobEvent): void {
    const job = e.job;
    if (e.from !== job.phase && (job.phase === 'done' || job.phase === 'failed')) this.refreshBalance();
    if (!this.open_) return;
    this.renderJobs();
    if (this.isShowing(job.id)) {
      if (job.phase === 'done') this.deps.jobs.markSeen(job.id);
      this.renderSide();
      if (e.from !== job.phase) this.say(`${job.title}: ${phaseLabel(job)}`);
    }
  }

  // 任务列表：最近的几个，点一下切到那个标签、在右边显示；进行中的能取消，结束的能移走
  private renderJobs(): void {
    const jobs = this.deps.jobs.list().slice(0, 8);
    this.jobsBox.hidden = jobs.length === 0;
    this.jobList.replaceChildren(...jobs.map((job) => {
      const activeNow = ACTIVE_PHASES.includes(job.phase);
      const main = el('button', { className: 'ga-job-main', type: 'button' },
        el('span', { className: 'ga-job-icon' }, icon(MODE_ICON[job.mode])),
        el('span', { className: 'ga-job-text' }, el('b', { className: 'ga-job-title', textContent: job.title }), el('span', { className: 'ga-job-status', textContent: phaseLabel(job) })),
      );
      main.setAttribute('aria-label', `${job.title}: ${phaseLabel(job)}. Show it`);
      main.addEventListener('click', () => this.open(job.mode, job.id));
      const bar = el('i', { className: 'ga-job-bar' });
      bar.style.setProperty('--p', String(Math.max(0.04, job.progress / 100)));
      const x = el('button', { className: 'ga-job-x', type: 'button', title: activeNow ? 'Cancel' : 'Remove from the list' }, icon('close'));
      x.setAttribute('aria-label', activeNow ? `Cancel ${job.title}` : `Remove ${job.title} from the list`);
      x.addEventListener('click', () => {
        if (activeNow) this.deps.jobs.cancel(job.id);
        else this.deps.jobs.dismiss(job.id);
        this.renderJobs();
        this.renderSide();
      });
      // 导入中（已经在往作品里加了）不能取消：不给按钮
      x.hidden = activeNow && !this.deps.jobs.canCancel(job.id);
      const li = el('li', { className: 'ga-job', dataset: { phase: job.phase, mode: job.mode } }, main, x);
      if (activeNow) li.append(bar);
      if (this.isShowing(job.id)) li.dataset.current = 'true';
      return li;
    }));
  }

  // —— 右边 ——

  private sideFor(): Side {
    if (this.tab === 'upload') return this.uploadSide();
    const id = this.selected[this.tab];
    const job = id ? this.deps.jobs.get(id) : undefined;
    if (!job) {
      const empty = this.tab === 'text' ? 'Your Tripo model will appear here. Describe it, then press Generate.' : this.tab === 'image' ? 'Pick a picture, then press Generate. Your model will appear here.' : 'Add the views, then press Generate. Your model will appear here.';
      return { kind: 'empty', text: empty };
    }
    return this.jobSide(job);
  }

  private uploadSide(): Side {
    const up = this.upload;
    if (!up) return { kind: 'empty', text: 'Your model will appear here. You can spin it around before adding it to the planet.' };
    if (up.phase === 'failed') return { kind: 'error', message: up.error ?? 'Could not read that file.', action: { label: 'Choose another file', run: () => this.modelInput.click() } };
    if (up.phase === 'processing' || !up.result) {
      const p = up.progress;
      return { kind: 'busy', label: p ? STAGE_TEXT[p.stage] : 'Reading the file…', ratio: p ? p.ratio : null };
    }
    const r = up.result;
    const facts = [`${nf.format(r.triangles)} triangles · ${mb(r.bytes)}`];
    if (r.simplified) facts.push(`Simplified from ${nf.format(r.trianglesBefore)} triangles so the planet stays smooth`);
    for (const w of r.warnings) if (!r.simplified || !/^Simplified/.test(w)) facts.push(w);
    return {
      kind: 'model', key: `upload-${up.token}`, load: async () => r.glb, title: up.title, onTitle: (t) => { up.title = t; }, facts, work: null,
      adding: up.phase === 'saving', add: () => void this.addUpload(up),
    };
  }

  private jobSide(job: GenJob): Side {
    if (job.phase === 'failed') {
      return { kind: 'error', message: job.error?.message ?? describeError('upstream'), action: this.retryAction(job) };
    }
    if (job.phase === 'cancelled') return { kind: 'error', message: 'Cancelled. Nothing was added to your works.', action: this.again(job) };
    if (job.phase !== 'done') {
      const ratio = job.phase === 'running' ? job.progress / 100 : job.phase === 'downloading' || job.phase === 'importing' ? 1 : null;
      // 导入那一步已经在往作品里加了，不能取消（没有 Cancel 按钮）；轮询暂时出错、正在重试时进度下面加一句
      const cancel = this.deps.jobs.canCancel(job.id) ? () => { this.deps.jobs.cancel(job.id); this.renderSide(); this.renderJobs(); } : undefined;
      return { kind: 'busy', label: job.stalled ? `${phaseLabel(job)} · ${STALLED_HINT}` : phaseLabel(job), ratio, cancel };
    }
    const work = job.workId ? this.deps.registry.work(job.workId) : undefined;
    const record = job.workId ? this.deps.registry.record(job.workId) : undefined;
    if (!work || !record) return { kind: 'error', message: 'This model is no longer in your works.', action: this.again(job) };
    const title = this.jobTitles.get(job.id) ?? work.title;
    return {
      kind: 'model', key: `work-${work.id}`, load: async () => record.glb, title, onTitle: (t) => { this.jobTitles.set(job.id, t); }, facts: [`${nf.format(work.tris)} triangles · ${mb(record.bytes)}`],
      work, adding: this.adding.has(job.id), add: () => void this.addJob(job),
    };
  }

  // 出错时的按钮：导入失败这类能接着做的（canRetry）用 Try again；额度、今天的上限用完了引去上传；别的回到表单重来
  private retryAction(job: GenJob): { label: string; run: () => void } | undefined {
    const code = job.error?.code;
    if (this.deps.jobs.canRetry(job.id)) {
      return { label: 'Try again', run: () => { this.deps.jobs.retry(job.id); this.renderSide(); this.renderJobs(); } };
    }
    if (code === 'quota' || code === 'daily_cap') return { label: 'Upload a model instead', run: () => this.setTab('upload', true) };
    return this.again(job);
  }

  private again(job: GenJob): { label: string; run: () => void } {
    return {
      label: 'Start over',
      run: () => {
        this.selected[job.mode] = null;
        if (job.mode === 'text' && job.prompt && !this.promptInput.value) this.promptInput.value = job.prompt;
        this.refreshPrompt();
        this.renderSide();
        this.focusTab(false);
      },
    };
  }

  private async addJob(job: GenJob): Promise<void> {
    if (!job.workId || this.adding.has(job.id)) return;
    this.adding.add(job.id);
    this.renderSide();
    try {
      const title = (this.jobTitles.get(job.id) ?? '').trim();
      const work = title ? await this.deps.registry.rename(job.workId, title) : this.deps.registry.work(job.workId);
      if (!work) return;
      this.deps.attach(work, job.teamId);
      this.deps.jobs.markSeen(job.id);
      this.deps.place(work.id, job.teamId);
    } catch (err) {
      console.error(err);
      toast('Could not rename this model. Please try again.');
    } finally {
      this.adding.delete(job.id);
      this.renderSide();
    }
  }

  // 按现在的状态画右边：舞台（空 / 进度 / 出错 / 模型）和下面的结果栏
  private renderSide(): void {
    const side = this.sideFor();
    this.side = side;
    this.renderUploadSteps();
    const box = this.stageBox;
    if (side.kind !== 'model') {
      box.dataset.state = side.kind;
      this.result.hidden = true;
      if (this.stageKey) {
        this.stage.clear();
        this.stageKey = null;
        this.stageReady = false;
      }
    }
    if (side.kind === 'empty') {
      this.stageEmpty.replaceChildren(el('i', { className: 'ga-plinth' }), el('p', { textContent: side.text }));
      return;
    }
    if (side.kind === 'error') {
      const nodes: Array<Node> = [el('span', { className: 'ga-error-icon' }, icon('alert')), el('p', { textContent: side.message })];
      if (side.action) {
        const act = side.action;
        nodes.push(el('button', { className: 'ga-error-action', type: 'button', textContent: act.label, onclick: () => act.run() }));
      }
      this.stageError.replaceChildren(...nodes);
      return;
    }
    if (side.kind === 'busy') {
      this.renderBusy(side.label, side.ratio, side.cancel);
      return;
    }
    // 模型：换了一件就重新载入（载入期间显示 Preparing preview…）
    if (this.stageKey !== side.key) {
      this.stageKey = side.key;
      this.stageReady = false;
      const key = side.key;
      side.load().then((data) => this.stage.show(data)).then((model) => {
        if (this.stageKey !== key || !model) return;
        this.stageReady = true;
        // 上传的作品：截缩略图就用这个舞台（模型已经在这里了，不用再开一个渲染器）
        const up = this.upload;
        if (up && key === `upload-${up.token}` && !up.thumb) up.thumb = this.stage.capture().catch(() => null);
        this.stage.setVisible(this.open_);
        this.renderSide();
      }, (err: unknown) => {
        if (this.stageKey !== key) return;
        console.error(err);
        this.stageKey = null;
        box.dataset.state = 'error';
        this.stageError.replaceChildren(el('span', { className: 'ga-error-icon' }, icon('alert')), el('p', { textContent: 'The preview could not be drawn, but the model is fine. You can still add it.' }));
      });
    }
    if (!this.stageReady) {
      this.renderBusy('Preparing the preview…', null);
    } else {
      box.dataset.state = 'model';
      this.stage.setVisible(this.open_);
    }
    this.result.hidden = false;
    if (document.activeElement !== this.nameInput) this.nameInput.value = side.title;
    this.facts.replaceChildren(...side.facts.map((f) => el('li', { textContent: f })));
    const note = side.work ? tripoNote(side.work) : null;
    this.note.replaceChildren(...(note ? [note] : []));
    this.note.hidden = !note;
    this.addButton.disabled = side.adding;
    this.addButton.replaceChildren(icon('planet'), side.adding ? 'Adding…' : 'Add to planet');
  }

  private renderBusy(label: string, ratio: number | null, cancel?: () => void): void {
    this.stageBox.dataset.state = 'busy';
    const pct = ratio === null ? null : Math.round(Math.max(0, Math.min(1, ratio)) * 100);
    const bar = el('div', { className: 'ga-bar', role: 'progressbar' });
    bar.setAttribute('aria-label', label);
    if (pct !== null) {
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute('aria-valuenow', String(pct));
      bar.style.setProperty('--p', String(pct / 100));
    } else bar.dataset.indeterminate = 'true';
    bar.append(el('i'));
    const nodes: Node[] = [el('span', { className: 'dots' }, el('i'), el('i'), el('i')), el('p', { className: 'ga-busy-label', textContent: label }), bar];
    if (cancel) nodes.push(el('button', { className: 'ga-cancel', type: 'button', textContent: 'Cancel', onclick: () => cancel() }));
    nodes.push(el('p', { className: 'ga-busy-hint', textContent: cancel ? 'You can close this window. Tripo keeps working, and we will let you know when it is ready.' : 'This runs in the background, so the planet stays smooth.' }));
    this.stageBusy.replaceChildren(...nodes);
  }

  // —— Tripo 连不连得上、剩多少额度 ——

  private checkTripo(): void {
    if (this.tripo.checked && this.tripo.ok) {
      this.refreshBalance();
      return;
    }
    this.deps.api.health().then((h) => {
      this.tripo = { ok: h.ok, mock: h.mock, error: h.ok ? null : { code: 'unavailable', message: describeError('unavailable') }, checked: true };
      this.mockChip.hidden = !h.mock;
      this.refreshGenerate();
      if (h.ok) this.refreshBalance();
    }, (err: unknown) => {
      const code = err instanceof TripoError ? err.code : 'unavailable';
      this.tripo = { ok: false, mock: false, error: { code, message: describeError(code) }, checked: true };
      this.refreshGenerate();
    });
  }

  private refreshBalance(): void {
    if (!this.tripo.ok) return;
    this.deps.api.balance().then((b) => {
      this.balance = b.balance;
      this.credits.hidden = false;
      this.credits.replaceChildren(icon('ticket'), `${nf.format(Math.max(0, Math.floor(b.balance)))} credits left`);
      this.credits.title = b.frozen > 0 ? `${nf.format(b.frozen)} more are held for models being generated` : 'Credits left on the demo’s Tripo account';
    }, () => {
      this.balance = null;
      this.credits.hidden = true;
    });
  }

  // —— 键盘：Esc 关，Tab 在窗口里循环 ——

  private key(e: KeyboardEvent): void {
    if (!this.open_) return;
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...this.card.querySelectorAll<HTMLElement>('button, input:not([type="file"]), textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((x) => !x.closest('[hidden]') && !(x as HTMLButtonElement).disabled && x.offsetParent !== null);
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

  private say(text: string): void {
    if (text === this.lastSaid) return;
    this.lastSaid = text;
    this.live.textContent = text;
  }

  // 进场：背景淡入，纸卡从下面带一点倾斜弹上来；减弱动效时只淡入
  private enter(): Array<Animation | null> {
    const list: Array<Animation | null> = [animate(this.backdrop, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' })];
    if (reducedMotion()) {
      list.push(animate(this.card, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' }));
      return list;
    }
    list.push(animate(this.card, [{ opacity: 0, transform: 'translateY(36px) scale(0.94) rotate(-1deg)' }, { opacity: 1, transform: 'none' }], { duration: 600, easing: curve('spring') }));
    return list;
  }

  private exit(): Array<Animation | null> {
    const reduce = reducedMotion();
    return [
      animate(this.backdrop, [{ opacity: 1 }, { opacity: 0 }], { duration: reduce ? 160 : 260, easing: 'ease-in', fill: 'forwards' }),
      animate(this.card, reduce ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(22px) scale(0.96)' }], { duration: reduce ? 160 : 240, easing: EASE_IN, fill: 'forwards' }),
    ];
  }

  // 自查脚本用
  debugState(): Record<string, unknown> {
    const up = this.upload;
    return {
      open: this.open_,
      tab: this.tab,
      stage: this.stageBox.dataset.state,
      stageReady: this.stageReady,
      tripo: { ...this.tripo },
      balance: this.balance,
      upload: up ? { phase: up.phase, title: up.title, triangles: up.result?.triangles ?? null, trianglesBefore: up.result?.trianglesBefore ?? null, simplified: up.result?.simplified ?? null, error: up.error } : null,
      selected: { ...this.selected },
    };
  }
}
