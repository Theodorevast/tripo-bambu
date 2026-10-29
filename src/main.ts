// 第二版的字体（OFL，自托管，src/assets/fonts/）：Cinzel 写大写标题，Cormorant Garamond 写副标题和说明，Inter 写界面小字。不再用 Nunito
import './ui/fonts-v2.css';
import './ui/styles.css';
import { App, type Sheet } from './app';
import { applyLocalWorks } from './assets/localWorks';
import seedJson from './data/seed.json';
import { browserStorage, LocalStore } from './data/store';
import type { Seed } from './data/types';
import { World } from './scenes/world';
import { PlanetScreen } from './ui/planetScreen';
import { MembersPage } from './ui/membersPage';
import { MuseumPage } from './ui/museumPage';
import { installDebugHooks } from './debug';
import { Editor } from './editor/editor';
import { installWalkDebug } from './play/debug';
import { WalkMode } from './play/walkMode';
import { startBoot } from './ui/boot';
import { installWater } from './nature/water';
import { installCoupons } from './fun/coupons';
import { installHomeTriboo } from './fun/couponsHome';
import { installHome } from './ui/home';
import { installTuneToggle } from './ui/tuneToggle';
import { installCreatePlanet } from './ui/createPlanet';
import { installCloudTriboo } from './scenes/homeCloudTriboo';
import { installHomeTribooTune } from './scenes/homeTribooTune';
// 第二版的界面主题（午夜天文台：深色半透明面板、香槟金细线、衬线字）：放在所有 import 的最后，
// 盖过 styles.css 和各模块自带的 CSS（cobrand、badge、coupons、createPlanet、walk）；旧的 CSS 文件不动
import './ui/theme-v2.css';

// 启动：读数据 → 建 3D 世界 → 装配各个页面 → 按地址显示
// 启动画面（index.html 的 #boot，页面一打开就有）跟着走三个阶段，3D 准备好后淡出；界面用到的几种字体从这里开始在后台预加载
const boot = startBoot();
// 本机有私有的真实模型时（开发环境，.tmp/local-models/），「你的星球」上的占位作品换成它们（assets/localWorks.ts）
const seed = await applyLocalWorks(seedJson as unknown as Seed);
const store = new LocalStore(seed, browserStorage());
await boot.phase('sky');
// 建不起来（没有 WebGPU 也没有 WebGL2，或者别的错）：停在启动画面上提示，后面的不再执行
const world = await World.create(document.querySelector<HTMLCanvasElement>('#stage')!).catch(boot.fail);
installWater(world); // 水面每帧取雨量、角色涉水放波纹
const app = new App(world, document.querySelector<HTMLDivElement>('#app')!, store, seed.you, await store.listTeams());
const home = installHome(app); // 首页（H2）：你的星球放前排正中、名牌写 You、「Visit your planet」
const planetScreen = new PlanetScreen(world, app.root, (teamId, workId) => app.navigate({ view: 'museum', teamId, workId }));
const editor = new Editor(app, planetScreen);
const walk = new WalkMode(app, planetScreen);
const coupons = installCoupons(app, planetScreen, walk, editor); // 点翠宝吐优惠券（fun/coupons.ts）：站桩和漫游的翠宝能点，模型、着色器在后台预热
installHomeTriboo(app, coupons, home); // 首页右下角躲着的翠宝（H2）：点它吐一张券，展开成领券窗口
installCloudTriboo(world); // 首页翠宝元素①：云海上空一朵翠宝形状的云（scenes/homeCloudTriboo.ts；开场预热之前装上，一起编译）
installHomeTribooTune(world); // ?tune → Home → Cloud Triboo / Stardust Triboo
installCreatePlanet(app, store); // P3：#/create 造星窗口、首页标题卡片的「Create a planet」接上 openCreatePlanet、新星球从云海升起来（ui/createPlanet*.ts）
app.planetLayer = {
  enter: (team) => {
    planetScreen.enter(team); // 立即返回：展台马上摆好，模型在后台加载
    editor.restoreTempWorks(team); // 这次页面里摆过的临时作品不在存档里，回到自己的星球时重新摆上
  },
  leave: () => { walk.exit(true); editor.deactivate(); planetScreen.leave(); },
  // 转场一开始先下载、解码摆着的作品的模型，解码完马上开始准备（贴图、着色器）；云层全遮住时 enter 摆展台，直接接过准备好的（F2）
  prefetch: (team) => planetScreen.view.prepareAhead(team),
};
// Members / Museum 打开时先退出编辑：看不见星球时 Delete、Q / E 不能再改它，拖到一半的位置也先存好
let openSheet: Sheet | null = null;
const sheet = (s: Sheet): Sheet => ({
  open: (team, route) => {
    walk.exit(true);
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
  walk.exit(true); // 编辑和漫游互斥：漫游中点 Edit，镜头立刻回到轨道镜头再进编辑
  editor.toggle();
};
app.onWalk = () => {
  if (openSheet) app.closeSheet();
  editor.deactivate();
  walk.toggle();
};
installDebugHooks(app, planetScreen);
installWalkDebug(app, walk);
app.members = sheet(new MembersPage(app.root, seed.you.memberId, () => app.closeSheet(), (workId) => {
  const team = app.currentTeam;
  if (team) app.navigate({ view: 'museum', teamId: team.id, workId });
}));
app.museum = sheet(new MuseumPage(app.root, world, () => app.closeSheet(), (workId) => {
  const team = app.currentTeam;
  if (team) app.navigate(workId ? { view: 'museum', teamId: team.id, workId } : { view: 'museum', teamId: team.id });
}));
// 地址带 ?tune：实时调参面板。动态加载，Tweakpane 打成单独的包，平时不下载
// 只有带 ?tune 时，左上角标题卡片上才有「Tune」按钮（开关面板，ui/tuneToggle.ts）；平时不显示按钮、不打开面板（用户：先不开放 tune）
if (new URLSearchParams(location.search).has('tune')) installTuneToggle(app.topbar, world);
await boot.phase('warm');
// 星球都摆进场景了：开场之前在后台把着色器编译好，开场飞行的第一帧不卡
await world.warmUp();
await boot.phase('land');
boot.reveal(); // 不等：云散开和开场飞行同时进行
await app.start();
void walk.preload(); // 角色模型在后台加载、预编译：第一次点 Walk 时不卡
