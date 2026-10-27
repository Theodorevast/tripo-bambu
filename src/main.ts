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

// 启动：读数据 → 建 3D 世界 → 装配各个页面 → 按地址显示
const seed = seedJson as unknown as Seed;
const store = new LocalStore(seed, browserStorage());
const world = await World.create(document.querySelector<HTMLCanvasElement>('#stage')!);
const app = new App(world, document.querySelector<HTMLDivElement>('#app')!, store, seed.you, await store.listTeams());
await app.start();
