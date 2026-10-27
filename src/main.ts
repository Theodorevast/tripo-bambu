import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/500-italic.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-mono/400.css';
import './ui/styles.css';
import { App, type Sheet } from './app';
import seedJson from './data/seed.json';
import { browserStorage, LocalStore } from './data/store';
import type { Seed } from './data/types';
import { World } from './scenes/world';
import { PlanetScreen } from './ui/planetScreen';
import { MembersPage } from './ui/membersPage';
import { MuseumPage } from './ui/museumPage';
import { installDebugHooks } from './debug';
import { Editor } from './editor/editor';

// 启动：读数据 → 建 3D 世界 → 装配各个页面 → 按地址显示
const seed = seedJson as unknown as Seed;
const store = new LocalStore(seed, browserStorage());
const world = await World.create(document.querySelector<HTMLCanvasElement>('#stage')!);
const app = new App(world, document.querySelector<HTMLDivElement>('#app')!, store, seed.you, await store.listTeams());
const planetScreen = new PlanetScreen(world, app.root, (teamId, workId) => app.navigate({ view: 'museum', teamId, workId }));
const editor = new Editor(app, planetScreen);
app.planetLayer = {
  enter: (team) => {
    planetScreen.enter(team); // 立即返回：展台马上摆好，模型在后台加载
    editor.restoreTempWorks(team); // 这次页面里摆过的临时作品不在存档里，回到自己的星球时重新摆上
  },
  leave: () => { editor.deactivate(); planetScreen.leave(); },
};
// Members / Museum 打开时先退出编辑：看不见星球时 Delete、Q / E 不能再改它，拖到一半的位置也先存好
let openSheet: Sheet | null = null;
const sheet = (s: Sheet): Sheet => ({
  open: (team, route) => {
    editor.deactivate();
    openSheet = s;
    return s.open(team, route);
  },
  close: () => {
    if (openSheet === s) openSheet = null;
    s.close();
  },
});
// 顶栏压在 Members / Museum 上面，开着页面也点得到 Edit：先回星球页（关掉页面），再切换编辑
app.onEdit = () => {
  if (openSheet) app.closeSheet();
  editor.toggle();
};
installDebugHooks(app, planetScreen);
app.members = sheet(new MembersPage(app.root, seed.you.memberId, () => app.closeSheet(), (workId) => {
  const team = app.currentTeam;
  if (team) app.navigate({ view: 'museum', teamId: team.id, workId });
}));
app.museum = sheet(new MuseumPage(app.root, world, () => app.closeSheet(), (workId) => {
  const team = app.currentTeam;
  if (team) app.navigate(workId ? { view: 'museum', teamId: team.id, workId } : { view: 'museum', teamId: team.id });
}));
await app.start();
