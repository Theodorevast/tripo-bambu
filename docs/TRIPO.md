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
| Cloudflare Worker | `server/tripo/worker.mjs` + `rate-limiter.mjs` + `wrangler.toml` | 部署到 Cloudflare（第 7 节，两个版本都用） |

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
| `GET /models` | — | `{ ok, defaultModel, defaultTexture, models: [{ id, label, blurb, textures, eta, measured, credits }] }`（模型选择器，见 10.9） |
| `GET /balance` | — | `{ ok, balance, frozen }`（Tripo 积分，带两位小数的数字，别用 parseInt） |
| `POST /upload` | multipart，字段 `file`，**一张** PNG / JPEG，≤ 10 MB | `{ ok, token, type: 'png' \| 'jpeg' }` |
| `POST /task` | JSON，见下 | `{ ok, taskId }` |
| `GET /task/:id` | — | `{ ok, status, progress, modelUrl?, previewUrl?, credits?, error? }`（`credits`：成功时 Tripo 报的扣费） |
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
- 加速用的可选字段（三种任务都能带，都不加钱，见 10.9）：
  - `textureQuality: 'fast'`：快速贴图。中转发 `pbr: false`，v3.0 以上再加 `texture_quality: 'fast'` 和 `texture_version: 'v3.5-20260815'`；P 系列没有这一档；和 `pbr: true` 一起传会被拒。`'standard'` 等于不传。
  - `faceLimit`：`0` = 不发 `face_limit`，或者 1000–500000 的整数；不传用中转的默认（`TRIPO_FACE_LIMIT`，30 万）。P1 这种自己有更低上限的版本不发默认值。
  - `compress`：布尔，`true` 发 `compress: 'geometry'`（meshopt，只给 v3.0 以上）；不传按 `TRIPO_COMPRESS`（默认关）。
  - 这些参数被 Tripo 当成无效参数（1003 / 1004）拒绝时，中转去掉它们再建一次（建任务失败不扣积分）。

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
3. **部署**：在主机 / 平台的环境变量里设 `TRIPO_API_KEY`；Cloudflare 用 `npx --yes wrangler@4.156.0 secret put TRIPO_API_KEY`（第二版再加 `--env v2`）。
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
| `npm run cf:dev` | Cloudflare Worker 本地试跑（wrangler dev，强制模拟模式，见 7.5） |
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

## 7. 部署：Cloudflare Worker（第一版、第二版都用这个）

一个 Worker 既托管网页（`dist/`，Workers Static Assets）又做中转：`/api/*` 先进 Worker（`server/tripo/worker.mjs`），其余请求直接走静态资源、不进 Worker。限流计数在 Durable Objects 里（`server/tripo/rate-limiter.mjs`），所有实例、所有机房看到的是同一份计数。客户端 IP 用 Cloudflare 填的 `CF-Connecting-IP`（伪造不了）。

配置就是仓库根目录的 `wrangler.toml`，两个版本用同一份，不用按分支改：

| | 第一版 | 第二版 |
| --- | --- | --- |
| 分支 / 文件夹 | `int/v6`（→ `main`）/ `Desktop\gbn` | `v2-medieval` / `Desktop\gbn-medieval` |
| 部署命令 | `npm run cf:deploy` | `npm run cf:deploy:v2`（`--env v2`） |
| Worker 名 | `community-planets` | `community-planets-v2` |
| 限流计数 | 自己的 `RateLimiter`（Durable Object） | 绑到第一版的 `RateLimiter`（`script_name`），**两版共用一份计数和每日上限** |

wrangler 没装进项目（不动 `package-lock.json`），统一用固定版本 `npx --yes wrangler@4.156.0`，`npm run cf:*` 脚本里也是它。以前的 `wrangler.toml.example` 换成了能直接部署的 `wrangler.toml`：第二版的 `[env.v2]` 要和第一版写在同一份配置里，两个文件夹各自复制、各自改的话很快就对不上。

### 7.1 上线步骤（按顺序做）

在 Git Bash 里跑（PowerShell 也行，第 2 步的管道写法除外）。两个文件夹先拿到最新代码：第一版在 `int/v6`；第二版的 `v2-medieval` 先合并含这次改动的 `int/v6`。依赖没装过就先 `npm ci`。

**1. 登录 Cloudflare**（一台电脑做一次）

```sh
npx --yes wrangler@4.156.0 login      # 浏览器里点授权
npx --yes wrangler@4.156.0 whoami     # 能看到自己的账号就对了
```

**2. 给两个 Worker 各设一次密钥**（存在 Cloudflare，不进仓库；设一次以后每次部署都在）

```sh
cd ~/Desktop/gbn
npx --yes wrangler@4.156.0 secret put TRIPO_API_KEY             # 第一版
npx --yes wrangler@4.156.0 secret put TRIPO_API_KEY --env v2    # 第二版
```

提示 `Enter a secret value` 时粘贴密钥（不回显）。Worker 还不存在时 wrangler 会问要不要先建一个空的，回答 y。

Git Bash 的默认窗口（mintty）里这个提示有时出不来、一直卡着。可以改成从自己的 `.env.local` 管道传进去，密钥不会显示在屏幕上：

```sh
sed -n 's/^TRIPO_API_KEY=//p' .env.local | tr -d "\r\n\"'" | npx --yes wrangler@4.156.0 secret put TRIPO_API_KEY
sed -n 's/^TRIPO_API_KEY=//p' .env.local | tr -d "\r\n\"'" | npx --yes wrangler@4.156.0 secret put TRIPO_API_KEY --env v2
```

**3. 构建并部署：先第一版，再第二版**（第二版用的是第一版的 `RateLimiter`，第一版没部署时第二版找不到它）

```sh
cd ~/Desktop/gbn
npm run cf:deploy        # = npm run build，再 npx --yes wrangler@4.156.0 deploy --env=

cd ~/Desktop/gbn-medieval
npm run cf:deploy:v2     # = npm run build，再 npx --yes wrangler@4.156.0 deploy --env v2
```

账号第一次部署到 workers.dev 时，wrangler 会问要不要注册 workers.dev 子域：选 y，起个名字（也可以先在控制台 Workers & Pages 里注册）。部署成功会打印网址。以后改了代码，在对应的文件夹重跑同一条命令。

**4. 确认是真实模式**

浏览器打开下面的地址，或者用 curl：

```sh
curl https://community-planets.<子域>.workers.dev/api/tripo/health       # → {"ok":true,"mock":false}
curl https://community-planets-v2.<子域>.workers.dev/api/tripo/health    # → {"ok":true,"mock":false}
```

- `"mock":true`：这个 Worker 没设上密钥（用 `npx --yes wrangler@4.156.0 secret list` 查，第二版加 `--env v2`），或者设了 `TRIPO_MOCK=1`（见第 5 步）。
- 500 且提到 `RATE_LIMITER`：Durable Objects 绑定没配上，用仓库里的 `wrangler.toml` 重新部署。
- 第二版 500「服务端出错」：多半是第一版还没部署或部署失败；`npm run cf:tail:v2` 能看到具体错误。

然后打开首页，在生成页用最便宜的方式试一个任务（文字生成、不带贴图，10 积分）。

**5. 不改代码：切模拟模式、改每日上限**

- 切到模拟模式（马上生效，以后重新部署也保持）：
  ```sh
  echo 1 | npx --yes wrangler@4.156.0 secret put TRIPO_MOCK              # 第一版
  echo 1 | npx --yes wrangler@4.156.0 secret put TRIPO_MOCK --env v2     # 第二版
  ```
  切回真实模式：同样的命令把 `1` 换成 `0`（或者 `secret delete TRIPO_MOCK`，会问一次确认）。health 的 `mock` 跟着变。
- 改每日上限、应急关掉生成：控制台 Workers & Pages → `community-planets` → Settings → Variables and Secrets，改 `TRIPO_MAX_TASKS_PER_DAY`（`0` = 关掉生成）→ Deploy，马上生效。两版共用计数，`community-planets-v2` 也改成一样的。注意：下次 `npm run cf:deploy` 会恢复成 `wrangler.toml` 里的值（wrangler 部署时会先删掉控制台改的变量）。
- 只是这次部署换个值，也可以不改文件：`npm run build && npx --yes wrangler@4.156.0 deploy --env= --var TRIPO_MAX_TASKS_PER_DAY:10`（第二版换成 `--env v2`）。长期改就改 `wrangler.toml` 里的两处 `[vars]`。

**6. 看日志**

```sh
npm run cf:tail        # 第一版，实时：每个请求、真实模式提示、出错信息（没有密钥）
npm run cf:tail:v2     # 第二版
```

`wrangler.toml` 打开了 `[observability]`，控制台里这个 Worker 的 Logs 页还能查最近几天的日志（免费版每天 20 万条、留 3 天）。

**7. 网址**

| | 网页 | 接口自检 |
| --- | --- | --- |
| 第一版 | `https://community-planets.<子域>.workers.dev` | `https://community-planets.<子域>.workers.dev/api/tripo/health` |
| 第二版 | `https://community-planets-v2.<子域>.workers.dev` | `https://community-planets-v2.<子域>.workers.dev/api/tripo/health` |

`<子域>` 是账号的 workers.dev 子域（控制台 Workers & Pages 页能看到，部署时 wrangler 也会打印完整网址）。要用自己的域名：控制台 → 这个 Worker → Settings → Domains & Routes。

### 7.2 方案 B：Worker 只做中转，网页放在别处

1. `wrangler.toml` 删掉 `[assets]` 段，`[vars]` 加 `ALLOWED_ORIGINS`（网页的地址，如 `https://planets.example.com`，多个用逗号隔开）；`MOCK_MODEL_URL` 写网页那边的完整地址。Durable Objects 的绑定保留。
2. 构建网页时设 `VITE_TRIPO_PROXY=https://community-planets.<子域>.workers.dev`（这是公开地址，不是密钥，可以进前端包），前端所有 `/api/tripo` 请求都以它为前缀；`modelUrl` / `previewUrl` 用它来解析（见第 2 节）。
3. `dist/` 传到任意静态托管（见仓库根目录 `DEPLOY.md`）。

跨域时：上传（multipart）和 GET 不需要预检；建任务（JSON）会先发 `OPTIONS` 预检，中转会回 204。canvas 要读预览图时 `<img crossOrigin="anonymous">`。

### 7.3 限流：Durable Objects

- 绑定 `RATE_LIMITER` → 类 `RateLimiter`（`server/tripo/rate-limiter.mjs`），SQLite 后端（`[[migrations]]` 里的 `new_sqlite_classes`；Workers 免费版只能用这种）。
- 每个限流 key 一个对象：`task:<ip>`、`upload:<ip>`、`req:<ip>` 各一个。**全站每日上限 `task:all` 全球只有一个对象**，所以是强一致的，换 IP、换机房、换实例都绕不过去。
- 滑动窗口的规则和 Node / Vite 用的内存版是同一份代码（`handler.mjs` 的 `windowHit` / `windowRelease` / `pruneStamps`），包括 Tripo 明确拒绝时退回名额。
- 一次限流检查 = 一次 RPC 往返：每个接口请求查一次 `req:<ip>`；建任务再查 `task:<ip>`、`task:all`；上传再查 `upload:<ip>`。静态资源的请求不进 Worker，也不碰 Durable Objects。退名额在响应发出后用 `ctx.waitUntil` 做完。
- 计数存在对象自己的存储里：对象被回收、重新部署、`wrangler dev` 重启都不丢。一天以前的时间戳由对象的闹钟清掉，什么都不剩就整个删掉，不占存储。
- 第二版的绑定写了 `script_name = "community-planets"`，用的是第一版的对象（第二版自己不建：`[env.v2]` 里 `migrations = []`）。两版各自按自己的 `[vars]` 判断，所以两处上限要设成一样；不一样时，上限大的那一版能一直用到它自己的上限。
- 出错就关门：调 Durable Objects 失败（比如免费额度用完）时中转回 500，不调 Tripo。真实模式缺了 `RATE_LIMITER` 绑定时所有接口直接回 500（提示检查 `wrangler.toml`）；只有模拟模式没有绑定时才退回单实例的内存计数（单元测试、只看页面时）。
- 想让第二版单独计数：删掉 `[[env.v2.durable_objects.bindings]]` 里的 `script_name`，再把 `[env.v2]` 里的 `migrations = []` 删掉（继承顶层的 `[[migrations]]`）。
- Cloudflare 现在推荐用 `exports` 代替 `migrations` 声明 Durable Object 类。两种都支持；部署过 `migrations` 的以后可以换成 `exports`，反过来不行，所以这里先用 `migrations`。

最后的兜底照旧：Tripo 账户里只充演示需要的积分（见第 9 节）。

### 7.4 Cloudflare 的限制、价格和该用哪个套餐

2026-10-30 查的官方文档：[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[Workers 价格](https://developers.cloudflare.com/workers/platform/pricing/)、[Durable Objects 价格](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[Durable Objects 限制](https://developers.cloudflare.com/durable-objects/platform/limits/)、[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)。

| | Workers 免费版 | Workers 付费版（每月最低 5 美元） |
| --- | --- | --- |
| Worker 请求 | 每天 10 万次（UTC 0 点重置，超了进 Worker 的请求回错误 1027） | 每月 1000 万次，超出每百万 0.30 美元 |
| 每个请求的 CPU 时间 | **10 ms** | 默认 30 秒，最多 5 分钟；每月含 3000 万 CPU 毫秒，超出每百万 0.02 美元 |
| 内存 | 每个实例 128 MB | 同左 |
| 子请求（fetch、调 Durable Objects） | 每个请求 50 个（调 Cloudflare 自己的服务 1000 个） | 1 万个 |
| 静态资源 | 免费、不限次数；每个版本 2 万个文件，单个文件 25 MiB | 免费、不限次数；10 万个文件，单个 25 MiB |
| 请求体 | 看域名的套餐：免费 / Pro 100 MB | 同左 |
| Durable Objects 请求 | 每天 10 万次 | 每月 100 万次，超出每百万 0.15 美元 |
| Durable Objects 时长 | 每天 13,000 GB-s | 每月 40 万 GB-s，超出每百万 GB-s 12.50 美元 |
| SQLite 读 / 写 | 每天 500 万 / 10 万行 | 每月 250 亿 / 5000 万行，写超出每百万行 1 美元 |
| SQLite 存储 | 共 5 GB | 每月 5 GB，超出每 GB 0.20 美元 |
| Workers Logs | 每天 20 万条，留 3 天 | 每月 2000 万条，留 7 天（2026-12-01 起改按 Cloudflare Observability 计价） |

免费版任何一项每日额度用完，当天这类操作就报错，到 UTC 0 点（北京时间 8 点）恢复。中转出错就关门：Worker 或 Durable Objects 的额度用完时生成接口不可用，但不会多花 Tripo 的钱；静态网页照常打开。

我们的用量（CPU 和内存是估计，本地 wrangler dev 不限也不报 CPU 时间）：

- 静态资源（网页、模型、缩略图）不进 Worker，不算请求；只有不存在的路径会进 Worker，回 404。构建结果 97 个文件、共 78 MB，最大的 `models/military-tank.glb` 6.2 MiB，离 2 万个文件、25 MiB 都很远（第二版的 `public/` 和第一版一样）。
- 每个 `/api/tripo/*` 请求：1 次 Worker 请求 + 1 次 Durable Objects 请求 + 1 行写入（`req:<ip>`）；建任务再多 2 次请求、2 行写入。
- 一次生成大约 40–70 个接口请求（建任务、每 2–3 秒轮询一次、下载、预览）。每日上限 30 个时一天大约 2000–5000 个请求，免费版的几项每日额度都只用到几个百分点。
- 内存：下载是流式的，40–45 MB 的模型不进内存；上传最多 10 MB，要整个读进来解析表单，估计占 20–30 MB。
- CPU：查任务、建任务、转发下载估计都在 1–2 毫秒以内（等 Durable Objects 和 Tripo 的时间不算 CPU）。**上传是例外**：要在 Worker 里解析最多 10 MB 的 multipart 表单再转发，图大时有可能超过免费版的 10 ms，超了这个请求失败（错误 1102）。

**建议用付费版（5 美元 / 月）**。公开演示时：（1）大图上传不会撞 10 ms 的 CPU 上限；（2）没有每天 10 万次的硬上限，有人刷接口时不会让当天剩下的时间里所有人都用不了生成；（3）Durable Objects 的额度按月算、超了按量计费，不会当天中途报错。按上面的用量，付费版包含的额度就够，每月就是 5 美元。只给团队内部看、上传的图不大时，免费版也能跑。

### 7.5 本地试跑（wrangler dev）

```sh
npm run cf:dev     # 构建，再 wrangler dev（http://localhost:8787），强制模拟模式（--var TRIPO_MOCK:1）
npm run cf:check   # 构建，再两个版本各跑一次 deploy --dry-run（不用登录）
```

- 一定用 `npm run cf:dev`，不要直接 `wrangler dev`：wrangler dev 会读文件夹里的 `.env.local`，里面有真实密钥时就是真实模式，会花额度。`--var TRIPO_MOCK:1` 比 `.env.local` 优先（试过）。
- Durable Objects 在本地也是真的（存在 `.wrangler/state`），重启 `wrangler dev` 后计数还在；想清零就删掉 `.wrangler/state`。
- 本地可以自己带 `CF-Connecting-IP` 头（`curl -H 'CF-Connecting-IP: 198.51.100.1' …`），方便测每个 IP 的限流。
- 本地想看第二版用第一版的计数：要在同一个 `wrangler dev` 里同时跑两个 Worker（多个 `-c`，第二版的配置放前面）。分成两个终端各跑一个时，第二版调第一版的对象会报 `Network connection lost`（本机用 wrangler 4.156.0 试过）。

本地端到端（模拟模式）试过：health 回 `mock:true`；同一 IP 第 6 个任务回 429 `rate_limited`；每日上限到 30 个回 `daily_cap`；重启 `wrangler dev` 后计数还在；首页、模型、缩略图、JS 都能打开；模拟生成 9 秒左右走完，下载的模型和 `dist/models/tufted-armchair.glb` 一致、带 `Content-Length`；第二版（和第一版在同一个 `wrangler dev` 里）看到的是第一版的计数。

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
| `TRIPO_DEFAULT_MODEL_VERSION` | `v3.1-20260211` | 前端没指定时用的版本（也是选择器上标 Recommended 的那个） |
| `TRIPO_FACE_LIMIT` | `300000` | 发给 Tripo 的默认 `face_limit`（网页导入时反正简化到 30 万面）。`0` = 不发；只认 1000–500000 |
| `TRIPO_COMPRESS` | 空 | `geometry` = 默认带 `compress: 'geometry'`（meshopt）。真实测过一次、确认结果文件用的是 `EXT_meshopt_compression` 再打开（10.9） |
| `TRIPO_API_BASE` | `https://openapi.tripo3d.ai/v3` | 中国区账号用 `https://openapi.tripo3d.com/v3` |
| `TRIPO_DOWNLOAD_HOSTS` | 空 | 结果文件额外允许的主机。内置 `tripo3d.ai`、`tripo3d.com` 及其子域名 |
| `TRIPO_MAX_DOWNLOAD_MB` | 200 | 结果文件上限 |
| `TRIPO_MOCK` | 空 | `1` = 强制模拟模式 |
| `TRIPO_MOCK_MODEL_FILE` | `models/tufted-armchair.glb` | 模拟模式的模型（Node / Vite，相对 `public/` 或 `dist/`） |
| `MOCK_MODEL_URL` / `MOCK_PREVIEW_URL` | 空 | 模拟模式的模型 / 预览图地址（Worker） |
| `PORT` / `HOST` / `STATIC_DIR` / `TRUST_PROXY` | 8787 / 0.0.0.0 / dist / 0 | 独立 Node 服务 |

固定的限制：JSON 请求体 ≤ 16 KB；`prompt` ≤ 1024 字；一次上传一张图、只认 PNG / JPEG（按文件头判断）；多视图正好 4 个位置、正面必填、至少 2 张；下载只按任务 id，不接受任何 URL。

**算一下最多花多少**：本中转只开放了不加钱的参数（快速贴图、`face_limit`、`compress` 都不加钱），单个任务最多 30 积分（图片 / 多视图带贴图；文字带贴图 20、不带 10；1 积分 = 0.01 美元）；把 P1 加进 `TRIPO_MODEL_VERSIONS` 的话最多 50。默认每日上限 50 个，即滚动 24 小时内最多约 1500 积分（约 15 美元）。

**会场共用 Wi-Fi**：所有人可能共用一个出口 IP，会一起被「每 IP」限额卡住。现场演示时调大 `TRIPO_MAX_TASKS_PER_IP_PER_HOUR` 和 `TRIPO_MAX_REQUESTS_PER_IP_PER_MINUTE`，靠 `TRIPO_MAX_TASKS_PER_DAY` 兜底。

---

## 9. 安全设计

- **密钥**：只从环境变量读；中转发出的所有文字（错误信息、日志）都会把密钥本身和长得像密钥的串（`tsk_…`）抹掉；单元测试检查所有响应和日志里都没有密钥；启动提示只说「有没有密钥」。
- **防盗刷**：每 IP 限流、全站每日上限、上传限流、总请求限流（Cloudflare 上计数在 Durable Objects，全局一致）；先占名额再调 Tripo，Tripo 明确拒绝时退回名额，结果不明（超时、5xx）时不退（请求可能已经扣费）。
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

### 10.9 速度：模型、选项、耗时、价格（2026-10-30 调研 + 实测）

模型页大多是前端渲染的，数字是从站点的 JS 包里读出来的；同一页上有两个数时两个都写。

**生成要多久**（官方都是「约」，不分文字 / 单图 / 多视图）：

| | 不带贴图 | 带贴图 | 来源 |
| --- | --- | --- | --- |
| v3.1 | 约 40 秒 | 约 120 秒（带 PBR） | [v3.1 模型页](https://developers.tripo3d.ai/en/models/v3-1) |
| P1 | 约 10 秒（「base mesh generation in approximately 10 seconds」） | 约 60 秒 | [P1 模型页（存档，2026-08-20）](http://web.archive.org/web/20260820050958/https://developers.tripo3d.ai/en/models/p1)（现在 /models/p1 跳到 P2）；同一个包里还有旧数字 2 秒 / 15 秒 |
| v3.0、v2.5、P2 | 没写 | 没写 | Tripo CLI 只说 v3.0「Good quality, faster」 |

- [Quick Start](https://developers.tripo3d.ai/en/docs/quick-start)：「Typical generation takes 10–120 seconds」；只要几何约 40 秒、标准贴图约 80 秒、v3.1 + PBR + 高清贴图 + 高清几何约 120 秒；单图 + 转换约 125 秒、单图转多视图再生成约 120 秒（单图、多视图和文字差不多）。
- **PBR 是最慢的一段**：「PBR generation is significantly slower (~120s vs ~20s)」（同页另一处写 ~40s）。`pbr: true` 会强制带贴图。
- 第三方实测（含排队）：WaveSpeed 上 H3.1 单图约 197 秒、H2.5 约 159 秒（[链接](https://wavespeed.ai/models/tripo3d/h3.1/image-to-3d)）。H2.5 并不明显快。
- **我们的实测**：v3.1 文字、不带贴图约 90 秒（比官方的 40 秒多：文字要先出图，再加排队）。
- v3 里**没有 Turbo**：`Turbo-v1.0-20250506` 列为已退役、映射到 v2.5（[官方迁移说明](https://developers.tripo3d.ai/assets/developer/tripo-v2-to-v3-migration/SKILL.md)）。文档里能快的只有 P1、`texture: false`、`texture_quality: fast`。

**选项对时间、价格的影响**：

| 选项 | 时间 | 价格 | 来源 |
| --- | --- | --- | --- |
| `texture: false` | v3.1 约 40 秒对 120 秒；P1 约 10 秒对 60 秒 | 文字 10、单图 / 多视图 20（带贴图 20 / 30） | 模型页、[Pricing](https://developers.tripo3d.ai/en/pricing) |
| `pbr: false`（带贴图） | 标准贴图约 80 秒对 PBR 约 120 秒 | 不另收钱（按带贴图算） | Quick Start、Pricing |
| `texture_quality: fast`（要配 `texture_version: v3.5-20260815`） | 「the fastest generation, trading texture detail for speed」，没给数字 | **和 standard 一样**：「Output texture size and credit cost are both identical to `standard`」；价目表 Fast 10 / Standard 10 | [Text to Model](https://developers.tripo3d.ai/en/docs/generation-text-to-model/standard.md)、[Changelog](https://developers.tripo3d.ai/en/docs/changelog.md) |
| `texture_quality: detailed` | 多约 90 秒（另一处写 80 秒），4K | +10 | Quick Start、Pricing |
| `face_limit` | 没写 | 生成不加钱（只有 `/v3/models/convert` 用它时按高级转换收 10） | Pricing |
| `compress: 'geometry'` | 没写 | 不加钱 | Pricing |
| `export_uv: false` | 「faster generation and smaller file size」 | — | Text to Model |
| 加钱的（都不放行） | — | 高清贴图 +10、8K +20、高清几何 +20、四边面 +5、智能低模 +10、拆件 +20 | Pricing |

- `texture_version: v3.5-20260815` 是 2026-09 加的新贴图模型，要显式写；默认还是 `v3.0-20250812`；`fast` 和 `delight` 都要它（Changelog）。
- P 系列价格：P1 文字 30（不带贴图）/ 40（标准贴图），单图、多视图 40 / 50（Pricing 的 P Series 页；存档页还有 Detailed 50 / 60 / 60）；P2 每种方式 100 / 110 / 120 / 130（[P2 模型页](https://developers.tripo3d.ai/en/models/p2)）。实际扣费以任务的 `credits_consumed` 为准（[Task Query](https://developers.tripo3d.ai/en/docs/task-query.md)）。

**`compress: 'geometry'` 是 meshopt**：文档「meshopt compression for reduced file size」，只支持 `model ≥ v3.0-20250812`，P 系列页上没有；JS SDK 的类型写「`'geometry'` applies meshopt compression」（[tripo-js-sdk](https://github.com/Tripo-Developer/tripo-js-sdk)），Python SDK 收布尔值、发 `"geometry"`（[tripo-python-sdk](https://github.com/Tripo-Developer/tripo-python-sdk)）。文档里没有 Draco、KTX2、WebP（0 处）。贴图格式只能通过转换接口改（`texture_format` 有 WEBP，默认 JPEG、4096；非默认值收 10 积分，[Convert](https://developers.tripo3d.ai/en/docs/models-convert.md)）。
- 我们的导入管线认 `EXT_meshopt_compression`（gltf-transform 4.5.1 只认这个名字，不认新的 `KHR_meshopt_compression`）。文档没写扩展名，所以 **`TRIPO_COMPRESS` 默认关**：等测速脚本第 7 行看到真实结果的 `extensionsUsed` 是 `EXT_meshopt_compression`，再设 `TRIPO_COMPRESS=geometry`。

**面数**：不传 `face_limit` 是「adaptive topology」，没给数字；上限 v3.1 150 万（`geometry_quality: detailed` 200 万）、v3.0 100 万、v2.5 50 万，四边面 15 万，智能低模 500–2 万；网页 / 手机建议 1–5 万面（Text to Model）。P1 50–2 万面，P2 48–5 万三角面（[P 系列](https://developers.tripo3d.ai/en/docs/generation-text-to-model/p.md)）。

**结果文件，我们的实测**（`.tmp/real-test/` 里两个 v3.1 的真实结果）：

| | 大小 | 面数 | 贴图 | 扩展 |
| --- | --- | --- | --- | --- |
| 文字、不带贴图 | 38.75 MB | 1,425,240 | 无 | 无 |
| 单图、带贴图（PBR） | 42.33 MB | 1,410,071 | 3 张 2048（2 张 JPEG、1 张 PNG），共 3.3 MB | 无 |

**92% 是几何**（不压缩：uint32 索引 16 MB、位置 8.6 MB、法线 8.6 MB、UV 5.7 MB），贴图只占 3.3 MB。v3.1 不限面数时给到 141 万面，接近它的上限；网页导入时又会简化到 30 万面。所以 **`face_limit = 300000`** 不会比现在难看（用户看到的本来就是 30 万面），文件小到约 12 MB（把同一个模型简化到 29 万面实测 12.1 MB），导入也不用再简化。

**预览图**：`rendered_image_url` 只在 success 时有（「Only populated when `status=success`」）；官方样例是 `.png` 占位，阿里云的接入样例是 `openapi.cdn.tripo3d.com` 上的 `.webp`。

**进度和轮询**：v3 没有预计时间、排队位置（`queue_position`、`estimated_running_time`、`running_left_time`、`queuing_num` 都去掉了，「derive UX from `progress`」）；两个 SDK 还声明着 `running_left_time` / `queuing_num`，别指望。`queued` 是 0、`running` 0–100、`success` 100。轮询：「Query once every 1-2 seconds」（[Task Lifecycle](https://developers.tripo3d.ai/en/docs/task-lifecycle.md)、[Rate Limits](https://developers.tripo3d.ai/en/docs/rate-limits.md)），迁移说明写 2–5 秒，JS SDK 默认 2 秒；**轮询的 GET 不占建任务的频率额度**。并发：H 系列 10 个、P 系列 5 个。

**这次怎么用上**（代码见 `server/tripo/handler.mjs` 的 `MODEL_CATALOG`、`ETA_SEC`，`src/ui/genaiDialog.ts` 的选择器，`src/genai/eta.ts`、`jobs.ts`）：

- **模型选择器**：文字、单图、多视图三页都有，每个版本一行：名字、一句长处、大概多久、多少积分。数据都从中转的 `GET /models` 来（中转是唯一来源，只列 `TRIPO_MODEL_VERSIONS` 放行的；P2 照旧不放行）。预计耗时在 **`ETA_SEC` 一张表**里，按「模型 × 生成方式 × 贴图档」写秒数，现在是估的（`measured: false`）：
  - v3.1 文字：不带贴图 90（实测）、快速贴图 120、标准贴图 170；单图、多视图比文字少 10–15 秒（官方 40 / 120 秒是单图的量级）。
  - v3.0 比 v3.1 少约 15%；v2.5 和 v3.0 差不多（第三方的数）；P1 文字 30 / 80。
  - 测完把实测的中位数填进去、`measured` 改成 `true`（界面上的「≈」悬停提示会写 Measured）。
- **默认 H3.1 + 快速贴图**：模型之间差得不多（P1 快但贵一倍、是低模的样子），差得多的是贴图——带 PBR 的标准贴图最慢。快速贴图 = 不要 PBR + v3.0 以上用 Tripo 的快速贴图模型，同价，估计比标准贴图快三成左右（约 120 秒对 170 秒），还保住 v3.1 的形状。要完整的 PBR 材质就选 Standard；改默认：`handler.mjs` 的 `DEFAULT_TEXTURE`。
- **默认 `face_limit = 300000`**：下载从约 42 MB 降到约 12 MB。模拟模式实测（`scripts/perf-genai-import.mjs`，真实结果当样本）：success 以后本机下载 0.13 → 0.05 秒、导入 + 缩略图 + 存进本地 2.04 → 0.54 秒、窗口里画出来 0.12 秒；真实网络上下载才是大头：42.3 MB 在 20 / 50 / 100 Mbps 上约 17.8 / 7.1 / 3.6 秒，12.1 MB 约 5.1 / 2.0 / 1.0 秒。Node 里按阶段量导入管线：141 万面要 1.64 秒（清理 0.62、简化 0.82、压缩 0.20），30 万面 0.29 秒。
- **成功马上给预览图**：任务一 success，窗口舞台上先放 Tripo 渲染的预览图（白底用 multiply 融进舞台），下面是下载进度（「Downloading… 4.2 MB of 12.1 MB」），模型导入好再换成能转的 3D。
- **倒计时**：按选的模型的预计耗时 + Tripo 的进度推（进度越往后越信进度，最多八成五；往上涨不到 15 秒不改口），「About 40 s left」「Almost done…」「Taking a little longer than usual…」。
- **轮询收尾**：进度到 90%、或者过了预计耗时的 85%（到 150% 为止），每秒问一次；平时照旧 2 秒起、没变化 ×1.25、最多 5 秒。成功以后平均早 1–2 秒开始下载。
- **加速参数的退路**：快速贴图、`face_limit`、`compress` 被 Tripo 当成无效参数（1003 / 1004）时，中转去掉它们再建一次。

### 10.10 实测：scripts/bench-tripo.mjs

用户同意过：最多 8 个任务、最多 200 积分。脚本自己没有密钥，只和**本地中转**说话；一个一个建文字任务（同一句提示词「a small wooden treasure chest with brass corners」），记提交到 success 的时间、Tripo 的进度时间线、结果大小 / 面数 / glTF 扩展、下载耗时、预览图、每个任务前后的余额差（和 Tripo 报的 `credits`）。计划超过 `--max-credits`（默认、上限 200）不开始；每个任务开始前再算一次；余额比开始时少了超过上限就停。中转是真实模式时必须 `REAL=1` 加 `--yes`；默认只连本机。结果写 `.tmp/bench/bench-<时间>.json` 和 `.md`。

在主目录跑（Git Bash）：

```sh
cd ~/Desktop/gbn
# 1. 一个终端：起真实模式的本地中转（读 .env.local 的密钥），每 IP 上限调大，放行 P1；只要接口，不用先 build
TRIPO_MOCK=0 TRIPO_MAX_TASKS_PER_IP_PER_HOUR=20 \
TRIPO_MODEL_VERSIONS=v3.1-20260211,v3.0-20250812,v2.5-20250123,P1-20260311 \
HOST=127.0.0.1 PORT=8790 node server/tripo/node-server.mjs
# 2. 另一个终端：先看计划和预计积分（不建任务）
node scripts/bench-tripo.mjs --base http://127.0.0.1:8790/api/tripo --dry-run
# 3. 真的跑（约 15–25 分钟）
REAL=1 node scripts/bench-tripo.mjs --base http://127.0.0.1:8790/api/tripo --yes --max-tasks 8 --max-credits 200
```

默认矩阵（按重要性排，中途停了也先拿到要紧的；共 170 积分）：

| # | 模型 | 贴图 | 其他 | 积分 | 回答什么 |
| --- | --- | --- | --- | --- | --- |
| 1 | v3.1 | 快速 | 默认 face_limit 30 万 | 20 | 默认路子要多久 |
| 2 | v3.1 | 标准（PBR） | 同上 | 20 | 快速贴图省多少 |
| 3 | v3.1 | 标准（PBR） | 不限面数（`faceLimit: 0`） | 20 | 以前的做法：face_limit 对时间、大小的影响 |
| 4 | v3.1 | 不带 | 默认 | 10 | 不带贴图 |
| 5 | v3.0 | 快速 | 默认 | 20 | H3.0 |
| 6 | v2.5 | 快速（只关 PBR） | 默认 | 20 | H2.5 |
| 7 | v3.1 | 快速 | `compress: true` | 20 | meshopt 的扩展名、大小（决定要不要开 `TRIPO_COMPRESS`） |
| 8 | P1 | 标准 | 版本自己的面数 | 40 | P1（中转没放行 P1 时自动跳过） |

只跑几行：`--only 1,2,7`。测完把每行「到 success」的秒数填进 `ETA_SEC`（文字那一列；单图、多视图照比例估），`measured` 改成 `true`；第 7 行的扩展是 `EXT_meshopt_compression` 就设 `TRIPO_COMPRESS=geometry`（`wrangler.toml` 的 `[vars]` 两处）。

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
7. 各版本、各贴图档的真实耗时（`ETA_SEC` 现在是估的）、`face_limit` 和快速贴图对耗时的影响、`compress: 'geometry'` 结果用的扩展名：跑 `scripts/bench-tripo.mjs`（10.10）。
8. `texture_quality: fast` 在 v3.0 上是否可用（文档只说要配 `texture_version`）；被拒时中转会去掉它重试，不会挡住生成。

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
- **开放更多参数**（比如 `negative_prompt`；`face_limit`、快速贴图、`compress` 已经开了，见 10.9）：在 `TASK_FIELDS` 加字段，在 `buildTask()` 里校验并写进 `payload`。注意有些参数会多扣积分（见 10.7）。
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
- 模型列表（`GET /models`：放行的版本、说明、贴图档、预计耗时、积分，跟着 `TRIPO_MODEL_VERSIONS` 走）、快速贴图 / `face_limit` / `compress` 的白名单和映射、加速参数被拒时去掉重试一次、查任务带 `credits`；
- 最后检查所有用例的响应和日志里都没有出现密钥。

`tests/rateLimiter.test.ts`（假的 Durable Objects 绑定）覆盖 Cloudflare 上的限流：滑动窗口和内存版逐步一致、重启后计数还在、清理闹钟、一次检查一次往返、退名额走 `waitUntil`、可重试的错误只重试一次、两版共用每日上限、静态资源不碰 Durable Objects、真实模式缺绑定时拒绝、模拟模式的模型不套限大小的流。
