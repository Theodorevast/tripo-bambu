import type { PlanetStore } from './data/store';
import type { Seed, Team } from './data/types';
import { parseRoute, toHash, type Route } from './router';
import type { World } from './scenes/world';
import { GalaxyUi } from './ui/galaxyUi';
import { toast } from './ui/toast';
import { Topbar } from './ui/topbar';

// 星球页上叠加的内容（作品、编辑器）和覆盖整屏的页面（Members、Museum）由 main.ts 装进来
export interface PlanetLayer {
  enter(team: Team): Promise<void>;
  leave(): void;
}

export interface Sheet {
  open(team: Team, route: Route): Promise<void> | void;
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
  onEdit: () => void = () => {};
  private currentTeamId: string | null = null;
  private routing: Promise<void> = Promise.resolve();

  constructor(world: World, root: HTMLElement, store: PlanetStore, you: Seed['you'], teams: Team[]) {
    this.world = world;
    this.root = root;
    this.store = store;
    this.you = you;
    this.teams = teams;
    const youHandle = teams.find((t) => t.id === you.teamId)?.members.find((m) => m.id === you.memberId)?.handle ?? 'you';
    this.topbar = new Topbar(root, youHandle, {
      back: () => this.navigate({ view: 'galaxy' }),
      members: () => { if (this.currentTeamId) this.navigate({ view: 'members', teamId: this.currentTeamId }); },
      museum: () => { if (this.currentTeamId) this.navigate({ view: 'museum', teamId: this.currentTeamId }); },
      edit: () => this.onEdit(),
    });
    this.galaxyUi = new GalaxyUi(world, root, (teamId) => this.navigate({ view: 'planet', teamId }));
    world.setTeams(teams);
    // 开场飞行期间顶栏就显示星系标题；直接打开星球页时，show() 在第一次 await 之前就换成 showTeam
    this.topbar.showGalaxy(teams.length, teams.reduce((n, t) => n + t.works.length, 0));
  }

  get currentTeam(): Team | null {
    return this.teams.find((t) => t.id === this.currentTeamId) ?? null;
  }

  async start(): Promise<void> {
    addEventListener('hashchange', () => void this.queue(parseRoute(location.hash)));
    const first = parseRoute(location.hash);
    if (first.view === 'galaxy') await this.world.intro();
    await this.queue(first);
    window.__ready = true;
  }

  // replace：替换当前这条历史记录（重定向用），后退时不会回到出错的地址又被弹回来
  navigate(route: Route, opts: { replace?: boolean } = {}): void {
    const hash = toHash(route);
    if (location.hash === hash || (hash === '#/' && location.hash === '')) void this.queue(route);
    else if (opts.replace) location.replace(hash);
    else location.hash = hash;
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

  // 路由串行处理：上一次切换（飞行、加载模型）结束后再处理下一次
  private queue(route: Route): Promise<void> {
    this.routing = this.routing
      .then(() => this.show(route))
      .catch((err: unknown) => {
        console.error(err);
        toast('Something went wrong. Please try again.');
      });
    return this.routing;
  }

  private async show(route: Route): Promise<void> {
    const team = route.view === 'galaxy' ? null : this.teams.find((t) => t.id === route.teamId) ?? null;
    if (route.view !== 'galaxy' && !team) {
      toast('That team does not exist');
      this.navigate({ view: 'galaxy' }, { replace: true });
      return;
    }
    // 同一团队的同一种页面之间切换（比如 Museum 里打开某件作品）不关页面
    const sameTeam = team !== null && team.id === this.currentTeamId;
    if (route.view !== 'members' || !sameTeam) this.members?.close();
    if (route.view !== 'museum' || !sameTeam) this.museum?.close();
    if (!team) {
      if (this.currentTeamId) {
        this.planetLayer?.leave();
        this.currentTeamId = null;
        await this.world.unfocus();
      }
      this.topbar.showGalaxy(this.teams.length, this.teams.reduce((n, t) => n + t.works.length, 0));
      this.galaxyUi.setEnabled(true);
      return;
    }
    this.galaxyUi.setEnabled(false);
    if (!sameTeam) {
      this.planetLayer?.leave();
      this.currentTeamId = team.id;
      this.topbar.showTeam(team, team.id === this.you.teamId);
      await this.world.focus(team.id);
      await this.planetLayer?.enter(team);
    }
    if (route.view === 'members') await this.members?.open(team, route);
    if (route.view === 'museum') await this.museum?.open(team, route);
  }
}
