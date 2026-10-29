import type { App } from '../app';
import type { TagSnapshot } from './galaxyUi';

// 首页（星系视图，H2）的接线：main.ts 调一次。
// - 「你的星球」放在前排正中、大一点（World 的版式），名牌上写 You
// - 「Visit your planet」：你的星球先压一下、回弹，再走现有的穿云转场；指着按钮时你的星球跟着放大、名牌弹出来
// - window.__home：自查脚本用（名牌在哪、你的星球是哪颗；翠宝那部分由 fun/couponsHome.ts 接上）

export interface CloudPeekState {
  ready: boolean;
  phase: string; // idle / bulge / rise / stay / sink / close
  active: boolean;
  at: { x: number; y: number } | null; // 身体中心在画面上（CSS 像素），点得到的时候才有
  rect: { left: number; top: number; right: number; bottom: number } | null; // 露出来那一块在画面上
  hover: boolean;
  act: string | null; // spit / shake
  nextIn: number; // 还有多久冒下一次（秒）
  since: number; // 开场演完以后过了多久（秒；-1：还没演完）。第一次在开场后 since + nextIn 秒冒出来（≥ 8）
  count: number; // 开页以来定时（和 Peek now）冒了几次
  guides: number; // 开页以来悬停带路带了几次
  mode: string; // timer（定时冒出来）/ guide（悬停时带路）
  guideFor: string | null; // 带路时指着哪颗星球
}

export interface HomeDebug {
  state(): {
    you: string;
    shape: 'wide' | 'tall';
    tags: TagSnapshot[];
    intro: boolean; // 开场：翠宝在右边缘探头打招呼（还在演）
    triboo: { ready: boolean; shown: boolean; at: { x: number; y: number } | null; phase: string; hover: boolean; cooldown: number } | null;
    card: { open: boolean; shown: boolean; title: string | null; claim: string | null };
    cloud: CloudPeekState | null; // 云里探头的翠宝（fun/cloudPeek.ts）
  };
  // 翠宝（fun/couponsHome.ts）接上以后填
  triboo?: () => ReturnType<HomeDebug['state']>['triboo'];
  intro?: () => boolean;
  card?: () => ReturnType<HomeDebug['state']>['card'];
  cloud?: () => CloudPeekState;
  peekCloud?: () => boolean; // 马上让云里的翠宝冒出来（?tune 的 Peek now、自查脚本）；不能冒（转场、领券窗口开着、减弱动效）时返回 false
}

declare global {
  interface Window {
    __home?: HomeDebug;
  }
}

// 「Create a planet」：建星球的流程（另一个任务做的 openCreatePlanet）装上以后调 setCreatePlanet 接过来；
// 还没装上时去 #/create（路由还不认识它时就留在首页）
let createPlanet: (() => void) | null = null;
export function setCreatePlanet(fn: (() => void) | null): void {
  createPlanet = fn;
}

export function openCreate(): void {
  if (createPlanet) createPlanet();
  else location.hash = '#/create';
}

export function installHome(app: App): HomeDebug {
  const you = app.you.teamId;
  app.world.setYou(you);
  app.galaxyUi.setYou(you);
  // 按钮按下时才读「你的星球」：用「Create a planet」建了新星球以后（P3，App.addTeam）就去新的那颗
  app.topbar.onVisit = () => app.galaxyUi.visitTeam(app.you.teamId);
  app.topbar.onVisitHover = (on) => app.galaxyUi.hoverTeam(on ? app.you.teamId : null);
  app.topbar.onCreate = openCreate;
  app.topbar.refreshVisit();
  // 标题卡片多高（字体到了、窗口变了、加了联名标志都会变）：首页取景让开它
  const title = app.root.querySelector<HTMLElement>('.tb-title');
  if (title && typeof ResizeObserver !== 'undefined') {
    const measure = () => {
      if (title.dataset.home === undefined) return;
      const r = title.getBoundingClientRect();
      app.world.setHomeCard(r.right, r.bottom);
    };
    new ResizeObserver(measure).observe(title);
    addEventListener('resize', measure);
    measure();
  }
  const debug: HomeDebug = {
    state: () => ({
      you: app.you.teamId,
      shape: app.world.homeShape,
      tags: app.galaxyUi.snapshot(),
      intro: debug.intro?.() ?? false,
      triboo: debug.triboo?.() ?? null,
      card: debug.card?.() ?? { open: false, shown: false, title: null, claim: null },
      cloud: debug.cloud?.() ?? null,
    }),
  };
  window.__home = debug;
  return debug;
}
