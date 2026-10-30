# Tripo API 中转（/api/tripo）

网页只调同源的 `/api/tripo/*`，由一个很薄的服务端中转去调 Tripo。**Tripo 的 API 密钥只在服务端**（环境变量 `TRIPO_API_KEY`），不进仓库、不进前端包、不进日志和任何响应。

```
浏览器 ──/api/tripo/*──▶ 中转（server/tripo/handler.mjs） ──Bearer 密钥──▶ Tripo API v3（openapi.tripo3d.ai/v3）
                          限流 · 每日上限 · 跨域白名单 · 参数白名单 · 只拉 Tripo 的结果
```

同一份处理逻辑（`handle(request, env, info) → Response`，Web 标准、零依赖）接了三个外壳：

| 外壳 | 文件 | 用在哪 |
| --- | --- | --- |
| Vite 插件 | `server/tripo/vite-plugin.mjs`（已在 `vite.config.ts` 注册） | `npm run dev`、`npm run preview` |
| 独立 Node 服务 | `server/tripo/node-server.mjs`（`npm start`） | 一个进程同时托管 `dist/` 和 `/api/tripo`，直接部署 |
| Cloudflare Worker | `server/tripo/worker.mjs` + `wrangler.toml.example` | 部署到 Cloudflare |

> **Tripo API v2 在 2026-10-31 16:00 UTC（北京时间 11 月 1 日 0 点）停用**，所以这里接的是 **v3**。v3 的接口、字段和从 v2 换过来改了什么，见文末「Tripo API v3 调研结果」。

---

## 1. 快速开始

```sh
npm run dev                          # 没有 .env.local 里的密钥 → 模拟模式，不花额度
TRIPO_MOCK=1 npm run dev             # 有密钥也强制模拟（自测一律这样跑）
curl http://127.0.0.1:5173/api/tripo/health   # → {"ok":true,"mock":true}
```

**自测脚本默认都应该带 `TRIPO_MOCK=1` 跑。** `scripts/lib/browser.mjs` 的 `startServer()` 已经默认设了 `TRIPO_MOCK=1`，所有用它起开发服务器的检查脚本（`node scripts/smoke.mjs` 等）都是模拟模式；真要连 Tripo 必须显式写 `TRIPO_MOCK=0`。

启动时控制台会打一行当前模式：模拟模式是普通提示；真实模式是黄色的「⚠ Tripo 真实模式：会消耗额度……」。`/api/tripo/health` 返回的 `mock` 和实际行为一致，检查脚本可以靠它判断。

---

## 2. 接口约定（给前端）

所有接口都在 `/api/tripo` 下。成功时 `ok: true`；**出错一律** `{ ok: false, code, message }`（429 时另带 `retryAfter` 秒数和 `Retry-After` 头）。类型定义见 `server/tripo/handler.d.mts`（前端可以 `import type`）。

| 接口 | 请求 | 返回 |
| --- | --- | --- |
| `GET /health` | — | `{ ok, mock }` |
| `GET /balance` | — | `{ ok, balance, frozen }`（Tripo 积分，带两位小数的数字，别用 parseInt） |
| `POST /upload` | multipart，字段 `file`，**一张** PNG / JPEG，≤ 10 MB | `{ ok, token, type: 'png' \| 'jpeg' }` |
| `POST /task` | JSON，见下 | `{ ok, taskId }` |
| `GET /task/:id` | — | `{ ok, status, progress, modelUrl?, previewUrl?, error? }` |
| `GET /download/:id` | — | 结果 GLB，流式返回，`Content-Type: model/gltf-binary`，带 `Content-Length` |
| `GET /preview/:id` | — | 结果预览图（同源，可以画到 canvas 上） |

`POST /task` 的三种请求体（只认这些字段，多一个都拒绝）：

```jsonc
{ "mode": "text", "prompt": "a small wooden chair", "texture": true, "pbr": true, "modelVersion": "v3.1-20260211" }
{ "mode": "image", "token": "<upload 返回的 token>", "type": "png", "texture": true, "pbr": true }
{ "mode": "multiview", "views": [{ "token": "…", "type": "png" }, null, { "token": "…" }, null] }   // 顺序：前、左、后、右
```

- `texture`、`pbr`、`modelVersion`、`type` 都可以不传。不传时 Tripo 默认带贴图和 PBR；`texture: false` 会一并关掉 PBR（Tripo 的 `pbr` 默认是 true，而且会强制带贴图）。
- `prompt` 最多 1024 个字。多视图正好 4 项，**正面必须有，至少 2 张**。
- `modelVersion` 默认 `v3.1-20260211`，可选值由 `TRIPO_MODEL_VERSIONS` 决定（默认只有 H 系列，见第 8 节）。

`status` 取值：`queued`、`running`、`success`、`failed`、`cancelled`、`unknown`。`progress` 是 0–100 的整数。成功时给 `modelUrl: '/api/tripo/download/:id'` 和 `previewUrl: '/api/tripo/preview/:id'`；失败或取消时给 `error`。

错误码 `code`：

| code | HTTP | 什么时候 | 前端怎么办 |
| --- | --- | --- | --- |
| `rate_limited` | 429 | 本 IP 太频繁（生成、上传、总请求数），或者 Tripo 自己的频率 / 并发上限 | 按 `retryAfter` 提示稍后再试 |
| `daily_cap` | 429 | 全站 24 小时内的生成额度用完 | 提示明天再来 |
| `quota` | 402 | Tripo 账户积分不足 | 提示额度用完 |
| `bad_request` | 400 / 405 / 413 / 415 / 403 | 参数不对、图太大、格式不支持、来源不在白名单、内容没过 Tripo 审核 | 把 `message` 给用户看 |
| `upstream` | 502 / 504 / 500 | Tripo 出错、超时、连不上，或服务端配置问题 | 轮询时遇到就接着轮询；建任务时提示稍后再试 |
| `not_found` | 404 | 没有这个任务、任务还没成功就来下载 | — |

前端调用建议：

```js
const base = import.meta.env.VITE_TRIPO_PROXY ?? '';      // 同源部署留空；分开部署时是中转的地址（见 7.2）
const api = (path) => `${base}/api/tripo${path}`;

const fd = new FormData();
fd.append('file', file);                                   // PNG / JPEG；别的格式先在浏览器里转成 PNG
const up = await (await fetch(api('/upload'), { method: 'POST', body: fd })).json();

const created = await (await fetch(api('/task'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'image', token: up.token, type: up.type }),
})).json();

// 每 2–3 秒轮询一次；upstream 错误当成暂时的、接着轮询；最多等 5 分钟左右
// 成功后马上下载一次存到本地（IndexedDB），别反复下载：每次下载都会去 Tripo 重新取一次
const glb = await (await fetch(new URL(state.modelUrl, base || location.href))).arrayBuffer();
```

`modelUrl` / `previewUrl` 是相对**中转所在域名**的路径；分开部署时要像上面这样用中转地址去解析。

---

## 3. 模拟模式

**进入条件**：没有 `TRIPO_API_KEY`，或者 `TRIPO_MOCK=1`（也接受 `true`）。**进程环境变量的优先级最高**：`TRIPO_MOCK=1 npm run dev` 一定是模拟模式，哪怕 `.env.local` 里有密钥、甚至写了 `TRIPO_MOCK=0`。

模拟模式下所有接口照常返回同样形状的数据，不发任何请求到 Tripo：

- 任务 8–12 秒走完：前约 1.5 秒 `queued`，然后 `running`、进度平滑上升，最后 `success`。任务 id 形如 `mock_<时间>_<时长>_<s|f>_<随机>`，状态完全由 id 和当前时间算出来（服务重启、Worker 多实例都不影响）。
- 余额固定 `{ balance: 1000, frozen: 0 }`；上传照样校验大小和格式，返回 `mock_file_…` 形式的 token。
- 下载：Vite 插件和 Node 服务读 `public/models/tufted-armchair.glb`（1.8 MB，可用 `TRIPO_MOCK_MODEL_FILE` 换），预览图是 `public/thumbs/` 里同名的缩略图；Worker 按 `MOCK_MODEL_URL` / `MOCK_PREVIEW_URL` 去取（没配预览图时给一张 SVG）。
- 限流和每日上限照样生效，前端能测到 `rate_limited`、`daily_cap`。开发时嫌 5 个 / 小时不够，可以在自己的 `.env.local` 里设 `TRIPO_MAX_TASKS_PER_IP_PER_HOUR=50`。

**模拟出错的开关**（方便前端测出错的界面）：

| 怎么触发 | 结果 |
| --- | --- |
| 提示词里带 `#fail` | 任务跑到约 60% 时 `failed`，带 `error` |
| 提示词里带 `#quota` | 建任务时直接返回 `quota` |
| 提示词里带 `#upstream` | 建任务时直接返回 `upstream` |
| 上传的图片文件名里带 `#fail`（如 `cat#fail.png`） | 用这张图的图片任务、多视图任务都会失败 |

---

## 4. 怎么配密钥

1. 在 Tripo 开放平台控制台创建 API 密钥（格式 `tsk_…`）。
2. **本地**：在仓库根目录建 `.env.local`（已在 `.gitignore` 里），写一行 `TRIPO_API_KEY=…`。变量模板见 `.env.example`（只有变量名和说明）。
3. **部署**：在主机 / 平台的环境变量里设 `TRIPO_API_KEY`；Cloudflare 用 `npx wrangler secret put TRIPO_API_KEY`。
4. **不要**起名 `VITE_TRIPO_API_KEY`：`VITE_` 开头的变量会被 Vite 打进前端包。Vite 插件发现这种变量会直接报错停下。
5. 密钥不在聊天、工单、截图里传。怀疑泄露就在控制台作废重建。

读取顺序（后面的盖前面的）：`.env` → `.env.local` → `.env.[mode]` → `.env.[mode].local` → **进程环境变量**（最高）。`npm run dev` 的 mode 是 `development`，`npm run preview` 和 `npm start` 是 `production`。

---

## 5. 本地怎么跑

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发服务器，带 `/api/tripo` |
| `npm run build && npm run preview` | 本地预览构建结果，同样带 `/api/tripo` |
| `npm run build && npm start` | 独立 Node 服务（默认 `http://0.0.0.0:8787`），和线上一样 |
| `npm test` | 单元测试（含 `tests/tripoProxy.test.ts`，fetch 打桩，不发真实请求） |

强制模拟模式：Git Bash 写 `TRIPO_MOCK=1 npm run dev`；PowerShell 写 `$env:TRIPO_MOCK=1; npm run dev`；cmd 写 `set TRIPO_MOCK=1&& npm run dev`。

模拟模式下用 curl 走一遍完整流程：

```sh
S=http://127.0.0.1:8787/api/tripo
curl -s $S/health
curl -s -F "file=@front.png;type=image/png" $S/upload            # → {"ok":true,"token":"…","type":"png"}
curl -s -H 'Content-Type: application/json' -d '{"mode":"text","prompt":"a small wooden chair"}' $S/task
curl -s $S/task/<taskId>                                          # 轮询到 success
curl -s -o model.glb $S/download/<taskId>
```

---

## 6. 部署：独立 Node 服务

一个进程同时托管 `dist/` 和 `/api/tripo`，零依赖，Node 24。

```sh
npm ci
npm run build
TRIPO_API_KEY=… TRIPO_MAX_TASKS_PER_DAY=50 PORT=8787 npm start
```

- 先带 `TRIPO_MOCK=1` 起一次，把页面和流程走通，再去掉。
- 静态文件：`/assets/*`（Vite 构建出的带哈希文件）加 `Cache-Control: public, max-age=31536000, immutable`；`index.html`、模型等其余文件 `no-cache`（带 ETag，没变就 304）；文本类按需 gzip。挡掉 `../` 越界和点开头的文件（`.env` 之类）。
- 必须用 HTTPS 访问（WebGPU 只在安全上下文可用）：前面放 Nginx / Caddy，或者用平台自带的 HTTPS。
- **前面有反向代理时设 `TRUST_PROXY=1`**（几层代理就填几），否则所有人都是代理的 IP，会共用一份「每 IP」限额；直连时保持 0，因为 `X-Forwarded-For` 可以伪造。
- 只跑**一个进程**：限流计数在内存里，PM2 cluster 之类的多进程会让上限翻倍；重启后计数清零（最后的兜底是 Tripo 账户里的积分，见第 9 节）。
- Render / Railway / Fly.io 这类平台：构建命令 `npm ci && npm run build`，启动命令 `npm start`，在面板里设环境变量；平台的负载均衡算一层代理，设 `TRUST_PROXY=1`。

Nginx 示例：

```nginx
server {
  listen 443 ssl;
  server_name planets.example.com;
  client_max_body_size 11m;                       # 单张图 10 MB + 表单开销
  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;                          # 下载结果时边收边发
  }
}
```

---

## 7. 部署：Cloudflare Worker

`server/tripo/worker.mjs` 把 `/api/tripo/*` 交给中转，其余请求交给静态资源。客户端 IP 用 Cloudflare 填的 `CF-Connecting-IP`（伪造不了）。

### 7.1 方案 A：同一个 Worker 既托管网页又做中转（推荐）

```sh
cp wrangler.toml.example wrangler.toml          # 按需改 name、[vars]
npm run build                                   # dist/ 作为静态资源（Workers Static Assets）上传
npx wrangler secret put TRIPO_API_KEY           # 交互输入密钥，不落盘
npx wrangler deploy
```

`wrangler.toml` 里 `[assets] directory = "./dist"`、`binding = "ASSETS"`、`run_worker_first = ["/api/*"]`：`/api/*` 先进 Worker，其余直接走静态资源。同源，`ALLOWED_ORIGINS` 留空。第一次部署建议在 `[vars]` 里加 `TRIPO_MOCK = "1"` 走通再删。本地调试用 `npx wrangler dev`，密钥放 `.dev.vars`（已在 `.gitignore` 里）。

### 7.2 方案 B：Worker 只做中转，网页放在别处

1. `wrangler.toml` 删掉 `[assets]` 段，`ALLOWED_ORIGINS` 写网页的地址（如 `https://planets.example.com`，多个用逗号隔开）；`MOCK_MODEL_URL` 写网页那边的完整地址。
2. 构建网页时设 `VITE_TRIPO_PROXY=https://community-planets.<子域>.workers.dev`（这是公开地址，不是密钥，可以进前端包），前端所有 `/api/tripo` 请求都以它为前缀；`modelUrl` / `previewUrl` 用它来解析（见第 2 节）。
3. `dist/` 传到任意静态托管（见仓库根目录 `DEPLOY.md`）。

跨域时：上传（multipart）和 GET 不需要预检；建任务（JSON）会先发 `OPTIONS` 预检，中转会回 204。canvas 要读预览图时 `<img crossOrigin="anonymous">`。

### 7.3 Worker 里的限流只在单个实例内有效

Worker 版的计数存在内存里，**只在单个 Worker 实例（isolate）里有效**。Cloudflare 会在很多机房同时跑很多实例、随时回收，所以每 IP 限流和每日上限只挡得住落在同一实例里的连续请求，挡不住分散的盗刷。真正上线要换掉存储，中转留了接口：

```js
// createHandler({ store }) 的 store 只要实现这一个方法（可以是异步的）
// hit(key, limit, windowMs, now) → { ok, retryAfterMs, release() }
//   key 形如 task:<ip>、task:all（每日上限）、upload:<ip>、req:<ip>；超限时 ok=false，retryAfterMs 是还要等多久
```

- **Durable Objects（推荐）**：强一致。每个 key 一个对象（`env.COUNTER.idFromName(key)`），对象里存时间戳数组，逻辑照抄 `handler.mjs` 里的 `createMemoryStore`。因为 store 要用到 `env`，在 `worker.mjs` 里按请求创建：`createHandler({ store: doStore(env), ... })`。
- **KV**：最终一致，同一时刻的并发请求可能都读到旧计数，上限会被超过一些；当软上限够用。
- Cloudflare 自带的 Rate Limiting 绑定可以替代每 IP 的限流，但它按机房计数，同样不适合做全局每日上限。

不论哪种，都要保留最后的兜底：Tripo 账户里只充演示需要的积分（见第 9 节）。

---

## 8. 各项限制和怎么调

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `TRIPO_MAX_TASKS_PER_IP_PER_HOUR` | 5 | 每个 IP 每小时最多建几个生成任务（滑动窗口）。IPv6 按 /64 算一个 |
| `TRIPO_MAX_TASKS_PER_DAY` | 50 | 全站滚动 24 小时内最多几个生成任务（所有 IP 合计）。**设 0 = 立刻关掉生成**（应急开关） |
| `TRIPO_MAX_UPLOADS_PER_IP_PER_HOUR` | 30 | 每个 IP 每小时最多上传几张图（多视图一次要 2–4 张） |
| `TRIPO_MAX_REQUESTS_PER_IP_PER_MINUTE` | 300 | 每个 IP 每分钟所有接口合计（含轮询、下载） |
| `TRIPO_MAX_IMAGE_MB` | 10 | 单张图上限，最大只能调到 20（Tripo 的上限） |
| `ALLOWED_ORIGINS` | 空 | 允许跨域调用的网页来源，逗号分隔；空 = 只允许同源。`*` 表示任何来源（不建议） |
| `TRIPO_MODEL_VERSIONS` | `v3.1-20260211,v3.0-20250812,v2.5-20250123` | 前端能选的模型版本。P 系列（`P1-20260311`、`P2-20260801`）贵很多，默认不放行 |
| `TRIPO_DEFAULT_MODEL_VERSION` | `v3.1-20260211` | 前端没指定时用的版本 |
| `TRIPO_API_BASE` | `https://openapi.tripo3d.ai/v3` | 中国区账号用 `https://openapi.tripo3d.com/v3` |
| `TRIPO_DOWNLOAD_HOSTS` | 空 | 结果文件额外允许的主机。内置 `tripo3d.ai`、`tripo3d.com` 及其子域名 |
| `TRIPO_MAX_DOWNLOAD_MB` | 200 | 结果文件上限 |
| `TRIPO_MOCK` | 空 | `1` = 强制模拟模式 |
| `TRIPO_MOCK_MODEL_FILE` | `models/tufted-armchair.glb` | 模拟模式的模型（Node / Vite，相对 `public/` 或 `dist/`） |
| `MOCK_MODEL_URL` / `MOCK_PREVIEW_URL` | 空 | 模拟模式的模型 / 预览图地址（Worker） |
| `PORT` / `HOST` / `STATIC_DIR` / `TRUST_PROXY` | 8787 / 0.0.0.0 / dist / 0 | 独立 Node 服务 |

固定的限制：JSON 请求体 ≤ 16 KB；`prompt` ≤ 1024 字；一次上传一张图、只认 PNG / JPEG（按文件头判断）；多视图正好 4 个位置、正面必填、至少 2 张；下载只按任务 id，不接受任何 URL。

**算一下最多花多少**：本中转只开放了基本参数，单个任务最多 30 积分（图片 / 多视图带贴图；文字带贴图 20、不带 10；1 积分 = 0.01 美元）。默认每日上限 50 个，即滚动 24 小时内最多约 1500 积分（约 15 美元）。

**会场共用 Wi-Fi**：所有人可能共用一个出口 IP，会一起被「每 IP」限额卡住。现场演示时调大 `TRIPO_MAX_TASKS_PER_IP_PER_HOUR` 和 `TRIPO_MAX_REQUESTS_PER_IP_PER_MINUTE`，靠 `TRIPO_MAX_TASKS_PER_DAY` 兜底。

---

## 9. 安全设计

- **密钥**：只从环境变量读；中转发出的所有文字（错误信息、日志）都会把密钥本身和长得像密钥的串（`tsk_…`）抹掉；单元测试检查所有响应和日志里都没有密钥；启动提示只说「有没有密钥」。
- **防盗刷**：每 IP 限流、全站每日上限、上传限流、总请求限流；先占名额再调 Tripo，Tripo 明确拒绝时退回名额，结果不明（超时、5xx）时不退（请求可能已经扣费）。
- **跨域白名单不是鉴权**：它只能挡住别的网站在浏览器里调我们的接口，挡不住 curl。真正的保护是上面的限流和每日上限；**最后的兜底是 Tripo 账户余额**——测试账号只充演示需要的积分，演示结束后作废密钥。
- **参数白名单**：只放行三种任务和固定字段；token 只能是字母、数字、`_`、`-`，所以塞不进 URL（避免让 Tripo 去拉任意地址），也拼不出别的路径。
- **下载不是通用代理**：前端只给任务 id，中转自己向 Tripo 查结果链接；链接必须是 https、默认端口、主机在白名单里、不带账号密码；跳转逐跳检查；不把密钥发给存储主机；有大小上限；返回时强制 `Content-Type`、加 `X-Content-Type-Options: nosniff` 和 `Content-Security-Policy: sandbox`。
- **上传**：按文件头认 PNG / JPEG，不信扩展名和 Content-Type；重新包成新的文件发给 Tripo，不转发用户的文件名。
- **开发服务器**：中转前加了 Host 检查（防 DNS 重绑定），规则同 Vite 的 `allowedHosts`。

---

## 10. Tripo API v3 调研结果

调研日期 2026-10-30。官方文档已从 `platform.tripo3d.ai/docs` 迁到 **developers.tripo3d.ai**（中国站 developers.tripo3d.com），每一页在地址后加 `.md` 就是 Markdown 版，总目录见 <https://developers.tripo3d.ai/llms.txt>。另外对照了官方 SDK 的源码：Python SDK 1.0.0（2026-10，专门为 v2 停用改到 v3）和 JS SDK。

### 10.1 基本

| 项 | v3 | 来源 |
| --- | --- | --- |
| 基地址 | `https://openapi.tripo3d.ai/v3`；中国区 `https://openapi.tripo3d.com/v3` | [Introduction](https://developers.tripo3d.ai/en/docs/introduction)、JS SDK `src/constants.js`、Python SDK `tripo3d/client.py` |
| 鉴权 | 请求头 `Authorization: Bearer <api_key>`；密钥以 `tsk_` 开头（Python SDK 会校验） | [Authentication](https://developers.tripo3d.ai/en/docs/authentication)、Python SDK `client.py` |
| 响应格式 | 成功 `{ "code": 0, "data": {…} }`；失败 `{ "code": 2010, "status": "error", "message", "suggestion", "request_id" }`，HTTP 200 但 `code ≠ 0` 也是失败 | [Introduction](https://developers.tripo3d.ai/en/docs/introduction)、Python SDK `_http.py` |
| 异步任务 | 建任务返回 `task_id`，再 `GET /v3/tasks/{task_id}` 轮询（建议 1–2 秒一次，设 5 分钟左右超时） | [Task Lifecycle](https://developers.tripo3d.ai/en/docs/task-lifecycle) |
| v2 停用 | 2026-10-01 起不再更新；**2026-10-31 16:00 UTC 起 v2 所有接口停止服务**；v2、v3 共用同一个密钥 | platform.tripo3d.ai 控制台的停用公告、Python SDK [CHANGELOG](https://github.com/Tripo-Developer/tripo-python-sdk/blob/master/CHANGELOG.md)、[迁移指南](https://developers.tripo3d.ai/en/docs/migration-v2-to-v3) |

### 10.2 上传图片

`POST /v3/files`，`multipart/form-data`，字段 `file`。返回 `{ "code": 0, "data": { "file_token": "file_abc123" } }`，之后放进生成接口的 `input`。图片只写了 **JPEG、PNG，最大 20 MB**；模型 GLB / GLTF / FBX / OBJ / STL 最大 150 MB；60 MB 以上建议走预签名上传 `POST /v3/files/presign`（返回 `presigned_url`、`file_token`、`expires_in`）。来源：[File Upload](https://developers.tripo3d.ai/en/docs/files)、[Presign](https://developers.tripo3d.ai/en/docs/files-presign)。

### 10.3 建任务

| 任务 | 接口 | 主要字段 |
| --- | --- | --- |
| 文字生成 | `POST /v3/generation/text-to-model` | `prompt`（必填，≤ 1024 字）、`model`（必填）、`negative_prompt`（≤ 255 字） |
| 单图生成 | `POST /v3/generation/image-to-model` | `input`（必填：file_token、公开 URL 或之前生图任务的 task_id，三选一）、`model`（必填）、`texture_alignment`、`orientation`、`enable_image_autofix`；图片 PNG / JPEG / WebP，≤ 20 MB |
| 多视图生成 | `POST /v3/generation/multiview-to-model` | `inputs`（必填）、`model`（必填）。三种写法选一种：**view-key（推荐）** `[{ "front": "file_a" }, { "back": "file_b" }]`，顺序无所谓；旧的按位置写法 4 个字符串 `[前, 左, 后, 右]`，空位填 `""`；或 `[{ "task_id": … }]` 复用「图生多视图」的结果。**正面不能省，至少 2 张** |

三种任务共有的可选字段：`texture`（默认 true）、`pbr`（默认 true，输出 base_color / metallic / roughness / normal，**设为 true 会强制 `texture` 也为 true**）、`texture_quality`（`fast` 需配 `texture_version=v3.5-20260815` / `standard` / `detailed` / `extreme` 8K）、`texture_version`、`delight`、`geometry_quality`（`standard` / `detailed`，仅 v3.0 以上）、`face_limit`、`auto_size`、`quad`（会强制输出 FBX）、`smart_low_poly`、`generate_parts`（必须同时关贴图和 PBR）、`compress: "geometry"`、`export_orientation`、`export_uv`、`model_seed` / `image_seed` / `texture_seed`。返回 `{ "code": 0, "data": { "task_id": "123e4567-…" } }`。来源：[Text to Model](https://developers.tripo3d.ai/en/docs/generation-text-to-model/standard)、[Image to Model](https://developers.tripo3d.ai/en/docs/generation-image-to-model/standard)、[Multiview to Model](https://developers.tripo3d.ai/en/docs/generation-multiview-to-model/standard)。

**本中转只开放** `prompt` / `input` / `inputs` / `model` / `texture` / `pbr`，其余（尤其是加钱的 `geometry_quality=detailed`、`texture_quality=detailed|extreme`、`quad`、`generate_parts`）一律不放行。

### 10.4 模型版本（`model`，必填）

| 版本 | 说明 |
| --- | --- |
| `v3.1-20260211` | H3.1，最新、质量最好（推荐，JS SDK 的默认值） |
| `v3.0-20250812` | H3.0，上一代稳定版 |
| `v2.5-20250123` | H2.5，旧版（Python SDK 的默认值） |
| `P2-20260801` | P 系列，原生四边面，48–50,000 三角面；**一个任务 100–130 积分** |
| `P1-20260311` | P 系列低模，50–20,000 面 |

`v2.0-20240919` 在 v3 上已不提供。来源：[Models & Versions](https://developers.tripo3d.ai/en/docs/models-and-versions)、[Changelog](https://developers.tripo3d.ai/en/docs/changelog)、Python SDK [docs/API.md](https://github.com/Tripo-Developer/tripo-python-sdk/blob/master/docs/API.md)。

### 10.5 查任务

`GET /v3/tasks/{task_id}` 返回 `data`：`task_id`、`type`（如 `text_to_model`）、`status`、`progress`（0–100 整数）、`output`（只在 success 时有：`model_url`、`rendered_image_url` 等）、`error_code`、`error_message`（可选）、`credits_consumed`（带两位小数）、`created_at`、`completed_at`（ISO 8601）。

`status`：`queued`（progress 0）→ `running`（0–100）→ `success`（100）/ `failed` / `cancelled`。内部的 `banned`、`expired` 在 v3 一般报成 `failed`，旧响应里出现就当终止；其他值（如 `unknown`）不要当成功或失败，继续轮询并设超时。批量查询 `POST /v3/tasks/list`（一次最多 100 个）。来源：[Task Query](https://developers.tripo3d.ai/en/docs/task-query)、[Task Lifecycle](https://developers.tripo3d.ai/en/docs/task-lifecycle)、JS SDK `src/client.js`。

### 10.6 结果文件

- `model_url`、`rendered_image_url` 是**带签名的临时链接**。JS SDK 的 README 写「模型链接在任务完成后约 5 分钟过期，要马上下载」；官方 SDK 页面的排错建议是「链接过期就重新查一次任务，再马上下载；不要把临时链接当永久地址存」。下载时**不要带** `Authorization` 头（几个官方 SDK 都是这么做的）。来源：[JS SDK README](https://github.com/Tripo-Developer/tripo-js-sdk)、[SDK Integration](https://developers.tripo3d.ai/en/docs/sdk)。
- 所以本中转的 `/download/:id` **每次都重新查任务拿新链接**，再流式转发。
- 结果文件的主机：官方文档的样例是 `cdn.tripo3d.ai`（文档注明是示意）；阿里云百炼接入 Tripo 的文档里样例是 `https://openapi.cdn.tripo3d.com/xxxx.glb?auth_key=…`（该接入里链接 2 小时过期）。来源：[阿里云文档](https://help.aliyun.com/en/model-studio/tripo-3d-generation-guide)。中转默认放行 `tripo3d.ai`、`tripo3d.com` 及其子域名。
- 浏览器能不能直接跨域下载这些链接：**待确认**（我们走中转，不受影响）。

### 10.7 余额、限流、计费

- 余额 `GET /v3/account/balance` → `{ balance, frozen }`（带两位小数的数字；`frozen` 是进行中任务预扣的积分）。用量 `GET /v3/account/usage`。来源：[Account](https://developers.tripo3d.ai/en/docs/account)。
- 频率限制按 API 密钥算，超了 HTTP 429、`code 1007`；并发限制按账户、按任务类别算（H 系列 3D 生成默认 10 个、P 系列 5 个同时进行），超了 HTTP 429、`code 2000`，带 `Retry-After`。具体频率数值文档没写。来源：[Rate Limits](https://developers.tripo3d.ai/en/docs/rate-limits)。
- 先冻结、成功才扣：失败、取消的任务不收费。价格（1 积分 = 0.01 美元）：H 系列文字生成 10（不带贴图）/ 20（标准贴图），单图、多视图 20 / 30；高清贴图 +10、8K 贴图 +20、高清几何 +20、四边面 +5、智能低模 +10、拆件 +20；P2 是 100 / 110 / 120 / 130。来源：[Billing](https://developers.tripo3d.ai/en/docs/billing)、[Pricing](https://developers.tripo3d.ai/en/pricing)。

### 10.8 错误码（请求级）

| code | HTTP | 含义 | 中转映射成 |
| --- | --- | --- | --- |
| 2 / 1002 | 401 | 密钥缺失或无效 | `upstream`（服务端配置问题） |
| 1003 / 1004 | 400 | 请求体格式错 / 参数无效 | `bad_request` |
| 1007 | 429 | 频率超限 | `rate_limited` |
| 2000 | 429 | 并发超限 | `rate_limited` |
| 2002 / 2003 / 2004 | 400 | 不支持的任务类型 / 空文件 / 不支持的文件类型 | `bad_request` |
| 2008 | 400 | 内容审核不通过 | `bad_request` |
| 2010 | 403 | 积分不足 | `quota` |
| 2015 / 2018 | 400 | 版本已废弃 / 模型太复杂 | `bad_request` |
| 1000 / 1001 | 500 | 服务端错误 | `upstream` |

任务失败时的 `error_code` 和请求级的 `code` 是两套，同一个数字含义可能不同。HTTP 404 一律映射成 `not_found`。来源：[Error Handling](https://developers.tripo3d.ai/en/docs/error-handling)。

---

## 11. 从 v2 换到 v3 改了什么

| | v2（已停用） | v3（本中转用的） |
| --- | --- | --- |
| 基地址 | `https://api.tripo3d.ai/v2/openapi` | `https://openapi.tripo3d.ai/v3` |
| 建任务 | 一个 `POST /task`，靠 `type` 字段区分 | 每种能力一个接口，如 `POST /v3/generation/text-to-model`，不再传 `type` |
| 图片输入 | 按来源用不同字段（`file` / `file_token` / `url` / `object`，多视图是 `files` 列表） | 统一成 `input`（单图）/ `inputs`（多视图），值是 file_token、URL 或 task_id，服务端自己判断 |
| 模型版本 | `model_version`（可选） | `model`（**必填**） |
| 上传 | `POST /v2/openapi/upload` | `POST /v3/files`，返回 `file_token` |
| 查任务 | `GET /v2/openapi/task/{id}` | `GET /v3/tasks/{id}` |
| 输出字段 | `model`、`pbr_model`、`base_model`、`rendered_image` | 一个 `model_url`（PBR 版就是它）、`rendered_image_url`，统一 `*_url` |
| 其他字段 | `create_time`、`consumed_credit` | `created_at`（ISO 8601）、`credits_consumed` |
| 状态 | 有 `banned`、`expired` | 一般都报成 `failed`，看 `error_code` |
| 其他 | refine、stylize 可用；有 `v2.0-20240919` 模型 | refine、stylize 已下线；`v2.0-20240919` 不再提供 |

来源：[迁移指南](https://developers.tripo3d.ai/en/docs/migration-v2-to-v3)、[Changelog](https://developers.tripo3d.ai/en/docs/changelog)、Python SDK [CHANGELOG](https://github.com/Tripo-Developer/tripo-python-sdk/blob/master/CHANGELOG.md) 和 [docs/API.md](https://github.com/Tripo-Developer/tripo-python-sdk/blob/master/docs/API.md#migrating-from-0x)。

我们的 `/api/tripo` 接口约定没有因此改形状，对应关系：

| 前端发的 | 中转发给 Tripo v3 的 |
| --- | --- |
| `{ mode: 'text', prompt }` | `POST /v3/generation/text-to-model` `{ prompt, model }` |
| `{ mode: 'image', token, type }` | `POST /v3/generation/image-to-model` `{ input: token, model }`（v3 不需要 `type`，中转只校验它） |
| `{ mode: 'multiview', views: [前, 左, 后, 右] }` | `POST /v3/generation/multiview-to-model` `{ inputs: [{ front: … }, { back: … }], model }`（view-key 写法，跳过 null） |
| `modelVersion` | `model`（不传时用 `TRIPO_DEFAULT_MODEL_VERSION`） |
| `texture` / `pbr` | 原样；`texture: false` 时一并发 `pbr: false` |
| `GET /task/:id` 的 `modelUrl` / `previewUrl` | 不直接给 Tripo 的临时链接，而是本中转的 `/download/:id`、`/preview/:id` |

---

## 12. 待确认

真实密钥不在开发环境里，以下几点没法实测，代码里也标了「待确认」：

1. **国际区结果文件的实际主机**。默认放行 `*.tripo3d.ai`、`*.tripo3d.com`；如果真实链接在别的主机（比如某个 `*.cloudfront.net`），下载会报「结果文件的主机 xxx 不在白名单里」，确认是 Tripo 的就加进 `TRIPO_DOWNLOAD_HOSTS`。
2. 结果链接的确切有效期（JS SDK 说约 5 分钟；阿里云的接入是 2 小时），以及 `GET /v3/tasks/{id}` 能查多久。
3. `/v3/files` 是否接受 WebP（上传文档只写了 JPEG、PNG；生成接口的文档写了 WebP）。中转目前只收 PNG / JPEG。
4. 任务 id 是否总是 UUID（中转只限定字符 `[A-Za-z0-9_-]` 和长度 8–128）。
5. 查不到任务时的业务码（中转以 HTTP 404 为准）。
6. 每个密钥的具体频率上限（文档没写数值）。

拿到真实密钥后的首次验证建议：先 `TRIPO_MOCK=1` 把前端走通；再去掉模拟，只做**一个**最便宜的任务（文字生成、`texture: false`，10 积分），确认轮询、下载、预览都通，再放开。

---

## 13. 开发团队要接自己的后端时改哪里

处理函数和框架无关：`createHandler(options)` 返回 `handle(request, env, info)`，输入 Web 标准的 `Request`、输出 `Response`。

- **挂到别的框架**：Next.js App Router、Hono、Deno、Bun 直接把 `Request` 交给 `handle`；Express / Koa 用 `server/tripo/node-adapter.mjs` 的 `createNodeMiddleware()`。
- **加用户登录**：在 `handler.mjs` 返回的 `handle` 开头（跨域检查之后、路由之前）校验会话或 JWT，不通过就返回 401；把限流 key 从 `task:<ip>` 换成 `task:<userId>`（`createTask`、`upload` 里的 `limit(...)` 调用）。
- **任务归属**：建任务成功后记 `taskId → userId`，在 `taskStatus`、`result`（下载 / 预览）里检查，防止别人拿到 id 就能下载。
- **多实例 / 持久的限流**：实现 `store` 接口（`hit(key, limit, windowMs, now)`，见 7.3）接 Redis、Durable Objects 或数据库，传给 `createHandler({ store })`。
- **结果存到自己的存储**：任务成功后由服务端下载一次存到 S3 / R2，给前端自己的地址，就不用每次下载都去 Tripo 取（也不怕链接过期）。改 `result()` 和 `taskStatus()` 里 `modelUrl` 的生成。
- **用 Webhook 代替轮询**：Tripo 支持 `task.completed`、`task.failed` 回调（HMAC-SHA256 签名），见 [Webhooks](https://developers.tripo3d.ai/en/docs/webhooks)。
- **开放更多参数**（比如 `negative_prompt`、`face_limit`）：在 `TASK_FIELDS` 加字段，在 `buildTask()` 里校验并写进 `payload`。注意有些参数会多扣积分（见 10.7）。
- **换模拟数据**：Node / Vite 用 `TRIPO_MOCK_MODEL_FILE`，Worker 用 `MOCK_MODEL_URL`；或者给 `createHandler` 传 `loadMockModel` / `loadMockPreview`。
- **中国区账号**：`TRIPO_API_BASE=https://openapi.tripo3d.com/v3`。

---

## 14. 测试

`npm test` 里的 `tests/tripoProxy.test.ts`（fetch 打桩成假的 Tripo 上游，不发真实请求）覆盖：

- 进程环境变量里的 `TRIPO_MOCK=1` 最优先、env 文件的先后顺序、`health` 如实报模式、真实模式的启动提示不带密钥的任何一部分；
- 每 IP 限流、全站每日上限（含设 0 关掉、24 小时后恢复）、上传限流、总请求限流、Tripo 明确拒绝时退回名额而结果不明时不退、IPv6 按 /64 计；
- 参数白名单（任务类型、多余字段、模型版本、token 格式、多视图规则、prompt 长度、请求体类型和大小）以及发给 Tripo 的 v3 请求体；
- 上传：转发到 `POST /v3/files`、大小上限、按文件头认格式、只收一张；
- 下载只放行 Tripo 主机：别的主机、后缀伪装、http、带账号密码、非默认端口、内网地址、跳到白名单外都拒绝且不去请求，不把密钥发给存储主机；
- 错误码映射、状态映射、跨域白名单、模拟模式的时间线和出错开关、Worker 外壳的路由和按 `CF-Connecting-IP` 限流；
- 最后检查所有用例的响应和日志里都没有出现密钥。
