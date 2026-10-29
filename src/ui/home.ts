import type { App } from '../app';
import type { TagSnapshot } from './galaxyUi';

// 首页（星系视图，H2）的接线：main.ts 调一次。
// - 「你的星球」放在前排正中、大一点（World 的版式），名牌上写 You
// - 「Visit your planet」：你的星球先压一下、回弹，再走现有的穿云转场；指着按钮时你的星球跟着放大、名牌弹出来
// - window.__home：自查脚本用（名牌在哪、你的星球是哪颗；翠宝那部分由 fun/couponsHome.ts 接上）

export interface HomeDebug {
  state(): {
    you: string;
    shape: 'wide' | 'tall';
    tags: TagSnapshot[];
    intro: boolean; // 开场：翠宝在右边缘探头打招呼（还在演）
    triboo: { ready: boolean; shown: boolean; at: { x: number; y: number } | null; phase: string; hover: boolean; cooldown: number } | null;
    card: { open: boolean; shown: boolean; title: string | null; claim: string | null };
  };
  // 翠宝（fun/couponsHome.ts）接上以后填
  triboo?: () => ReturnType<HomeDebug['state']>['triboo'];
  intro?: () => boolean;
  card?: () => ReturnType<HomeDebug['state']>['card'];
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
  app.topbar.onVisit = () => app.galaxyUi.visitTeam(you);
  app.topbar.onVisitHover = (on) => app.galaxyUi.hoverTeam(on ? you : null);
  app.topbar.onCreate = openCreate;
  app.topbar.refreshVisit();
  // 标题卡片多高（字体到了、窗口变了、加了联名标志都会变）：首页取景让开它
  const title = app.root.querySelector<HTMLElement>('.tb-title');
  if (title && typeof ResizeObserver !== 'undefined') {
    const measure = () => {
      if (title.dataset.home === undefined) return;
      app.world.setHomeTop(title.getBoundingClientRect().bottom);
    };
    new ResizeObserver(measure).observe(title);
    addEventListener('resize', measure);
    measure();
  }
  const debug: HomeDebug = {
    state: () => ({
      you,
      shape: app.world.homeShape,
      tags: app.galaxyUi.snapshot(),
      intro: debug.intro?.() ?? false,
      triboo: debug.triboo?.() ?? null,
      card: debug.card?.() ?? { open: false, shown: false, title: null, claim: null },
    }),
  };
  window.__home = debug;
  return debug;
}
