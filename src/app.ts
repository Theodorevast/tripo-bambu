import type { PlanetStore } from './data/store';
import type { Seed, Team } from './data/types';
import { isCurrentRoute } from './lib/currentRoute';
import { LatestQueue } from './lib/latestQueue';
import { parseRoute, toHash, type Route } from './router';
import { installTransitionDebug } from './scenes/transitionDebug';
import type { World } from './scenes/world';
import { installBadge } from './ui/badge';
import { GalaxyUi } from './ui/galaxyUi';
import { toast } from './ui/toast';
import { Topbar } from './ui/topbar';
import type { PlanetObject } from './planet/planetObject';

// 星球页上叠加的内容（作品、编辑器）和覆盖整屏的页面（Members、Museum）由 main.ts 装进来
export interface PlanetLayer {
  // 立即返回：展台马上摆好，模型在后台加载。路由不等模型（等了，加载期间 Back、Members 这些操作都会卡住）
  enter(team: Team): void;
  leave(): void;
  // 转场一开始：作品的模型先在后台下载、解码（不摆、不编译）；云层全遮住时 enter 才摆上展台
  prefetch?(team: Team): void;
}

export interface Sheet {
  open(team: Team, route: Route): Promise<void> | void;
  close(): void;
}

// 「建一颗星球」的窗口（P3，ui/createPlanet.ts 装进来）：#/create 时盖在星系上打开，别的地址关掉
export interface CreatorLayer {
  open(): void;
  close(): void;
}

export class App {
  readonly world: World;
  readonly root: HTMLElement;
  readonly store: PlanetStore;
  readonly you: Seed['you'];
  readonly topbar: Topbar;
  readonly galaxyUi: GalaxyUi;
  teams: Team[];
  planetLayer: PlanetLayer | null = null;
  members: Sheet | null = null;
  museum: Sheet | null = null;
  creator: CreatorLayer | null = null;
  onEdit: () => void = () => {};
  onWalk: () => void = () => {};
  private currentTeamId: string | null = null;
  // 路由排队：一次切换（镜头飞行）进行中又来了新的跳转，只留最新的一个，等这次结束后执行，中间的跳过
  private readonly routes = new LatestQueue<Route>((route) => this.show(route), (err) => {
    console.error(err);
    toast('Something went wrong. Please try again.');
  });

  constructor(world: World, root: HTMLElement, store: PlanetStore, you: Seed['you'], teams: Team[]) {
    this.world = world;
    this.root = root;
    this.store = store;
    // 这个浏览器建过团队（P3）：那个团队就是「你的」（编辑、Visit your planet 都认它）；没建过时是种子里的演示身份。
    // 存一份副本：建好新团队时改的是它，不碰 seed.json 里的那个对象
    const mine = teams.find((t) => t.createdByYou);
    this.you = { ...you, ...(mine ? { teamId: mine.id } : {}) };
    this.teams = teams;
    const youHandle = teams.find((t) => t.id === you.teamId)?.members.find((m) => m.id === you.memberId)?.handle ?? 'you';
    this.topbar = new Topbar(root, youHandle, {
      back: () => this.navigate({ view: 'galaxy' }),
      members: () => { if (this.currentTeamId) this.navigate({ view: 'members', teamId: this.currentTeamId }); },
      museum: () => { if (this.currentTeamId) this.navigate({ view: 'museum', teamId: this.currentTeamId }); },
      walk: () => this.onWalk(),
      edit: () => this.onEdit(),
    });
    this.galaxyUi = new GalaxyUi(world, root, (teamId) => this.navigate({ view: 'planet', teamId }));
    installBadge(root); // 角落里的「Made with Tripo」
    installTransitionDebug(world); // window.__trans：转场自查脚本用
    world.setTeams(teams);
    // 开场飞行期间顶栏就显示星系标题；直接打开星球页时，show() 在第一次 await 之前就换成 showTeam
    this.topbar.showGalaxy(teams.length, teams.reduce((n, t) => n + t.works.length, 0));
  }

  get currentTeam(): Team | null {
    return this.teams.find((t) => t.id === this.currentTeamId) ?? null;
  }

  // navigate 已经改了地址栏、hashchange 还没派发（还没进路由队列）的那一下（hashchange 是异步派发的）
  private navPending = false;

  // 有跳转正在处理（或排着）；自查脚本用它等路由处理完。
  // navigate 改了地址、hashchange 还没到的那一下也算：不然地址已经是新的、队列却还空着，
  // 等「路由空闲」的人会在转场开始之前就当它到了（check-home：键盘进星球后马上点 Edit，星球还没进，编辑器什么都不做）
  get routing(): boolean {
    return this.routes.busy || this.navPending;
  }

  async start(): Promise<void> {
    addEventListener('hashchange', () => void this.queue(parseRoute(location.hash)));
    const first = parseRoute(location.hash);
    if (first.view === 'galaxy' || first.view === 'create') await this.world.intro(); // #/create 的窗口盖在星系上：开场照样飞进星系
    await this.queue(first);
    window.__ready = true;
    // 开场的品牌露出：飞行落定、还停在星系全景上时，翠宝从一颗星球后面探头挥手（不等它，路由照常）
    // 开场的星尘拼标志放完了才探头（两个不同时出现）
    if (first.view === 'galaxy') void (this.world.galaxy?.shapeDone() ?? Promise.resolve()).then(() => { if (!this.currentTeamId && !this.routing) this.world.director.peekIntro(); });
  }

  // replace：替换当前这条历史记录（重定向用），后退时不会回到出错的地址又被弹回来
  navigate(route: Route, opts: { replace?: boolean } = {}): void {
    const hash = toHash(route);
    const before = location.hash;
    if (before === hash || (hash === '#/' && before === '')) {
      void this.queue(route);
      return;
    }
    this.navPending = true; // hashchange 到了、进了队列（queue）才清掉
    if (opts.replace) location.replace(hash);
    else location.hash = hash;
    // 地址其实没变（编码以后和原来一样）：不会有 hashchange，直接排进队列，免得一直算在跳转
    if (location.hash === before) void this.queue(route);
  }

  // Members / Museum 关闭后回到当前星球
  closeSheet(): void {
    if (this.currentTeamId) this.navigate({ view: 'planet', teamId: this.currentTeamId });
  }

  // 编辑器保存后同步：更新内存里的团队数据和星系里那颗星球
  replaceTeam(team: Team): void {
    this.teams = this.teams.map((t) => (t.id === team.id ? team : t));
    this.world.updateTeam(team);
  }

  // 新团队加入（P3：「Create a planet」建好以后，ui/createPlanetLaunch.ts 调）：记进团队列表，星系里加一颗星球（World.addPlanet：
  // 马上登记，着色器在后台编好才挂进场景，首页版式跟着重排）。是「你」建的就成了「你的星球」：首页把它放到前排正中
  // （别的星球慢慢挪开）、名牌写 You，Visit your planet 也去它那里（ui/home.ts 读 app.you）
  // claim = false：先不让它成为「你的星球」（造星的转场在蓄力时才调 claimYou，原来的你的星球那时才让开）
  // prebuilt：造星窗口里预热好的那颗星球（见 World.addPlanet）；不给时和原来一样新建
  addTeam(team: Team, claim = true, prebuilt?: PlanetObject): void {
    if (this.teams.some((t) => t.id === team.id)) return;
    this.teams = [...this.teams, team];
    this.world.addPlanet(team, prebuilt);
    if (team.createdByYou && claim) this.claimYou(team.id);
    if (!this.currentTeamId) this.topbar.showGalaxy(this.teams.length, this.teams.reduce((n, t) => n + t.works.length, 0));
  }

  // 这个团队成了「你的星球」：首页把它放到你的位置（别的星球慢慢挪开）、名牌写 You，Visit your planet 也去它那里
  claimYou(teamId: string): void {
    this.you.teamId = teamId;
    this.world.setYou(teamId, true);
    this.galaxyUi.setYou(teamId);
  }

  // 返回的 Promise 在这次跳转（或取代它的更新的那次）处理完时 resolve
  private queue(route: Route): Promise<void> {
    this.navPending = false;
    return this.routes.push(route);
  }

  private async show(route: Route): Promise<void> {
    // #/create（P3）：盖在星系上的造星窗口。别的地址先关掉它；#/create 本身按星系处理（在星球上就先回星系），落定后打开
    if (route.view !== 'create') this.creator?.close();
    const team = route.view === 'galaxy' || route.view === 'create' ? null : this.teams.find((t) => t.id === route.teamId) ?? null;
    if (route.view !== 'galaxy' && route.view !== 'create' && !team) {
      toast('That team does not exist');
      // 地址栏已经换成别的了（用户在排队期间又去了别处，那次跳转已经排上）：只提示，不把新地址改回星系
      if (isCurrentRoute(route)) this.navigate({ view: 'galaxy' }, { replace: true });
      return;
    }
    // 同一团队的同一种页面之间切换（比如 Museum 里打开某件作品）不关页面
    const sameTeam = team !== null && team.id === this.currentTeamId;
    if (route.view !== 'members' || !sameTeam) this.members?.close();
    if (route.view !== 'museum' || !sameTeam) this.museum?.close();
    if (!team) {
      if (this.currentTeamId) {
        this.currentTeamId = null;
        // 作品在云层全遮住时才撤下（转场开头那一下看不见）；转场没走到那一步时（测试里的假世界）落地后补上
        let left = false;
        const leave = () => {
          if (left) return;
          left = true;
          this.planetLayer?.leave();
        };
        await this.world.unfocus({ covered: leave });
        leave();
      }
      this.topbar.showGalaxy(this.teams.length, this.teams.reduce((n, t) => n + t.works.length, 0));
      this.galaxyUi.setEnabled(true);
      if (route.view === 'create') this.creator?.open();
      return;
    }
    this.galaxyUi.setEnabled(false);
    if (!sameTeam) {
      // 模型在转场一开始就先下载、解码（加载藏在转场里）；展台在云层全遮住时才摆（第一次画展台、编译作品着色器的那一帧
      // 在 WebGL2 上要 30–50 ms，藏在云里看不见），World 先把作品排着，云散开时依次弹出来。
      // 从另一颗星球跳过来：旧星球的作品也是这时才撤下。都不等模型
      const hop = this.currentTeamId !== null;
      let entered = false;
      const swap = () => {
        if (entered) return;
        entered = true;
        if (hop) this.planetLayer?.leave();
        this.planetLayer?.enter(team);
      };
      this.currentTeamId = team.id;
      this.topbar.showTeam(team, team.id === this.you.teamId);
      this.planetLayer?.prefetch?.(team);
      await this.world.focus(team.id, { covered: swap });
      swap(); // 转场没走到全遮住那一步（测试里的假世界）：落地后补上
    }
    if (route.view === 'members') await this.members?.open(team, route);
    if (route.view === 'museum') await this.museum?.open(team, route);
  }
}
