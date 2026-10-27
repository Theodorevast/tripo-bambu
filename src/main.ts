import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/500-italic.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-mono/400.css';
import './ui/styles.css';
import { App } from './app';
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
app.planetLayer = { enter: (team) => planetScreen.enter(team), leave: () => { editor.deactivate(); planetScreen.leave(); } };
app.onEdit = () => editor.toggle();
installDebugHooks(app, planetScreen);
app.members = new MembersPage(app.root, seed.you.memberId, () => app.closeSheet(), (workId) => {
  const team = app.currentTeam;
  if (team) app.navigate({ view: 'museum', teamId: team.id, workId });
});
app.museum = new MuseumPage(app.root, world, () => app.closeSheet(), (workId) => {
  const team = app.currentTeam;
  if (team) app.navigate(workId ? { view: 'museum', teamId: team.id, workId } : { view: 'museum', teamId: team.id });
});
await app.start();
