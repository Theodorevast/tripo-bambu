# 部署 / Deploy

## 中文

1. 构建（Node 24）：

   ```sh
   npm ci
   npm run build
   ```

2. 把整个 `dist/` 上传到任意静态托管（Nginx、对象存储 + CDN、GitHub Pages、Netlify 等）即可。没有服务器端代码；页面用 `#/` 路由，不用配改写规则。`dist/` 约 77 MB，大部分是作品模型，单个文件最大约 6.2 MB。
3. 必须用 HTTPS 访问：WebGPU 只在安全上下文里可用（本机 `localhost` 除外）。用 HTTP 打开会退到 WebGL 2。
4. 部署到子路径（例如 `https://example.com/gbn/`）：
   - 默认构建用相对路径（`vite.config.ts` 里 `base: './'`），放在哪个目录下都能打开，但地址必须以 `/` 结尾（`/gbn/`，不能是 `/gbn`）。
   - 更稳妥：构建时设好 Vite 的 `base`，所有资源都用绝对路径：

     ```sh
     npm run build -- --base=/gbn/
     ```

     在 Windows 的 Git Bash 里要写成 `MSYS_NO_PATHCONV=1 npm run build -- --base=/gbn/`，否则 `/gbn/` 会被改写成 `C:/Program Files/Git/gbn/`。PowerShell、cmd 不受影响。
5. 素材版权：`brand/` 下的翠宝模型、tripo 和 MakerWorld 标志、像素翠宝动图是品牌方的素材；`models/`、`thumbs/` 是社区作者的作品。版权归各自所有者，只用于本站，不要转用或公开分发，仓库保持私有。

## English

1. Build (Node 24):

   ```sh
   npm ci
   npm run build
   ```

2. Upload the whole `dist/` folder to any static host (Nginx, object storage + CDN, GitHub Pages, Netlify, ...). There is no server-side code, and routing uses `#/` URLs, so no rewrite rules are needed. `dist/` is about 77 MB, mostly the community models; the largest single file is about 6.2 MB.
3. The site must be served over HTTPS: WebGPU only works in a secure context (`localhost` is the exception). Over plain HTTP the app falls back to WebGL 2.
4. Deploying under a sub-path (for example `https://example.com/gbn/`):
   - The default build uses relative paths (`base: './'` in `vite.config.ts`), so it works from any folder, as long as the URL ends with `/` (`/gbn/`, not `/gbn`).
   - The safer option is to set Vite's `base` at build time, so every asset URL is absolute:

     ```sh
     npm run build -- --base=/gbn/
     ```

     In Git Bash on Windows, run `MSYS_NO_PATHCONV=1 npm run build -- --base=/gbn/` instead; otherwise Git Bash rewrites `/gbn/` to `C:/Program Files/Git/gbn/`. PowerShell and cmd are not affected.
5. Asset ownership: everything in `brand/` (the Triboo model, the tripo and MakerWorld logos, the pixel Triboo GIFs) belongs to the brands, and `models/` and `thumbs/` are works by community creators. They remain the property of their owners and are for use on this site only. Do not reuse or redistribute them, and keep this repository private.
