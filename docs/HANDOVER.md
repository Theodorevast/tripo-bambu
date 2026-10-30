# 交接文档：Community Planets

写给接手的开发团队。依据 int/v6 `9b8f353`（2026-10-30；上传模型和 Tripo 生成在 `3eef512` 合进来）。细节以代码和下面链接的文档为准。

---

## 1. 一页概览

### 1.1 是什么

Community Planets 是一个网页 3D 社区演示（包名 `gbn`，MakerWorld × Tripo 的活动「GBN | Great Benchy Nations」）。每个团队一颗小星球，成员的 3D 作品摆在上面。主流程：

星系首页 → 进星球 → Members / Museum → 编辑模式摆作品 → 漫游（翠宝角色在星球上走）→ 点翠宝吐优惠券 → 「Create a planet」建自己的星球 → **新功能**：上传 3D 模型，或者用 Tripo API v3 生成模型（文字、单图、多视图）。

技术栈：

- three.js r186（`three@0.186.1`），WebGPU 渲染器加 TSL 节点材质；浏览器没有 WebGPU 时退到 WebGL 2。
- Vite 8、TypeScript（`npm run typecheck`）、Vitest；Node 24.x（`package.json` 的 `engines`）。
- 运行时依赖只有 `three`、`tweakpane`（地址带 `?tune` 时才加载的实时调参面板）和 `@fontsource/nunito`。
- 路由用 hash：`#/`、`#/t/<团队>`、`#/t/<团队>/members`、`#/t/<团队>/museum[/<作品>]`、`#/create`（见 `src/router.ts`）。所以纯静态托管时不用配改写规则。

### 1.2 怎么跑

```sh
npm ci            # 按 package-lock.json 装依赖（Node 24）
npm run dev       # 开发服务器 http://127.0.0.1:5173，自带 /api/tripo 中转；没有密钥时是模拟模式，不花额度
npm run build     # 构建到 dist/
npm start         # 独立 Node 服务：同时托管 dist/ 和 /api/tripo，默认 http://0.0.0.0:8787（先 build）
```

其他命令：

| 命令 | 用途 |
| --- | --- |
| `npm test` | 单元测试（加上 Durable Objects 限流后：62 个文件、636 项全过） |
| `npm run typecheck` | 类型检查 |
| `npm run preview` | 本地预览构建结果（4173 端口，也带 `/api/tripo`） |
| `npm run smoke` | 冒烟测试（见第 5 节） |
| `npm run prep` | 处理社区作品：`models-in/` → `public/models`、`public/thumbs`、`src/data/works.json`，最后自动跑 `npm run lods` |
| `npm run lods` | 出星球视图用的轻量模型 `public/models/lod/`（只减面、贴图不动，见第 8 节）；换了模型以后跑，结果提交进仓库 |
| `npm run seed` | 用 `src/data/teams.template.json` + `works.json` 生成 `src/data/seed.json` |
| `npm run cf:dev` | Cloudflare Worker 本地试跑（wrangler dev，强制模拟模式） |
| `npm run cf:check` | 两个版本的 `wrangler deploy --dry-run`（不用登录） |
| `npm run cf:deploy` / `cf:deploy:v2` | 构建并部署第一版 / 第二版到 Cloudflare（见 7.2） |
| `npm run cf:tail` / `cf:tail:v2` | 看线上的实时日志 |

注意：

- 必须用 HTTPS 访问：WebGPU 只在安全上下文里可用（`localhost` 除外）。
- 自测一律带 `TRIPO_MOCK=1`（Git Bash：`TRIPO_MOCK=1 npm run dev`），有密钥也不会调 Tripo。

### 1.3 两个版本

| 分支 | 是什么 | 方向 |
| --- | --- | --- |
| `main`（GitHub 私有仓库 `Theodorevast/community-planets`） | **第一版**，一直在部署的那个。本地的集成分支是 `int/v6` | 明亮的卡通纸面风：Nunito 字体、翠宝黄、纸卡界面、弹性动效 |
| `v2-medieval` | **第二版**，玩法全部保留，换了整套视觉 | 「午夜的天文台」：星图式星系，蓝调时刻 / 月夜两套光，细金线加衬线字（Cinzel、Cormorant Garamond、Inter，均为 OFL），画廊式 Members / Museum，烫金券，泛光、胶片颗粒、暗角，中古只做点缀（尖拱、立石、灯柱、石砌天文台） |

- 第二版的说明在那个分支根目录的 `V2-README.md`；`compare/index.html` 是两版的对比页。部署方式和第一版一样（`git checkout v2-medieval && npm ci && npm run build`）。
- `v1-backport` 是从第二版移植回第一版的流畅度修复，已经合进 main（`de4eb2f`）。
- GitHub 的 `main` 已经包含上传模型和 Tripo 生成（`3eef512` 合进来的）。
- **上传和 Tripo 生成两版都有**（第二版换了皮）。两版共用文件的改动清单见第 6.3 节。

### 1.4 目录结构

| 目录 / 文件 | 一句话 |
| --- | --- |
| `src/main.ts` | 入口：装配 3D 世界、页面、编辑器、漫游、优惠券、上传和生成 |
| `src/app.ts` · `src/router.ts` | 页面状态和叠加层 · hash 路由 |
| `src/tune.ts` · `src/debug.ts` | `?tune` 实时调参面板 · 给自查脚本用的钩子（把 3D 物体换算成屏幕坐标） |
| `src/scenes/` | 星系首页、星球视图、镜头、转场（穿云、跳星球）、作品分批出场 |
| `src/planet/` | 星球的程序化生成：噪声地形、地表、作品摆放、装饰 |
| `src/nature/` | 草、天空和大气、水、生机层（被踩的草等）、装饰 |
| `src/play/` | 漫游：翠宝角色、步态、跟随镜头、球面行走 |
| `src/editor/` | 编辑模式：选中、摆放、旋转、删除，以及把 GLB 拖进页面 |
| `src/museum/` | Museum 的 3D 查看器和一张画布分区画多个视口 |
| `src/ui/` | DOM 界面：启动画面、首页、Members、Museum、造星窗口、作品卡、编辑条、联名徽章、「Add a work」窗口（`genai*`） |
| `src/fun/` | 翠宝吐优惠券、云里探头 |
| `src/data/` | 种子数据（`seed.json`）、存储（`store.ts` 的 `LocalStore`）、优惠券（`coupons.ts`）、类型（`types.ts`） |
| `src/works/` | 用户作品：存储（IndexedDB）、并进团队、导入管线（Web Worker）、预览和缩略图舞台 |
| `src/genai/` | Tripo 生成的前端：中转客户端、任务状态机、提示文案、图片预处理、前端模拟 |
| `src/assets/` | 模型和缩略图地址、品牌素材地址、本机私有模型替换（`localWorks.ts`，只在开发环境生效） |
| `src/style/` · `src/lib/` | 调色和遮罩 · 小工具 |
| `server/tripo/` | Tripo API 中转：核心 `handler.mjs`，加 Vite 插件、Node 服务、Cloudflare Worker 三个外壳；Worker 的限流在 `rate-limiter.mjs`（Durable Objects） |
| `public/` | 静态资源：`models/`（社区作品 GLB）、`thumbs/`（缩略图）、`brand/`（品牌素材，见 6.4） |
| `scripts/` | 自查（`check-*`）、冒烟（`smoke`）、截图（`shot-*`）、性能（`perf-*`）、录屏（`record-*`）、素材管线（`prep-models`、`build-seed`） |
| `tests/` | Vitest 单元测试 |
| `dev/` | 单独的调试页（草、天空、生机、星球、导入、缩略图、多视口）；`npm run dev` 后打开 `/dev/<名字>.html` |
| `docs/` | 本文件、[TRIPO.md](TRIPO.md)（中转）、`superpowers/`（最初的设计文档和实现计划） |
| `DEPLOY.md` · `.env.example` · `wrangler.toml` | 部署说明（中英） · 服务端环境变量模板 · Cloudflare Worker 配置（两个版本都用，见 7.2） |

不在仓库里（`.gitignore`）：

- `dist/`、`shots/`（自查截图）、`.tmp/`（其中 `.tmp/local-models/` 是本机私有的真实模型）。
- `models-in/`（`npm run prep` 的输入）、`assets/generated/`。
- 根目录的 `model/`、`tripo/`：本机私有素材，不要提交。
- `.env.local`、`.env.*.local`、`.dev.vars`、`.wrangler/`。

---

## 2. Tripo 生成

完整说明见 **[docs/TRIPO.md](TRIPO.md)**。要点如下。

```
浏览器 ──/api/tripo/*──▶ 中转 server/tripo/handler.mjs ──Bearer 密钥──▶ Tripo API v3（https://openapi.tripo3d.ai/v3）
                     限流 · 每日上限 · 跨域白名单 · 参数白名单 · 只从 Tripo 的主机下载结果
```

### 2.1 密钥只在服务端

- 只从环境变量 `TRIPO_API_KEY` 读：本地写在 `.env.local`，部署时设成主机的环境变量；Cloudflare 用 `npx --yes wrangler@4.156.0 secret put TRIPO_API_KEY`（第二版再加 `--env v2`）。
- **不要**起名 `VITE_TRIPO_API_KEY`：`VITE_` 开头的变量会被打进前端包。Vite 插件发现这种变量会直接报错停下。
- 错误信息和日志会抹掉密钥，以及长得像密钥的串（`tsk_…`）。单元测试检查所有响应和日志里都没有密钥。
- 前端只认中转地址：构建时的 `VITE_TRIPO_PROXY`，默认同源。这个地址是公开的，不是密钥。

### 2.2 三个外壳

同一份处理逻辑 `handle(request, env, info) → Response`（Web 标准，零依赖）：

| 外壳 | 文件 | 用在哪 |
| --- | --- | --- |
| Vite 插件 | `server/tripo/vite-plugin.mjs`（已在 `vite.config.ts` 注册） | `npm run dev`、`npm run preview` |
| 独立 Node 服务 | `server/tripo/node-server.mjs`（`npm start`） | 一个进程同时托管 `dist/` 和 `/api/tripo` |
| Cloudflare Worker | `server/tripo/worker.mjs` + `rate-limiter.mjs` + `wrangler.toml` | 部署到 Cloudflare（见 7.2） |

- Express / Koa 可以用 `server/tripo/node-adapter.mjs` 的 `createNodeMiddleware()`。
- 接口：`GET /health`、`GET /balance`、`POST /upload`、`POST /task`、`GET /task/:id`、`GET /download/:id`、`GET /preview/:id`。出错一律返回 `{ ok: false, code, message }`。
- 类型定义在 `server/tripo/handler.d.mts`；请求体和错误码见 TRIPO.md 第 2 节。

### 2.3 限流和每日上限（默认值）

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `TRIPO_MAX_TASKS_PER_IP_PER_HOUR` | 5 | 每个 IP 每小时建几个生成任务（IPv6 按 /64 算一个） |
| `TRIPO_MAX_TASKS_PER_DAY` | 50 | 全站滚动 24 小时的总任务数；**设 0 = 立刻关掉生成**（应急开关） |
| `TRIPO_MAX_UPLOADS_PER_IP_PER_HOUR` | 30 | 每个 IP 每小时上传几张图 |
| `TRIPO_MAX_REQUESTS_PER_IP_PER_MINUTE` | 300 | 每个 IP 每分钟所有接口合计（含轮询、下载） |
| `TRIPO_MAX_IMAGE_MB` | 10 | 单张图上限，最大 20 |

- 中转先占名额再调 Tripo。Tripo 明确拒绝时退回名额；结果不明（超时、5xx）时不退，因为请求可能已经扣费。
- 只开放基本参数，单个任务最多 30 积分（1 积分 = 0.01 美元）。按默认上限，一天最多约 1500 积分，约 15 美元。
- P 系列模型一个任务 100 积分起，默认不放行（`TRIPO_MODEL_VERSIONS`）。
- 会场共用 Wi-Fi 时大家是同一个出口 IP，要调大每 IP 的两项上限，靠每日上限兜底。
- Cloudflare 上 `wrangler.toml` 设的是每日 30 个（两版合计，最多约 900 积分、9 美元）、每 IP 每小时 5 个。

### 2.4 模拟模式

- **什么时候进模拟模式**：没有 `TRIPO_API_KEY`，或者 `TRIPO_MOCK=1`。进程环境变量的优先级最高，盖过 `.env.local` 里的密钥和 `TRIPO_MOCK=0`。
- `GET /api/tripo/health` 返回的 `mock` 和实际行为一致。启动时，真实模式会打一行黄色的「⚠ … 真实模式：会消耗额度」。
- 模拟时所有接口返回同样形状的数据：
  - 任务 8–12 秒走完，余额固定 1000；
  - 下载的模型是 `public/models/tufted-armchair.glb`（Node / Vite 用 `TRIPO_MOCK_MODEL_FILE` 换，Worker 用 `MOCK_MODEL_URL`、`MOCK_PREVIEW_URL`）；
  - 限流和每日上限照样生效。
- 测出错界面用的开关：
  - 提示词带 `#fail`：任务约 60% 时失败；
  - 提示词带 `#quota`：额度不足；
  - 提示词带 `#upstream`：上游出错；
  - 上传的图片文件名带 `#fail`：用这张图的任务失败。
- 前端另有一个离线模拟（`?tripo=mock`，`src/genai/mock.ts`），只给单元测试用。浏览器检查一律走中转的模拟模式。

### 2.5 从 v2 换到 v3

**Tripo API v2 在 2026-10-31 16:00 UTC（北京时间 11 月 1 日 0 点）停止服务**，所以中转接的是 v3。v2、v3 共用同一个密钥。主要变化（详见 TRIPO.md 第 10–11 节）：

| | v2 | v3 |
| --- | --- | --- |
| 基地址 | `https://api.tripo3d.ai/v2/openapi` | `https://openapi.tripo3d.ai/v3`（中国区 `https://openapi.tripo3d.com/v3`，用 `TRIPO_API_BASE` 切换） |
| 建任务 | 一个 `POST /task`，靠 `type` 区分 | 每种能力一个接口：`/v3/generation/text-to-model`、`image-to-model`、`multiview-to-model` |
| 图片输入 | `file` / `file_token` / `url` / `files` | 统一成 `input`（单图）/ `inputs`（多视图，用 view-key 写法） |
| 模型版本 | `model_version`（可选） | `model`（必填；默认 `v3.1-20260211`） |
| 上传 / 查任务 | `/v2/openapi/upload`、`/task/{id}` | `POST /v3/files`、`GET /v3/tasks/{id}` |
| 输出 | `model`、`pbr_model`、`rendered_image` | `model_url`、`rendered_image_url`（带签名的临时链接，约 5 分钟过期） |
| 其他 | 有 refine、stylize 和 `v2.0-20240919` | 都已下线；多视图要有正面、至少 2 张；`pbr: true` 会强制带贴图 |

前端调 `/api/tripo` 的接口约定没有因为换 v3 改形状。

### 2.6 上线前必须做

1. **限流存储。**
   - Cloudflare Worker：已经换成 **Durable Objects**（`server/tripo/rate-limiter.mjs`），全局一致，全站每日上限只有一个对象，两版共用。见 TRIPO.md 7.3。
   - Node 服务的计数还在内存里：只能跑一个进程（多进程上限会翻倍），重启后清零。多实例部署要给 `createHandler({ store })` 传一个持久的 store（Redis、数据库），接口照 `rate-limiter.mjs` 的 `createDurableStore`：`hit(key, limit, windowMs, now) → { ok, retryAfterMs, release() }`，滑动窗口的规则用 `handler.mjs` 的 `windowHit` / `windowRelease`。
2. **设好 `ALLOWED_ORIGINS`。**
   - 网页和中转同源时留空，表示只允许同源。
   - 分开部署时写网页的确切来源（如 `https://planets.example.com`，多个用逗号隔开），**不要用 `*`**。
   - 跨域白名单只挡浏览器里的别的网站，挡不住 curl，不能代替限流和登录。
3. 前面有反向代理或平台负载均衡时，设 `TRUST_PROXY=<代理层数>`。否则所有人共用代理的 IP 和同一份「每 IP」限额。
4. 最后的兜底是 Tripo 账户余额：只充演示需要的积分，演示结束后在控制台作废密钥。
5. 中转现在没有用户鉴权：拿到任务 id 就能下载结果。上线前加登录，并记录任务归属（TRIPO.md 第 13 节写了改哪里）。
6. 第一次用真实密钥时，先 `TRIPO_MOCK=1` 走通，再只做**一个**最便宜的任务（文字生成、`texture: false`，10 积分），确认轮询、下载、预览都通。

---

## 3. 用户作品的存储

### 3.1 现在存在哪

- 用户作品（上传的和 Tripo 生成的）存在浏览器的 **IndexedDB**：库 `gbn-user-works`，表 `works`，主键 `id`。代码在 `src/works/userWorks.ts`。
- 每条记录 = 元数据 + 优化后的 GLB（Blob）+ 256×256 透明背景 WebP 缩略图（Blob，渲染不出来时是 `null`）。
- IndexedDB 打不开时（隐私模式等），`openUserWorks()` 退回 `MemoryUserWorksStore`（`persistent = false`），作品只活到关掉标签页，界面会提示。

同一个浏览器里还有这些本地数据：

| 键 | 内容 | 代码 |
| --- | --- | --- |
| localStorage `gbn:v1:planets` | 各星球的摆放（含 `u-…` 用户作品）、本浏览器新建的那个团队 | `src/data/store.ts` 的 `LocalStore` |
| localStorage `gbn:v1:tripo-jobs` | 生成任务列表（刷新后 `resume()` 接着轮询） | `src/genai/jobs.ts` |
| localStorage `gbn:mock:tripo` | 前端离线模拟的状态（只在 `?tripo=mock` 时用） | `src/genai/mock.ts` |

### 3.2 `UserWorksStore` 接口

```ts
export type UserWorkSource = 'upload' | 'tripo';
export type UserWorkMode = 'text' | 'image' | 'multiview';

export interface UserWorkMeta {
  id: string;            // u- 开头；也是分享链接 #/t/<团队>/museum/<id> 里的 id
  title: string;
  author: string;        // 作者的成员 id（演示里就是 seed.you.memberId）
  authorHandle?: string; // 显示用的 @handle（不带 @）
  source: UserWorkSource;
  prompt?: string;       // 文字生成的提示词
  mode?: UserWorkMode;   // Tripo 生成方式
  createdAt: number;     // 毫秒
  triangles: number;     // 优化后的三角面数
  bytes: number;         // 优化后的 GLB 字节数
  teamId: string;        // 归哪个团队（在哪颗星球上加的）
}

export interface UserWork extends UserWorkMeta {
  glb: Blob;          // model/gltf-binary
  thumb: Blob | null; // image/webp
}

export interface UserWorksStore {
  list(): Promise<UserWork[]>;                    // 这个用户能看到的全部作品，按 createdAt 从早到晚
  add(work: UserWork): Promise<{ saved: boolean }>; // 同 id 整条覆盖（改名 = 改了 title 再 add）；saved=false 表示只在内存里
  remove(id: string): Promise<void>;               // id 不存在时什么也不做
  clear(): Promise<void>;                          // Reset demo
  onChange(listener: (works: UserWork[]) => void): () => void; // 增删改后通知最新的完整列表，返回取消订阅函数
  readonly persistent: boolean;                    // 刷新以后还在不在
}
```

读回来的每条记录都要过 `toUserWork()` 逐字段核对，对不上就整条丢掉。几个约束：

- `id` 必须匹配 `^u-[a-z0-9-]+$`；
- `title` ≤ 200 字；
- `source` 只认 `upload` / `tripo`。

后端发的 id 要么保持 `u-` 前缀，要么同时改这个校验。

### 3.3 数据怎么流

- **上传**：「Add a work」窗口 → 导入管线 `src/works/import*.ts`（在 Web Worker 里跑）：
  - 只收 `.glb` 和内嵌资源的 `.gltf`，≤ 50 MB；
  - dedup、weld，超过 30 万面时简化，贴图边长缩到 ≤ 2048，最后 meshopt 压缩；
  - 然后 `modelStage.ts` 截缩略图，`store.add()` 存下来。
- **生成**：`src/genai/jobs.ts` 的状态机 uploading → submitting → queued → running → downloading → importing → done / failed / cancelled。
  - success 后马上下载一次，走同一条导入管线（大小上限 200 MB），存进 IndexedDB；之后都从本地读。
- **接进页面**：`src/works/userWorksTeams.ts`。
  - `UserWorksRegistry` 启动时读出全部记录，把 GLB、缩略图注册成 blob URL，变成页面认识的 `Work`。
  - `PlanetStoreWithUserWorks` 包在 `LocalStore` 外面，读团队时把用户作品并进对应团队的 `works`（排在种子作品后面）；`reset()` 时一起清掉。
  - 在 `src/main.ts` 里，`openUserWorks()` 和建 3D 世界同时进行；用户作品注册好以后才 `listTeams()`、加载星球，所以刷新后摆放照常找得到作品。
  - 生成功能由 `installGenAI(app, editor, userWorks, store, …)` 接进来。

### 3.4 换成后端时改哪里

1. **另写一个实现 `UserWorksStore` 的类**（比如 GLB、缩略图传对象存储，元数据进数据库）。
   - `list()` 可以先把文件下载成 Blob，改动最小。
   - 也可以给 `UserWork` 加 `glbUrl` / `thumbUrl`，在 `userWorksTeams.ts` 的 `workFromRecord()` 里直接用远程地址。`src/assets/models.ts` 的 `modelUrl()`、`thumbUrl()` 已经原样接受 `https:` 地址。
2. **`src/main.ts`**：把 `openUserWorks()` 换成新实现。别的代码不用动。
3. **团队归属**：现在靠元数据里的 `teamId`，由 `PlanetStoreWithUserWorks` 并进去。如果团队数据以后也由后端给（作品直接在 `team.works` 里），这层包装可以去掉，`UserWorksRegistry` 只负责把新作品注册成地址。
4. **摆放**：照旧由 `PlanetStore.savePlanet()` 存，和种子作品的摆放一起换（见第 4 节）。
5. **作者**：现在 `author = app.you.memberId`（来自 `seed.you`），`authorHandle` 从团队成员里找。接登录以后换成真实用户。
6. **生成任务列表**：`GenJobs` 的 `storage` 依赖是 `StorageLike`（现在是 localStorage）。要跨设备续上，可以换成后端存，或者由中转按用户记任务。
7. **中转地址**：构建时设 `VITE_TRIPO_PROXY`。结果要长期保存时，建议由服务端在 success 后下载一次，存到 S3 / R2，再给前端自己的地址（TRIPO.md 第 13 节）。
8. **Reset demo**：现在会清空本机的全部用户作品、任务列表和摆放。接后端后要决定保不保留这个按钮，保留的话只对演示账号生效。

---

## 4. 还是假数据，要接真实后端

| 哪块 | 现在 | 代码 | 接后端时 |
| --- | --- | --- | --- |
| **团队和成员** | 16 个团队全部来自 `src/data/seed.json`。`npm run seed` 用 `teams.template.json` + `works.json` 生成 | `src/data/store.ts` 的 `LocalStore`（实现 `PlanetStore`） | 另写一个 `PlanetStore` 实现（`listTeams`、`getTeam`、`savePlanet`、`reset`、`createTeam`、`createdTeam`，文件头注释写了 Supabase、Cloudflare D1 之类），替换 `src/main.ts` 里的 `new LocalStore(seed, browserStorage())` |
| **摆放和新建的团队** | 存在 localStorage `gbn:v1:planets`；重新部署换了种子（指纹变了）时作废本地存档；每个浏览器只能建一个团队 | `LocalStore.savePlanet()`、`createTeam()` | 存到后端，按用户限制建团队的数量 |
| **登录身份** | 没有登录，所有人都是 `seed.you = { teamId: 'lumen-guild', memberId: 'you' }` | `src/main.ts` 把它传给 `App` 和 `MembersPage`；首页的「你的星球」、用户作品的作者都用它 | 换成会话里的真实用户；中转的限流 key 也从 IP 换成用户 id |
| **优惠券兑换码** | `COUPONS_LIVE = false`；5 种券写死，`drawCoupons()` 在本地生成 `TRIBOO-XXXX-XXXX` 形式的假码，卡片上有一行小字说明是示例码；冷却也只在前端 | `src/data/coupons.ts`（界面在 `src/fun/coupons*.ts`） | 由服务端发券（面额、券名、兑换码、有效期），换掉 `drawCoupons()`，把 `COUPONS_LIVE` 改成 `true`；防刷放在服务端 |
| **邀请链接** | `inviteCode()` 生成假邀请码，`inviteLink()` 拼成 `<地址>?invite=<码>#/t/<团队>`。`?invite=` 只是个记号，路由不看它；按昵称加好友也只在本地核对格式和人数 | `src/ui/createPlanetModel.ts`、`src/ui/createPlanet.ts` | 后端发邀请码、校验、把人加进团队；好友昵称要去后端查 |

另外，开发环境里放了 `.tmp/local-models/works.json` 时，`src/assets/localWorks.ts` 会把种子里同 id 的占位作品换成本机私有的真实模型。生产构建里这段整支去掉；地址带 `?nolocal` 时也不换。

---

## 5. 自查脚本

- 浏览器自查用 `playwright-core` 驱动本机 Chrome，大多自己起开发服务器（`scripts/lib/browser.mjs` 的 `startServer()`）。
- **`startServer()` 默认设 `TRIPO_MOCK=1`**：`.env.local` 里有真实密钥也不扣额度。
- 会建生成任务的只有 `check-genai.mjs` 和 `record-genai.mjs`。它们强制 `TRIPO_MOCK=1`，开页后先查 `/api/tripo/health`，返回的 `mock` 不是 `true` 就中止。
- 一次自查要建十几个任务，所以这两个脚本在模拟模式下把每 IP 每小时、每天的任务上限放宽到 500、5000。只对脚本自己起的开发服务器生效。
- **只有显式写 `REAL=1` 才会走真实接口**，留给经用户同意的最后一次真实测试，平时不要用。

常用开关：

- `WEBGL2=1`：藏起 `navigator.gpu`，走 WebGL 2 后备；
- `HEADED=1`：开有界面的 Chrome（无头模式可能拿不到 WebGPU）；
- `DPR=<n>`：设备像素比；`SIZE=390x844`：手机竖屏（部分脚本支持）；
- `VITE_CACHE_DIR=<目录>`：给这次的开发服务器单独的依赖缓存。

截图都存到 `shots/`。

| 脚本 | 查什么 |
| --- | --- |
| `smoke.mjs`（`npm run smoke`） | 冒烟：启动画面 → 星系 → 自己的星球 → Members → Museum → 打开作品 → 编辑模式摆一件 → Reset demo → 漫游走一秒 → 回星系；另开手机尺寸、做不了 3D 的浏览器。`SMOKE_BASE=<地址>` 可以测构建预览或线上 |
| `check-genai.mjs` | 上传和 Tripo 生成（36 项）：上传摆放、刷新后还在、Museum 预览逐像素落在卡片里；文字、单图、多视图生成；`#fail`、`#quota`；生成到一半刷新接着做；Reset demo；键盘、减少动态效果、手机竖屏 |
| `check-import.mjs` | 导入管线（`dev/import.html`，真的模块 Worker）：结果对不对，导入期间主线程没有超过 50 ms 的长任务；大模型夹具第一次跑时生成到 `.tmp/import-check/` |
| `check-editor.mjs` | 编辑器：选中、删除、摆回、旋转、刷新后存档；编辑条位置、拖动、快捷键、临时作品 |
| `check-drop.mjs` | 把 GLB 拖进页面变成临时作品、能摆，但存档里没有它；拖 `.txt` 被拒 |
| `check-create.mjs` | 「Create a planet」全流程：Launch 后每帧 ≤ 50 ms，刷新后还在，Reset demo；减少动态效果、键盘、手机竖屏 |
| `check-coupons.mjs` | 点翠宝吐券、冷却、捡券看卡片、Copy code、券落地后淡出 |
| `check-home.mjs` | 首页：版式、名牌、进星球、翠宝领券窗口、云里探头、减少动态效果 |
| `check-home-triboo.mjs` | 首页的云朵翠宝、开场星尘拼标志：时序、不压界面、GPU 开销、手机竖屏 |
| `check-transitions.mjs` | 转场：进出星球、跳星球、回星系，逐帧帧间隔 < 50 ms；减少动态效果；角落的「Made with Tripo」徽章 |
| `check-walk.mjs` | 漫游：走、撞作品、翻过北极、按 E 开作品卡、点地面自动走、Esc 退出；顺便采样走路时有没有新建对象 |
| `check-walk-anim.mjs` | 翠宝走路动画：拆部件、着地的脚不滑、减少动态效果 |
| `check-ui.mjs` | 界面动画只动 transform / opacity；各种界面开着时 3D 的帧间隔；调参面板 |
| `check-i1.mjs` | 接线：`?tune` 面板分组、AgX 色调映射、云海层级、草场只建一次、漫游踩草 |
| `check-pipelines.mjs` | 进星球时新建了哪些渲染管线（第一次画才同步编译的着色器就是卡顿的来源） |
| `check-multiview.mjs` | 一张画布分区画多个视口（三个格子应是红、绿、蓝） |

其余脚本：

- `perf-*.mjs` 测性能，`shot*.mjs` 截图，`record-*.mjs` 录屏（`record-genai.mjs` 同样默认模拟模式）；
- `prep-models.mjs`、`make-lods.mjs`、`build-seed.mjs` 是素材管线；`inspect-glb.mjs`、`make-*fixture.mjs` 是辅助工具；
- `perf-load.mjs` 量加载速度（线上或本机限速，见第 8 节），`shot-lod.mjs` 截 LOD 和原文件的对比图；
- `dev/*.check.mjs` 查对应的调试页。

单元测试 `npm test` 不发真实请求：`tests/tripoProxy.test.ts` 把 fetch 打桩成假的 Tripo 上游。

---

## 6. 已知问题

### 6.1 中转（T1 报告）

- **限流**：Cloudflare Worker 用 Durable Objects（全局一致，两版共用）；Node 服务还在内存里（单进程、重启清零），多实例部署要换（见 2.6）。
- 本地分成两个终端分别 `wrangler dev` 第一版和 `--env v2` 时，第二版调第一版的 Durable Object 会报 `Network connection lost`；放进同一个 `wrangler dev`（多个 `-c`）就正常（TRIPO.md 7.5）。线上不受影响。
- **没有用户鉴权和任务归属**：拿到任务 id 就能下载。`ALLOWED_ORIGINS` 挡不住 curl。
- `/download/:id` 每次都重新查任务、拿新链接、再流式转发（Tripo 的链接几分钟就过期）。前端只在 success 后下载一次，存进 IndexedDB。
- **待确认**（开发环境没有真实密钥，测不了；代码注释里也标了）：
  1. 国际区结果文件的实际主机。不在白名单（`*.tripo3d.ai`、`*.tripo3d.com`）里时，报错会写出主机名，确认后加进 `TRIPO_DOWNLOAD_HOSTS`。
  2. 结果链接的确切有效期，以及任务能查多久。
  3. `/v3/files` 收不收 WebP。目前只收 PNG / JPEG，前端会先转格式。
  4. 任务 id 是不是总是 UUID。
  5. 查不到任务时回什么业务码。
  6. 每个密钥的具体频率上限。
- 会场共用 Wi-Fi 时大家共用每 IP 的限额（见 2.3）。

### 6.2 前端（T2 报告）

- 第一次打开一件新模型的预览时，主画面偶尔有一帧 33–50 ms。原因是节点材质在主线程生成着色器，加上截缩略图时读回画布。可以改用 `createImageBitmap` 异步取，或者推到空闲时再截。
- 生成任务只在一个标签页里跑。同一个浏览器开两个标签页都会轮询：不会重复建任务，只是多查几次。
- `POST /task` 还没回来时关掉页面：中转可能已经建了任务，但前端不知道 taskId，标成 interrupted，请用户重来（可能多花一次额度）。
- 结果链接约 5 分钟过期。导入失败时 `retry()` 先用内存里下载好的那份；刷新以后才重新下载，那时链接可能已经过期。
- Draco、KTX2 压缩的模型会被拒（没有解码器）；只保留默认场景；超大的 PNG 贴图不重新编码。
- 直接拖进页面（不经过「Add a work」窗口）的 GLB 还是原来的临时作品，不存。check-editor、check-drop、check-create 都依赖这个行为。

### 6.3 上传和生成在第二版里

上传和生成已经合进 `v2-medieval`（换成第二版深色细金线的皮，只改了 `src/ui/theme-v2.css` 的第 6 部分，逻辑和第一版是同一份）。下面的清单留给以后两版分别演进时对照。当初搬过去时，新文件直接拷：

- `src/works/`、`src/genai/`、`src/ui/genai*`、`server/tripo/`；
- 对应的 `scripts/`、`tests/`、`dev/import.*`。

改动过的共用文件（合并时可能冲突，int/v6 上一共 +135 / −15 行）：

| 文件 | 改了什么 |
| --- | --- |
| `src/main.ts` | 用户作品的打开和注册；`PlanetStoreWithUserWorks` 包住 `LocalStore`；`installGenAI(...)` |
| `src/data/types.ts` | `Work` 加可选字段 `source`、`prompt`、`mode`、`authorHandle` |
| `src/assets/models.ts` | `thumbUrl()` 接受 `blob:` / `http(s):` / `data:`；导出 `normalizeModel()` |
| `src/editor/editor.ts` | `onAddWork`、`syncTeam()`、`placeWork()` |
| `src/ui/editPanel.ts`、`icons.ts`、`badge.ts`、`workCard.ts`、`museumPage.ts` | 作品栏的 Upload / Create 按钮、图标、Tripo 标记；Museum 卡片入场放完才挂 3D 预览 |
| `src/scenes/planetView.ts` | 路牌在成员里找不到作者时用 `authorHandle` |
| `vite.config.ts` | 中转插件、`optimizeDeps.include`（gltf-transform、meshoptimizer）、`worker.format: 'es'` |

「Add a work」窗口的样式全部在 `src/ui/genai.css`，状态都写在 `data-*` 属性上。第二版换皮只改 CSS 就行。

### 6.4 品牌和授权（`DEPLOY.md` 第 5 条）

- `public/brand/` 里的翠宝模型（`triboo.glb`）、Tripo 和 MakerWorld 的标志、像素翠宝动图是品牌方的素材。
- `public/models/`、`public/thumbs/` 是社区作者的作品。
- 版权都归各自的所有者，**只用于本站，不要转用或公开分发，仓库保持私有**。
- 根目录的 `model/`、`tripo/` 和 `.tmp/local-models/` 是本机私有素材，不在仓库里，也不要提交。
- 界面上的「Made with Tripo」徽章、券上的「Use on Tripo」都用到 Tripo 品牌。券和兑换码现在是假的（见第 4 节）。正式上线前请和品牌方确认用法和券的真实权益。
- 字体：第一版 Nunito（`@fontsource/nunito`）；第二版 Cinzel、Cormorant Garamond、Inter。都是 OFL 许可。

---

## 7. 部署

`DEPLOY.md` 写了纯静态部署：把 `dist/` 传到任意静态托管就能用，但 **Tripo 生成不可用**。这时生成标签会显示提示，上传照常能用。要用生成，就需要服务端中转，有下面两种方式（详见 TRIPO.md 第 6、7 节）。

### 7.1 方式一：独立 Node 服务（`npm start`）

```sh
npm ci
npm run build
TRIPO_API_KEY=… TRIPO_MAX_TASKS_PER_DAY=50 PORT=8787 npm start   # 第一次先带 TRIPO_MOCK=1 走通
```

- 一个进程同时托管 `dist/` 和 `/api/tripo`，零依赖，Node 24。
  - `/assets/*` 长缓存，`index.html` 等其余文件 `no-cache` 加 ETag；
  - 挡掉 `../` 越界和点开头的文件。
- 前面放 Nginx / Caddy 或用平台自带的 HTTPS。Nginx 要设 `client_max_body_size 11m`、`proxy_buffering off`，并且设 `TRUST_PROXY=1`。
- **只跑一个进程**（限流计数在内存里）。
- Render / Railway / Fly.io：构建命令 `npm ci && npm run build`，启动命令 `npm start`，`TRUST_PROXY=1`。

环境变量（在主机上设；本地可以写在 `.env.local`）：

| 变量 | 要不要设 | 说明 |
| --- | --- | --- |
| `TRIPO_API_KEY` | **必填**（不设就是模拟模式） | Tripo 密钥，`tsk_…` |
| `TRIPO_MOCK` | 第一次部署设 `1`，走通后删掉 | 强制模拟 |
| `TRIPO_MAX_TASKS_PER_DAY` | 建议显式设 | 全站每日上限，默认 50；0 = 关掉生成 |
| `TRIPO_MAX_TASKS_PER_IP_PER_HOUR` | 可选 | 默认 5 |
| `TRIPO_MAX_UPLOADS_PER_IP_PER_HOUR` | 可选 | 默认 30 |
| `TRIPO_MAX_REQUESTS_PER_IP_PER_MINUTE` | 可选 | 默认 300 |
| `TRIPO_MAX_IMAGE_MB` | 可选 | 默认 10，最大 20 |
| `ALLOWED_ORIGINS` | 同源留空；分开部署时必填 | 跨域白名单 |
| `TRUST_PROXY` | 有反向代理时**必填** | 代理层数；直连保持 0 |
| `PORT` / `HOST` / `STATIC_DIR` | 可选 | 默认 8787 / 0.0.0.0 / dist |
| `TRIPO_MODEL_VERSIONS` / `TRIPO_DEFAULT_MODEL_VERSION` | 可选 | 默认只放行 H 系列；默认 `v3.1-20260211` |
| `TRIPO_API_BASE` | 中国区账号必填 | 默认 `https://openapi.tripo3d.ai/v3` |
| `TRIPO_DOWNLOAD_HOSTS` | 可选 | 结果文件额外允许的主机 |
| `TRIPO_MAX_DOWNLOAD_MB` | 可选 | 默认 200 |
| `TRIPO_MOCK_MODEL_FILE` | 可选 | 模拟模式的模型，相对 `dist/`，默认 `models/tufted-armchair.glb` |

### 7.2 方式二：Cloudflare Worker（两个版本都这样部署）

配置是仓库根目录的 `wrangler.toml`（以前的 `wrangler.toml.example` 换成了能直接部署的），两个版本用同一份。上线步骤按顺序写在 **TRIPO.md 7.1**，简要：

```sh
npx --yes wrangler@4.156.0 login
npx --yes wrangler@4.156.0 secret put TRIPO_API_KEY             # 第一版（community-planets）
npx --yes wrangler@4.156.0 secret put TRIPO_API_KEY --env v2    # 第二版（community-planets-v2）
cd ~/Desktop/gbn && npm run cf:deploy                            # 先部署第一版（int/v6）
cd ~/Desktop/gbn-medieval && npm run cf:deploy:v2                # 再部署第二版（v2-medieval）
curl https://community-planets.<子域>.workers.dev/api/tripo/health   # → {"ok":true,"mock":false}
```

- 同一个 Worker 既托管 `dist/` 又做中转（方案 A，同源，不用设 `ALLOWED_ORIGINS`）：`[assets]` 里 `run_worker_first = ["/api/*"]`，其余请求直接走静态资源。网页用 # 路由，不需要 SPA 回退。
- 限流在 Durable Objects（绑定 `RATE_LIMITER` → 类 `RateLimiter`，SQLite 后端）：全局一致，全站每日上限只有一个对象。第二版绑到第一版的类（`script_name`），**两版共用一份计数和每日上限**，所以要先部署第一版。真实模式缺这个绑定时接口直接拒绝。详见 TRIPO.md 7.3。
- 客户端 IP 用 `CF-Connecting-IP`，不需要 `TRUST_PROXY`。
- 套餐：建议付费版（5 美元 / 月），原因和 Cloudflare 的各项限制见 TRIPO.md 7.4。
- 不改代码切模拟模式：`echo 1 | npx --yes wrangler@4.156.0 secret put TRIPO_MOCK`（`0` 切回，第二版加 `--env v2`）；改每日上限在控制台改变量（下次部署会恢复成 `wrangler.toml` 的值）。见 TRIPO.md 7.1 第 5 步。
- 方案 B（网页放在别处，Worker 只做中转）见 TRIPO.md 7.2。
- npm 脚本：`cf:dev`（本地，强制模拟）、`cf:check`（两个版本 dry-run）、`cf:deploy`、`cf:deploy:v2`、`cf:tail`、`cf:tail:v2`，都用固定版本的 `npx --yes wrangler@4.156.0`（wrangler 没装进项目）。

环境变量：

| 变量 | 设在哪 | 说明 |
| --- | --- | --- |
| `TRIPO_API_KEY` | `wrangler secret put`（两个 Worker 各一次） | **必填**，不要写进 `wrangler.toml` |
| `TRIPO_MOCK` | `wrangler secret put TRIPO_MOCK`（`1` / `0`） | 临时切模拟模式；不写进 `[vars]`，免得和它重名 |
| `TRIPO_MAX_TASKS_PER_DAY`、`TRIPO_MAX_TASKS_PER_IP_PER_HOUR` | `[vars]`（第二版在 `[env.v2.vars]`） | 公开演示 `"30"`（两版合计）、`"5"`；两处设成一样 |
| `MOCK_MODEL_URL` / `MOCK_PREVIEW_URL` | 同上 | `/models/tufted-armchair.glb`、`/thumbs/tufted-armchair.webp`（从 `dist/` 里取） |
| `TRIPO_MAX_UPLOADS_PER_IP_PER_HOUR`、`TRIPO_MAX_REQUESTS_PER_IP_PER_MINUTE`、`TRIPO_MAX_IMAGE_MB`、`ALLOWED_ORIGINS`、`TRIPO_MODEL_VERSIONS`、`TRIPO_DEFAULT_MODEL_VERSION`、`TRIPO_API_BASE`、`TRIPO_DOWNLOAD_HOSTS`、`TRIPO_MAX_DOWNLOAD_MB` | 要改时加进两处 `[vars]` | 默认值同上表 |
| `ASSETS`、`RATE_LIMITER` | `[assets]`、`[[durable_objects.bindings]]` | 绑定，不是变量 |
| `VITE_TRIPO_PROXY` | 构建网页时的环境变量 | 只在方案 B（网页和中转分开）时设；是公开地址，会进前端包 |

### 7.3 和 `.env.example` 对过

- `.env.example` 列了 20 个服务端变量：
  - `TRIPO_API_KEY`、`TRIPO_MOCK`；
  - 5 个限流（`TRIPO_MAX_TASKS_PER_DAY`、`TRIPO_MAX_TASKS_PER_IP_PER_HOUR`、`TRIPO_MAX_UPLOADS_PER_IP_PER_HOUR`、`TRIPO_MAX_REQUESTS_PER_IP_PER_MINUTE`、`TRIPO_MAX_IMAGE_MB`）；
  - `ALLOWED_ORIGINS`、`TRIPO_MODEL_VERSIONS`、`TRIPO_DEFAULT_MODEL_VERSION`、`TRIPO_API_BASE`、`TRIPO_DOWNLOAD_HOSTS`、`TRIPO_MAX_DOWNLOAD_MB`；
  - `TRIPO_MOCK_MODEL_FILE`、`MOCK_MODEL_URL`、`MOCK_PREVIEW_URL`；
  - `PORT`、`HOST`、`STATIC_DIR`、`TRUST_PROXY`。
- 和 `server/tripo/*.mjs` 实际读取的变量一一对应（代码另外只读 Worker 的 `ASSETS`、`RATE_LIMITER` 绑定），也和 TRIPO.md 第 8 节的表一致。
- 分属情况：
  - 只有 Node 用：`PORT`、`HOST`、`STATIC_DIR`、`TRUST_PROXY`、`TRIPO_MOCK_MODEL_FILE`；
  - 只有 Worker 用：`MOCK_MODEL_URL`、`MOCK_PREVIEW_URL`；
  - 其余两边都用。
- `VITE_TRIPO_PROXY` 不在 `.env.example` 里：它是前端构建变量，不是服务端变量，说明在 TRIPO.md 7.2 和 `wrangler.toml` 末尾的注释。

### 7.4 上线前检查清单

- [x] Cloudflare：限流在 Durable Objects，每日上限全局一致、两版共用（Node 多实例要自己换成 Redis 之类）
- [ ] Cloudflare 套餐：建议付费版（TRIPO.md 7.4）；两个 Worker 都设了 `TRIPO_API_KEY`，health 都是 `mock:false`
- [ ] `ALLOWED_ORIGINS` 设对（同源留空，分开部署写确切来源，不用 `*`）；有反向代理时设 `TRUST_PROXY`
- [ ] 密钥只在服务端（`wrangler secret` 或主机环境变量），没有任何 `VITE_*KEY`
- [ ] 先 `TRIPO_MOCK=1` 走通，再用真实密钥只做一个 10 积分的任务验证
- [ ] Tripo 账户只充演示需要的积分，演示结束后作废密钥
- [ ] HTTPS
- [ ] 计划接入登录、任务归属、用户作品和团队的后端（第 3、4 节）

---

## 8. 加载速度

2026-10-30 量的。「刚进去的时候模型加载有点慢」，原因和改法如下。

### 8.1 慢在哪

用 `scripts/perf-load.mjs` 量线上第一版，从开发机（国内，经本机代理）走真实网络：

| | 改之前 |
| --- | --- |
| 冷启动：HTML 到 | 3.2 秒（新连接的 TLS 约 1 秒，首字节 1.4–3.2 秒） |
| 冷启动：星系可以操作（`window.__ready`） | 12.4 秒 |
| 点「Visit your planet」→ 第一件 / 全部作品出场 | +47 秒 / +53 秒 |
| 进星球要下载 | 4 个 GLB，共 14.14 MB，约 0.29 MB/s |
| 热启动（第二次打开）：星系可以操作 / 作品全部出场 | 5.9 秒 / +1.7 秒；每个文件还要再问一次服务器，每次 0.3–0.65 秒 |

结论：

- **主要是模型的字节数**。「你的星球」4 件作品各 30 万面，几何占文件的四分之三。
- **4 件同时下载**。带宽平分，每件都要等到快结束才到，所以作品是一起很晚才出场。
- 启动的 JS 是次要的：压缩后 0.48 MB，其中 `createPlanetTune-*.js` 1.3 MB（gzip 后 0.39 MB）开场就加载，它其实是 three.js 和共用代码，只是被按其中一个模块命名。首页的翠宝 GLB 1.1 MB，不挡启动。
- 每次打开都要重新问服务器：Cloudflare 默认给所有文件 `Cache-Control: public, max-age=0, must-revalidate`，连带指纹的 `/assets/*` 也一样。
- Cloudflare 不压缩 `model/gltf-binary`（不在它默认压缩的类型里）。这些 meshopt 压过的 GLB 再 gzip / brotli 也只能省 12–16%，不值得为此让 Worker 经手。

本机可以复现（`npm run build` 后 `THROTTLE=3000/300 node scripts/perf-load.mjs`：vite preview，响应头按 Cloudflare 的规则模拟，Chrome 限速 3 Mbps、往返 300 ms）。改之前：作品 +36.6 秒才开始出场，+40.3 秒全部出场。

### 8.2 改了什么

1. **星球视图用轻量模型（LOD）**。
   - 文件在 `public/models/lod/`，用 `npm run lods`（`scripts/lib/lod.mjs`）出，**只减面，贴图逐字节不动**。单元测试 `tests/loadSpeed.test.ts` 会检查贴图和原文件一样。
   - 误差上限是模型最长边的 0.1%（作品 1.6 米，就是 1.6 毫米）。星球视图镜头最近时（离星球中心 1.35 个半径，离作品约 10 米，DPR 2），这个误差不到 0.4 像素。漫游时镜头贴着作品，也只有 1 像素左右。
   - 21 件里出了 17 件。剩下 4 件本来就不重，或者 UV 接缝太碎、减不下去：坦克、扶手椅、恐龙骨架、南瓜女孩。这 4 件直接用原文件。
   - 「你的星球」从 14.14 MB 降到 6.36 MB；全部作品在星球视图要下载的量从 73.1 MB 降到 40.5 MB。
   - 用在主画面（星球视图、编辑、漫游）和 Museum 的卡片预览。大图查看器（Museum 里点开一件）仍然用原文件。地址带 `?lod=0` 时全部用原文件，对比、排查用。
   - 对比图用 `node scripts/shot-lod.mjs` 截，存在 `shots/lod-ab/`。
   - LOD 文件**提交进仓库**，约 30 MB。这样构建、部署不用再跑减面，也就不依赖 WASM 版本，结果可以审、可以复现。换了模型时 `npm run prep` 会自动重出。
2. **下载排队，最显眼的先下**（`src/assets/models.ts` 的 `Downloads`）。
   - 主画面现在要用的模型一次只下一件。
   - 进星球时按作品多正对镜头排序（`planetView.ts` 的 `byVisibility`）。
   - 预取（指着星球、首页空闲时）只在没有别的下载时才下，急件不等它。
   - 解析照旧一次一件，进星球的转场帧不受影响。
3. **首页空闲时预取「你的星球」**（`main.ts`）。
   - 星系可以操作、主线程空下来以后，在后台下载「你的星球」的作品。
   - 只下载、不解析，主线程上不做事。
   - 指着星球时的预取照旧。
4. **长缓存**。
   - `public/_headers` 会被 Workers Static Assets 读取（[文档](https://developers.cloudflare.com/workers/static-assets/headers/)，最多 100 条规则）。`/assets/*`、`/models/*`、`/thumbs/*`、`/brand/*` 都设成 `public, max-age=31536000, immutable`。
   - 模型、缩略图、品牌素材的名字不带指纹，换了文件名字也不变。所以代码里的地址都带 `?v=<内容指纹>`：由 `vite.config.ts` 的 `assetVersions` 插件在构建时算，`src/assets/versions.ts` 读。Workers Static Assets 找文件时不看查询串。
   - `index.html` 仍然每次都问，新版本一部署就生效。
   - `npm start` 的 Node 服务不读 `_headers`，那边的缓存规则不变（见 7.1）。

改之后，本机同样限速（3 Mbps / 300 ms），首页停 3 秒再点：

| | 改之前 | 改之后 |
| --- | --- | --- |
| 点 Visit → 第一件作品出场 | +36.6 秒 | **+2.0 秒** |
| 点 Visit → 全部出场 | +40.3 秒 | **+16.4 秒** |
| 点 Visit 以后还要下载 | 14.14 MB | 4.83 MB（另有 1.54 MB 在首页那 3 秒里预取好了） |
| 热启动 | 每个文件都再问一次，每次约 0.34 秒 | 全部从磁盘缓存读，0 字节，不问服务器 |
| 冷启动到星系可以操作 | 7.5 秒 | 7.5 秒（没变，见 8.4） |

### 8.3 国内访问（建议，没有做）

国内连 Cloudflare 本身就慢。没有企业版加 ICP 备案，Cloudflare 在国内没有节点；`workers.dev` 也没有为国内优化，有时还会被干扰。

开发机实测：

- 请求被送到洛杉矶（`CF-RAY …-LAX`）。
- 新连接光 TLS 就要约 1 秒，首字节 1.4–3.2 秒；连接复用以后往返约 0.3 秒（HTTP/3）。
- 吞吐约 0.24–0.3 MB/s。

按 0.3 MB/s 算，改完以后：

- 「你的星球」的 LOD 6.4 MB，约 21 秒（首页预取能先下掉一部分）；
- 全部作品的星球视图文件 40.5 MB，约 2.3 分钟；
- 大图查看器的原文件每件 3–6 MB，约 10–20 秒。

**建议把 `/models/`、`/thumbs/` 放到国内的 CDN**（阿里云 OSS + CDN、腾讯云 COS + CDN、七牛等，合计约 105 MB）。

- 需要一个备案过的域名。国内 CDN 往返通常几十毫秒、几 MB/s 以上，「你的星球」一两秒就能下完。
- 代码只要改一处：`src/assets/versions.ts` 的 `assetUrl()`，给 `models/`、`thumbs/` 换一个构建时的地址前缀，比如新加 `VITE_ASSET_BASE`。
- 把 `dist/models`、`dist/thumbs` 传上去。
- 桶和 CDN 要设：
  - CORS（`Access-Control-Allow-Origin` 写网页的来源，GLTFLoader 用 fetch 跨域读）；
  - `Cache-Control: public, max-age=31536000, immutable`；
  - **CDN 的缓存键要包含查询串**（`?v=`），否则换了文件要手动刷新 CDN。
- 更彻底的做法是整站放国内（HTML、JS 也是）。冷启动时 HTML 3.2 秒加 JS 3.7 秒，大部分是连 Cloudflare 的开销。海外用户留在 Cloudflare，按地区解析到两个入口。

### 8.4 还可以做的（这次没做）

- **大图查看器第一次打开一件作品时要下载原文件**（3–6 MB）。以前星球视图已经下过原文件，查看器只要问一下服务器；现在星球视图用的是 LOD。
  - 现在的缓解：在星球上点了作品（作品卡弹出来），或者打开了 Museum 的网格，就在后台低优先级下载原文件（`ModelLibrary.warmFull`）。字节留在 HTTP 缓存里，查看器打开时直接读。
  - 更好的做法：查看器先显示 LOD（缓存里有），原文件下好再换上。
- **冷启动的启动画面**要等 110 KB 的 CSS 到了才画出来。线上 HTML 3.2 秒就到了，CSS 和 JS 一起要到 6.9 秒。把启动画面的那几条 CSS 内联进 `index.html`，国内冷启动能早约 3.7 秒看到画面。
- 首页的翠宝 GLB 1.1 MB，和 JS 抢开场的带宽。
