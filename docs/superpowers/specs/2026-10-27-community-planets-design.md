# gbn：社区星球 demo 设计

> 日期：2026年10月27日
> 状态：方案 A 和整体设计已由用户确认（2026-10-27）；文末「替用户做的细节决定」是写 spec 时补的，用户可以否决
> 工作标题：Community Planets（可改）

## 目标与约束

一个海外 3D 建模社区想让成员组队建造星球：几个成员组成一个团队，一个团队共建一颗星球，把各自做的模型摆上去；每颗星球有成员页和博物馆；所有团队的星球组成一片社区星系。本次只做内部演示或提案用的 demo，让人看到这个点子能成立。

| 约束 | 内容 |
|---|---|
| 截止 | 2026年10月29日（周四）中午交可访问的链接 |
| 用途 | 内部演示、提案。数据用假的，不接真后端 |
| 社区 | 海外 3D 建模社区，平时在 Discord 活动；界面用英文 |
| 平台 | 桌面浏览器优先（最新版 Chrome、Edge、Safari、Firefox）；手机能打开、不出错即可，不做手机专属操作 |
| 分享 | 部署成静态网站发链接；平台和部署时间要用户同意 |
| 模型 | 用户提供 10–20 个社区作品 GLB 和作品信息；作者是否同意公开由用户确认 |
| 许可 | 不用 AGPL、GPL、专有许可的库（沿用 `工具/13-网页交互.md` 的许可红灯清单） |

## 方案选择

| 方案 | 结论 | 理由 |
|---|---|---|
| A. 原生 TS + three.js（`three/webgpu`）+ HTML/CSS 界面 | **采用** | 直接复制万圣节项目的工程；本机的 threejs-* skills 都是按这套写的；AI 能用 Playwright 截图自己检查 |
| B. React + React Three Fiber + drei | 不用 | 界面写得快，但和现有工程、skills 都不一样，3 天里换技术栈风险大 |
| C. Godot 4.7 导出网页 | 不用 | Web 导出只能用 WebGL2，空项目 brotli 压缩后约 7 MiB，要整包下载完才能启动；上传 GLB、页面跳转这类网页功能要通过 JavaScriptBridge 绕一层；AI 只能手改 .tscn，每看一次效果都要重新导出 |

## 1. 概念：三层结构

| 层 | 对应 | 画面 |
|---|---|---|
| 我 | 成员和自己的作品 | Members 页 |
| 我们 | 团队和团队的星球 | 星球视图、Museum 页 |
| 大家 | 整个社区 | 星系 |

凝聚感来自「看见彼此」：星球让团队有一样共同的东西，星系让每个团队看到自己是社区的一部分。

## 2. 演示流程与画面

演示身份：第一个有作品的团队里的一位虚构成员，界面右上角显示「Signed in as @<handle> · You」。只有这个团队的星球能编辑。

### 2.1 星系（Galaxy）

- 深色太空背景，有星点和淡淡的星云，里面漂着 14–16 颗星球：4–6 个有作品的团队，加 10 个 under construction 的团队。
- 星球排成一个松散的圆盘，整体缓慢转动；可以拖动鼠标旋转视角，滚轮缩放（有上下限）。
- 悬停一颗星球：星球描边高亮，旁边显示团队名和成员数。
- 点击：镜头用约 1.2 秒的缓入缓出飞到这颗星球，进入星球视图。
- 星系里的星球用低细分网格，不加载任何模型，所以首屏很快。

### 2.2 星球视图（Planet）

- 聚焦时，这颗星球换成高细分网格，并加载该团队的模型；模型加载完之前，先显示半透明的展台。
- 每件作品立在一个小圆形展台上，展台颜色取团队主色。
- 镜头绕星球中心转动（OrbitControls，带阻尼，限制远近）。
- 悬停作品：作品高亮，上方显示作品名标签。
- 点击作品：右侧弹出作品卡，显示作品名、作者、所属团队、面数、简介（有的话），以及「View in Museum」按钮。
- 顶栏：团队名和口号；按钮 Members、Museum、Edit（只有你的团队有）、← Galaxy。
- under construction 的星球没有作品，中间显示「<团队名> is still building · N members · founded N days ago」；Members 页照常显示，Museum 页显示「No works yet」。

### 2.3 Members 页

一个盖在星球视图上的面板，背后的星球变暗。每个成员一行：头像（用首字母和团队色生成）、显示名、@handle、角色（Captain / Builder）、作品数，以及这位成员作品的缩略图。点缩略图会打开 Museum，并定位到那件作品。

### 2.4 Museum 页

- 整屏的作品网格，作品按 `seed.json` 里的顺序排列。每张卡片里有一个慢慢自转的 3D 模型，下面写作品名和作者。
- 所有卡片共用一个 canvas，按卡片在页面上的位置分区渲染（scissor），只渲染当前在屏幕里的卡片。
- 点卡片打开大图查看器：可以拖动 360° 旋转，滚轮缩放，旁边显示作品信息；按 Esc 或点 × 关闭。
- 如果分区渲染行不通（见第 12 节），就改成静态缩略图，点开后再用单个 3D 查看器。

### 2.5 编辑（Edit，只限你的团队）

- 点顶栏的 Edit 进入编辑模式，按钮变成 Done；点 Done 退出。编辑模式下点作品是选中它，不弹作品卡。
- 底部作品栏：团队全部作品的缩略图，外加一个「Drop GLB here」区域。
- 每件作品在星球上最多出现一次。作品栏里已经摆上去的作品带勾号，再点它，镜头会转到它所在的位置。
- 选中一件还没摆的作品后，鼠标在星球上移动时会显示它的半透明预览，已经贴合地表、朝向法线；点击就放下。
- 点选一件已经放好的作品，旁边会出现编辑条：
  - 拖动作品：沿球面移动；
  - 旋转：Q / E 键每次转 15°，或拖编辑条上的旋转滑块；
  - 缩放：编辑条上的滑块，范围 0.5–2 倍；
  - 删除：Delete 键或编辑条上的按钮。
- 星球外观面板：5 套预设（见 4.2）、光环开关、大气开关、「Reroll terrain」（换一个新种子）。换预设或换种子后，已放的作品保持方向不变，自动贴到新的地表上。
- 每次修改都自动存进浏览器本地存储。
- 「Reset demo」按钮：清掉本地修改，恢复初始数据，方便反复演示。
- 从电脑拖进来的 GLB 会作为一件临时作品出现在作品栏里，作者是你。它只出现在作品栏和星球上，不进 Museum；只在当前页面有效，不写进存档，刷新后就消失。

### 2.6 链接（hash 路由）

每个画面都有自己的地址，浏览器的后退键能用，演示时也能直接发某颗星球或某件作品的链接：

| 地址 | 画面 |
|---|---|
| `#/` | 星系 |
| `#/t/<teamId>` | 星球视图 |
| `#/t/<teamId>/members` | Members |
| `#/t/<teamId>/museum` | Museum |
| `#/t/<teamId>/museum/<workId>` | Museum 里打开的那件作品 |

## 3. 范围

| 优先级 | 内容 |
|---|---|
| P0（必须） | 第 2 节的全部画面和链接、本地保存、Reset demo、模型处理脚本、部署（用户同意后） |
| P1（有时间再做） | 「Found a planet」新建团队流程，以及新星球飞进星系的入住动画；环境音和界面音效（遵守 `工具/04-程序化合成.md` 的风格规则） |
| 不做 | 账号、真后端、多人实时协作、内容审核、手机专属操作、作品重叠检测、模型减面 |

## 4. 星球生成

### 4.1 配方

一颗星球完全由配方决定。同一份配方，在任何设备上都会生成一模一样的星球：

```ts
type PresetId = 'verdant' | 'desert' | 'glacier' | 'volcanic' | 'coral';

interface Placement {
  workId: string;
  dir: [number, number, number]; // 单位向量：作品在球面上的方向
  yaw: number;                   // 绕法线的旋转，弧度
  scale: number;                 // 0.5–2
}

interface PlanetRecipe {
  seed: number;
  preset: PresetId;
  ring: boolean;
  atmosphere: boolean;
  placements: Placement[];
}
```

位置用单位向量表示，不用经纬度，这样两极附近不会出现奇点。

### 4.2 生成步骤

1. 用 `seed` 初始化一个结果可复现的随机数生成器（mulberry32）。
2. `heightAt(dir)`：用多层 simplex 噪声（fBm）算出这个方向上地面到球心的距离。基础半径是 10，起伏的幅度和频率由预设决定。
3. 网格：按 `heightAt` 移动 `IcosahedronGeometry` 的顶点，按高度分段上顶点色，用平直着色（低多边形风格）。星系里用低细分，聚焦时用高细分（约 2 万个三角面）。
4. 海洋：在海平面半径处单独放一个球，半透明、低粗糙度。
5. 大气：一个略大的外壳，渲染背面，用 TSL 写 fresnel 边缘发光（参考 three.js 官方的 `webgpu_tsl_earth` 示例）。
6. 光环：`RingGeometry`，用 TSL 做径向渐变。

五套预设：

| 预设 | 地表 | 海洋 | 大气 |
|---|---|---|---|
| verdant | 绿、褐，山顶有雪 | 有，蓝色 | 淡蓝 |
| desert | 沙黄、赭红 | 无 | 暖橙 |
| glacier | 白、冰蓝 | 有，深蓝 | 青白 |
| volcanic | 玄武岩的黑灰色，低处是熔岩橙 | 无 | 暗红 |
| coral | 粉、桃、薄荷绿 | 有，青绿 | 淡粉 |

配色整体压低饱和度，不抢作品的风头。

### 4.3 摆放的数学

- 位置：作品贴在「展台底下最高的地面」上。展台顶面半径 `r = max(0.55, 0.95 × 模型水平半径) × scale`。取 `dir` 本身，再以 `dir` 为中心、在球心角 `r / 基础半径` 的一圈上均匀取 8 个方向，每个方向算 `max(heightAt(p), 海平面半径)`，取最大值 `g`。作品根节点放在 `dir × g`，展台顶面再高出 `0.18 × scale`。展台是一根往地下延伸 `2.0 × scale` 的圆柱：上坡一侧不会埋住展台顶面，下坡一侧靠这一段补上，既不悬空也不露缝。落在水面上的作品，展台顶面高出水面 `0.18 × scale`。编辑器的摆放预览用同一个公式，放下时不会跳。代码见 `src/planet/footprint.ts` 的 `footprintGroundRadius` 和 `src/scenes/planetView.ts` 的 `plinthRadius`。
  （原先的公式是 `dir × (max(heightAt(dir), 海平面半径) + 展台高度)`，只看中心一点，在陡坡上会让展台一边悬空、一边埋进地里。）
- 朝向：先用 `Quaternion.setFromUnitVectors((0,1,0), dir)` 把模型的「上」对准法线，再绕 `dir` 转 `yaw`。
- 统一尺寸：按包围盒把每个模型的最长边缩放到同一个长度（基础半径 10 的星球上为 2.0，可调），再乘 `scale`；模型水平居中，底部贴住展台。所有作品一样大，大模型就不会把小模型衬成一个小点。用最长边而不用高度，是因为按高度统一会把扁平的模型（比如一辆车）放得非常宽。
- 拾取：射线直接打星球网格。顶点是在 CPU 上移动的，所以打中的就是真实地表；网格约 2 万面，不需要 BVH。把打中的点归一化，就得到 `dir`。
- 拾取作品：射线只打每件作品的不可见拾取盒，高面数模型也不卡。以星球中心为心、`基础半径 × (1 − amp)` 为半径的球是「遮挡球」（地形最低也不会低于它）；拾取盒的命中如果比射线进入遮挡球的点更远，就一定在星球背后，直接忽略。悬浮标签用同一个测试，作品转到背面时标签消失。

## 5. 数据

```ts
interface Member {
  id: string;
  handle: string;        // 不带 @
  displayName: string;
  role: 'captain' | 'builder';
}

interface Work {
  id: string;
  title: string;
  authorId: string;      // 指向 Member.id
  file: string;          // public/models/ 下的文件名
  thumb: string;         // public/thumbs/ 下的文件名
  tris: number;
  description?: string;
}

interface Team {
  id: string;
  name: string;
  motto: string;
  color: string;         // 团队主色，十六进制
  status: 'active' | 'under-construction';
  foundedDaysAgo: number;
  members: Member[];
  works: Work[];
  planet: PlanetRecipe;
}
```

- `src/data/seed.json`：所有团队的初始数据，由 `scripts/build-seed.mjs` 生成，输入是 `src/data/teams.template.json`（16 个虚构团队的名字、口号、配色、星球参数和虚构成员）和 `src/data/works.json`（作品清单，由第 6 节的处理脚本生成；GLB 到之前是占位作品）。作品作者用用户表里的名字，团队名、口号和其余成员是虚构的。每个有作品的团队放 3–4 件作品，团队数 = 作品总数 ÷ 3.5 四舍五入，最多 6 个（10–12 件作品时是 3 个，13 件起是 4–6 个）。同一作者的作品放进同一个团队。另有 10 个 under construction 的团队。
- 星系里的位置不存储，由团队在列表里的顺序确定性地算出来。
- `PlanetStore` 接口：

```ts
interface PlanetStore {
  listTeams(): Promise<Team[]>;
  getTeam(id: string): Promise<Team | undefined>;
  savePlanet(teamId: string, planet: PlanetRecipe): Promise<void>;
  reset(): Promise<void>;
}
```

- 这次实现 `LocalStore`：读取 `seed.json`，再叠加本地存储里的修改（键名 `gbn:v1:planets`，只存改过的星球配方）。以后换真后端，只需要另写一个实现。
- 本地存储不能用时（比如隐私模式），修改只存在内存里。

## 6. 模型处理

用户把 GLB 放进 `models-in/`（这个目录不入库），并填写一张 `models-in/works.csv`：

```csv
file,title,author,description
lighthouse.glb,Old Lighthouse,mia,
```

`scripts/prep-models.mjs` 对每个文件做这几件事：

1. 用 gltf-transform（MIT）清理用不到的数据、合并重复顶点，把网格压缩成 meshopt 格式，把贴图的最长边缩到 2048 以内并转成 WebP。不减面。
2. 输出到 `public/models/<workId>.glb`。
3. 用 Playwright 打开一个只渲染单个模型的页面，在中性背景上截一张 512×512 的缩略图，存成 `public/thumbs/<workId>.webp`。
4. 写 `models-in/prep-report.json`：每个文件处理前后的大小和面数。面数超过 50 万，或者处理后仍然超过 15 MB 的，在报告里标出来，由用户决定要不要换。
5. 写 `src/data/works.json`，然后运行 `npm run seed` 重新生成 `seed.json`。

运行时用 `GLTFLoader` + `MeshoptDecoder` 加载。

GLB 到之前，用程序生成的彩色几何体当占位模型，缩略图用纯色块，其他开发照常进行。

## 7. 架构

```
src/
  main.ts            启动、路由、场景切换
  router.ts          hash 路由
  data/              types.ts、seed.json、store.ts（PlanetStore + LocalStore）
  planet/            rng.ts、noise.ts（heightAt）、presets.ts、generate.ts（配方 → 网格，纯函数）、
                     materials.ts（地表、海洋、大气、光环，TSL）、placement.ts（第 4.3 节的数学）
  scenes/            galaxy.ts、planetView.ts、camera.ts（飞行过渡）
  museum/            previews.ts（共享 canvas 分区渲染）、viewer.ts（大图查看器）
  editor/            editor.ts（选择、拾取、拖动、旋转、缩放、删除）、dropGlb.ts
  assets/            models.ts（加载、缓存、尺寸归一化）
  ui/                topbar.ts、workCard.ts、membersPage.ts、museumPage.ts、editPanel.ts、styles.css
scripts/
  prep-models.mjs    第 6 节
  smoke.mjs          Playwright 冒烟测试
tests/               vitest
public/models/  public/thumbs/
```

- 技术栈照搬万圣节项目：Vite 8、TypeScript、three 0.186（`three/webgpu`）、vitest、playwright-core。
- 星系和星球共用一个渲染器；Museum 页的卡片预览共用一个 canvas，大图查看器另用一个 canvas。
- 上面是主要模块；完整的文件清单以实现计划（`docs/superpowers/plans/2026-10-27-community-planets.md`）为准。
- 所有自定义材质都用 TSL 写。`WebGPURenderer` 不支持 `ShaderMaterial`、`RawShaderMaterial`、`onBeforeCompile` 和 `EffectComposer`，所以用 GLSL 写的现成星球代码只能参考，不能直接拿来用。
- 界面是原生 HTML/CSS，盖在 canvas 上面。

数据只往一个方向流：

```
seed.json + 本地修改 → PlanetStore → Team / PlanetRecipe → generate → 场景
编辑操作 → 修改 PlanetRecipe → store.savePlanet → 重新生成受影响的部分
```

## 8. 视觉方向

- 模型是主角，星球只是展台：用摄影棚式的柔和主光加环境补光，让不同风格的作品都好看。
- 星球配色饱和度低；背景是深色太空，有星点和淡淡的星云。
- 界面参考博物馆的展签：标题用衬线字体，正文用无衬线字体，留白多，信息层级清楚。
- 审美类 skill 用 frontend-design-2（沿用 工具 的约定）。
- 周二晚上先发截图给用户确认方向，确认后再往下做。

## 9. 出错时的处理

| 情况 | 处理 |
|---|---|
| 某个 GLB 加载失败 | 在该位置显示灰色占位体，作品卡上注明「Model failed to load」；其他作品照常显示 |
| 浏览器不支持 WebGPU | three.js 自动改用 WebGL2 |
| 拖进来的文件不是 GLB，或者超过 100 MB | 拒绝，并显示提示 |
| 本地存储不能用 | 修改只存在内存里，刷新后恢复初始数据 |
| 地址里的团队不存在 | 回到星系，并显示提示 |
| 地址里的作品不在这个团队的 Museum 里 | 留在该团队的 Museum 网格，并显示提示 |

## 10. 测试

- 用 vitest 测纯逻辑：
  - 同一份配方生成的顶点完全一样，不同种子生成的不一样；
  - `heightAt` 的结果在预设给定的范围内；
  - 摆放：作品位于地表上方展台高度处，模型的「上」和法线方向一致；
  - 尺寸归一化后的高度等于目标高度乘以 `scale`；
  - LocalStore：保存、读取、叠加、reset；
  - 路由：每种地址都解析正确。
- `scripts/smoke.mjs`（Playwright）依次走一遍：打开星系 → 点一颗星球 → 打开 Members → 打开 Museum，再打开一件作品 → 回到星球进入编辑，摆一件作品 → Reset demo。每一步都截图，console 里不能有报错。
- 每个画面做好后截图给用户看。

## 11. 时间表

| 时间 | 内容 |
|---|---|
| 10月27日（周二） | 写实现计划；搭工程；先验证 WebGPU 下的分区渲染（第 12 节）；做星球生成、星系、星球视图；做数据层和假数据；晚上发截图 |
| 10月28日（周三） | 编辑；Members；Museum；GLB 一到就跑处理脚本；和用户定部署平台 |
| 10月29日（周四）上午 | 打磨转场和加载状态；用 Playwright 把所有流程走一遍；用户同意后部署；中午交链接 |

## 12. 风险与备选

| 风险 | 应对 |
|---|---|
| `WebGPURenderer` 的分区渲染（`setScissor` / `setViewport`）有问题 | 周二第一件事就验证；行不通就改成静态缩略图 + 单个 3D 查看器 |
| GLB 到得晚 | 先用占位模型开发；GLB 到了以后，只需跑处理脚本、改 `seed.json` |
| 模型太大 | 处理脚本负责压缩；仍然太大的在报告里标出来 |
| 有人在中国大陆打开链接 | 调研显示 `vercel.app`、`workers.dev` 在大陆基本被封。部署前先问清楚观看的人在哪里；如果有人在大陆，选平台前先在 GreatFire 上查该域名的状态 |
| 时间不够 | 按这个顺序砍：先砍全部 P1 → Museum 的分区渲染改用缩略图 → 星球外观面板只留预设 |

## 13. 以后做成正式产品（不在本次范围）

- 把 `PlanetStore` 换成真后端：Supabase（匿名登录 + 行级权限），或者 Cloudflare Worker + D1。Cloudflare KV 的免费额度每天只有 1,000 次写入和 1,000 次 list，不适合「列出所有星球」这种需求。
- 用 Discord OAuth 登录，团队对应 Discord 里的角色或频道。
- 上传流程在服务器上跑同样的 gltf-transform 压缩，并加上审核。
- 社区玩法可以参考这几个例子：r/place（用稀缺制造协作）、Git City（每人一栋楼的共享城市，楼的尺寸做了归一化）、Spore（生物存成几 KB 的「DNA」，异步共享）。Git City 是 AGPL 许可，只能参考，不能复用代码。

## 14. 约定（沿用 工具）

1. 只做本地提交，不推送远程；推送和部署要用户明确同意。
2. 提交时只 `git add` 自己改的文件。
3. 公开内容里不写本机路径和用户名。
4. 选库前先查 `工具/13-网页交互.md` 的许可红灯清单。
5. 星数、版本、日期一律实测。

## 15. 调研依据（2026年10月27日，调研 agent 查询）

| 结论 | 来源 |
|---|---|
| Godot 4.7 导出网页只支持 WebGL 2.0（Compatibility 渲染器），不支持 WebGPU | [Godot 文档](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html) |
| Godot 4.7 空项目导出网页，brotli 压缩后约 7.47 MiB；three r186 的 `three.core` + `three.webgpu` 用 br 压缩后共约 0.29 MB | [ranma 2026-07-04](https://ranma.hashnode.dev/godot-4-7-web-export-from-46-2-mb-to-3-0-mb)；jsDelivr 实测 |
| `WebGPURenderer` 不支持 `ShaderMaterial`、`RawShaderMaterial`、`onBeforeCompile`、`EffectComposer` | [three.js 手册](https://threejs.org/manual/#en/webgpurenderer) |
| Git City 用幂曲线（指数 0.55）压缩楼与楼之间的尺寸差距 | [TabNews 2026-03-03](https://www.tabnews.com.br/shrizzon/12-mil-devs-r1-586-de-receita-0-de-marketing-os-12-primeiros-dias-da-git-city) |
| `vercel.app`、`workers.dev` 在大陆基本被封 | [GreatFire vercel.app](https://en.greatfire.org/domain/vercel.app)、[GreatFire workers.dev](https://en.greatfire.org/domain/workers.dev) |
| Cloudflare KV 免费额度：每天 1,000 次写入、1,000 次 list | [Cloudflare KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |

## 16. 替用户做的细节决定

用户已确认：方案 A；团队和成员是虚构的（作品作者用真名）；星系里加约 10 颗 under construction 的星球；整体设计。

下面这些是写 spec 时补的，用户可以否决：

1. 演示身份是第一个有作品的团队里的一位虚构成员
2. 五套星球预设及其配色（第 4.2 节）
3. 所有作品统一最长边（2.0，可调），缩放范围 0.5–2 倍，旋转每次 15°
4. 从电脑拖进来的 GLB 不写进存档，也不进 Museum
5. 不做作品重叠检测，不给模型减面；每件作品在星球上最多出现一次
6. 加「Reset demo」按钮和 hash 路由
7. 处理脚本的阈值：贴图最长边 2048；面数超过 50 万、文件超过 15 MB 的标出来
8. 拖入文件的上限是 100 MB
