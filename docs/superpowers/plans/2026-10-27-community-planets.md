# Community Planets Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个可以发链接的网页 demo：海外 3D 建模社区的团队各建一颗星球、摆上成员的作品，所有团队的星球组成一片星系；每颗星球有 Members 页和 Museum 页，「你」所在团队的星球可以编辑。

**Architecture:** Vite + 原生 TypeScript + three.js r186（`three/webgpu`，不支持 WebGPU 时自动退回 WebGL2），界面是盖在 canvas 上的原生 HTML/CSS。星球完全由「配方」（种子 + 预设 + 摆放列表）生成；数据经 `PlanetStore` 接口读写，这次的实现是 `seed.json` + 浏览器本地存储。星系和星球共用一个渲染器；Museum 的卡片预览共用一个 canvas 分区渲染，大图查看器另用一个 canvas。

**Tech Stack:** three 0.186.1 + TSL、Vite 8.3.5、TypeScript 7.0.2、vitest 5.0.5、playwright-core 1.64.1（驱动本机 Chrome）、@gltf-transform 4.5.1 + meshoptimizer 1.3.0 + sharp 0.35.5（模型处理）、Fontsource 5.3.0（Cormorant Garamond、IBM Plex Sans、IBM Plex Mono）。

**Spec:** `docs/superpowers/specs/2026-10-27-community-planets-design.md`

## Global Constraints

- 截止：2026年10月29日（周四）中午交可访问的链接；P1（新建团队流程、音效）不在本计划里
- 界面文字全部英文；代码注释用中文
- 桌面浏览器优先（最新版 Chrome、Edge、Safari、Firefox）；手机能打开、不出错即可，不做手机专属操作
- 许可：不用 AGPL、GPL、专有许可的库（以 `工具/13-网页交互.md` 的许可红灯清单为准）；Git City 是 AGPL，只能参考
- `WebGPURenderer` 不支持 `ShaderMaterial`、`RawShaderMaterial`、`onBeforeCompile`、`EffectComposer`：自定义材质一律用 TSL（`three/tsl`）+ `*NodeMaterial`
- WebGPU 的 `Points` 只能画 1 像素：星星用 `InstancedMesh`
- `renderer.setScissor` / `setViewport` 用左上角原点、CSS 像素；`render()` 在 `autoClear` 打开或 `scene.background` 是颜色时会清空整张画布
- 只做本地提交，不推送远程；部署要用户明确同意
- 提交时只 `git add` 自己改的文件，不用 `git add -A`
- 公开内容里不写本机路径和用户名
- 星数、版本、日期一律实测，不凭记忆
- 审美类 skill 只用 frontend-design-2
- 每个提交的最后一段是 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（用第二个 `-m` 传入）
- Node 24（本机 v24.22.0）能直接 import `.ts`：`.mjs` 脚本引用的 `src/**/*.ts`，以及这些文件再引用的文件，相对 import 一律写 `.ts` 扩展名（tsconfig 已开 `allowImportingTsExtensions`）；`import type` 不受限制
- Chrome 路径 `C:/Program Files/Google/Chrome/Application/chrome.exe`，可用环境变量 `CHROME_PATH` 覆盖
- 在 Git Bash 里调用脚本时，路径参数不要以 `/` 开头（会被改写成 Windows 路径），写成 `dev/planet.html`、`index.html#/t/lumen-guild`
- 常量（全部来自 spec）：基础半径 10；作品最长边 2.0；缩放 0.5–2；旋转步长 15°；星球高细分约 2 万面；镜头飞行 1.2 秒；拖入文件上限 100 MB；贴图最长边 2048；面数超过 50 万或处理后超过 15 MB 要标记；缩略图 512×512 WebP；本地存储键 `gbn:v1:planets`；under construction 团队 10 个；有作品的团队最多 6 个

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `index.html`、`public/favicon.svg` | 页面入口：`canvas#stage` + `div#app`（界面都挂在这里） |
| `src/main.ts` | 启动：读数据 → 建 3D 世界 → 组装各个页面 → 按地址显示 |
| `src/app.ts` | 路由和页面切换：星系 ↔ 星球 ↔ Members / Museum；保存后同步团队数据 |
| `src/router.ts` | hash 地址 ↔ `Route`（纯函数） |
| `src/debug.ts` | `window.__app`：给 Playwright 脚本的屏幕坐标换算 |
| `src/env.d.ts` | `window.__ready` 等全局标记的类型 |
| `src/data/types.ts` | 全部数据类型 |
| `src/data/store.ts` | `PlanetStore` 接口 + `LocalStore`（seed + 本地存储，坏数据和存储报错都能扛） |
| `src/data/teams.template.json` | 16 个虚构团队：名字、口号、颜色、星球参数、虚构成员 |
| `src/data/works.json` | 作品清单（占位作品；模型处理脚本会重写它） |
| `src/data/seed.json` | 生成的初始数据（`npm run seed`） |
| `src/lib/csv.ts` | 极简 CSV 解析、文件名转 id |
| `src/lib/assemble.ts` | 团队模板 + 作品 → seed（分队、成员、展示位摆放） |
| `src/planet/rng.ts` | 可复现随机数、字符串哈希 |
| `src/planet/presets.ts` | 5 套星球预设、基础半径 |
| `src/planet/noise.ts` | `heightAt`（fBm 噪声）、海平面、归一化高度 |
| `src/planet/generate.ts` | 配方 → 地表网格（纯函数，低多边形、每面一色） |
| `src/planet/placement.ts` | 摆放的数学：贴地、对准法线、朝向、尺寸归一化 |
| `src/planet/materials.ts` | TSL 材质：地表、海洋、大气、光环 |
| `src/planet/planetObject.ts` | 一颗星球的 3D 对象（两档细分、按需重建） |
| `src/scenes/lights.ts` | 摄影棚式布光 |
| `src/scenes/sky.ts` | 星云穹顶 + 实例化星星 |
| `src/scenes/layout.ts` | 星系螺旋布局（纯函数） |
| `src/scenes/camera.ts` | 镜头：OrbitControls + 1.2 秒飞行 |
| `src/scenes/world.ts` | 渲染器、场景、所有星球、拾取、聚焦 / 取消聚焦 |
| `src/scenes/planetView.ts` | 聚焦星球上的作品：展台、拾取盒、加载、贴地 |
| `src/assets/models.ts` | GLB 加载、缓存、尺寸归一化；模型和缩略图地址 |
| `src/assets/placeholder.ts` | 占位作品（按 id 确定性生成） |
| `src/museum/multiview.ts` | 一个 canvas 分区画多个视口 |
| `src/museum/framing.ts` | 预览镜头取景 |
| `src/museum/viewer.ts` | 大图查看器（独立 canvas） |
| `src/editor/editor.ts` | 编辑模式：摆放、拖动、旋转、缩放、删除、外观、保存、Reset |
| `src/editor/dropGlb.ts` | 拖入 GLB 的检查和监听 |
| `src/ui/dom.ts` | `el()`、`initials()`、`formatTris()` |
| `src/ui/toast.ts`、`topbar.ts`、`galaxyUi.ts`、`planetScreen.ts`、`workCard.ts`、`membersPage.ts`、`museumPage.ts`、`editPanel.ts`、`styles.css` | 各块界面 |
| `dev/multiview.*`、`dev/planet.*`、`dev/thumb.*` | 单独验证用的开发页面 |
| `scripts/lib/browser.mjs`、`scripts/lib/fixture.mjs` | 脚本共用：开发服务器 + Chrome；测试用 GLB |
| `scripts/build-seed.mjs`、`prep-models.mjs`、`make-fixture.mjs`、`inspect-glb.mjs` | 数据和模型处理 |
| `scripts/shot.mjs`、`check-multiview.mjs`、`check-editor.mjs`、`check-drop.mjs`、`smoke.mjs` | 截图和自查 |
| `tests/*.test.ts` | vitest 单元测试 |

时间安排：Task 1–9 在 10月27日（周二），晚上发截图给用户；Task 10–14 在 10月28日（周三）；Task 15–16 在 10月29日（周四）上午。

---

### Task 1: 工程骨架 + 可复现随机数

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `public/favicon.svg`, `.gitignore`, `.gitattributes`, `src/main.ts`, `src/env.d.ts`, `src/ui/styles.css`, `src/planet/rng.ts`
- Test: `tests/rng.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `type Rng = () => number`；`mulberry32(seed: number): Rng`；`hashString(s: string): number`；`Window.__ready / __mv / __thumbReady` 的类型；CSS 变量 `--ink --ink-dim --ink-faint --void --panel --panel-solid --line --accent --danger --font-display --font-ui --font-mono --radius`

- [ ] **Step 1: 写工程配置**

`package.json`：

```json
{
  "name": "gbn",
  "private": true,
  "type": "module",
  "engines": { "node": "24.x" },
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview --port 4173 --host 127.0.0.1",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p .",
    "seed": "node scripts/build-seed.mjs",
    "prep": "node scripts/prep-models.mjs",
    "shot": "node scripts/shot.mjs",
    "smoke": "node scripts/smoke.mjs"
  },
  "dependencies": {
    "@fontsource/cormorant-garamond": "5.3.0",
    "@fontsource/ibm-plex-mono": "5.3.0",
    "@fontsource/ibm-plex-sans": "5.3.0",
    "three": "0.186.1"
  },
  "devDependencies": {
    "@gltf-transform/core": "4.5.1",
    "@gltf-transform/extensions": "4.5.1",
    "@gltf-transform/functions": "4.5.1",
    "@types/node": "^26.6.5",
    "@types/three": "0.186.0",
    "meshoptimizer": "1.3.0",
    "playwright-core": "1.64.1",
    "sharp": "0.35.5",
    "typescript": "7.0.2",
    "vite": "8.3.5",
    "vitest": "5.0.5"
  }
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests", "dev"]
}
```

`vite.config.ts`：

```ts
import { defineConfig } from 'vite';

// base 用相对路径：构建结果放到任何子路径下都能直接打开
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: '127.0.0.1' },
});
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
```

`index.html`：

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="Community Planets: teams of 3D artists build a planet together and show their work." />
    <link rel="icon" href="./favicon.svg" type="image/svg+xml" />
    <title>Community Planets</title>
  </head>
  <body>
    <canvas id="stage"></canvas>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`public/favicon.svg`：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="9" fill="#d9b77e"/><ellipse cx="16" cy="16" rx="15" ry="5" fill="none" stroke="#ece6da" stroke-width="1.6" transform="rotate(-20 16 16)"/></svg>
```

`.gitignore`：

```
node_modules/
dist/
.vite/
*.log
shots/
models-in/
.tmp/
```

`.gitattributes`：

```
* text=auto eol=lf
*.glb binary
*.webp binary
*.png binary
```

- [ ] **Step 2: 安装依赖**

Run: `npm install`
Expected: 没有 `ERR!`；`node -e "console.log(require('./node_modules/three/package.json').version)"` 输出 `0.186.1`

- [ ] **Step 3: 写失败的测试**

`tests/rng.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { hashString, mulberry32 } from '../src/planet/rng';

describe('mulberry32', () => {
  it('同一个种子产生同一串数', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it('不同种子产生不同的数', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
  it('结果落在 [0, 1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('hashString', () => {
  it('稳定，且能区分不同字符串', () => {
    expect(hashString('nebula')).toBe(hashString('nebula'));
    expect(hashString('nebula')).not.toBe(hashString('nebulb'));
  });
});
```

- [ ] **Step 4: 运行测试，确认失败**

Run: `npx vitest run tests/rng.test.ts`
Expected: FAIL，报错找不到 `../src/planet/rng`

- [ ] **Step 5: 实现**

`src/planet/rng.ts`：

```ts
// mulberry32：给定种子，产生可复现的 [0, 1) 随机数序列
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a：把字符串（如作品 id）变成 32 位种子
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `npx vitest run tests/rng.test.ts`
Expected: PASS（4 个测试）

- [ ] **Step 7: 写全局类型、基础样式和临时入口**

`src/env.d.ts`：

```ts
// 页面上给自查脚本用的全局标记
interface Window {
  __ready?: boolean; // 应用启动完、首屏内容加载完
  __mv?: { backend: string }; // dev/multiview 页面实际用的渲染后端
  __thumbReady?: boolean; // dev/thumb 页面渲染完
}
```

`src/ui/styles.css`：

```css
/* 设计变量：暖白文字像展签纸，黄铜色做强调，背景是深空 */
:root {
  --ink: #ece6da;
  --ink-dim: #a8a194;
  --ink-faint: #6f6a61;
  --void: #07080d;
  --panel: rgba(13, 14, 20, 0.88);
  --panel-solid: #0d0e14;
  --line: rgba(236, 230, 218, 0.14);
  --accent: #d9b77e;
  --danger: #e07a5f;
  --font-display: 'Cormorant Garamond', Georgia, serif;
  --font-ui: 'IBM Plex Sans', system-ui, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, monospace;
  --radius: 3px;
  color-scheme: dark;
}

* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--void); color: var(--ink); font: 400 14px/1.5 var(--font-ui); -webkit-font-smoothing: antialiased; }
#stage { position: fixed; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
#app { position: fixed; inset: 0; pointer-events: none; }
#app > * { pointer-events: auto; }
[hidden] { display: none !important; }

button { font: 500 13px/1 var(--font-ui); letter-spacing: 0.02em; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: var(--radius); padding: 8px 14px; cursor: pointer; transition: border-color 0.15s, color 0.15s, background 0.15s; }
button:hover { border-color: var(--accent); color: var(--accent); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button.primary { background: var(--accent); border-color: var(--accent); color: #17130c; }
button.primary:hover { background: #e6c793; color: #17130c; }
button[aria-pressed='true'] { border-color: var(--accent); color: var(--accent); }
button.danger { color: var(--danger); border-color: rgba(224, 122, 95, 0.4); }
button.danger:hover { border-color: var(--danger); color: var(--danger); }

.mono { font-family: var(--font-mono); font-size: 11.5px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-dim); }
.display { font-family: var(--font-display); font-weight: 500; letter-spacing: 0.01em; }
```

`src/main.ts`（临时，Task 8 整个替换）：

```ts
import './ui/styles.css';

// 临时入口：Task 8 换成真正的启动流程
document.querySelector<HTMLDivElement>('#app')!.textContent = 'Community Planets';
window.__ready = true;
```

- [ ] **Step 8: 类型检查和构建**

Run: `npm run typecheck`，然后 `npm run build`
Expected: 两个命令都以 0 退出；生成 `dist/index.html`

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts vitest.config.ts index.html public/favicon.svg .gitignore .gitattributes src/main.ts src/env.d.ts src/ui/styles.css src/planet/rng.ts tests/rng.test.ts
git commit -m "chore: 工程骨架与可复现随机数" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 验证「一个 canvas 分区画多个视口」

spec 第 12 节的第一个风险：Museum 的卡片预览依赖它。这一步做出可复用的 `MultiView`，并用像素检查证明它在 WebGPU 和 WebGL2 后备下都能用。

**Files:**
- Create: `src/museum/multiview.ts`, `dev/multiview.html`, `dev/multiview.ts`, `scripts/lib/browser.mjs`, `scripts/check-multiview.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface View { element: HTMLElement; scene: THREE.Scene; camera: THREE.PerspectiveCamera; tick?: (dt: number) => void }`
  - `class MultiView { static create(canvas: HTMLCanvasElement): Promise<MultiView>; readonly renderer: THREE.WebGPURenderer; readonly backendName: 'webgpu' | 'webgl2'; add(view: View): () => void; clearViews(): void; render(dt: number): void }`
  - `scripts/lib/browser.mjs`：`CHROME`、`startServer(overrides?) → Promise<{ server, base }>`（`base` 不带结尾斜杠）、`launch() → Promise<Browser>`、`watchErrors(page) → string[]`

- [ ] **Step 1: 写脚本共用模块**

`scripts/lib/browser.mjs`：

```js
// 自查脚本共用：启动 Vite 开发服务器、用本机 Chrome 打开页面、收集页面错误
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

export const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// overrides 合并进 Vite 配置，例如 { publicDir: '.tmp/out' }
export async function startServer(overrides = {}) {
  const server = await createServer({ ...overrides, logLevel: 'warn', server: { host: '127.0.0.1', port: 5199, strictPort: false } });
  await server.listen();
  const base = (server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5199/').replace(/\/$/, '');
  return { server, base };
}

// HEADED=1 时开有界面的 Chrome：无头模式下可能拿不到 WebGPU，只会测到 WebGL2 后备
export function launch() {
  return chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
}

export function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`JS: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${r.status()} ${r.url()}`); });
  return errors;
}
```

- [ ] **Step 2: 实现 MultiView**

`src/museum/multiview.ts`：

```ts
import * as THREE from 'three/webgpu';

// 一个 canvas 画多个小视口，每个视口跟着页面上一个元素走（scissor）
// WebGPU 的 render() 在 autoClear 打开时会清空整张画布（scissor 管不住 loadOp clear），
// 所以这里关掉 autoClear，每帧开头手动清一次；setScissor / setViewport 用左上角原点、CSS 像素
export interface View {
  element: HTMLElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  tick?: (dt: number) => void;
}

const size = new THREE.Vector2();

export class MultiView {
  readonly renderer: THREE.WebGPURenderer;
  private readonly views = new Set<View>();

  private constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
  }

  static async create(canvas: HTMLCanvasElement): Promise<MultiView> {
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
    await renderer.init();
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    return new MultiView(renderer);
  }

  get backendName(): 'webgpu' | 'webgl2' {
    return (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  }

  add(view: View): () => void {
    this.views.add(view);
    return () => this.views.delete(view);
  }

  clearViews(): void {
    this.views.clear();
  }

  // 每帧调用一次：同步画布尺寸 → 整张清空 → 逐个视口渲染（不在屏幕里的跳过）
  render(dt: number): void {
    const r = this.renderer;
    const w = r.domElement.clientWidth;
    const h = r.domElement.clientHeight;
    if (w === 0 || h === 0) return; // canvas 被隐藏时尺寸是 0，不能 setSize(0, 0)
    r.getSize(size);
    if (size.x !== w || size.y !== h) r.setSize(w, h, false);
    r.setScissorTest(false);
    r.clear();
    r.setScissorTest(true);
    for (const v of this.views) {
      const rect = v.element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= h || rect.left >= w) continue;
      v.tick?.(dt);
      v.camera.aspect = rect.width / rect.height;
      v.camera.updateProjectionMatrix();
      // 视口可以伸出画布（投影不变形），scissor 必须夹在画布里
      const x0 = Math.max(0, rect.left);
      const y0 = Math.max(0, rect.top);
      const x1 = Math.min(w, rect.right);
      const y1 = Math.min(h, rect.bottom);
      r.setViewport(rect.left, rect.top, rect.width, rect.height);
      r.setScissor(x0, y0, x1 - x0, y1 - y0);
      r.render(v.scene, v.camera);
    }
  }
}
```

- [ ] **Step 3: 写验证页面**

`dev/multiview.html`：

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>multiview check</title>
    <style>
      body { margin: 0; background: #111; }
      .row { display: flex; gap: 40px; padding: 60px; }
      .cell { width: 240px; height: 240px; border: 1px solid #444; }
      #mv { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    </style>
  </head>
  <body>
    <div class="row"><div class="cell" id="a"></div><div class="cell" id="b"></div><div class="cell" id="c"></div></div>
    <canvas id="mv"></canvas>
    <script type="module" src="./multiview.ts"></script>
  </body>
</html>
```

`dev/multiview.ts`：

```ts
import * as THREE from 'three/webgpu';
import { MultiView } from '../src/museum/multiview';

// 三个格子各画一个纯色方块：红、绿、蓝。检查脚本按格子中心取色
const colors: Record<string, number> = { a: 0xff0000, b: 0x00ff00, c: 0x0000ff };
const mv = await MultiView.create(document.querySelector<HTMLCanvasElement>('#mv')!);
for (const [id, hex] of Object.entries(colors)) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), new THREE.MeshBasicNodeMaterial({ color: hex })));
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
  camera.position.set(0, 0, 4);
  mv.add({ element: document.getElementById(id)!, scene, camera });
}
mv.renderer.setAnimationLoop(() => mv.render(1 / 60));
window.__mv = { backend: mv.backendName };
```

- [ ] **Step 4: 写检查脚本**

`scripts/check-multiview.mjs`：

```js
// 验证「一个 canvas 分区画多个视口」：三个格子中心应分别是红、绿、蓝
import sharp from 'sharp';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const { server, base } = await startServer();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 500 } });
const errors = watchErrors(page);
await page.goto(`${base}/dev/multiview.html`);
await page.waitForFunction(() => window.__mv !== undefined, null, { timeout: 15000 });
await page.waitForTimeout(500);
const backend = await page.evaluate(() => window.__mv.backend);
const { data, info } = await sharp(await page.screenshot()).raw().toBuffer({ resolveWithObject: true });
let ok = true;
for (const [id, channel] of Object.entries({ a: 0, b: 1, c: 2 })) {
  const box = await page.locator(`#${id}`).boundingBox();
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  const i = (y * info.width + x) * info.channels;
  const rgb = [data[i], data[i + 1], data[i + 2]];
  const pass = rgb[channel] > 120 && rgb.every((v, k) => k === channel || v < 80);
  ok &&= pass;
  console.log(`${id}: rgb(${rgb.join(',')}) ${pass ? 'OK' : 'FAIL'}`);
}
console.log(`backend: ${backend}`);
if (errors.length) { ok = false; console.log(errors.join('\n')); }
console.log(ok ? 'MULTIVIEW OK' : 'MULTIVIEW FAIL');
await browser.close();
await server.close();
process.exitCode = ok ? 0 : 1;
```

- [ ] **Step 5: 无头模式运行**

Run: `node scripts/check-multiview.mjs`
Expected: 三行 `OK`、一行 `backend: webgl2` 或 `backend: webgpu`、最后 `MULTIVIEW OK`

- [ ] **Step 6: 有界面模式运行（测真正的 WebGPU 路径）**

Run（PowerShell）：`$env:HEADED='1'; node scripts/check-multiview.mjs; Remove-Item Env:HEADED`
Run（Git Bash）：`HEADED=1 node scripts/check-multiview.mjs`
Expected: `backend: webgpu` 且 `MULTIVIEW OK`。如果这台机器的 Chrome 拿不到 WebGPU，会显示 `webgl2`，记下来告诉用户即可

排错：如果三个格子位置上下颠倒，说明某个后端的 y 方向不同，先在 `render()` 里打印 `rect` 和 `r.getDrawingBufferSize()` 对比；如果只看到最后一个格子，说明有地方还在清屏（检查 `autoClear` 和 `scene.background`）。排查 30 分钟仍不行，就把 Task 11 的 `LIVE_CARD_PREVIEWS` 设为 `false`（卡片改用静态缩略图），并告诉用户。

- [ ] **Step 7: 类型检查**

Run: `npm run typecheck`
Expected: 0 退出

- [ ] **Step 8: Commit**

```bash
git add src/museum/multiview.ts dev/multiview.html dev/multiview.ts scripts/lib/browser.mjs scripts/check-multiview.mjs
git commit -m "feat: 一个 canvas 分区渲染多个视口，并加像素检查脚本" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 数据类型 + 星球生成（纯函数）

**Files:**
- Create: `src/data/types.ts`, `src/planet/presets.ts`, `src/planet/noise.ts`, `src/planet/generate.ts`
- Test: `tests/planet.test.ts`

**Interfaces:**
- Consumes: `mulberry32`（Task 1）
- Produces:
  - `src/data/types.ts`：`PresetId`、`Placement`、`PlanetRecipe`、`Member`、`Work`、`Team`、`Seed`（字段见下方代码）
  - `BASE_RADIUS = 10`；`interface Preset { id; label; amp; freq; sea: number | null; bands: Array<[number, string]>; water; atmosphere; ring }`；`PRESETS: Record<PresetId, Preset>`；`PRESET_IDS: PresetId[]`
  - `type HeightFn = (x: number, y: number, z: number) => number`；`makeHeightFn(seed: number, preset: PresetId): HeightFn`；`seaRadius(preset: PresetId): number`（无海返回 0）；`normalizedHeight(r: number, preset: PresetId): number`
  - `LOD_LOW = 10`、`LOD_HIGH = 31`；`buildTerrainGeometry(recipe: PlanetRecipe, detail: number): THREE.BufferGeometry`（非索引，带 `color` 属性和面法线）

- [ ] **Step 1: 写数据类型**

`src/data/types.ts`：

```ts
// 全部数据类型（对应 spec 第 4.1、5 节）
export type PresetId = 'verdant' | 'desert' | 'glacier' | 'volcanic' | 'coral';

export interface Placement {
  workId: string;
  dir: [number, number, number]; // 单位向量：作品在球面上的方向（星球本地坐标）
  yaw: number; // 绕法线的旋转，弧度
  scale: number; // 0.5–2
}

export interface PlanetRecipe {
  seed: number;
  preset: PresetId;
  ring: boolean;
  atmosphere: boolean;
  placements: Placement[];
}

export interface Member {
  id: string;
  handle: string; // 不带 @
  displayName: string;
  role: 'captain' | 'builder';
}

export interface Work {
  id: string;
  title: string;
  authorId: string; // 指向 Member.id
  file: string; // public/models/ 下的文件名；空字符串 = 占位模型；blob: 开头 = 拖进来的临时作品
  thumb: string; // public/thumbs/ 下的文件名；空字符串 = 纯色块
  tris: number;
  description?: string;
}

export interface Team {
  id: string;
  name: string;
  motto: string;
  color: string; // 团队主色，十六进制
  status: 'active' | 'under-construction';
  foundedDaysAgo: number;
  members: Member[];
  works: Work[];
  planet: PlanetRecipe;
}

export interface Seed {
  teams: Team[];
  you: { teamId: string; memberId: string }; // 演示身份
}
```

- [ ] **Step 2: 写失败的测试**

`tests/planet.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { PlanetRecipe, PresetId } from '../src/data/types';
import { buildTerrainGeometry, LOD_HIGH, LOD_LOW } from '../src/planet/generate';
import { makeHeightFn, normalizedHeight, seaRadius } from '../src/planet/noise';
import { BASE_RADIUS, PRESET_IDS, PRESETS } from '../src/planet/presets';

const recipe = (seed: number, preset: PresetId = 'verdant'): PlanetRecipe => ({ seed, preset, ring: false, atmosphere: true, placements: [] });

// 斐波那契球面点：确定性地铺满球面
function sphere(i: number, n: number): [number, number, number] {
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(1 - y * y);
  const phi = i * Math.PI * (3 - Math.sqrt(5));
  return [Math.cos(phi) * r, y, Math.sin(phi) * r];
}

describe('makeHeightFn', () => {
  it('高度落在预设给定的范围内', () => {
    for (const id of PRESET_IDS) {
      const h = makeHeightFn(123, id);
      const amp = PRESETS[id].amp;
      for (let i = 0; i < 500; i++) {
        const [x, y, z] = sphere(i, 500);
        const r = h(x, y, z);
        expect(r).toBeGreaterThanOrEqual(BASE_RADIUS * (1 - amp) - 1e-9);
        expect(r).toBeLessThanOrEqual(BASE_RADIUS * (1 + amp) + 1e-9);
      }
    }
  });
  it('同一个种子、同一个方向，高度一样', () => {
    expect(makeHeightFn(5, 'desert')(0.6, 0.8, 0)).toBe(makeHeightFn(5, 'desert')(0.6, 0.8, 0));
  });
});

describe('buildTerrainGeometry', () => {
  it('同一份配方生成完全一样的顶点，换种子就不一样', () => {
    const a = Array.from(buildTerrainGeometry(recipe(1), LOD_LOW).getAttribute('position').array);
    const b = Array.from(buildTerrainGeometry(recipe(1), LOD_LOW).getAttribute('position').array);
    const c = Array.from(buildTerrainGeometry(recipe(2), LOD_LOW).getAttribute('position').array);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
  it('三角面数量：低细分 2420，高细分 20480', () => {
    expect(buildTerrainGeometry(recipe(1), LOD_LOW).getAttribute('position').count / 3).toBe(2420);
    expect(buildTerrainGeometry(recipe(1), LOD_HIGH).getAttribute('position').count / 3).toBe(20480);
  });
  it('每个三角面的三个顶点颜色相同（低多边形）', () => {
    const col = buildTerrainGeometry(recipe(3, 'coral'), LOD_LOW).getAttribute('color');
    for (let f = 0; f < col.count; f += 3) {
      expect(col.getX(f + 1)).toBe(col.getX(f));
      expect(col.getX(f + 2)).toBe(col.getX(f));
    }
  });
});

describe('seaRadius / normalizedHeight', () => {
  it('没有海的预设返回 0；有海的落在起伏范围内', () => {
    expect(seaRadius('desert')).toBe(0);
    const s = seaRadius('verdant');
    expect(s).toBeGreaterThan(BASE_RADIUS * (1 - PRESETS.verdant.amp));
    expect(s).toBeLessThan(BASE_RADIUS * (1 + PRESETS.verdant.amp));
  });
  it('normalizedHeight 把半径换算回 [-1, 1]', () => {
    expect(normalizedHeight(BASE_RADIUS, 'verdant')).toBeCloseTo(0);
    expect(normalizedHeight(BASE_RADIUS * (1 + PRESETS.verdant.amp), 'verdant')).toBeCloseTo(1);
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `npx vitest run tests/planet.test.ts`
Expected: FAIL，找不到 `../src/planet/generate`

- [ ] **Step 4: 实现预设**

`src/planet/presets.ts`：

```ts
import type { PresetId } from '../data/types';

export const BASE_RADIUS = 10;

export interface Preset {
  id: PresetId;
  label: string;
  amp: number; // 地形起伏幅度（相对基础半径）
  freq: number; // 噪声基础频率
  sea: number | null; // 海平面在起伏范围里的位置（-1..1）；null = 没有海
  bands: Array<[number, string]>; // [归一化高度上限, 颜色]，从低到高；最后一档上限 > 1
  water: string;
  atmosphere: string;
  ring: string;
}

// 配色整体压低饱和度：星球是展台，作品才是主角
export const PRESETS: Record<PresetId, Preset> = {
  verdant: {
    id: 'verdant', label: 'Verdant', amp: 0.09, freq: 1.4, sea: -0.05,
    bands: [[-0.15, '#8a7d5c'], [0.25, '#5f7a4e'], [0.55, '#4e6340'], [0.8, '#7a6a55'], [1.01, '#e8e4dc']],
    water: '#2f5d7c', atmosphere: '#9cc7e8', ring: '#c9bfa8',
  },
  desert: {
    id: 'desert', label: 'Desert', amp: 0.08, freq: 1.8, sea: null,
    bands: [[-0.4, '#a0603f'], [0.1, '#c08a5a'], [0.5, '#d4a974'], [1.01, '#e3c69a']],
    water: '#000000', atmosphere: '#f0b27a', ring: '#d9b28a',
  },
  glacier: {
    id: 'glacier', label: 'Glacier', amp: 0.07, freq: 1.2, sea: 0,
    bands: [[0.1, '#9fb7c4'], [0.45, '#c9dbe3'], [1.01, '#f2f5f6']],
    water: '#1f3f5a', atmosphere: '#d8f0f5', ring: '#b8c8d0',
  },
  volcanic: {
    id: 'volcanic', label: 'Volcanic', amp: 0.11, freq: 1.6, sea: null,
    bands: [[-0.55, '#c4552b'], [-0.2, '#3a3433'], [0.4, '#2b2727'], [1.01, '#4a4241']],
    water: '#000000', atmosphere: '#b0533c', ring: '#7d6a62',
  },
  coral: {
    id: 'coral', label: 'Coral', amp: 0.08, freq: 1.5, sea: 0.1,
    bands: [[0.2, '#e8b4a0'], [0.5, '#f0c9a8'], [0.75, '#a8d5ba'], [1.01, '#f4e1d2']],
    water: '#3f8f8a', atmosphere: '#f3c4cf', ring: '#e9cfc4',
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
```

- [ ] **Step 5: 实现高度函数**

`src/planet/noise.ts`：

```ts
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import type { PresetId } from '../data/types';
import { BASE_RADIUS, PRESETS } from './presets';
import { mulberry32 } from './rng';

// 输入单位向量，返回该方向上地面到球心的距离
export type HeightFn = (x: number, y: number, z: number) => number;

// fBm：4 层 simplex 噪声叠加，归一化后夹到 [-1, 1]
export function makeHeightFn(seed: number, preset: PresetId): HeightFn {
  const p = PRESETS[preset];
  const noise = new SimplexNoise({ random: mulberry32(seed) });
  return (x, y, z) => {
    let sum = 0;
    let amp = 1;
    let freq = p.freq;
    let norm = 0;
    for (let o = 0; o < 4; o++) {
      sum += amp * noise.noise3d(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    const n = Math.max(-1, Math.min(1, sum / norm));
    return BASE_RADIUS * (1 + p.amp * n);
  };
}

// 海平面半径；没有海时返回 0
export function seaRadius(preset: PresetId): number {
  const p = PRESETS[preset];
  return p.sea === null ? 0 : BASE_RADIUS * (1 + p.amp * p.sea);
}

// 半径换算回 [-1, 1]，给配色分段用
export function normalizedHeight(r: number, preset: PresetId): number {
  return (r / BASE_RADIUS - 1) / PRESETS[preset].amp;
}
```

- [ ] **Step 6: 实现地表网格**

`src/planet/generate.ts`：

```ts
import * as THREE from 'three/webgpu';
import type { PlanetRecipe } from '../data/types';
import { makeHeightFn, normalizedHeight } from './noise';
import { BASE_RADIUS, PRESETS } from './presets';

export const LOD_LOW = 10; // 星系里：20 × 11² = 2420 个三角面
export const LOD_HIGH = 31; // 聚焦时：20 × 32² = 20480 个三角面

// 配方 → 地表网格（纯函数，不碰 GPU）。IcosahedronGeometry 是非索引几何：
// 每个三角面有自己的 3 个顶点，所以可以每面一种颜色，computeVertexNormals 得到的也是面法线
export function buildTerrainGeometry(recipe: PlanetRecipe, detail: number): THREE.BufferGeometry {
  const height = makeHeightFn(recipe.seed, recipe.preset);
  const bands = PRESETS[recipe.preset].bands.map(([limit, hex]) => ({ limit, color: new THREE.Color(hex) }));
  const geo = new THREE.IcosahedronGeometry(BASE_RADIUS, detail);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    v.multiplyScalar(height(v.x, v.y, v.z));
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  const colors = new Float32Array(pos.count * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let f = 0; f < pos.count; f += 3) {
    a.fromBufferAttribute(pos, f);
    b.fromBufferAttribute(pos, f + 1);
    c.fromBufferAttribute(pos, f + 2);
    const t = normalizedHeight((a.length() + b.length() + c.length()) / 3, recipe.preset);
    const { color } = bands.find((band) => t <= band.limit) ?? bands[bands.length - 1];
    for (let k = 0; k < 3; k++) colors.set([color.r, color.g, color.b], (f + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `npx vitest run tests/planet.test.ts`
Expected: PASS（7 个测试）。如果三角面数量不对，说明 `IcosahedronGeometry` 的细分规则和 r125 之后的「每条边分成 detail+1 段」不一致，先打印实际数量再调 `LOD_LOW` / `LOD_HIGH`，并同步改测试和注释

- [ ] **Step 8: 类型检查并提交**

Run: `npm run typecheck`
Expected: 0 退出

```bash
git add src/data/types.ts src/planet/presets.ts src/planet/noise.ts src/planet/generate.ts tests/planet.test.ts
git commit -m "feat: 数据类型、星球预设与配方生成地表网格" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 摆放的数学

**Files:**
- Create: `src/planet/placement.ts`
- Test: `tests/placement.test.ts`

**Interfaces:**
- Consumes: `Placement`（Task 3）、`HeightFn`（Task 3）
- Produces:
  - 常量 `WORK_SIZE = 2.0`、`PLINTH_HEIGHT = 0.18`、`SCALE_MIN = 0.5`、`SCALE_MAX = 2`、`YAW_STEP = Math.PI / 12`、`SHOWCASE_POLE: [number, number, number]`（展示方向，单位向量）
  - `groundRadius(dir: THREE.Vector3, height: HeightFn, sea: number): number`
  - `placementTransform(p: Placement, height: HeightFn, sea: number): { position: THREE.Vector3; quaternion: THREE.Quaternion }`
  - `faceYaw(dir: [number, number, number], toward: [number, number, number]): number`
  - `fitToSize(box: THREE.Box3, size?: number): { scale: number; offset: THREE.Vector3 }`
  - `clampScale(s: number): number`

- [ ] **Step 1: 写失败的测试**

`tests/placement.test.ts`：

```ts
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { clampScale, faceYaw, fitToSize, groundRadius, placementTransform, SHOWCASE_POLE, WORK_SIZE } from '../src/planet/placement';

const flat = () => 10; // 平地：处处半径 10
const dirs: Array<[number, number, number]> = [[0, 1, 0], [1, 0, 0], [0, -1, 0], [0.3, -0.5, 0.81]];

describe('placementTransform', () => {
  it('位置在地表上，模型的「上」对准法线', () => {
    for (const dir of dirs) {
      const { position, quaternion } = placementTransform({ workId: 'w', dir, yaw: 0.7, scale: 1 }, flat, 0);
      const n = new THREE.Vector3(...dir).normalize();
      expect(position.length()).toBeCloseTo(10, 6);
      expect(new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).distanceTo(n)).toBeLessThan(1e-6);
    }
  });
  it('yaw 只绕法线转，不改变「上」', () => {
    const a = placementTransform({ workId: 'w', dir: [0, 0, 1], yaw: 0, scale: 1 }, flat, 0).quaternion;
    const b = placementTransform({ workId: 'w', dir: [0, 0, 1], yaw: Math.PI / 2, scale: 1 }, flat, 0).quaternion;
    const fa = new THREE.Vector3(1, 0, 0).applyQuaternion(a);
    const fb = new THREE.Vector3(1, 0, 0).applyQuaternion(b);
    expect(Math.abs(fa.dot(fb))).toBeLessThan(1e-6);
  });
  it('有海时落点不低于海平面', () => {
    expect(groundRadius(new THREE.Vector3(0, 1, 0), () => 9.5, 9.8)).toBe(9.8);
    expect(groundRadius(new THREE.Vector3(0, 1, 0), () => 10.2, 9.8)).toBe(10.2);
  });
});

describe('faceYaw', () => {
  it('转完以后模型正面（+Z）朝向目标方向在切平面上的投影', () => {
    for (const dir of dirs) {
      const toward: [number, number, number] = [0.2, 0.9, 0.4];
      const { quaternion } = placementTransform({ workId: 'w', dir, yaw: faceYaw(dir, toward), scale: 1 }, flat, 0);
      const n = new THREE.Vector3(...dir).normalize();
      const t = new THREE.Vector3(...toward);
      const want = t.addScaledVector(n, -t.dot(n)).normalize();
      expect(new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).distanceTo(want)).toBeLessThan(1e-6);
    }
  });
  it('目标和法线平行时返回 0', () => {
    expect(faceYaw([0, 1, 0], [0, 3, 0])).toBe(0);
  });
  it('SHOWCASE_POLE 是单位向量', () => {
    expect(Math.hypot(...SHOWCASE_POLE)).toBeCloseTo(1, 9);
  });
});

describe('fitToSize', () => {
  it('最长边缩放到 WORK_SIZE，水平居中，底部贴 y=0', () => {
    const box = new THREE.Box3(new THREE.Vector3(2, -1, 4), new THREE.Vector3(6, 1, 5)); // 4 × 2 × 1
    const { scale, offset } = fitToSize(box);
    expect(scale).toBeCloseTo(WORK_SIZE / 4);
    const min = box.min.clone().multiplyScalar(scale).add(offset);
    const max = box.max.clone().multiplyScalar(scale).add(offset);
    expect(min.y).toBeCloseTo(0);
    expect((min.x + max.x) / 2).toBeCloseTo(0);
    expect((min.z + max.z) / 2).toBeCloseTo(0);
    expect(max.x - min.x).toBeCloseTo(WORK_SIZE);
  });
  it('clampScale 限制在 0.5–2', () => {
    expect(clampScale(0.1)).toBe(0.5);
    expect(clampScale(3)).toBe(2);
    expect(clampScale(1.2)).toBe(1.2);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/placement.test.ts`
Expected: FAIL，找不到 `../src/planet/placement`

- [ ] **Step 3: 实现**

`src/planet/placement.ts`：

```ts
import * as THREE from 'three/webgpu';
import type { Placement } from '../data/types';
import type { HeightFn } from './noise';

export const WORK_SIZE = 2.0; // 所有作品统一的最长边
export const PLINTH_HEIGHT = 0.18; // 展台露出地面的高度
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 2;
export const YAW_STEP = Math.PI / 12; // 15°

// 展示方向：镜头飞到星球时从这个方向看过去，初始作品也围着它摆
export const SHOWCASE_POLE: [number, number, number] = (() => {
  const v = new THREE.Vector3(0, 0.45, 1).normalize();
  return [v.x, v.y, v.z];
})();

const UP = new THREE.Vector3(0, 1, 0);

// 作品落点的地面半径：有海时不低于海平面（作品立在漂浮的展台上）
export function groundRadius(dir: THREE.Vector3, height: HeightFn, sea: number): number {
  return Math.max(height(dir.x, dir.y, dir.z), sea);
}

// 作品根节点的位置和朝向：先把模型的「上」对准球面法线，再绕法线转 yaw
export function placementTransform(p: Placement, height: HeightFn, sea: number): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const dir = new THREE.Vector3(...p.dir).normalize();
  const position = dir.clone().multiplyScalar(groundRadius(dir, height, sea));
  const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, dir);
  quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, p.yaw));
  return { position, quaternion };
}

// 求 yaw，让模型正面（局部 +Z）朝向 toward 在切平面上的投影
export function faceYaw(dir: [number, number, number], toward: [number, number, number]): number {
  const n = new THREE.Vector3(...dir).normalize();
  const t = new THREE.Vector3(...toward);
  const want = t.addScaledVector(n, -t.dot(n));
  if (want.lengthSq() < 1e-10) return 0;
  want.normalize();
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, n));
  return Math.atan2(new THREE.Vector3().crossVectors(forward, want).dot(n), forward.dot(want));
}

// 最长边缩放到 size；offset 让模型水平居中、底部落在 y=0（先缩放再平移）
export function fitToSize(box: THREE.Box3, size = WORK_SIZE): { scale: number; offset: THREE.Vector3 } {
  const dim = box.getSize(new THREE.Vector3());
  const scale = size / (Math.max(dim.x, dim.y, dim.z) || 1);
  const center = box.getCenter(new THREE.Vector3());
  return { scale, offset: new THREE.Vector3(-center.x * scale, -box.min.y * scale, -center.z * scale) };
}

export function clampScale(s: number): number {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, s));
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/placement.test.ts`
Expected: PASS（8 个测试）

- [ ] **Step 5: 类型检查并提交**

Run: `npm run typecheck`
Expected: 0 退出

```bash
git add src/planet/placement.ts tests/placement.test.ts
git commit -m "feat: 作品贴地、对准法线、朝向与尺寸归一化" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 路由 + 本地数据层

**Files:**
- Create: `src/router.ts`, `src/data/store.ts`
- Test: `tests/router.test.ts`, `tests/store.test.ts`

**Interfaces:**
- Consumes: `Seed`、`Team`、`PlanetRecipe`（Task 3）
- Produces:
  - `type Route = { view: 'galaxy' } | { view: 'planet'; teamId: string } | { view: 'members'; teamId: string } | { view: 'museum'; teamId: string; workId?: string }`
  - `parseRoute(hash: string): Route`；`toHash(route: Route): string`
  - `interface PlanetStore { listTeams(): Promise<Team[]>; getTeam(id: string): Promise<Team | undefined>; savePlanet(teamId: string, planet: PlanetRecipe): Promise<void>; reset(): Promise<void> }`
  - `interface StorageLike { getItem; setItem; removeItem }`；`STORAGE_KEY = 'gbn:v1:planets'`；`class LocalStore implements PlanetStore`（`new LocalStore(seed: Seed, storage: StorageLike | null)`，返回的都是副本）；`browserStorage(): StorageLike | null`

- [ ] **Step 1: 写失败的测试**

`tests/router.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseRoute, toHash, type Route } from '../src/router';

describe('parseRoute', () => {
  it.each<[string, Route]>([
    ['', { view: 'galaxy' }],
    ['#/', { view: 'galaxy' }],
    ['#/t/nebula', { view: 'planet', teamId: 'nebula' }],
    ['#/t/nebula/members', { view: 'members', teamId: 'nebula' }],
    ['#/t/nebula/museum', { view: 'museum', teamId: 'nebula' }],
    ['#/t/nebula/museum/w-3', { view: 'museum', teamId: 'nebula', workId: 'w-3' }],
    ['#/nope', { view: 'galaxy' }],
    ['#/t/x/what', { view: 'galaxy' }],
  ])('%s', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });
});

describe('toHash', () => {
  it('和 parseRoute 互逆', () => {
    const routes: Route[] = [
      { view: 'galaxy' },
      { view: 'planet', teamId: 'a b' },
      { view: 'members', teamId: 'x' },
      { view: 'museum', teamId: 'x' },
      { view: 'museum', teamId: 'x', workId: 'w/1' },
    ];
    for (const r of routes) expect(parseRoute(toHash(r))).toEqual(r);
  });
});
```

`tests/store.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { LocalStore, STORAGE_KEY, type StorageLike } from '../src/data/store';
import type { PlanetRecipe, Seed } from '../src/data/types';

function memStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

const planetA: PlanetRecipe = { seed: 1, preset: 'verdant', ring: false, atmosphere: true, placements: [] };
const seed: Seed = {
  you: { teamId: 'a', memberId: 'you' },
  teams: [
    { id: 'a', name: 'A', motto: '', color: '#ffffff', status: 'active', foundedDaysAgo: 3, members: [], works: [], planet: planetA },
    { id: 'b', name: 'B', motto: '', color: '#000000', status: 'under-construction', foundedDaysAgo: 1, members: [], works: [], planet: { seed: 2, preset: 'desert', ring: true, atmosphere: false, placements: [] } },
  ],
};

describe('LocalStore', () => {
  it('没有修改时返回 seed 里的数据', async () => {
    const s = new LocalStore(seed, memStorage());
    expect((await s.listTeams()).map((t) => t.id)).toEqual(['a', 'b']);
    expect((await s.getTeam('b'))?.planet.preset).toBe('desert');
    expect(await s.getTeam('zzz')).toBeUndefined();
  });
  it('保存的星球配方写进存储，新实例也读得到', async () => {
    const storage = memStorage();
    await new LocalStore(seed, storage).savePlanet('a', { ...planetA, preset: 'coral' });
    expect(storage.data.has(STORAGE_KEY)).toBe(true);
    expect((await new LocalStore(seed, storage).getTeam('a'))?.planet.preset).toBe('coral');
  });
  it('返回的是副本，改它不影响存储', async () => {
    const s = new LocalStore(seed, memStorage());
    const t = await s.getTeam('a');
    t!.planet.preset = 'glacier';
    expect((await s.getTeam('a'))?.planet.preset).toBe('verdant');
  });
  it('reset 清掉所有修改', async () => {
    const storage = memStorage();
    const s = new LocalStore(seed, storage);
    await s.savePlanet('a', { ...planetA, ring: true });
    await s.reset();
    expect((await s.getTeam('a'))?.planet.ring).toBe(false);
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
  });
  it('存储里是坏数据时忽略它', async () => {
    const storage = memStorage();
    storage.data.set(STORAGE_KEY, '{not json');
    expect((await new LocalStore(seed, storage).getTeam('a'))?.planet.preset).toBe('verdant');
  });
  it('存储抛错时退回内存，照常工作', async () => {
    const fail = () => { throw new Error('denied'); };
    const s = new LocalStore(seed, { getItem: fail, setItem: fail, removeItem: fail });
    await s.savePlanet('a', { ...planetA, preset: 'volcanic' });
    expect((await s.getTeam('a'))?.planet.preset).toBe('volcanic');
    await s.reset();
    expect((await s.getTeam('a'))?.planet.preset).toBe('verdant');
  });
  it('没有存储（null）时只存在内存里', async () => {
    const s = new LocalStore(seed, null);
    await s.savePlanet('b', { ...seed.teams[1].planet, ring: false });
    expect((await s.getTeam('b'))?.planet.ring).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/router.test.ts tests/store.test.ts`
Expected: FAIL，找不到 `../src/router` 和 `../src/data/store`

- [ ] **Step 3: 实现路由**

`src/router.ts`：

```ts
// hash 路由：#/、#/t/<teamId>、#/t/<teamId>/members、#/t/<teamId>/museum[/<workId>]
export type Route =
  | { view: 'galaxy' }
  | { view: 'planet'; teamId: string }
  | { view: 'members'; teamId: string }
  | { view: 'museum'; teamId: string; workId?: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 't' || !parts[1]) return { view: 'galaxy' };
  const teamId = parts[1];
  if (parts.length === 2) return { view: 'planet', teamId };
  if (parts[2] === 'members' && parts.length === 3) return { view: 'members', teamId };
  if (parts[2] === 'museum' && parts.length === 3) return { view: 'museum', teamId };
  if (parts[2] === 'museum' && parts.length === 4) return { view: 'museum', teamId, workId: parts[3] };
  return { view: 'galaxy' };
}

export function toHash(route: Route): string {
  const team = (id: string) => `#/t/${encodeURIComponent(id)}`;
  switch (route.view) {
    case 'galaxy':
      return '#/';
    case 'planet':
      return team(route.teamId);
    case 'members':
      return `${team(route.teamId)}/members`;
    case 'museum':
      return `${team(route.teamId)}/museum${route.workId ? `/${encodeURIComponent(route.workId)}` : ''}`;
  }
}
```

- [ ] **Step 4: 实现数据层**

`src/data/store.ts`：

```ts
import type { PlanetRecipe, Seed, Team } from './types';

// 以后换真后端（Supabase、Cloudflare D1 等）只需另写一个实现
export interface PlanetStore {
  listTeams(): Promise<Team[]>;
  getTeam(id: string): Promise<Team | undefined>;
  savePlanet(teamId: string, planet: PlanetRecipe): Promise<void>;
  reset(): Promise<void>;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const STORAGE_KEY = 'gbn:v1:planets';

// seed.json + 本地修改（只存改过的星球配方）。存储报错（隐私模式、配额满）时退回内存
export class LocalStore implements PlanetStore {
  private readonly seed: Seed;
  private storage: StorageLike | null;
  private overrides: Record<string, PlanetRecipe>;

  constructor(seed: Seed, storage: StorageLike | null) {
    this.seed = seed;
    this.storage = storage;
    this.overrides = this.readOverrides();
  }

  async listTeams(): Promise<Team[]> {
    return this.seed.teams.map((t) => this.withOverride(t));
  }

  async getTeam(id: string): Promise<Team | undefined> {
    const t = this.seed.teams.find((x) => x.id === id);
    return t && this.withOverride(t);
  }

  async savePlanet(teamId: string, planet: PlanetRecipe): Promise<void> {
    this.overrides[teamId] = structuredClone(planet);
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.overrides));
    } catch {
      this.storage = null;
    }
  }

  async reset(): Promise<void> {
    this.overrides = {};
    try {
      this.storage?.removeItem(STORAGE_KEY);
    } catch {
      this.storage = null;
    }
  }

  private withOverride(t: Team): Team {
    const copy = structuredClone(t);
    const o = this.overrides[t.id];
    if (o) copy.planet = structuredClone(o);
    return copy;
  }

  private readOverrides(): Record<string, PlanetRecipe> {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, PlanetRecipe>) : {};
    } catch {
      return {};
    }
  }
}

// 浏览器里取 localStorage；某些隐私设置下访问它本身就会抛错
export function browserStorage(): StorageLike | null {
  try {
    const s = window.localStorage;
    s.getItem(STORAGE_KEY);
    return s;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npx vitest run tests/router.test.ts tests/store.test.ts`
Expected: PASS（router 9 个、store 7 个）

- [ ] **Step 6: 类型检查并提交**

Run: `npm run typecheck`
Expected: 0 退出

```bash
git add src/router.ts src/data/store.ts tests/router.test.ts tests/store.test.ts
git commit -m "feat: hash 路由与本地数据层（存储出错时退回内存）" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 生成 seed.json（团队模板 + 作品 → 初始数据）

**Files:**
- Create: `src/lib/csv.ts`, `src/lib/assemble.ts`, `src/data/teams.template.json`, `src/data/works.json`, `scripts/build-seed.mjs`
- Generate: `src/data/seed.json`
- Test: `tests/csv.test.ts`, `tests/assemble.test.ts`

**Interfaces:**
- Consumes: `faceYaw`、`SHOWCASE_POLE`（Task 4）；`Seed` 等类型（Task 3）
- Produces:
  - `parseCsv(text: string): Array<Record<string, string>>`；`slugify(name: string): string`
  - `interface WorkInput { id; title; author; file; thumb; tris; description? }`；`interface TemplateTeam { id; name; motto; color; preset; seed; ring; foundedDaysAgo; crew: Array<{ handle; displayName }> }`；`interface Template { you: { id; handle; displayName }; teams: TemplateTeam[] }`
  - `MAX_ACTIVE = 6`、`UNDER_CONSTRUCTION = 10`；`activeTeamCount(works: number): number`；`memberId(handle: string): string`；`showcaseDirs(n: number): Array<[number, number, number]>`；`assembleSeed(template: Template, works: WorkInput[]): Seed`
  - `src/data/seed.json`（`Seed` 结构）；演示身份是第一个团队里 id 为 `you` 的成员

- [ ] **Step 1: 写失败的测试**

`tests/csv.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseCsv, slugify } from '../src/lib/csv';

describe('parseCsv', () => {
  it('解析表头和普通行', () => {
    expect(parseCsv('file,title,author,description\nlighthouse.glb,Old Lighthouse,mia,\n')).toEqual([
      { file: 'lighthouse.glb', title: 'Old Lighthouse', author: 'mia', description: '' },
    ]);
  });
  it('支持引号里的逗号、转义引号、CRLF 和 BOM', () => {
    expect(parseCsv('\uFEFFfile,title\r\na.glb,"Hello, ""World"""\r\n')).toEqual([{ file: 'a.glb', title: 'Hello, "World"' }]);
  });
  it('跳过空行，缺的列补空字符串', () => {
    expect(parseCsv('file,title\n\na.glb\n\n')).toEqual([{ file: 'a.glb', title: '' }]);
  });
});

describe('slugify', () => {
  it('文件名转 id', () => {
    expect(slugify('My Robot (v2).GLB')).toBe('my-robot-v2');
    expect(slugify('???.glb')).toBe('work');
  });
});
```

`tests/assemble.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import templateJson from '../src/data/teams.template.json';
import { activeTeamCount, assembleSeed, memberId, showcaseDirs, UNDER_CONSTRUCTION, type Template, type WorkInput } from '../src/lib/assemble';

const template = templateJson as unknown as Template;
const works = (n: number, authors = n): WorkInput[] =>
  Array.from({ length: n }, (_, i) => ({ id: `w${i}`, title: `Work ${i}`, author: `artist${i % authors}`, file: '', thumb: '', tris: 1000 }));

describe('activeTeamCount', () => {
  it('10–24 件作品时每个团队平均 3–4 件，最多 6 个团队', () => {
    for (let n = 10; n <= 24; n++) {
      const t = activeTeamCount(n);
      expect(t).toBeLessThanOrEqual(6);
      expect(n / t).toBeGreaterThanOrEqual(3);
      expect(n / t).toBeLessThanOrEqual(4);
    }
  });
});

describe('assembleSeed', () => {
  it('每件作品恰好分到一个团队，同一作者的作品不拆开', () => {
    const input = works(14, 9);
    const seed = assembleSeed(template, input);
    expect(seed.teams.flatMap((t) => t.works.map((w) => w.id)).sort()).toEqual(input.map((w) => w.id).sort());
    for (const a of new Set(input.map((w) => w.author))) {
      expect(seed.teams.filter((t) => t.works.some((w) => w.authorId === memberId(a)))).toHaveLength(1);
    }
  });
  it('作者都不重复时，每个团队 3–4 件作品', () => {
    for (let n = 10; n <= 24; n++) {
      for (const t of assembleSeed(template, works(n)).teams.filter((x) => x.status === 'active')) {
        expect(t.works.length).toBeGreaterThanOrEqual(3);
        expect(t.works.length).toBeLessThanOrEqual(4);
      }
    }
  });
  it('有作品的团队之外，另有 10 个 under construction 团队，它们没有作品', () => {
    const seed = assembleSeed(template, works(14));
    expect(seed.teams.filter((t) => t.status === 'active')).toHaveLength(4);
    const uc = seed.teams.filter((t) => t.status === 'under-construction');
    expect(uc).toHaveLength(UNDER_CONSTRUCTION);
    expect(uc.every((t) => t.works.length === 0 && t.planet.placements.length === 0)).toBe(true);
  });
  it('演示身份在第一个团队里', () => {
    const seed = assembleSeed(template, works(10));
    expect(seed.you.teamId).toBe(seed.teams[0].id);
    expect(seed.teams[0].members.some((m) => m.id === seed.you.memberId)).toBe(true);
  });
  it('每件作品都有摆放，方向是单位向量；作者都在成员里；团队 id 不重复', () => {
    const seed = assembleSeed(template, works(12));
    expect(new Set(seed.teams.map((t) => t.id)).size).toBe(seed.teams.length);
    for (const t of seed.teams) {
      expect(t.planet.placements.map((p) => p.workId)).toEqual(t.works.map((w) => w.id));
      for (const p of t.planet.placements) expect(Math.hypot(...p.dir)).toBeCloseTo(1, 6);
      for (const w of t.works) expect(t.members.some((m) => m.id === w.authorId)).toBe(true);
      expect(t.members.filter((m) => m.role === 'captain')).toHaveLength(1);
    }
  });
});

describe('showcaseDirs', () => {
  it('n 个方向在半径 10 的星球上两两相距 3 以上', () => {
    for (let n = 1; n <= 7; n++) {
      const d = showcaseDirs(n);
      expect(d).toHaveLength(n);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          expect(10 * Math.hypot(d[i][0] - d[j][0], d[i][1] - d[j][1], d[i][2] - d[j][2])).toBeGreaterThan(3);
        }
      }
    }
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/csv.test.ts tests/assemble.test.ts`
Expected: FAIL，找不到 `../src/lib/csv`、`../src/lib/assemble` 和 `../src/data/teams.template.json`

- [ ] **Step 3: 实现 CSV**

`src/lib/csv.ts`：

```ts
// 极简 CSV：支持双引号包裹（内含逗号、换行、"" 转义），第一行是表头，空行跳过
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  const src = text.replace(/^\uFEFF/, '');
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = '';
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
    } else cell += ch;
  }
  endRow();
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, j) => [k, (r[j] ?? '').trim()])));
}

// 文件名 → 作品 id：去扩展名、小写、非字母数字换成 -
export function slugify(name: string): string {
  return name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'work';
}
```

- [ ] **Step 4: 实现组装**

`src/lib/assemble.ts`（会被 Node 脚本直接 import，所以相对 import 带 `.ts`）：

```ts
import * as THREE from 'three/webgpu';
import type { Member, PresetId, Seed, Team, Work } from '../data/types';
import { faceYaw, SHOWCASE_POLE } from '../planet/placement.ts';

export interface WorkInput {
  id: string;
  title: string;
  author: string; // 作者 handle
  file: string;
  thumb: string;
  tris: number;
  description?: string;
}

export interface TemplateTeam {
  id: string;
  name: string;
  motto: string;
  color: string;
  preset: PresetId;
  seed: number;
  ring: boolean;
  foundedDaysAgo: number;
  crew: Array<{ handle: string; displayName: string }>; // 虚构成员，第一位是队长
}

export interface Template {
  you: { id: string; handle: string; displayName: string };
  teams: TemplateTeam[]; // 前 6 个可以成为有作品的团队，第 7–16 个是 under construction
}

export const MAX_ACTIVE = 6;
export const UNDER_CONSTRUCTION = 10;
const CONE = THREE.MathUtils.degToRad(34); // 作品围着展示方向摆成一圈，和它的夹角

// 团队数 = 作品数 ÷ 3.5 四舍五入，1–6 个
export function activeTeamCount(works: number): number {
  return Math.min(MAX_ACTIVE, Math.max(1, Math.round(works / 3.5)));
}

export function memberId(handle: string): string {
  return `m-${handle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

// 展示位：1 件放在正中，多件均匀排在 34° 的圆锥上，镜头飞到星球时一眼能看全
export function showcaseDirs(n: number): Array<[number, number, number]> {
  const pole = new THREE.Vector3(...SHOWCASE_POLE);
  if (n === 1) return [[pole.x, pole.y, pole.z]];
  const t = new THREE.Vector3().crossVectors(pole, new THREE.Vector3(0, 1, 0)).normalize();
  const b = new THREE.Vector3().crossVectors(t, pole).normalize();
  return Array.from({ length: n }, (_, k) => {
    const phi = (2 * Math.PI * k) / n + Math.PI / 2;
    const d = pole.clone().multiplyScalar(Math.cos(CONE))
      .addScaledVector(t, Math.sin(CONE) * Math.cos(phi))
      .addScaledVector(b, Math.sin(CONE) * Math.sin(phi))
      .normalize();
    return [d.x, d.y, d.z];
  });
}

export function assembleSeed(template: Template, works: WorkInput[]): Seed {
  const active = works.length === 0 ? 0 : activeTeamCount(works.length);
  // 按作者分组，同一作者的作品进同一个团队；大组先放，每次放进当前作品最少的团队
  const groups = new Map<string, WorkInput[]>();
  for (const w of works) groups.set(w.author, [...(groups.get(w.author) ?? []), w]);
  const buckets: WorkInput[][] = Array.from({ length: active }, () => []);
  for (const g of [...groups.values()].sort((a, b) => b.length - a.length)) {
    const i = buckets.reduce((best, bucket, k) => (bucket.length < buckets[best].length ? k : best), 0);
    buckets[i].push(...g);
  }
  const crewOf = (tt: TemplateTeam): Member[] =>
    tt.crew.map((c, k) => ({ id: memberId(c.handle), handle: c.handle, displayName: c.displayName, role: k === 0 ? 'captain' : 'builder' }));

  const teams: Team[] = template.teams.slice(0, active).map((tt, i) => {
    const ws = buckets[i];
    const authors: Member[] = [...new Set(ws.map((w) => w.author))].map((a) => ({ id: memberId(a), handle: a, displayName: a, role: 'builder' }));
    const members = [...crewOf(tt), ...authors];
    if (i === 0) members.push({ id: template.you.id, handle: template.you.handle, displayName: template.you.displayName, role: 'builder' });
    const dirs = showcaseDirs(ws.length);
    return {
      id: tt.id, name: tt.name, motto: tt.motto, color: tt.color, status: 'active', foundedDaysAgo: tt.foundedDaysAgo, members,
      works: ws.map((w): Work => ({
        id: w.id, title: w.title, authorId: memberId(w.author), file: w.file, thumb: w.thumb, tris: w.tris,
        ...(w.description ? { description: w.description } : {}),
      })),
      planet: {
        seed: tt.seed, preset: tt.preset, ring: tt.ring, atmosphere: true,
        placements: ws.map((w, k) => ({ workId: w.id, dir: dirs[k], yaw: faceYaw(dirs[k], SHOWCASE_POLE), scale: 1 })),
      },
    };
  });
  for (const tt of template.teams.slice(MAX_ACTIVE, MAX_ACTIVE + UNDER_CONSTRUCTION)) {
    teams.push({
      id: tt.id, name: tt.name, motto: tt.motto, color: tt.color, status: 'under-construction', foundedDaysAgo: tt.foundedDaysAgo,
      members: crewOf(tt), works: [],
      planet: { seed: tt.seed, preset: tt.preset, ring: tt.ring, atmosphere: true, placements: [] },
    });
  }
  return { teams, you: { teamId: teams[0]?.id ?? '', memberId: template.you.id } };
}
```

- [ ] **Step 5: 写团队模板**

`src/data/teams.template.json`（16 个团队全部虚构；前 6 个可以有作品，后 10 个是 under construction）：

```json
{
  "you": { "id": "you", "handle": "orbit_ollie", "displayName": "Ollie Park" },
  "teams": [
    { "id": "lumen-guild", "name": "Lumen Guild", "motto": "We sculpt with light.", "color": "#d9b77e", "preset": "verdant", "seed": 1103, "ring": true, "foundedDaysAgo": 41,
      "crew": [{ "handle": "hexa_ines", "displayName": "Ines Duarte" }, { "handle": "polyfox", "displayName": "Kai Morrow" }] },
    { "id": "quiet-vertex", "name": "Quiet Vertex", "motto": "Fewer polygons, more feeling.", "color": "#8fb3c9", "preset": "glacier", "seed": 2207, "ring": false, "foundedDaysAgo": 33,
      "crew": [{ "handle": "lowpoly_lu", "displayName": "Lu Ming" }, { "handle": "rennie_uv", "displayName": "Rennie Okafor" }] },
    { "id": "kiln-collective", "name": "Kiln Collective", "motto": "Fired in Blender, glazed by hand.", "color": "#c97b5a", "preset": "desert", "seed": 3301, "ring": true, "foundedDaysAgo": 27,
      "crew": [{ "handle": "terra_tomas", "displayName": "Tomas Rios" }, { "handle": "glaze_june", "displayName": "June Park" }] },
    { "id": "moss-and-mesh", "name": "Moss & Mesh", "motto": "Small worlds, grown slowly.", "color": "#9bb57f", "preset": "coral", "seed": 4409, "ring": false, "foundedDaysAgo": 19,
      "crew": [{ "handle": "fern_ade", "displayName": "Adeola Ben" }, { "handle": "subdiv_sami", "displayName": "Sami Lind" }] },
    { "id": "ember-forge", "name": "Ember Forge", "motto": "Hard surfaces, warm hearts.", "color": "#d1694a", "preset": "volcanic", "seed": 5501, "ring": true, "foundedDaysAgo": 12,
      "crew": [{ "handle": "anvil_ash", "displayName": "Ash Calloway" }, { "handle": "bevel_bo", "displayName": "Bo Nakamura" }] },
    { "id": "tidepool-atelier", "name": "Tidepool Atelier", "motto": "Everything floats here.", "color": "#6fb7b0", "preset": "coral", "seed": 6607, "ring": true, "foundedDaysAgo": 8,
      "crew": [{ "handle": "kelp_kira", "displayName": "Kira Volk" }, { "handle": "retopo_rex", "displayName": "Rex Adler" }] },
    { "id": "paper-moon-co", "name": "Paper Moon Co.", "motto": "Folding our first planet.", "color": "#c8c0e0", "preset": "glacier", "seed": 7703, "ring": true, "foundedDaysAgo": 4,
      "crew": [{ "handle": "origami_oz", "displayName": "Oz Hart" }, { "handle": "fold_faye", "displayName": "Faye Lin" }] },
    { "id": "night-shift-nodes", "name": "Night Shift Nodes", "motto": "We render after midnight.", "color": "#7f8fd6", "preset": "volcanic", "seed": 8803, "ring": false, "foundedDaysAgo": 3,
      "crew": [{ "handle": "noctua_ned", "displayName": "Ned Ames" }, { "handle": "lamp_lio", "displayName": "Lio Brandt" }, { "handle": "owl_ottilie", "displayName": "Ottilie Ross" }] },
    { "id": "pixel-orchard", "name": "Pixel Orchard", "motto": "Planting our first trees.", "color": "#b6c46a", "preset": "verdant", "seed": 9901, "ring": false, "foundedDaysAgo": 2,
      "crew": [{ "handle": "seedling_sol", "displayName": "Sol Maren" }, { "handle": "graft_gus", "displayName": "Gus Albrecht" }] },
    { "id": "salt-flats-studio", "name": "Salt Flats Studio", "motto": "Wide horizons, clean topology.", "color": "#e0cfa8", "preset": "desert", "seed": 10103, "ring": true, "foundedDaysAgo": 6,
      "crew": [{ "handle": "dune_dara", "displayName": "Dara Quinn" }, { "handle": "mirage_mo", "displayName": "Mo Haddad" }] },
    { "id": "glasswing", "name": "Glasswing", "motto": "Translucent things only.", "color": "#a9d8e8", "preset": "glacier", "seed": 11113, "ring": false, "foundedDaysAgo": 5,
      "crew": [{ "handle": "prism_pia", "displayName": "Pia Sorensen" }, { "handle": "ior_ike", "displayName": "Ike Mensah" }, { "handle": "frost_fen", "displayName": "Fen Calder" }] },
    { "id": "rust-belt-rigs", "name": "Rust Belt Rigs", "motto": "Rigging anything that moves.", "color": "#b5714f", "preset": "desert", "seed": 12107, "ring": false, "foundedDaysAgo": 1,
      "crew": [{ "handle": "bone_bex", "displayName": "Bex Hollis" }, { "handle": "ik_ivo", "displayName": "Ivo Petrov" }] },
    { "id": "coral-cartographers", "name": "Coral Cartographers", "motto": "Mapping the shallows.", "color": "#f0a69a", "preset": "coral", "seed": 13109, "ring": true, "foundedDaysAgo": 2,
      "crew": [{ "handle": "reef_rosa", "displayName": "Rosa Imai" }, { "handle": "chart_chen", "displayName": "Chen Yu" }] },
    { "id": "obsidian-loop", "name": "Obsidian Loop", "motto": "Edge loops all the way down.", "color": "#8a7f96", "preset": "volcanic", "seed": 14107, "ring": true, "foundedDaysAgo": 7,
      "crew": [{ "handle": "loop_lena", "displayName": "Lena Varga" }, { "handle": "crease_cy", "displayName": "Cy Whitlock" }, { "handle": "pole_pax", "displayName": "Pax Mori" }] },
    { "id": "cloud-kiln", "name": "Cloud Kiln", "motto": "Soft shapes, slow bakes.", "color": "#d8d4ee", "preset": "coral", "seed": 15101, "ring": false, "foundedDaysAgo": 3,
      "crew": [{ "handle": "puff_pim", "displayName": "Pim de Wit" }, { "handle": "bake_bea", "displayName": "Bea Lund" }] },
    { "id": "tiny-titans", "name": "Tiny Titans", "motto": "Miniatures with ambition.", "color": "#e2b45c", "preset": "verdant", "seed": 16103, "ring": true, "foundedDaysAgo": 1,
      "crew": [{ "handle": "mini_max", "displayName": "Max Ferro" }, { "handle": "scale_suki", "displayName": "Suki Arden" }] }
  ]
}
```

- [ ] **Step 6: 写占位作品清单**

`src/data/works.json`（GLB 到之前用；14 件、10 位虚构作者，组装后是 4 个团队，分别有 4、4、3、3 件作品。Task 14 的处理脚本会整个重写这个文件）：

```json
[
  { "id": "ph-01", "title": "Brass Lantern", "author": "mia_makes", "file": "", "thumb": "", "tris": 12840 },
  { "id": "ph-02", "title": "Tidal Shrine", "author": "mia_makes", "file": "", "thumb": "", "tris": 48210 },
  { "id": "ph-03", "title": "Paper Crane Mk II", "author": "kenji_polys", "file": "", "thumb": "", "tris": 6420 },
  { "id": "ph-04", "title": "Rusty Courier Bot", "author": "zoe_sculpts", "file": "", "thumb": "", "tris": 88730 },
  { "id": "ph-05", "title": "Moss Golem", "author": "zoe_sculpts", "file": "", "thumb": "", "tris": 132400 },
  { "id": "ph-06", "title": "Lighthouse at Dusk", "author": "arno_builds", "file": "", "thumb": "", "tris": 21950 },
  { "id": "ph-07", "title": "Tea House", "author": "sana_vertex", "file": "", "thumb": "", "tris": 35600 },
  { "id": "ph-08", "title": "Orbital Kiosk", "author": "felix_uv", "file": "", "thumb": "", "tris": 17330 },
  { "id": "ph-09", "title": "Clockwork Owl", "author": "felix_uv", "file": "", "thumb": "", "tris": 64120 },
  { "id": "ph-10", "title": "Desert Rover", "author": "noor_mesh", "file": "", "thumb": "", "tris": 41890 },
  { "id": "ph-11", "title": "Glass Greenhouse", "author": "liam_lowpoly", "file": "", "thumb": "", "tris": 9480 },
  { "id": "ph-12", "title": "Fox Spirit", "author": "ivy_retopo", "file": "", "thumb": "", "tris": 27710 },
  { "id": "ph-13", "title": "Windmill No. 9", "author": "ivy_retopo", "file": "", "thumb": "", "tris": 15260 },
  { "id": "ph-14", "title": "Coral Throne", "author": "otto_bevel", "file": "", "thumb": "", "tris": 72050 }
]
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `npx vitest run tests/csv.test.ts tests/assemble.test.ts`
Expected: PASS（csv 4 个、assemble 7 个）

- [ ] **Step 8: 写生成脚本并生成 seed.json**

`scripts/build-seed.mjs`：

```js
// 生成 src/data/seed.json：团队模板 + 作品清单（works.json 由 prep-models 写；GLB 到之前是占位作品）
import { readFileSync, writeFileSync } from 'node:fs';
import { assembleSeed } from '../src/lib/assemble.ts';

const template = JSON.parse(readFileSync('src/data/teams.template.json', 'utf8'));
const works = JSON.parse(readFileSync('src/data/works.json', 'utf8'));
const seed = assembleSeed(template, works);
writeFileSync('src/data/seed.json', `${JSON.stringify(seed, null, 2)}\n`);
const active = seed.teams.filter((t) => t.status === 'active');
console.log(`seed.json：${seed.teams.length} 个团队（有作品 ${active.length} 个：${active.map((t) => `${t.name} ${t.works.length}`).join('、')}），作品 ${works.length} 件`);
```

Run: `npm run seed`
Expected: `seed.json：14 个团队（有作品 4 个：Lumen Guild 4、Quiet Vertex 4、Kiln Collective 3、Moss & Mesh 3），作品 14 件`

- [ ] **Step 9: 全部测试 + 类型检查，然后提交**

Run: `npm test`，然后 `npm run typecheck`
Expected: 全部 PASS；0 退出

```bash
git add src/lib/csv.ts src/lib/assemble.ts src/data/teams.template.json src/data/works.json src/data/seed.json scripts/build-seed.mjs tests/csv.test.ts tests/assemble.test.ts
git commit -m "feat: 由团队模板和作品清单生成 seed.json" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 星球的 3D 对象（TSL 材质 + 两档细分）

**Files:**
- Create: `src/scenes/lights.ts`, `src/planet/materials.ts`, `src/planet/planetObject.ts`, `dev/planet.html`, `dev/planet.ts`, `scripts/shot.mjs`
- Test: `tests/planetObject.test.ts`

**Interfaces:**
- Consumes: `buildTerrainGeometry`、`LOD_LOW`、`LOD_HIGH`、`makeHeightFn`、`seaRadius`、`HeightFn`、`PRESETS`、`BASE_RADIUS`（Task 3）
- Produces:
  - `addStudioLights(scene: THREE.Scene): void`
  - `surfaceMaterial(preset, rim: boolean)`、`waterMaterial(preset)`、`atmosphereMaterial(preset)`、`ringMaterial(preset, inner, outer)`
  - `class PlanetObject { constructor(recipe: PlanetRecipe); readonly group: THREE.Group; readonly works: THREE.Group; terrain: THREE.Mesh; height: HeightFn; sea: number; readonly currentRecipe: PlanetRecipe; setRecipe(recipe: PlanetRecipe): void; setDetail(detail: number): void }`——`setRecipe` 只在种子、预设、光环、大气变化时重建；`works` 组挂作品，重建时保留
  - `scripts/shot.mjs <路径> <输出.png> [--wait ms] [--click 选择器] [--width px] [--height px]`：等页面设置 `window.__ready = true` 后截图，并打印页面错误

- [ ] **Step 1: 写失败的测试**

`tests/planetObject.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { PlanetRecipe } from '../src/data/types';
import { LOD_HIGH } from '../src/planet/generate';
import { PlanetObject } from '../src/planet/planetObject';

const base: PlanetRecipe = { seed: 7, preset: 'verdant', ring: true, atmosphere: true, placements: [] };

describe('PlanetObject', () => {
  it('只改摆放时不重建地表', () => {
    const p = new PlanetObject(base);
    const terrain = p.terrain;
    p.setRecipe({ ...base, placements: [{ workId: 'w', dir: [0, 1, 0], yaw: 0, scale: 1 }] });
    expect(p.terrain).toBe(terrain);
  });
  it('换预设会重建地表；没有海的预设 sea 为 0', () => {
    const p = new PlanetObject(base);
    const terrain = p.terrain;
    expect(p.sea).toBeGreaterThan(0);
    p.setRecipe({ ...base, preset: 'desert' });
    expect(p.terrain).not.toBe(terrain);
    expect(p.sea).toBe(0);
  });
  it('setDetail 切换细分；换配方后细分保持不变；作品组一直在', () => {
    const p = new PlanetObject(base);
    p.setDetail(LOD_HIGH);
    expect(p.terrain.geometry.getAttribute('position').count / 3).toBe(20480);
    p.setRecipe({ ...base, seed: 8 });
    expect(p.terrain.geometry.getAttribute('position').count / 3).toBe(20480);
    expect(p.works.parent).toBe(p.group);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/planetObject.test.ts`
Expected: FAIL，找不到 `../src/planet/planetObject`

- [ ] **Step 3: 写布光**

`src/scenes/lights.ts`：

```ts
import * as THREE from 'three/webgpu';

// 摄影棚式布光：暖色主光 + 冷色天光补光 + 背后的轮廓光，让各种风格的作品都好看
export function addStudioLights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2420, 0.9));
  const key = new THREE.DirectionalLight(0xfff1dc, 2.4);
  key.position.set(40, 60, 80);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fb8ff, 1.1);
  rim.position.set(-60, 20, -80);
  scene.add(rim);
}
```

- [ ] **Step 4: 写 TSL 材质**

`src/planet/materials.ts`：

```ts
import * as THREE from 'three/webgpu';
import { cameraPosition, color, dot, float, length, modelPosition, normalize, positionLocal, positionWorld, pow, saturate, sin, smoothstep } from 'three/tsl';
import type { PresetId } from '../data/types';
import { PRESETS } from './presets';

// 世界坐标下：从星球中心指向片元的方向、从片元指向镜头的方向
const sphereNormal = () => normalize(positionWorld.sub(modelPosition));
const toCamera = () => normalize(cameraPosition.sub(positionWorld));

// 地表：顶点色（每面一色）+ 边缘一圈大气色微光。微光按球面法线算，不受低多边形面片朝向影响
export function surfaceMaterial(preset: PresetId, rim: boolean): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  if (rim) {
    const f = pow(float(1).sub(saturate(dot(sphereNormal(), toCamera()))), 3);
    m.emissiveNode = color(PRESETS[preset].atmosphere).mul(f).mul(0.35);
  }
  return m;
}

export function waterMaterial(preset: PresetId): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({ color: PRESETS[preset].water, roughness: 0.3, metalness: 0, transparent: true, opacity: 0.88 });
}

// 大气：背面渲染的外壳，叠加混合。外壳背面上 d 从外缘的 0 增加到星球边缘附近的约 0.5，
// 所以光晕贴着星球边缘最亮，往外淡出
export function atmosphereMaterial(preset: PresetId): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const d = dot(sphereNormal(), toCamera()).mul(-1);
  m.colorNode = color(PRESETS[preset].atmosphere);
  m.opacityNode = pow(smoothstep(0, 0.5, d), 1.6).mul(0.9);
  return m;
}

// 光环：RingGeometry 在 XY 平面；按到中心的距离画几十道深浅不一的环带，内外缘淡出
export function ringMaterial(preset: PresetId, inner: number, outer: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false });
  const t = length(positionLocal.xy).sub(inner).div(outer - inner);
  const bands = sin(t.mul(38)).mul(0.5).add(0.5).mul(0.35).add(0.45);
  const edge = smoothstep(0, 0.08, t).mul(float(1).sub(smoothstep(0.85, 1, t)));
  m.colorNode = color(PRESETS[preset].ring);
  m.opacityNode = bands.mul(edge).mul(0.75);
  return m;
}
```

- [ ] **Step 5: 实现 PlanetObject**

`src/planet/planetObject.ts`：

```ts
import * as THREE from 'three/webgpu';
import type { PlanetRecipe } from '../data/types';
import { buildTerrainGeometry, LOD_LOW } from './generate';
import { atmosphereMaterial, ringMaterial, surfaceMaterial, waterMaterial } from './materials';
import { makeHeightFn, seaRadius, type HeightFn } from './noise';
import { BASE_RADIUS, PRESETS } from './presets';

// 一颗星球的 3D 对象：地表（两档细分）、海洋、大气、光环；works 组挂作品，重建时保留
export class PlanetObject {
  readonly group = new THREE.Group();
  readonly works = new THREE.Group();
  terrain!: THREE.Mesh;
  height!: HeightFn;
  sea = 0;
  private recipe!: PlanetRecipe;
  private detail = LOD_LOW;
  private parts: THREE.Object3D[] = [];

  constructor(recipe: PlanetRecipe) {
    this.group.add(this.works);
    this.setRecipe(recipe);
  }

  get currentRecipe(): PlanetRecipe {
    return this.recipe;
  }

  // 只有外观字段（种子、预设、光环、大气）变化才重建；摆放变化由 PlanetView 处理
  setRecipe(recipe: PlanetRecipe): void {
    const prev = this.recipe;
    this.recipe = recipe;
    if (prev && prev.seed === recipe.seed && prev.preset === recipe.preset && prev.ring === recipe.ring && prev.atmosphere === recipe.atmosphere) return;
    this.rebuild();
  }

  setDetail(detail: number): void {
    if (detail === this.detail) return;
    this.detail = detail;
    this.rebuildTerrain();
  }

  private rebuild(): void {
    for (const p of this.parts) {
      this.group.remove(p);
      disposeTree(p);
    }
    this.parts = [];
    const { preset } = this.recipe;
    this.height = makeHeightFn(this.recipe.seed, preset);
    this.sea = seaRadius(preset);
    this.rebuildTerrain();
    if (this.sea > 0) this.addPart(new THREE.Mesh(new THREE.IcosahedronGeometry(this.sea, 12), waterMaterial(preset)));
    if (this.recipe.atmosphere) {
      const r = BASE_RADIUS * (1 + PRESETS[preset].amp) * 1.12;
      this.addPart(new THREE.Mesh(new THREE.IcosahedronGeometry(r, 8), atmosphereMaterial(preset)));
    }
    if (this.recipe.ring) {
      const inner = BASE_RADIUS * 1.45;
      const outer = BASE_RADIUS * 2.15;
      const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 128, 1), ringMaterial(preset, inner, outer));
      ring.rotation.set(-Math.PI / 2 + 0.38, 0, 0.22); // 放到赤道面再稍微倾斜
      this.addPart(ring);
    }
  }

  private rebuildTerrain(): void {
    if (this.terrain) {
      this.group.remove(this.terrain);
      disposeTree(this.terrain);
    }
    this.terrain = new THREE.Mesh(buildTerrainGeometry(this.recipe, this.detail), surfaceMaterial(this.recipe.preset, this.recipe.atmosphere));
    this.terrain.name = 'terrain';
    this.group.add(this.terrain);
  }

  private addPart(o: THREE.Object3D): void {
    this.parts.push(o);
    this.group.add(o);
  }
}

function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    const mesh = c as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `npx vitest run tests/planetObject.test.ts`
Expected: PASS（3 个测试）

- [ ] **Step 7: 写预设预览页和截图脚本**

`dev/planet.html`：

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>planet presets</title>
    <style>html, body { margin: 0; height: 100%; background: #07080d; } #c { width: 100%; height: 100%; display: block; }</style>
  </head>
  <body>
    <canvas id="c"></canvas>
    <script type="module" src="./planet.ts"></script>
  </body>
</html>
```

`dev/planet.ts`：

```ts
import * as THREE from 'three/webgpu';
import { LOD_HIGH } from '../src/planet/generate';
import { PlanetObject } from '../src/planet/planetObject';
import { PRESET_IDS } from '../src/planet/presets';
import { addStudioLights } from '../src/scenes/lights';

// 5 套预设排成一行，偶数位带光环
const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
await renderer.init();
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#07080d');
addStudioLights(scene);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 18, 150);
camera.lookAt(0, 0, 0);
PRESET_IDS.forEach((preset, i) => {
  const p = new PlanetObject({ seed: 1000 + i, preset, ring: i % 2 === 0, atmosphere: true, placements: [] });
  p.setDetail(LOD_HIGH);
  p.group.position.set((i - 2) * 48, 0, 0);
  scene.add(p.group);
});
renderer.setAnimationLoop(() => renderer.render(scene, camera));
requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true; }));
```

`scripts/shot.mjs`：

```js
// 截图自查：node scripts/shot.mjs <路径> <输出.png> [--wait ms] [--click 选择器] [--width px] [--height px]
// 路径不要以 / 开头（Git Bash 会改写），例：node scripts/shot.mjs "index.html#/t/lumen-guild" shots/planet.png
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const [route, out, ...rest] = process.argv.slice(2);
if (!route || !out || /^[A-Za-z]:[\\/]/.test(route)) {
  console.error('用法：node scripts/shot.mjs <路径> <输出.png> [--wait ms] [--click 选择器] [--width px] [--height px]（路径不要以 / 开头）');
  process.exit(2);
}
const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const { server, base } = await startServer();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: Number(opt('--width', 1440)), height: Number(opt('--height', 900)) } });
const errors = watchErrors(page);
await page.goto(`${base}/${route.replace(/^\/+/, '')}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
const click = opt('--click');
if (click) await page.locator(click).first().click();
await page.waitForTimeout(Number(opt('--wait', 800)));
mkdirSync(path.dirname(out), { recursive: true });
await page.screenshot({ path: out });
console.log(errors.length ? `页面错误 ${errors.length} 条：\n${errors.join('\n')}` : '页面无报错');
await browser.close();
await server.close();
process.exitCode = errors.length ? 1 : 0;
```

- [ ] **Step 8: 截图检查**

Run: `node scripts/shot.mjs dev/planet.html shots/planets.png --wait 1500`
Expected: 输出 `页面无报错`。用 Read 工具打开 `shots/planets.png` 检查：5 颗星球颜色各不相同（绿、沙黄、冰白、黑灰带橙、粉）；第 1、3、5 颗有光环；每颗边缘有一圈大气光晕，贴着星球最亮、往外淡出；地表是低多边形面片；Verdant、Glacier、Coral 有海。光晕太强或太弱时，调 `atmosphereMaterial` 里的 `0.5`（贴边的位置）和 `0.9`（强度）

- [ ] **Step 9: 类型检查并提交**

Run: `npm run typecheck`
Expected: 0 退出

```bash
git add src/scenes/lights.ts src/planet/materials.ts src/planet/planetObject.ts dev/planet.html dev/planet.ts scripts/shot.mjs tests/planetObject.test.ts
git commit -m "feat: 星球 3D 对象（TSL 地表、海洋、大气、光环）与截图脚本" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 星系世界 + 应用骨架（路由、顶栏、悬停、点击飞入）

**Files:**
- Create: `src/scenes/layout.ts`, `src/scenes/sky.ts`, `src/scenes/camera.ts`, `src/scenes/world.ts`, `src/ui/dom.ts`, `src/ui/toast.ts`, `src/ui/topbar.ts`, `src/ui/galaxyUi.ts`, `src/app.ts`
- Modify: `src/main.ts`（整个替换）, `src/ui/styles.css`（末尾追加）
- Test: `tests/layout.test.ts`, `tests/dom.test.ts`

**Interfaces:**
- Consumes: `PlanetObject`、`addStudioLights`（Task 7）；`SHOWCASE_POLE`（Task 4）；`parseRoute`、`toHash`、`Route`、`LocalStore`、`browserStorage`（Task 5）；`seed.json`（Task 6）
- Produces:
  - `galaxyPositions(n: number): Array<[number, number, number]>`
  - `createSky(): THREE.Group`
  - `interface Framing { target: THREE.Vector3; position: THREE.Vector3; minDistance: number; maxDistance: number; autoRotate: boolean }`；`class CameraRig { camera; controls: OrbitControls; readonly flying: boolean; jump(f: Framing): void; fly(f: Framing, duration?: number): Promise<void>; update(dt: number): void; resize(w: number, h: number): void }`
  - `interface PlanetEntry { team: Team; planet: PlanetObject; hit: THREE.Mesh; home: THREE.Vector3 }`；`GALAXY_VIEW`；`planetFraming(home)`；`class World { static create(canvas); renderer; scene; rig; planets: Map<string, PlanetEntry>; frameHooks: Set<(dt) => void>; focused; hovered; paused; setTeams(teams); updateTeam(team); rayFrom(x, y): THREE.Raycaster; pickPlanet(x, y): PlanetEntry | null; setHover(e); toScreen(p): { x; y } | null; intro(): Promise<void>; focus(teamId): Promise<PlanetEntry | null>; unfocus(): Promise<void> }`
  - `el(tag, props?, ...children)`、`initials(name)`、`formatTris(n)`；`toast(message, ms?)`
  - `interface TopbarActions { back(); members(); museum(); edit() }`；`class Topbar { constructor(root, youHandle, actions); showGalaxy(teamCount, workCount); showTeam(team, isYours); setEditing(on) }`
  - `interface PlanetLayer { enter(team: Team): Promise<void>; leave(): void }`；`interface Sheet { open(team: Team, route: Route): Promise<void> | void; close(): void }`；`class App { world; root; store; you; topbar; teams; planetLayer: PlanetLayer | null; members: Sheet | null; museum: Sheet | null; onEdit: () => void; readonly currentTeam: Team | null; start(); navigate(route); closeSheet(); replaceTeam(team) }`

- [ ] **Step 1: 写失败的测试**

`tests/layout.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { galaxyPositions } from '../src/scenes/layout';

describe('galaxyPositions', () => {
  it('结果确定；16 颗星球两两间距不小于 50（带光环的星球外径 21.5，不会重叠）', () => {
    const a = galaxyPositions(16);
    expect(galaxyPositions(16)).toEqual(a);
    for (let i = 0; i < 16; i++) {
      for (let j = i + 1; j < 16; j++) {
        expect(Math.hypot(a[i][0] - a[j][0], a[i][1] - a[j][1], a[i][2] - a[j][2])).toBeGreaterThanOrEqual(50);
      }
    }
  });
  it('整个星系在水平半径 160 以内，星系镜头能看全', () => {
    for (const [x, , z] of galaxyPositions(16)) expect(Math.hypot(x, z)).toBeLessThan(160);
  });
});
```

`tests/dom.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { formatTris, initials } from '../src/ui/dom';

describe('initials', () => {
  it('取前两个词的首字母', () => {
    expect(initials('Ollie Park')).toBe('OP');
    expect(initials('mia_makes')).toBe('MM');
    expect(initials('Brass Lantern of Doom')).toBe('BL');
    expect(initials('')).toBe('?');
  });
});

describe('formatTris', () => {
  it('千分位；0 显示为破折号', () => {
    expect(formatTris(128402)).toBe('128,402 tris');
    expect(formatTris(0)).toBe('— tris');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/layout.test.ts tests/dom.test.ts`
Expected: FAIL，找不到 `../src/scenes/layout` 和 `../src/ui/dom`

- [ ] **Step 3: 实现布局和 DOM 小工具**

`src/scenes/layout.ts`：

```ts
// 星系布局：Vogel 螺旋（黄金角）。间距 34 时 16 颗星球的最小间距约 56，外径约 138
export const GALAXY_SPACING = 34;

export function galaxyPositions(n: number): Array<[number, number, number]> {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: n }, (_, i) => {
    const r = GALAXY_SPACING * Math.sqrt(i + 1.5);
    const a = i * golden;
    return [Math.cos(a) * r, Math.sin(i * 1.7) * 9, Math.sin(a) * r];
  });
}
```

`src/ui/dom.ts`：

```ts
// 建元素：props 直接赋给元素（textContent、className、onclick……），dataset 单独处理
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], 'dataset'>> & { dataset?: Record<string, string> } = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

export function initials(name: string): string {
  return name.split(/[\s_\-.]+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('') || '?';
}

export function formatTris(n: number): string {
  return n > 0 ? `${n.toLocaleString('en-US')} tris` : '— tris';
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/layout.test.ts tests/dom.test.ts`
Expected: PASS（4 个测试）

- [ ] **Step 5: 写天空和镜头**

`src/scenes/sky.ts`：

```ts
import * as THREE from 'three/webgpu';
import { color, mix, mx_fractal_noise_float, normalize, positionLocal, smoothstep } from 'three/tsl';
import { mulberry32 } from '../planet/rng';

// 天空：大号背面球画星云渐变 + 2500 颗星星。WebGPU 的 Points 只能画 1 像素，所以星星用实例化小球
export function createSky(): THREE.Group {
  const sky = new THREE.Group();
  const dir = normalize(positionLocal);
  const n1 = mx_fractal_noise_float(dir.mul(2.2), 4, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
  const n2 = mx_fractal_noise_float(dir.mul(3.1).add(7.3), 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
  const domeMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
  domeMat.colorNode = mix(mix(color('#07080d'), color('#1b1530'), smoothstep(0.45, 0.85, n1)), color('#2a1c24'), smoothstep(0.62, 0.95, n2));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 24), domeMat);
  dome.renderOrder = -1;
  sky.add(dome);

  const count = 2500;
  const rng = mulberry32(99);
  const stars = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicNodeMaterial(), count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = rng() * 2 - 1;
    const phi = rng() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    p.set(Math.cos(phi) * r, u, Math.sin(phi) * r).multiplyScalar(3000);
    s.setScalar(1.5 + rng() ** 4 * 5);
    stars.setMatrixAt(i, m.compose(p, q, s));
    stars.setColorAt(i, c.setHSL(0.58 + rng() * 0.12, 0.25, 0.7 + rng() * 0.3));
  }
  stars.frustumCulled = false;
  sky.add(stars);
  return sky;
}
```

`src/scenes/camera.ts`：

```ts
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface Framing {
  target: THREE.Vector3;
  position: THREE.Vector3;
  minDistance: number;
  maxDistance: number;
  autoRotate: boolean;
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// 镜头：OrbitControls 负责手动转动；fly() 用缓入缓出飞到新的取景（默认 1.2 秒）
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 6000);
  readonly controls: OrbitControls;
  private flight: { fromPos: THREE.Vector3; fromTarget: THREE.Vector3; to: Framing; start: number; ms: number; done: () => void } | null = null;

  constructor(dom: HTMLElement) {
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.autoRotateSpeed = 0.35;
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  jump(f: Framing): void {
    this.camera.position.copy(f.position);
    this.controls.target.copy(f.target);
    this.apply(f);
    this.controls.update();
  }

  fly(f: Framing, duration = 1.2): Promise<void> {
    this.flight?.done();
    this.controls.enabled = false;
    this.controls.autoRotate = false;
    // 飞行时放开距离限制，否则 update() 会把镜头夹回去
    this.controls.minDistance = 0;
    this.controls.maxDistance = Infinity;
    return new Promise((done) => {
      this.flight = { fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(), to: f, start: performance.now(), ms: duration * 1000, done };
    });
  }

  update(dt: number): void {
    const fl = this.flight;
    if (!fl) {
      this.controls.update(dt);
      return;
    }
    const k = easeInOutCubic(Math.min(1, (performance.now() - fl.start) / fl.ms));
    this.camera.position.lerpVectors(fl.fromPos, fl.to.position, k);
    this.controls.target.lerpVectors(fl.fromTarget, fl.to.target, k);
    this.camera.lookAt(this.controls.target);
    if (k >= 1) {
      this.flight = null;
      this.apply(fl.to);
      this.controls.enabled = true;
      fl.done();
    }
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private apply(f: Framing): void {
    this.controls.minDistance = f.minDistance;
    this.controls.maxDistance = f.maxDistance;
    this.controls.autoRotate = f.autoRotate;
  }
}
```

- [ ] **Step 6: 写 3D 世界**

`src/scenes/world.ts`：

```ts
import * as THREE from 'three/webgpu';
import type { Team } from '../data/types';
import { LOD_HIGH, LOD_LOW } from '../planet/generate';
import { SHOWCASE_POLE } from '../planet/placement';
import { PlanetObject } from '../planet/planetObject';
import { BASE_RADIUS } from '../planet/presets';
import { CameraRig, type Framing } from './camera';
import { galaxyPositions } from './layout';
import { addStudioLights } from './lights';
import { createSky } from './sky';

export interface PlanetEntry {
  team: Team;
  planet: PlanetObject;
  hit: THREE.Mesh; // 不可见的拾取球，比打地表网格便宜
  home: THREE.Vector3; // 星球在星系里的位置
}

const POLE = new THREE.Vector3(...SHOWCASE_POLE);
export const GALAXY_VIEW: Framing = { target: new THREE.Vector3(0, 0, 0), position: new THREE.Vector3(0, 170, 330), minDistance: 160, maxDistance: 620, autoRotate: true };

// 镜头从展示方向看向星球；初始作品就排在这个方向周围
export function planetFraming(home: THREE.Vector3): Framing {
  return { target: home.clone(), position: home.clone().addScaledVector(POLE, 30), minDistance: 15, maxDistance: 70, autoRotate: false };
}

// 3D 世界：一个渲染器、一个场景，星系里所有星球都在里面；聚焦就是把镜头飞到某颗星球前面
export class World {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly planets = new Map<string, PlanetEntry>();
  readonly frameHooks = new Set<(dt: number) => void>();
  focused: PlanetEntry | null = null;
  hovered: PlanetEntry | null = null;
  paused = false; // Museum 打开时主画面被盖住，停止渲染
  private readonly halo: THREE.Mesh;
  private readonly timer = new THREE.Timer();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  private constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
    this.rig = new CameraRig(renderer.domElement);
    this.scene.add(createSky());
    addStudioLights(this.scene);
    // 悬停光圈：每帧转到正对镜头
    this.halo = new THREE.Mesh(
      new THREE.RingGeometry(1, 1.04, 96),
      new THREE.MeshBasicNodeMaterial({ color: '#d9b77e', transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.halo.visible = false;
    this.scene.add(this.halo);
    this.rig.jump(GALAXY_VIEW);
    this.resize();
    addEventListener('resize', () => this.resize());
    renderer.setAnimationLoop((t) => this.frame(t));
  }

  static async create(canvas: HTMLCanvasElement): Promise<World> {
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    await renderer.init();
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    return new World(renderer);
  }

  setTeams(teams: Team[]): void {
    for (const e of this.planets.values()) this.scene.remove(e.planet.group, e.hit);
    this.planets.clear();
    const homes = galaxyPositions(teams.length);
    teams.forEach((team, i) => {
      const home = new THREE.Vector3(...homes[i]);
      const planet = new PlanetObject(team.planet);
      planet.group.position.copy(home);
      const hit = new THREE.Mesh(new THREE.SphereGeometry(BASE_RADIUS * 1.3, 16, 12), new THREE.MeshBasicNodeMaterial());
      hit.visible = false; // Raycaster 照样能打中不可见的物体
      hit.position.copy(home);
      hit.userData.teamId = team.id;
      this.scene.add(planet.group, hit);
      this.planets.set(team.id, { team, planet, hit, home });
    });
  }

  updateTeam(team: Team): void {
    const e = this.planets.get(team.id);
    if (!e) return;
    e.team = team;
    e.planet.setRecipe(team.planet);
  }

  // 屏幕坐标 → 射线；各处拾取共用
  rayFrom(clientX: number, clientY: number): THREE.Raycaster {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.rig.camera);
    return this.raycaster;
  }

  pickPlanet(clientX: number, clientY: number): PlanetEntry | null {
    const hit = this.rayFrom(clientX, clientY).intersectObjects([...this.planets.values()].map((e) => e.hit), false)[0];
    return hit ? this.planets.get(hit.object.userData.teamId as string) ?? null : null;
  }

  setHover(e: PlanetEntry | null): void {
    this.hovered = e;
    this.halo.visible = e !== null;
  }

  // 世界坐标 → 屏幕像素坐标；在镜头背后时返回 null
  toScreen(p: THREE.Vector3): { x: number; y: number } | null {
    const v = p.clone().project(this.rig.camera);
    if (v.z > 1) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  // 打开页面时从远处缓缓推进到星系全景
  intro(): Promise<void> {
    this.rig.jump({ ...GALAXY_VIEW, position: GALAXY_VIEW.position.clone().multiplyScalar(2.6), maxDistance: Infinity });
    return this.rig.fly(GALAXY_VIEW, 2.4);
  }

  async focus(teamId: string): Promise<PlanetEntry | null> {
    const e = this.planets.get(teamId);
    if (!e) return null;
    if (this.focused && this.focused !== e) this.focused.planet.setDetail(LOD_LOW);
    this.focused = e;
    this.setHover(null);
    e.planet.setDetail(LOD_HIGH);
    await this.rig.fly(planetFraming(e.home));
    return e;
  }

  async unfocus(): Promise<void> {
    const prev = this.focused;
    this.focused = null;
    await this.rig.fly(GALAXY_VIEW);
    prev?.planet.setDetail(LOD_LOW);
  }

  private frame(time: number): void {
    this.timer.update(time);
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.rig.update(dt);
    if (this.hovered) {
      this.halo.position.copy(this.hovered.home);
      this.halo.scale.setScalar(BASE_RADIUS * 1.55);
      this.halo.quaternion.copy(this.rig.camera.quaternion);
    }
    for (const hook of this.frameHooks) hook(dt);
    if (!this.paused) this.renderer.render(this.scene, this.rig.camera);
  }

  private resize(): void {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.rig.resize(innerWidth, innerHeight);
  }
}
```

- [ ] **Step 7: 写提示条、顶栏和星系交互**

`src/ui/toast.ts`：

```ts
let box: HTMLDivElement | null = null;
let timer = 0;

// 屏幕底部的提示条，几秒后自动消失
export function toast(message: string, ms = 2800): void {
  if (!box) {
    box = document.createElement('div');
    box.className = 'toast';
    box.setAttribute('role', 'status');
    document.querySelector('#app')?.append(box);
  }
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(timer);
  timer = window.setTimeout(() => box?.classList.remove('show'), ms);
}
```

`src/ui/topbar.ts`：

```ts
import type { Team } from '../data/types';
import { el } from './dom';

export interface TopbarActions {
  back(): void;
  members(): void;
  museum(): void;
  edit(): void;
}

// 顶栏：左边标题，中间是星球页的按钮，右边是演示身份
export class Topbar {
  private readonly title = el('div', { className: 'tb-title' });
  private readonly actions = el('nav', { className: 'tb-actions' });
  private readonly editButton: HTMLButtonElement;

  constructor(root: HTMLElement, youHandle: string, act: TopbarActions) {
    this.editButton = el('button', { className: 'primary', textContent: 'Edit', onclick: () => act.edit() });
    this.actions.append(
      el('button', { textContent: '← Galaxy', onclick: () => act.back() }),
      el('button', { textContent: 'Members', onclick: () => act.members() }),
      el('button', { textContent: 'Museum', onclick: () => act.museum() }),
      this.editButton,
    );
    const who = el('div', { className: 'tb-who mono' }, `Signed in as @${youHandle} · `, el('span', { className: 'you-tag', textContent: 'You' }));
    root.append(el('header', { className: 'topbar' }, this.title, this.actions, who));
  }

  showGalaxy(teamCount: number, workCount: number): void {
    this.title.replaceChildren(
      el('div', { className: 'display tb-name', textContent: 'Community Planets' }),
      el('div', { className: 'mono', textContent: `${teamCount} teams · ${workCount} works · one sky` }),
    );
    this.actions.hidden = true;
  }

  showTeam(team: Team, isYours: boolean): void {
    this.title.replaceChildren(
      el('div', { className: 'display tb-name', textContent: team.name }),
      el('div', { className: 'tb-motto', textContent: team.motto }),
    );
    this.actions.hidden = false;
    this.editButton.hidden = !isYours;
    this.setEditing(false);
  }

  setEditing(on: boolean): void {
    this.editButton.textContent = on ? 'Done' : 'Edit';
    this.editButton.setAttribute('aria-pressed', String(on));
  }
}
```

`src/ui/galaxyUi.ts`：

```ts
import * as THREE from 'three/webgpu';
import type { PlanetEntry, World } from '../scenes/world';
import { el } from './dom';

// 星系页：悬停星球显示团队名和人数，点击（不是拖动）进入星球
export class GalaxyUi {
  private enabled = true;
  private readonly world: World;
  private readonly label = el('div', { className: 'float-label' });
  private shown: PlanetEntry | null = null;
  private down: { x: number; y: number } | null = null;

  constructor(world: World, root: HTMLElement, onPick: (teamId: string) => void) {
    this.world = world;
    this.label.hidden = true;
    root.append(this.label);
    const canvas = world.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => {
      if (!this.enabled || world.rig.flying) return;
      const hit = world.pickPlanet(e.clientX, e.clientY);
      world.setHover(hit);
      canvas.style.cursor = hit ? 'pointer' : '';
    });
    canvas.addEventListener('pointerdown', (e) => { this.down = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!this.enabled || world.rig.flying || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      const hit = world.pickPlanet(e.clientX, e.clientY);
      if (hit) onPick(hit.team.id);
    });
    world.frameHooks.add(() => this.placeLabel());
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.world.setHover(null);
      this.world.renderer.domElement.style.cursor = '';
    }
  }

  // 每帧把标签放到悬停星球的上方
  private placeLabel(): void {
    const h = this.world.hovered;
    const at = h ? this.world.toScreen(new THREE.Vector3(0, 15, 0).add(h.home)) : null;
    this.label.hidden = !at;
    if (!h || !at) return;
    if (this.shown !== h) {
      this.shown = h;
      this.label.replaceChildren(
        el('span', { className: 'display', textContent: h.team.name }),
        el('span', { className: 'mono', textContent: `${h.team.members.length} members · ${h.team.works.length} works` }),
      );
    }
    this.label.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -100%)`;
  }
}
```

- [ ] **Step 8: 写应用骨架和入口**

`src/app.ts`：

```ts
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

  navigate(route: Route): void {
    const hash = toHash(route);
    if (location.hash === hash || (hash === '#/' && location.hash === '')) void this.queue(route);
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
      this.navigate({ view: 'galaxy' });
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
```

`src/main.ts`（整个替换 Task 1 的临时版本）：

```ts
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
```

在 `src/ui/styles.css` 末尾追加：

```css
/* 顶栏：渐变背景本身不挡鼠标（选择器要带 #app，才能盖过 #app > * 的 pointer-events: auto） */
#app > .topbar { position: absolute; top: 0; left: 0; right: 0; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px; padding: 18px 24px; background: linear-gradient(rgba(7, 8, 13, 0.85), rgba(7, 8, 13, 0)); pointer-events: none; }
.topbar > * { pointer-events: auto; }
.tb-name { font-size: 28px; line-height: 1.1; }
.tb-motto { font-family: var(--font-display); font-style: italic; color: var(--ink-dim); font-size: 16px; }
.tb-actions { display: flex; gap: 8px; }
.tb-who { justify-self: end; }
.you-tag { color: var(--accent); }
@media (max-width: 760px) {
  .topbar { grid-template-columns: 1fr; padding: 14px 16px; }
  .tb-who { display: none; }
  .tb-actions { flex-wrap: wrap; }
}

/* 悬浮标签：跟着 3D 物体走，不挡鼠标 */
#app > .float-label { position: absolute; left: 0; top: 0; pointer-events: none; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 8px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); white-space: nowrap; }
.float-label .display { font-size: 18px; }

/* 提示条 */
#app > .toast { position: absolute; left: 50%; bottom: 28px; transform: translate(-50%, 12px); opacity: 0; transition: opacity 0.2s, transform 0.2s; padding: 10px 16px; background: var(--panel-solid); border: 1px solid var(--line); border-radius: var(--radius); pointer-events: none; z-index: 20; }
#app > .toast.show { opacity: 1; transform: translate(-50%, 0); }
```

- [ ] **Step 9: 截图检查**

Run: `node scripts/shot.mjs index.html shots/galaxy.png`
Expected: `页面无报错`。打开截图检查：深色星云背景、细小的星星、14 颗星球排成螺旋圆盘、顶栏左边是「Community Planets」和「14 teams · 14 works · one sky」，右边是「Signed in as @orbit_ollie · You」

Run: `node scripts/shot.mjs "index.html#/t/lumen-guild" shots/fly.png`
Expected: `页面无报错`；镜头停在 Lumen Guild 星球前（还没有作品，Task 9 加），顶栏显示团队名、口号和四个按钮（含 Edit）

- [ ] **Step 10: 全部测试 + 类型检查，然后提交**

Run: `npm test`，然后 `npm run typecheck`
Expected: 全部 PASS；0 退出

```bash
git add src/scenes/layout.ts src/scenes/sky.ts src/scenes/camera.ts src/scenes/world.ts src/ui/dom.ts src/ui/toast.ts src/ui/topbar.ts src/ui/galaxyUi.ts src/app.ts src/main.ts src/ui/styles.css tests/layout.test.ts tests/dom.test.ts
git commit -m "feat: 星系世界、镜头飞行、顶栏与路由骨架" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 星球页（作品上星球、悬停、作品卡、建设中提示）

**Files:**
- Create: `src/assets/placeholder.ts`, `src/assets/models.ts`, `src/scenes/planetView.ts`, `src/ui/workCard.ts`, `src/ui/planetScreen.ts`
- Modify: `src/main.ts`, `src/ui/styles.css`（末尾追加）
- Test: `tests/planetView.test.ts`

**Interfaces:**
- Consumes: `World`、`PlanetEntry`（Task 8）；`placementTransform`、`fitToSize`、`PLINTH_HEIGHT`（Task 4）；`hashString`、`mulberry32`（Task 1）；`el`、`formatTris`（Task 8）；`PlanetLayer`（Task 8）
- Produces:
  - `placeholderModel(id: string): THREE.Group`
  - `interface LoadedModel { object: THREE.Group; height: number; footprint: number; failed: boolean }`；`modelUrl(file)`、`thumbUrl(file)`；`class ModelLibrary { load(work: Pick<Work, 'id' | 'file'>): Promise<LoadedModel> }`
  - `interface PlacedWork { work; placement; root; scaler; plinth; proxy; model: LoadedModel | null }`；`class PlanetView { constructor(world); library; placed: Map<string, PlacedWork>; extraWorks: Map<string, Work>; team: Team | null; readonly planet: PlanetEntry | null; enter(team); leave(); findWork(id); place(p: Placement): Promise<PlacedWork | null>; remove(workId); updateTransform(pw); refreshAll(); pick(x, y): PlacedWork | null; topOf(pw): THREE.Vector3; setHighlight(pw | null) }`
  - `class WorkCard { show(work, team, failed); hide() }`
  - `class PlanetScreen implements PlanetLayer { constructor(world, root, onMuseum: (teamId, workId) => void); readonly view: PlanetView; readonly card: WorkCard; setInteractive(on: boolean) }`

- [ ] **Step 1: 写失败的测试**

`tests/planetView.test.ts`：

```ts
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { Team } from '../src/data/types';
import { PlanetObject } from '../src/planet/planetObject';
import { PlanetView } from '../src/scenes/planetView';
import type { World } from '../src/scenes/world';

const team: Team = {
  id: 't', name: 'T', motto: '', color: '#d9b77e', status: 'active', foundedDaysAgo: 1,
  members: [{ id: 'm', handle: 'm', displayName: 'M', role: 'captain' }],
  works: [
    { id: 'w1', title: 'One', authorId: 'm', file: '', thumb: '', tris: 10 },
    { id: 'w2', title: 'Two', authorId: 'm', file: '', thumb: '', tris: 10 },
  ],
  planet: {
    seed: 3, preset: 'desert', ring: false, atmosphere: false,
    placements: [
      { workId: 'w1', dir: [0, 1, 0], yaw: 0, scale: 1 },
      { workId: 'w2', dir: [1, 0, 0], yaw: 0, scale: 1.5 },
    ],
  },
};

// PlanetView 只用到 world.planets 和 world.rayFrom
function fakeWorld(): World {
  const planet = new PlanetObject(team.planet);
  return { planets: new Map([[team.id, { team, planet, hit: new THREE.Mesh(), home: new THREE.Vector3() }]]) } as unknown as World;
}

describe('PlanetView', () => {
  it('enter 摆上所有作品：贴在地表上，按 scale 缩放，模型已挂上', async () => {
    const world = fakeWorld();
    const view = new PlanetView(world);
    await view.enter(team);
    expect([...view.placed.keys()]).toEqual(['w1', 'w2']);
    const entry = world.planets.get('t')!;
    const w1 = view.placed.get('w1')!;
    expect(w1.root.parent).toBe(entry.planet.works);
    expect(w1.root.position.length()).toBeCloseTo(entry.planet.height(0, 1, 0), 6);
    expect(view.placed.get('w2')!.scaler.scale.x).toBe(1.5);
    expect(w1.model).not.toBeNull();
  });
  it('remove 拿掉一件；leave 清空全部', async () => {
    const view = new PlanetView(fakeWorld());
    await view.enter(team);
    view.remove('w1');
    expect(view.placed.has('w1')).toBe(false);
    view.leave();
    expect(view.placed.size).toBe(0);
    expect(view.team).toBeNull();
  });
  it('找不到的作品不摆', async () => {
    const view = new PlanetView(fakeWorld());
    await view.enter({ ...team, planet: { ...team.planet, placements: [{ workId: 'nope', dir: [0, 1, 0], yaw: 0, scale: 1 }] } });
    expect(view.placed.size).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/planetView.test.ts`
Expected: FAIL，找不到 `../src/scenes/planetView`

- [ ] **Step 3: 写占位模型和模型库**

`src/assets/placeholder.ts`：

```ts
import * as THREE from 'three/webgpu';
import { hashString, mulberry32 } from '../planet/rng';

const makers: Array<() => THREE.BufferGeometry> = [
  () => new THREE.BoxGeometry(1, 1, 1),
  () => new THREE.CylinderGeometry(0.5, 0.5, 1, 24),
  () => new THREE.ConeGeometry(0.55, 1, 24),
  () => new THREE.SphereGeometry(0.55, 24, 16),
  () => new THREE.TorusKnotGeometry(0.32, 0.11, 96, 12),
];

// 占位作品（GLB 到之前用）：按作品 id 确定性地叠 2–4 块几何体，颜色在暖灰到黄铜之间
export function placeholderModel(id: string): THREE.Group {
  const rng = mulberry32(hashString(id));
  const material = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color().setHSL(0.05 + rng() * 0.5, 0.32, 0.56), roughness: 0.5, metalness: 0.1 });
  const group = new THREE.Group();
  let y = 0;
  const n = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const mesh = new THREE.Mesh(makers[Math.floor(rng() * makers.length)](), material);
    const s = 0.5 + rng() * 0.8;
    mesh.scale.setScalar(s);
    mesh.position.y = y + s * 0.5;
    mesh.rotation.y = rng() * Math.PI;
    y += s * 0.85;
    group.add(mesh);
  }
  return group;
}
```

`src/assets/models.ts`：

```ts
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { Work } from '../data/types';
import { fitToSize } from '../planet/placement';
import { placeholderModel } from './placeholder';

export interface LoadedModel {
  object: THREE.Group; // 已归一化：最长边 = WORK_SIZE，水平居中，底部在 y=0
  height: number; // 归一化后的高度
  footprint: number; // 归一化后的水平半径
  failed: boolean;
}

// blob:（拖进来的 GLB）和完整网址原样用，其余拼到 public/models/ 下
export function modelUrl(file: string): string {
  return /^(blob:|https?:|data:)/.test(file) ? file : `${import.meta.env.BASE_URL}models/${file}`;
}

export function thumbUrl(file: string): string {
  return `${import.meta.env.BASE_URL}thumbs/${file}`;
}

// 每个渲染器用自己的实例：GPU 资源不跨渲染器共享
export class ModelLibrary {
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private readonly cache = new Map<string, Promise<THREE.Object3D>>();

  async load(work: Pick<Work, 'id' | 'file'>): Promise<LoadedModel> {
    if (!work.file) return normalize(placeholderModel(work.id), false);
    try {
      return normalize(cloneSkinned(await this.fetch(modelUrl(work.file))), false);
    } catch (err) {
      console.warn(`model failed: ${work.file}`, err);
      return normalize(failedModel(), true);
    }
  }

  private fetch(url: string): Promise<THREE.Object3D> {
    let p = this.cache.get(url);
    if (!p) {
      p = this.loader.loadAsync(url).then((gltf) => gltf.scene);
      this.cache.set(url, p);
      p.catch(() => this.cache.delete(url));
    }
    return p;
  }
}

// 套两层：inner 负责缩放和居中，外层留给调用方随便摆
function normalize(source: THREE.Object3D, failed: boolean): LoadedModel {
  const inner = new THREE.Group();
  inner.add(source);
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  const { scale, offset } = fitToSize(box);
  inner.scale.setScalar(scale);
  inner.position.copy(offset);
  const object = new THREE.Group();
  object.add(inner);
  const size = box.getSize(new THREE.Vector3()).multiplyScalar(scale);
  return { object, height: size.y, footprint: Math.hypot(size.x, size.z) / 2, failed };
}

// 加载失败时显示的灰色方块
function failedModel(): THREE.Object3D {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: '#6f6a61', roughness: 0.8 }));
  mesh.position.y = 0.5;
  return mesh;
}
```

- [ ] **Step 4: 实现 PlanetView**

`src/scenes/planetView.ts`：

```ts
import * as THREE from 'three/webgpu';
import { ModelLibrary, type LoadedModel } from '../assets/models';
import type { Placement, Team, Work } from '../data/types';
import { PLINTH_HEIGHT, placementTransform } from '../planet/placement';
import type { PlanetEntry, World } from './world';

export interface PlacedWork {
  work: Work;
  placement: Placement;
  root: THREE.Group; // 贴地、对准法线、绕法线转 yaw
  scaler: THREE.Group; // 按 placement.scale 缩放；展台、模型、拾取盒都在里面
  plinth: THREE.Mesh;
  proxy: THREE.Mesh; // 不可见的拾取盒：拾取只打它，高面数模型也不卡
  model: LoadedModel | null;
}

const PLINTH_DEPTH = 0.5; // 展台往地下延伸，坡地上也不露缝

// 聚焦星球上的作品：放展台和拾取盒，模型加载完再挂上；地形变了重新贴地
export class PlanetView {
  readonly library = new ModelLibrary();
  readonly placed = new Map<string, PlacedWork>();
  readonly extraWorks = new Map<string, Work>(); // 拖进来的临时作品
  team: Team | null = null;
  private entry: PlanetEntry | null = null;
  private readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  get planet(): PlanetEntry | null {
    return this.entry;
  }

  async enter(team: Team): Promise<void> {
    this.team = team;
    this.entry = this.world.planets.get(team.id) ?? null;
    await Promise.all(team.planet.placements.map((p) => this.place(p)));
  }

  leave(): void {
    for (const id of [...this.placed.keys()]) this.remove(id);
    this.team = null;
    this.entry = null;
  }

  findWork(workId: string): Work | undefined {
    return this.team?.works.find((w) => w.id === workId) ?? this.extraWorks.get(workId);
  }

  async place(p: Placement): Promise<PlacedWork | null> {
    const work = this.findWork(p.workId);
    const entry = this.entry;
    if (!work || !entry || this.placed.has(work.id)) return null;
    const root = new THREE.Group();
    const scaler = new THREE.Group();
    // 模型加载完之前展台是半透明的（spec 2.2）
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1.06, PLINTH_DEPTH, 40),
      new THREE.MeshStandardNodeMaterial({ color: this.team?.color ?? '#d9b77e', roughness: 0.55, metalness: 0.15, transparent: true, opacity: 0.4 }),
    );
    plinth.position.y = PLINTH_HEIGHT - PLINTH_DEPTH / 2;
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicNodeMaterial());
    proxy.visible = false;
    proxy.userData.workId = work.id;
    scaler.add(plinth, proxy);
    root.add(scaler);
    entry.planet.works.add(root);
    const pw: PlacedWork = { work, placement: structuredClone(p), root, scaler, plinth, proxy, model: null };
    this.placed.set(work.id, pw);
    this.sizeParts(pw, 1, 0.8);
    this.updateTransform(pw);
    const model = await this.library.load(work);
    if (this.placed.get(work.id) !== pw) return null; // 加载期间被移除了
    pw.model = model;
    model.object.position.y = PLINTH_HEIGHT;
    scaler.add(model.object);
    this.sizeParts(pw, model.height, model.footprint);
    const plinthMaterial = plinth.material as THREE.MeshStandardNodeMaterial;
    plinthMaterial.opacity = 1;
    plinthMaterial.transparent = false;
    plinthMaterial.needsUpdate = true;
    return pw;
  }

  remove(workId: string): void {
    const pw = this.placed.get(workId);
    if (!pw) return;
    pw.root.removeFromParent();
    pw.plinth.geometry.dispose();
    (pw.plinth.material as THREE.Material).dispose();
    pw.proxy.geometry.dispose();
    (pw.proxy.material as THREE.Material).dispose();
    this.placed.delete(workId);
  }

  updateTransform(pw: PlacedWork): void {
    const entry = this.entry;
    if (!entry) return;
    const { position, quaternion } = placementTransform(pw.placement, entry.planet.height, entry.planet.sea);
    pw.root.position.copy(position);
    pw.root.quaternion.copy(quaternion);
    pw.scaler.scale.setScalar(pw.placement.scale);
  }

  refreshAll(): void {
    for (const pw of this.placed.values()) this.updateTransform(pw);
  }

  pick(clientX: number, clientY: number): PlacedWork | null {
    const proxies = [...this.placed.values()].map((pw) => pw.proxy);
    const hit = this.world.rayFrom(clientX, clientY).intersectObjects(proxies, false)[0];
    return hit ? this.placed.get(hit.object.userData.workId as string) ?? null : null;
  }

  // 作品顶上一点的世界坐标，给悬浮标签和编辑条用
  topOf(pw: PlacedWork): THREE.Vector3 {
    const h = (PLINTH_HEIGHT + (pw.model?.height ?? 1) + 0.4) * pw.placement.scale;
    return pw.root.localToWorld(new THREE.Vector3(0, h, 0));
  }

  setHighlight(target: PlacedWork | null): void {
    for (const pw of this.placed.values()) {
      const m = pw.plinth.material as THREE.MeshStandardNodeMaterial;
      m.emissive.set(pw === target ? (this.team?.color ?? '#d9b77e') : '#000000');
      m.emissiveIntensity = pw === target ? 0.6 : 0;
    }
  }

  private sizeParts(pw: PlacedWork, height: number, footprint: number): void {
    const r = Math.max(0.55, footprint * 0.95);
    pw.plinth.scale.set(r, 1, r);
    const w = Math.max(0.6, footprint * 2);
    pw.proxy.scale.set(w, height, w);
    pw.proxy.position.y = PLINTH_HEIGHT + height / 2;
  }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npx vitest run tests/planetView.test.ts`
Expected: PASS（3 个测试）

- [ ] **Step 6: 写作品卡和星球页交互**

`src/ui/workCard.ts`：

```ts
import type { Team, Work } from '../data/types';
import { el, formatTris } from './dom';

// 右侧作品卡：编号和面数、作品名、作者和团队、简介、去博物馆
export class WorkCard {
  private readonly node = el('aside', { className: 'work-card' });
  private readonly onMuseum: (workId: string) => void;

  constructor(root: HTMLElement, onMuseum: (workId: string) => void) {
    this.onMuseum = onMuseum;
    this.node.hidden = true;
    root.append(this.node);
  }

  show(work: Work, team: Team, failed: boolean): void {
    const author = team.members.find((m) => m.id === work.authorId);
    const index = team.works.findIndex((w) => w.id === work.id) + 1; // 0 = 临时作品
    const children: Node[] = [
      el('button', { className: 'wc-close', textContent: '×', ariaLabel: 'Close', onclick: () => this.hide() }),
      el('div', { className: 'mono', textContent: index > 0 ? `No. ${String(index).padStart(3, '0')} · ${formatTris(work.tris)}` : 'Temporary · not saved' }),
      el('h2', { className: 'display', textContent: work.title }),
      el('div', { className: 'wc-by', textContent: `by @${author?.handle ?? 'unknown'} · ${team.name}` }),
    ];
    if (failed) children.push(el('div', { className: 'wc-warn', textContent: 'Model failed to load' }));
    if (work.description) children.push(el('p', { className: 'wc-desc', textContent: work.description }));
    if (index > 0) children.push(el('button', { className: 'primary', textContent: 'View in Museum →', onclick: () => this.onMuseum(work.id) }));
    this.node.replaceChildren(...children);
    this.node.hidden = false;
  }

  hide(): void {
    this.node.hidden = true;
  }
}
```

`src/ui/planetScreen.ts`：

```ts
import type { PlanetLayer } from '../app';
import type { Team } from '../data/types';
import { PlanetView, type PlacedWork } from '../scenes/planetView';
import type { World } from '../scenes/world';
import { el } from './dom';
import { WorkCard } from './workCard';

// 星球页（非编辑状态）：悬停作品显示名字，点击弹出作品卡；建设中的星球显示提示
export class PlanetScreen implements PlanetLayer {
  readonly view: PlanetView;
  readonly card: WorkCard;
  private readonly world: World;
  private readonly label = el('div', { className: 'float-label' });
  private readonly note = el('div', { className: 'center-note' });
  private hovered: PlacedWork | null = null;
  private down: { x: number; y: number } | null = null;
  private active = false;
  private interactive = true;

  constructor(world: World, root: HTMLElement, onMuseum: (teamId: string, workId: string) => void) {
    this.world = world;
    this.view = new PlanetView(world);
    this.card = new WorkCard(root, (workId) => { if (this.view.team) onMuseum(this.view.team.id, workId); });
    this.label.hidden = true;
    this.note.hidden = true;
    root.append(this.label, this.note);
    const canvas = world.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => {
      if (this.active && this.interactive && !world.rig.flying) this.setHovered(this.view.pick(e.clientX, e.clientY));
    });
    canvas.addEventListener('pointerdown', (e) => { this.down = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    world.frameHooks.add(() => this.placeLabel());
  }

  async enter(team: Team): Promise<void> {
    this.active = true;
    if (team.status === 'under-construction') {
      this.note.replaceChildren(
        el('div', { className: 'display', textContent: `${team.name} is still building` }),
        el('div', { className: 'mono', textContent: `${team.members.length} members · founded ${team.foundedDaysAgo} days ago` }),
      );
      this.note.hidden = false;
    }
    await this.view.enter(team);
  }

  leave(): void {
    this.active = false;
    this.setHovered(null);
    this.card.hide();
    this.note.hidden = true;
    this.view.leave();
  }

  // 编辑模式下关掉悬停和作品卡
  setInteractive(on: boolean): void {
    this.interactive = on;
    if (!on) {
      this.setHovered(null);
      this.card.hide();
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.down;
    this.down = null;
    if (!this.active || !this.interactive || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    const pw = this.view.pick(e.clientX, e.clientY);
    if (pw && this.view.team) this.card.show(pw.work, this.view.team, pw.model?.failed ?? false);
    else this.card.hide();
  }

  private setHovered(pw: PlacedWork | null): void {
    if (pw === this.hovered) return;
    this.hovered = pw;
    this.view.setHighlight(pw);
    this.world.renderer.domElement.style.cursor = pw ? 'pointer' : '';
    this.label.hidden = !pw;
    if (pw) this.label.replaceChildren(el('span', { className: 'display', textContent: pw.work.title }));
  }

  private placeLabel(): void {
    if (!this.hovered) return;
    const at = this.world.toScreen(this.view.topOf(this.hovered));
    this.label.hidden = !at;
    if (at) this.label.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -100%)`;
  }
}
```

- [ ] **Step 7: 在入口装上星球页**

`src/main.ts`：在 `import { World } from './scenes/world';` 下面加一行：

```ts
import { PlanetScreen } from './ui/planetScreen';
```

把最后两行：

```ts
const app = new App(world, document.querySelector<HTMLDivElement>('#app')!, store, seed.you, await store.listTeams());
await app.start();
```

替换为：

```ts
const app = new App(world, document.querySelector<HTMLDivElement>('#app')!, store, seed.you, await store.listTeams());
const planetScreen = new PlanetScreen(world, app.root, (teamId, workId) => app.navigate({ view: 'museum', teamId, workId }));
app.planetLayer = planetScreen;
await app.start();
```

在 `src/ui/styles.css` 末尾追加：

```css
/* 作品卡 */
#app > .work-card { position: absolute; top: 96px; right: 24px; width: 300px; padding: 22px 22px 20px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); backdrop-filter: blur(8px); animation: fade-in 0.18s ease-out; }
.work-card h2 { margin: 6px 0 4px; font-size: 30px; line-height: 1.05; }
.wc-by { color: var(--ink-dim); margin-bottom: 14px; }
.wc-desc { color: var(--ink-dim); margin: 0 0 16px; }
.wc-warn { color: var(--danger); margin-bottom: 12px; }
.wc-close { position: absolute; top: 10px; right: 10px; border: none; font-size: 20px; padding: 2px 8px; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

/* 建设中提示 */
#app > .center-note { position: absolute; left: 50%; bottom: 14%; transform: translateX(-50%); text-align: center; pointer-events: none; }
.center-note .display { font-size: 30px; }
```

- [ ] **Step 8: 截图检查**

Run: `node scripts/shot.mjs "index.html#/t/lumen-guild" shots/planet.png`
Expected: `页面无报错`；Lumen Guild 星球上有 4 件占位作品，各自立在黄铜色展台上，排成一圈面向镜头，都直立在地表上（没有陷进地里或浮在空中）

Run: `node scripts/shot.mjs "index.html#/t/paper-moon-co" shots/uc.png`
Expected: `页面无报错`；星球上没有作品，下方显示「Paper Moon Co. is still building」和「2 members · founded 4 days ago」

- [ ] **Step 9: 全部测试 + 类型检查，然后提交**

Run: `npm test`，然后 `npm run typecheck`
Expected: 全部 PASS；0 退出

```bash
git add src/assets/placeholder.ts src/assets/models.ts src/scenes/planetView.ts src/ui/workCard.ts src/ui/planetScreen.ts src/main.ts src/ui/styles.css tests/planetView.test.ts
git commit -m "feat: 星球页：作品上星球、悬停标签、作品卡、建设中提示" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

到这里是周二的进度：把 `shots/galaxy.png`、`shots/planet.png`、`shots/uc.png` 发给用户确认视觉方向。

---

### Task 10: Members 页

**Files:**
- Create: `src/ui/membersPage.ts`
- Modify: `src/main.ts`, `src/ui/styles.css`（末尾追加）

**Interfaces:**
- Consumes: `Sheet`、`App.closeSheet()`、`App.currentTeam`、`App.navigate()`（Task 8）；`el`、`initials`（Task 8）；`thumbUrl`（Task 9）
- Produces: `class MembersPage implements Sheet { constructor(root, youId: string, onClose: () => void, onWork: (workId: string) => void); open(team: Team): void; close(): void }`；样式类 `.sheet`、`.sheet-panel`、`.sheet-head`、`.sheet-close`、`.tag`（Task 11 复用）

- [ ] **Step 1: 实现 Members 页**

`src/ui/membersPage.ts`：

```ts
import type { Sheet } from '../app';
import { thumbUrl } from '../assets/models';
import type { Member, Team } from '../data/types';
import { el, initials } from './dom';

// Members：盖在星球上的面板，每个成员一行：头像、名字、角色、作品缩略图
export class MembersPage implements Sheet {
  private readonly node = el('section', { className: 'sheet members' });
  private readonly youId: string;
  private readonly onClose: () => void;
  private readonly onWork: (workId: string) => void;
  private readonly onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.onClose(); };

  constructor(root: HTMLElement, youId: string, onClose: () => void, onWork: (workId: string) => void) {
    this.youId = youId;
    this.onClose = onClose;
    this.onWork = onWork;
    this.node.hidden = true;
    this.node.addEventListener('click', (e) => { if (e.target === this.node) this.onClose(); }); // 点背景关闭
    root.append(this.node);
  }

  open(team: Team): void {
    this.node.replaceChildren(el('div', { className: 'sheet-panel' },
      el('header', { className: 'sheet-head' },
        el('div', {},
          el('div', { className: 'mono', textContent: `${team.members.length} members · founded ${team.foundedDaysAgo} days ago` }),
          el('h1', { className: 'display', textContent: `${team.name} — Members` }),
        ),
        el('button', { className: 'sheet-close', textContent: 'Close', onclick: () => this.onClose() }),
      ),
      el('ul', { className: 'member-list' }, ...team.members.map((m) => this.row(team, m))),
    ));
    if (this.node.hidden) addEventListener('keydown', this.onKey);
    this.node.hidden = false;
  }

  close(): void {
    if (this.node.hidden) return;
    this.node.hidden = true;
    removeEventListener('keydown', this.onKey);
  }

  private row(team: Team, m: Member): HTMLLIElement {
    const works = team.works.filter((w) => w.authorId === m.id);
    const avatar = el('div', { className: 'avatar', textContent: initials(m.displayName) });
    avatar.style.background = team.color;
    const tags = [el('span', { className: `tag ${m.role}`, textContent: m.role === 'captain' ? 'Captain' : 'Builder' })];
    if (m.id === this.youId) tags.push(el('span', { className: 'tag you', textContent: 'You' }));
    return el('li', { className: 'member' },
      avatar,
      el('div', { className: 'member-main' },
        el('div', { className: 'member-name' }, el('span', { className: 'display', textContent: m.displayName }), ...tags),
        el('div', { className: 'mono', textContent: `@${m.handle} · ${works.length} ${works.length === 1 ? 'work' : 'works'}` }),
      ),
      el('div', { className: 'member-works' }, ...works.map((w) => {
        const b = el('button', { className: 'thumb', title: w.title, onclick: () => this.onWork(w.id) });
        if (w.thumb) b.append(el('img', { src: thumbUrl(w.thumb), alt: w.title, loading: 'lazy' }));
        else {
          b.textContent = initials(w.title);
          b.style.background = team.color;
        }
        return b;
      })),
    );
  }
}
```

- [ ] **Step 2: 装进入口**

`src/main.ts`：在 `import { PlanetScreen } from './ui/planetScreen';` 下面加一行：

```ts
import { MembersPage } from './ui/membersPage';
```

在 `app.planetLayer = planetScreen;` 下面加：

```ts
app.members = new MembersPage(app.root, seed.you.memberId, () => app.closeSheet(), (workId) => {
  const team = app.currentTeam;
  if (team) app.navigate({ view: 'museum', teamId: team.id, workId });
});
```

在 `src/ui/styles.css` 末尾追加：

```css
/* 覆盖整屏的页面（Members、Museum）：背景压暗，中间一块面板 */
#app > .sheet { position: absolute; inset: 0; background: rgba(5, 6, 10, 0.72); backdrop-filter: blur(3px); overflow-y: auto; padding: 88px 24px 48px; animation: fade-in 0.22s ease-out; }
.sheet-panel { max-width: 860px; margin: 0 auto; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 28px 32px 32px; }
.sheet-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 1px solid var(--line); padding-bottom: 18px; margin-bottom: 8px; }
.sheet-head h1 { margin: 4px 0 0; font-size: 38px; line-height: 1.05; }
.member-list { list-style: none; margin: 0; padding: 0; }
.member { display: grid; grid-template-columns: 52px 1fr auto; align-items: center; gap: 16px; padding: 16px 0; border-bottom: 1px solid var(--line); }
.avatar { width: 52px; height: 52px; border-radius: 50%; display: grid; place-items: center; font: 500 17px var(--font-ui); color: #15120c; }
.member-name { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.member-name .display { font-size: 22px; }
.tag { font: 500 10.5px/1 var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; padding: 4px 6px; border: 1px solid var(--line); border-radius: 2px; color: var(--ink-dim); }
.tag.captain { color: var(--accent); border-color: rgba(217, 183, 126, 0.45); }
.tag.you { color: #15120c; background: var(--accent); border-color: var(--accent); }
.member-works { display: flex; gap: 8px; }
.thumb { width: 56px; height: 56px; padding: 0; overflow: hidden; display: grid; place-items: center; font: 500 13px var(--font-ui); color: #15120c; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
@media (max-width: 720px) {
  .sheet-panel { padding: 20px; }
  .member { grid-template-columns: 44px 1fr; }
  .member-works { grid-column: 1 / -1; }
}
```

- [ ] **Step 3: 截图检查**

Run: `node scripts/shot.mjs "index.html#/t/lumen-guild/members" shots/members.png`
Expected: `页面无报错`；面板标题「Lumen Guild — Members」，上方一行「6 members · founded 41 days ago」；6 行成员：hexa_ines（Captain）、polyfox、mia_makes（2 works）、kenji_polys、liam_lowpoly、orbit_ollie（带 You 标签）；作者行右侧有作品的纯色缩略块

- [ ] **Step 4: 类型检查并提交**

Run: `npm run typecheck`
Expected: 0 退出

```bash
git add src/ui/membersPage.ts src/main.ts src/ui/styles.css
git commit -m "feat: Members 页" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Museum 页（卡片实时预览 + 大图查看器）

**Files:**
- Create: `src/museum/framing.ts`, `src/museum/viewer.ts`, `src/ui/museumPage.ts`
- Modify: `src/main.ts`, `src/ui/styles.css`（末尾追加）
- Test: `tests/framing.test.ts`

**Interfaces:**
- Consumes: `MultiView`（Task 2）；`ModelLibrary`、`thumbUrl`（Task 9）；`addStudioLights`（Task 7）；`World.paused`（Task 8）；`Sheet`、`App.closeSheet()`、`App.currentTeam`（Task 8）；`.sheet*` 样式（Task 10）
- Produces:
  - `frameModel(camera: THREE.PerspectiveCamera, height: number): void`
  - `class Viewer { isOpen: boolean; constructor(root, onClose: () => void, onToggle: (open: boolean) => void); open(work, team): Promise<void>; close(): void }`
  - `LIVE_CARD_PREVIEWS: boolean`；`class MuseumPage implements Sheet { constructor(root, world, onClose: () => void, onSelect: (workId: string | null) => void); open(team, route): Promise<void>; close(): void }`

- [ ] **Step 1: 写失败的测试**

`tests/framing.test.ts`：

```ts
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { frameModel } from '../src/museum/framing';

describe('frameModel', () => {
  it('最坏情况（最长边 2 的立方体，2×2×2）完整落在方形画面里', () => {
    const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
    frameModel(camera, 2);
    camera.updateMatrixWorld();
    for (const x of [-1, 1]) {
      for (const y of [0, 2]) {
        for (const z of [-1, 1]) {
          const p = new THREE.Vector3(x, y, z).project(camera);
          expect(Math.abs(p.x)).toBeLessThan(0.95);
          expect(Math.abs(p.y)).toBeLessThan(0.95);
        }
      }
    }
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/framing.test.ts`
Expected: FAIL，找不到 `../src/museum/framing`

- [ ] **Step 3: 实现取景**

`src/museum/framing.ts`：

```ts
import * as THREE from 'three/webgpu';

// 归一化后的模型（最长边 2.0，包围球半径不超过 √3 ≈ 1.73）完整出现在画面里：斜上方 3/4 视角
export function frameModel(camera: THREE.PerspectiveCamera, height: number): void {
  const dist = 1.75 / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.position.set(dist * 0.55, height * 0.5 + dist * 0.28, dist * 0.8);
  camera.lookAt(0, height * 0.5, 0);
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/framing.test.ts`
Expected: PASS（1 个测试）

- [ ] **Step 5: 实现大图查看器**

`src/museum/viewer.ts`：

```ts
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ModelLibrary } from '../assets/models';
import type { Team, Work } from '../data/types';
import { addStudioLights } from '../scenes/lights';
import { el, formatTris } from '../ui/dom';
import { frameModel } from './framing';

// 大图查看器：独立的 canvas 和渲染器（不依赖分区渲染），拖动 360° 旋转、滚轮缩放
export class Viewer {
  isOpen = false;
  private readonly node = el('div', { className: 'viewer' });
  private readonly canvas = el('canvas');
  private readonly info = el('div', { className: 'viewer-info' });
  private readonly library = new ModelLibrary();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
  private readonly size = new THREE.Vector2();
  private rendererReady: Promise<THREE.WebGPURenderer> | null = null;
  private controls: OrbitControls | null = null;
  private current: THREE.Object3D | null = null;
  private readonly onClose: () => void;
  private readonly onToggle: (open: boolean) => void;
  private readonly onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.onClose(); };

  constructor(root: HTMLElement, onClose: () => void, onToggle: (open: boolean) => void) {
    this.onClose = onClose;
    this.onToggle = onToggle;
    this.scene.background = new THREE.Color('#14151c');
    addStudioLights(this.scene);
    this.node.append(
      el('div', { className: 'viewer-stage' }, this.canvas),
      this.info,
      el('button', { className: 'viewer-close', textContent: '×', ariaLabel: 'Close', onclick: () => this.onClose() }),
    );
    this.node.hidden = true;
    root.append(this.node);
  }

  async open(work: Work, team: Team): Promise<void> {
    const author = team.members.find((m) => m.id === work.authorId);
    const index = team.works.findIndex((w) => w.id === work.id) + 1;
    this.info.replaceChildren(
      el('div', { className: 'mono', textContent: `No. ${String(index).padStart(3, '0')} · ${formatTris(work.tris)}` }),
      el('h2', { className: 'display', textContent: work.title }),
      el('div', { className: 'wc-by', textContent: `by @${author?.handle ?? 'unknown'} · ${team.name}` }),
      ...(work.description ? [el('p', { className: 'wc-desc', textContent: work.description })] : []),
      el('div', { className: 'mono hint', textContent: 'Drag to rotate · scroll to zoom · Esc to close' }),
    );
    if (!this.isOpen) {
      this.isOpen = true;
      this.node.hidden = false;
      this.onToggle(true);
      addEventListener('keydown', this.onKey);
    }
    this.rendererReady ??= this.createRenderer();
    const renderer = await this.rendererReady;
    const model = await this.library.load(work);
    if (!this.isOpen) return;
    if (this.current) this.scene.remove(this.current);
    this.current = model.object;
    this.scene.add(model.object);
    frameModel(this.camera, model.height);
    this.controls!.target.set(0, model.height * 0.5, 0);
    this.controls!.update();
    renderer.setAnimationLoop(() => this.frame(renderer));
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.node.hidden = true;
    void this.rendererReady?.then((r) => r.setAnimationLoop(null));
    removeEventListener('keydown', this.onKey);
    this.onToggle(false);
  }

  private async createRenderer(): Promise<THREE.WebGPURenderer> {
    const renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true });
    await renderer.init();
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 14;
    return renderer;
  }

  private frame(renderer: THREE.WebGPURenderer): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    renderer.getSize(this.size);
    if (this.size.x !== w || this.size.y !== h) {
      renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.controls!.update();
    renderer.render(this.scene, this.camera);
  }
}
```

- [ ] **Step 6: 实现 Museum 页**

`src/ui/museumPage.ts`：

```ts
import * as THREE from 'three/webgpu';
import type { Sheet } from '../app';
import { ModelLibrary, thumbUrl } from '../assets/models';
import type { Team, Work } from '../data/types';
import { frameModel } from '../museum/framing';
import { MultiView } from '../museum/multiview';
import { Viewer } from '../museum/viewer';
import type { Route } from '../router';
import { addStudioLights } from '../scenes/lights';
import type { World } from '../scenes/world';
import { el, formatTris } from './dom';
import { toast } from './toast';

// Task 2 的检查不通过时改成 false：卡片改用静态缩略图，查看器不受影响
export const LIVE_CARD_PREVIEWS = true;

interface Card {
  node: HTMLElement;
  preview: HTMLElement;
  work: Work;
}

// Museum：团队作品网格，每张卡片里一个慢慢自转的模型；点开进入大图查看器
export class MuseumPage implements Sheet {
  private readonly node = el('section', { className: 'sheet museum' });
  private readonly canvas = el('canvas', { className: 'museum-canvas' });
  private readonly library = new ModelLibrary(); // 卡片预览的渲染器专用
  private readonly viewer: Viewer;
  private readonly world: World;
  private readonly onClose: () => void;
  private readonly onSelect: (workId: string | null) => void;
  private multiview: MultiView | null = null;
  private teamId: string | null = null;
  private token = 0;
  private readonly onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !this.viewer.isOpen) this.onClose(); };

  constructor(root: HTMLElement, world: World, onClose: () => void, onSelect: (workId: string | null) => void) {
    this.world = world;
    this.onClose = onClose;
    this.onSelect = onSelect;
    this.node.hidden = true;
    this.canvas.hidden = true;
    this.node.addEventListener('click', (e) => { if (e.target === this.node) this.onClose(); });
    // 预览 canvas 在最上层：查看器打开时要藏起来，否则卡片会画到查看器上面
    this.viewer = new Viewer(root, () => this.onSelect(null), (open) => {
      this.canvas.hidden = open || !LIVE_CARD_PREVIEWS || this.teamId === null;
    });
    root.append(this.node, this.canvas);
  }

  async open(team: Team, route: Route): Promise<void> {
    if (this.teamId !== team.id) await this.renderGrid(team);
    const workId = route.view === 'museum' ? route.workId : undefined;
    if (!workId) {
      this.viewer.close();
      return;
    }
    const work = team.works.find((w) => w.id === workId);
    if (work) await this.viewer.open(work, team);
    else {
      toast('That work is not in this museum');
      this.onSelect(null);
    }
  }

  close(): void {
    if (this.teamId === null) return;
    this.token++;
    this.teamId = null;
    this.node.hidden = true;
    this.canvas.hidden = true;
    this.viewer.close();
    this.multiview?.clearViews();
    this.multiview?.renderer.setAnimationLoop(null);
    this.world.paused = false;
    removeEventListener('keydown', this.onKey);
  }

  private async renderGrid(team: Team): Promise<void> {
    const token = ++this.token;
    this.teamId = team.id;
    this.world.paused = true; // 主画面被盖住了，停掉省 GPU
    addEventListener('keydown', this.onKey);
    const cards = team.works.map((w, i) => this.card(team, w, i));
    this.node.replaceChildren(el('div', { className: 'sheet-panel wide' },
      el('header', { className: 'sheet-head' },
        el('div', {},
          el('div', { className: 'mono', textContent: `${team.works.length} works · ${team.name}` }),
          el('h1', { className: 'display', textContent: 'Museum' }),
        ),
        el('button', { className: 'sheet-close', textContent: 'Close', onclick: () => this.onClose() }),
      ),
      cards.length ? el('div', { className: 'museum-grid' }, ...cards.map((c) => c.node)) : el('p', { className: 'empty display', textContent: 'No works yet' }),
    ));
    this.node.hidden = false;
    if (!LIVE_CARD_PREVIEWS || cards.length === 0) return;
    this.multiview ??= await MultiView.create(this.canvas);
    if (token !== this.token) return;
    const mv = this.multiview;
    mv.clearViews();
    this.canvas.hidden = this.viewer.isOpen;
    mv.renderer.setAnimationLoop(() => mv.render(1 / 60));
    await Promise.all(cards.map(async (c) => {
      const model = await this.library.load(c.work);
      if (token !== this.token) return;
      const scene = new THREE.Scene();
      addStudioLights(scene);
      scene.add(model.object);
      const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
      frameModel(camera, model.height);
      c.preview.classList.add('ready');
      mv.add({ element: c.preview, scene, camera, tick: (dt) => { model.object.rotation.y += dt * 0.5; } });
    }));
  }

  private card(team: Team, work: Work, i: number): Card {
    const author = team.members.find((m) => m.id === work.authorId);
    const preview = el('div', { className: 'mc-preview' });
    if (!LIVE_CARD_PREVIEWS) {
      preview.classList.add('ready');
      if (work.thumb) preview.append(el('img', { src: thumbUrl(work.thumb), alt: work.title }));
    }
    const node = el('article', {
      className: 'museum-card',
      tabIndex: 0,
      onclick: () => this.onSelect(work.id),
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') this.onSelect(work.id); },
    },
      preview,
      el('div', { className: 'mc-title display', textContent: work.title }),
      el('div', { className: 'mc-by', textContent: `by @${author?.handle ?? 'unknown'}` }),
      el('div', { className: 'mono', textContent: `No. ${String(i + 1).padStart(3, '0')} · ${formatTris(work.tris)}` }),
    );
    node.setAttribute('role', 'button');
    return { node, preview, work };
  }
}
```

- [ ] **Step 7: 装进入口**

`src/main.ts`：在 `import { MembersPage } from './ui/membersPage';` 下面加一行：

```ts
import { MuseumPage } from './ui/museumPage';
```

在 `app.members = ...` 那一段下面加：

```ts
app.museum = new MuseumPage(app.root, world, () => app.closeSheet(), (workId) => {
  const team = app.currentTeam;
  if (team) app.navigate(workId ? { view: 'museum', teamId: team.id, workId } : { view: 'museum', teamId: team.id });
});
```

在 `src/ui/styles.css` 末尾追加：

```css
/* Museum */
.sheet-panel.wide { max-width: 1180px; }
.museum-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 18px; margin-top: 18px; }
.museum-card { cursor: pointer; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 12px 14px; transition: border-color 0.15s; }
.museum-card:hover, .museum-card:focus-visible { border-color: var(--accent); outline: none; }
.mc-preview { position: relative; aspect-ratio: 1; border-radius: 2px; background: radial-gradient(circle at 50% 40%, #1d1f29, #101118); margin-bottom: 12px; overflow: hidden; }
.mc-preview:not(.ready)::after { content: 'Loading'; position: absolute; inset: 0; display: grid; place-items: center; font: 11px var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-faint); }
.mc-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mc-title { font-size: 22px; line-height: 1.1; }
.mc-by { color: var(--ink-dim); margin: 2px 0 6px; }
.empty { font-size: 26px; color: var(--ink-dim); text-align: center; padding: 48px 0; }

/* 卡片预览共用的 canvas：盖在最上层，但不接收鼠标 */
#app > .museum-canvas { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 5; }

/* 大图查看器 */
#app > .viewer { position: fixed; inset: 0; z-index: 10; display: grid; grid-template-columns: 1fr 340px; grid-template-rows: 100%; background: rgba(5, 6, 10, 0.94); }
.viewer-stage { min-height: 0; }
.viewer-stage canvas { width: 100%; height: 100%; display: block; cursor: grab; }
.viewer-info { padding: 96px 28px 28px; border-left: 1px solid var(--line); background: var(--panel-solid); overflow-y: auto; }
.viewer-info h2 { font-size: 40px; line-height: 1.05; margin: 8px 0 6px; }
.viewer-info .hint { margin-top: 28px; color: var(--ink-faint); }
.viewer-close { position: absolute; top: 16px; right: 16px; font-size: 22px; padding: 4px 12px; }
@media (max-width: 820px) { #app > .viewer { grid-template-columns: 1fr; grid-template-rows: 60vh auto; } }
```

- [ ] **Step 8: 截图检查**

先在 `src/data/seed.json` 里查 Lumen Guild 的第一件作品 id（占位数据时是 `ph-01`），下面用 `<workId>` 代替。

Run: `node scripts/shot.mjs "index.html#/t/lumen-guild/museum" shots/museum.png --wait 2000`
Expected: `页面无报错`；标题「Museum」，4 张卡片，每张卡片里有一个正在转的占位模型，完整地出现在卡片里（没被裁掉）；卡片下方有作品名、作者和「No. 001 · 12,840 tris」这样的编号行

Run: `node scripts/shot.mjs "index.html#/t/lumen-guild/museum/<workId>" shots/viewer.png --wait 2000`
Expected: `页面无报错`；左边是大图模型，右边是作品信息和「Drag to rotate · scroll to zoom · Esc to close」；卡片预览没有画到查看器上面

- [ ] **Step 9: 全部测试 + 类型检查，然后提交**

Run: `npm test`，然后 `npm run typecheck`
Expected: 全部 PASS；0 退出

```bash
git add src/museum/framing.ts src/museum/viewer.ts src/ui/museumPage.ts src/main.ts src/ui/styles.css tests/framing.test.ts
git commit -m "feat: Museum 页：卡片实时预览与大图查看器" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: 编辑模式

**Files:**
- Create: `src/ui/editPanel.ts`, `src/editor/editor.ts`, `src/debug.ts`, `scripts/check-editor.mjs`
- Modify: `src/env.d.ts`, `src/main.ts`, `src/ui/styles.css`（末尾追加）

**Interfaces:**
- Consumes: `App`（`root`、`world`、`store`、`you`、`topbar.setEditing`、`replaceTeam`、`onEdit`，Task 8）；`PlanetScreen`（`view`、`setInteractive`，Task 9）；`PlanetView`（`team`、`placed`、`extraWorks`、`planet`、`library`、`place`、`remove`、`updateTransform`、`refreshAll`、`pick`、`topOf`、`setHighlight`，Task 9）；`clampScale`、`faceYaw`、`placementTransform`、`PLINTH_HEIGHT`、`YAW_STEP`（Task 4）；`PRESETS`、`PRESET_IDS`（Task 3）
- Produces:
  - `interface EditPanelActions { pick(work); rotate(deg); scale(value); remove(); appearance(patch); reroll(); reset() }`；`class EditPanel { constructor(root, actions); show(planet); hide(); setTray(works, placed: Set<string>, placingId: string | null); showBar(pw | null); moveBar(at: { x; y } | null); syncAppearance(planet) }`；作品栏结构 `.tray > .tray-head + .tray-row > .tray-items`
  - `class Editor { constructor(app, screen); active: boolean; toggle(); activate(); deactivate() }`（Task 13 会再加 `addTempWork`）
  - `interface DebugHooks { planetScreenPos(teamId); workScreenPos(workId); placedIds(); teamPlanet(teamId) }`；`installDebugHooks(app, screen)`；`window.__app`

- [ ] **Step 1: 写编辑界面**

`src/ui/editPanel.ts`：

```ts
import { thumbUrl } from '../assets/models';
import type { PlanetRecipe, PresetId, Work } from '../data/types';
import { PRESET_IDS, PRESETS } from '../planet/presets';
import type { PlacedWork } from '../scenes/planetView';
import { el, initials } from './dom';

export interface EditPanelActions {
  pick(work: Work): void; // 点作品栏里的作品
  rotate(deg: number): void; // 旋转滑块：绝对角度
  scale(value: number): void;
  remove(): void;
  appearance(patch: Partial<Pick<PlanetRecipe, 'preset' | 'ring' | 'atmosphere'>>): void;
  reroll(): void;
  reset(): void;
}

// 编辑模式的界面：底部作品栏、跟着选中作品走的编辑条、左侧星球外观面板
export class EditPanel {
  private readonly act: EditPanelActions;
  private readonly tray = el('section', { className: 'tray' });
  private readonly trayRow = el('div', { className: 'tray-row' });
  private readonly trayItems = el('div', { className: 'tray-items' });
  private readonly bar = el('div', { className: 'edit-bar' });
  private readonly barTitle = el('div', { className: 'display eb-title' });
  private readonly rotateInput = el('input', { type: 'range', min: '-180', max: '180', step: '1' });
  private readonly scaleInput = el('input', { type: 'range', min: '0.5', max: '2', step: '0.05' });
  private readonly planetPanel = el('aside', { className: 'planet-panel' });
  private readonly presetButtons = new Map<PresetId, HTMLButtonElement>();
  private readonly ringButton: HTMLButtonElement;
  private readonly atmoButton: HTMLButtonElement;
  private current: PlanetRecipe | null = null;

  constructor(root: HTMLElement, act: EditPanelActions) {
    this.act = act;
    this.trayRow.append(this.trayItems);
    this.tray.append(el('div', { className: 'mono tray-head', textContent: "Your team's works · pick one, then click the planet" }), this.trayRow);
    this.rotateInput.addEventListener('input', () => act.rotate(Number(this.rotateInput.value)));
    this.scaleInput.addEventListener('input', () => act.scale(Number(this.scaleInput.value)));
    this.bar.append(
      this.barTitle,
      el('label', { className: 'mono' }, 'Rotate', this.rotateInput),
      el('label', { className: 'mono' }, 'Scale', this.scaleInput),
      el('button', { className: 'danger', textContent: 'Delete', onclick: () => act.remove() }),
      el('div', { className: 'mono eb-hint', textContent: 'Drag to move · Q / E to turn · Del to remove' }),
    );
    for (const id of PRESET_IDS) {
      const b = el('button', { textContent: PRESETS[id].label, onclick: () => act.appearance({ preset: id }) });
      b.style.setProperty('--swatch', PRESETS[id].bands[1][1]);
      this.presetButtons.set(id, b);
    }
    this.ringButton = el('button', { textContent: 'Ring', onclick: () => { if (this.current) act.appearance({ ring: !this.current.ring }); } });
    this.atmoButton = el('button', { textContent: 'Atmosphere', onclick: () => { if (this.current) act.appearance({ atmosphere: !this.current.atmosphere }); } });
    this.planetPanel.append(
      el('div', { className: 'mono', textContent: 'Planet' }),
      el('div', { className: 'pp-presets' }, ...this.presetButtons.values()),
      el('div', { className: 'pp-toggles' }, this.ringButton, this.atmoButton),
      el('button', { textContent: 'Reroll terrain', onclick: () => act.reroll() }),
      el('hr'),
      el('button', { className: 'danger', textContent: 'Reset demo', onclick: () => act.reset() }),
    );
    this.tray.hidden = true;
    this.bar.hidden = true;
    this.planetPanel.hidden = true;
    root.append(this.tray, this.bar, this.planetPanel);
  }

  show(planet: PlanetRecipe): void {
    this.tray.hidden = false;
    this.planetPanel.hidden = false;
    this.syncAppearance(planet);
  }

  hide(): void {
    this.tray.hidden = true;
    this.bar.hidden = true;
    this.planetPanel.hidden = true;
  }

  setTray(works: Work[], placed: Set<string>, placingId: string | null): void {
    this.trayItems.replaceChildren(...works.map((w) => {
      const b = el('button', { className: 'tray-item', title: w.title, onclick: () => this.act.pick(w) });
      if (w.thumb) b.append(el('img', { src: thumbUrl(w.thumb), alt: '' }));
      else b.append(el('span', { className: 'ti-initials', textContent: initials(w.title) }));
      b.append(el('span', { className: 'ti-name', textContent: w.title }));
      if (placed.has(w.id)) b.append(el('span', { className: 'ti-check', textContent: '✓' }));
      if (w.id.startsWith('tmp-')) b.append(el('span', { className: 'ti-temp mono', textContent: 'temp' }));
      b.setAttribute('aria-pressed', String(w.id === placingId));
      return b;
    }));
  }

  showBar(pw: PlacedWork | null): void {
    this.bar.hidden = !pw;
    if (!pw) return;
    this.barTitle.textContent = pw.work.title;
    this.rotateInput.value = String(Math.round((pw.placement.yaw * 180) / Math.PI));
    this.scaleInput.value = String(pw.placement.scale);
  }

  // 编辑条贴在选中作品的上方；作品转到背面时隐藏
  moveBar(at: { x: number; y: number } | null): void {
    if (this.bar.hidden) return;
    this.bar.style.visibility = at ? 'visible' : 'hidden';
    if (at) this.bar.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, calc(-100% - 12px))`;
  }

  syncAppearance(planet: PlanetRecipe): void {
    this.current = planet;
    for (const [id, b] of this.presetButtons) b.setAttribute('aria-pressed', String(id === planet.preset));
    this.ringButton.setAttribute('aria-pressed', String(planet.ring));
    this.atmoButton.setAttribute('aria-pressed', String(planet.atmosphere));
  }
}
```

- [ ] **Step 2: 写编辑器**

`src/editor/editor.ts`：

```ts
import * as THREE from 'three/webgpu';
import type { App } from '../app';
import type { Placement, PlanetRecipe, Team, Work } from '../data/types';
import { clampScale, faceYaw, PLINTH_HEIGHT, placementTransform, YAW_STEP } from '../planet/placement';
import type { PlacedWork, PlanetView } from '../scenes/planetView';
import { EditPanel } from '../ui/editPanel';
import type { PlanetScreen } from '../ui/planetScreen';

const ghostMaterial = new THREE.MeshBasicNodeMaterial({ color: '#d9b77e', transparent: true, opacity: 0.45, depthWrite: false });

// 编辑模式：摆放、拖动、旋转、缩放、删除作品，改星球外观；每次修改都自动保存
export class Editor {
  active = false;
  private readonly app: App;
  private readonly screen: PlanetScreen;
  private readonly panel: EditPanel;
  private placing: Work | null = null;
  private ghost: THREE.Group | null = null;
  private selected: PlacedWork | null = null;
  private dragging = false;

  constructor(app: App, screen: PlanetScreen) {
    this.app = app;
    this.screen = screen;
    this.panel = new EditPanel(app.root, {
      pick: (w) => void this.pickFromTray(w),
      rotate: (deg) => this.withSelected((pw) => { pw.placement.yaw = THREE.MathUtils.degToRad(deg); }),
      scale: (v) => this.withSelected((pw) => { pw.placement.scale = clampScale(v); }),
      remove: () => this.removeSelected(),
      appearance: (patch) => this.setAppearance(patch),
      reroll: () => this.setAppearance({ seed: Math.floor(Math.random() * 1e9) }),
      reset: () => void this.resetDemo(),
    });
    const canvas = app.world.renderer.domElement;
    // 捕获阶段：赶在 OrbitControls 之前处理，点中作品时不让镜头跟着转
    canvas.addEventListener('pointerdown', (e) => this.onDown(e), { capture: true });
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    addEventListener('pointerup', () => this.onUp());
    addEventListener('keydown', (e) => this.onKey(e));
    app.world.frameHooks.add(() => this.placeBar());
  }

  private get view(): PlanetView {
    return this.screen.view;
  }

  toggle(): void {
    if (this.active) this.deactivate();
    else this.activate();
  }

  activate(): void {
    const team = this.view.team;
    if (this.active || !team || team.id !== this.app.you.teamId) return;
    this.active = true;
    this.screen.setInteractive(false);
    this.app.topbar.setEditing(true);
    this.panel.show(team.planet);
    this.refreshTray();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.cancelPlacing();
    this.select(null);
    this.panel.hide();
    this.screen.setInteractive(true);
    this.app.topbar.setEditing(false);
  }

  // —— 作品栏 ——

  private allWorks(): Work[] {
    return [...(this.view.team?.works ?? []), ...this.view.extraWorks.values()];
  }

  private refreshTray(): void {
    this.panel.setTray(this.allWorks(), new Set(this.view.placed.keys()), this.placing?.id ?? null);
  }

  private async pickFromTray(work: Work): Promise<void> {
    const pw = this.view.placed.get(work.id);
    if (pw) {
      // 已经摆上去了：选中它，镜头转过去
      this.cancelPlacing();
      this.select(pw);
      const entry = this.view.planet;
      if (entry) {
        const dir = new THREE.Vector3(...pw.placement.dir).normalize();
        await this.app.world.rig.fly({ target: entry.home.clone(), position: entry.home.clone().addScaledVector(dir, 30), minDistance: 15, maxDistance: 70, autoRotate: false }, 0.8);
      }
      return;
    }
    this.select(null);
    this.cancelPlacing();
    this.placing = work;
    this.refreshTray();
    const model = await this.view.library.load(work);
    if (this.placing !== work) return;
    model.object.position.y = PLINTH_HEIGHT;
    model.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.material = ghostMaterial;
    });
    const ghost = new THREE.Group();
    ghost.add(model.object);
    ghost.visible = false;
    this.view.planet?.planet.works.add(ghost);
    this.ghost = ghost;
  }

  private cancelPlacing(): void {
    this.ghost?.removeFromParent();
    this.ghost = null;
    this.placing = null;
    if (this.active) this.refreshTray();
  }

  // —— 指针和键盘 ——

  // 鼠标下的地表方向（星球本地坐标的单位向量）；没打中星球返回 null
  private surfaceDir(e: PointerEvent): [number, number, number] | null {
    const entry = this.view.planet;
    if (!entry) return null;
    const hit = this.app.world.rayFrom(e.clientX, e.clientY).intersectObject(entry.planet.terrain, false)[0];
    if (!hit) return null;
    const v = entry.planet.group.worldToLocal(hit.point.clone()).normalize();
    return [v.x, v.y, v.z];
  }

  private towardCamera(): [number, number, number] {
    const entry = this.view.planet;
    if (!entry) return [0, 1, 0];
    const v = this.app.world.rig.camera.position.clone().sub(entry.home).normalize();
    return [v.x, v.y, v.z];
  }

  private onDown(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return;
    if (this.placing) {
      const dir = this.surfaceDir(e);
      if (!dir) return;
      e.stopImmediatePropagation();
      void this.commitPlacement(this.placing, dir);
      return;
    }
    const pw = this.view.pick(e.clientX, e.clientY);
    this.select(pw);
    if (!pw) return;
    e.stopImmediatePropagation();
    this.dragging = true;
    this.app.world.renderer.domElement.style.cursor = 'grabbing';
  }

  private onMove(e: PointerEvent): void {
    if (!this.active) return;
    if (this.dragging && this.selected) {
      const dir = this.surfaceDir(e);
      if (dir) {
        this.selected.placement.dir = dir;
        this.view.updateTransform(this.selected);
      }
      return;
    }
    const entry = this.view.planet;
    if (!this.placing || !this.ghost || !entry) return;
    const dir = this.surfaceDir(e);
    this.ghost.visible = dir !== null;
    if (!dir) return;
    const { position, quaternion } = placementTransform({ workId: '', dir, yaw: faceYaw(dir, this.towardCamera()), scale: 1 }, entry.planet.height, entry.planet.sea);
    this.ghost.position.copy(position);
    this.ghost.quaternion.copy(quaternion);
  }

  private onUp(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.app.world.renderer.domElement.style.cursor = '';
    this.save();
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active || (e.target as HTMLElement | null)?.closest?.('input, textarea')) return;
    if (e.key === 'q' || e.key === 'Q') this.withSelected((pw) => { pw.placement.yaw -= YAW_STEP; });
    else if (e.key === 'e' || e.key === 'E') this.withSelected((pw) => { pw.placement.yaw += YAW_STEP; });
    else if (e.key === 'Delete' || e.key === 'Backspace') this.removeSelected();
    else if (e.key === 'Escape') {
      if (this.placing) this.cancelPlacing();
      else this.select(null);
    }
  }

  // —— 修改 ——

  private async commitPlacement(work: Work, dir: [number, number, number]): Promise<void> {
    const placement: Placement = { workId: work.id, dir, yaw: faceYaw(dir, this.towardCamera()), scale: 1 };
    this.cancelPlacing();
    const pw = await this.view.place(placement);
    this.refreshTray();
    if (!pw) return;
    this.select(pw);
    this.save();
  }

  private select(pw: PlacedWork | null): void {
    this.selected = pw;
    this.view.setHighlight(pw);
    this.panel.showBar(pw);
  }

  private withSelected(change: (pw: PlacedWork) => void): void {
    const pw = this.selected;
    if (!pw) return;
    change(pw);
    pw.placement.yaw = Math.atan2(Math.sin(pw.placement.yaw), Math.cos(pw.placement.yaw)); // 收回 (-π, π]
    this.view.updateTransform(pw);
    this.panel.showBar(pw);
    this.save();
  }

  private removeSelected(): void {
    const pw = this.selected;
    if (!pw) return;
    this.select(null);
    this.view.remove(pw.work.id);
    this.refreshTray();
    this.save();
  }

  private setAppearance(patch: Partial<Pick<PlanetRecipe, 'seed' | 'preset' | 'ring' | 'atmosphere'>>): void {
    const team = this.view.team;
    if (!team) return;
    const next: Team = { ...team, planet: { ...team.planet, ...patch, placements: this.savedPlacements() } };
    this.commit(next);
    this.view.refreshAll(); // 地形变了，作品重新贴地
    this.panel.syncAppearance(next.planet);
  }

  // 只保存正式作品的摆放；拖进来的临时作品（tmp- 开头）不进存档
  private savedPlacements(): Placement[] {
    return [...this.view.placed.values()].map((pw) => structuredClone(pw.placement)).filter((p) => !p.workId.startsWith('tmp-'));
  }

  private save(): void {
    const team = this.view.team;
    if (team) this.commit({ ...team, planet: { ...team.planet, placements: this.savedPlacements() } });
  }

  private commit(team: Team): void {
    this.view.team = team;
    this.app.replaceTeam(team);
    void this.app.store.savePlanet(team.id, team.planet);
  }

  private async resetDemo(): Promise<void> {
    if (!confirm('Reset the demo? All local changes will be lost.')) return;
    await this.app.store.reset();
    location.reload();
  }

  private placeBar(): void {
    if (this.active && this.selected) this.panel.moveBar(this.app.world.toScreen(this.view.topOf(this.selected)));
  }
}
```

- [ ] **Step 3: 写调试钩子**

`src/debug.ts`：

```ts
import * as THREE from 'three/webgpu';
import type { App } from './app';
import type { PlanetRecipe } from './data/types';
import { PLINTH_HEIGHT } from './planet/placement';
import type { PlanetScreen } from './ui/planetScreen';

// 给 Playwright 脚本用：把 3D 物体换算成屏幕坐标，脚本才「点」得到它们
export interface DebugHooks {
  planetScreenPos(teamId: string): { x: number; y: number } | null;
  workScreenPos(workId: string): { x: number; y: number } | null;
  placedIds(): string[];
  teamPlanet(teamId: string): PlanetRecipe | null;
}

export function installDebugHooks(app: App, screen: PlanetScreen): void {
  window.__app = {
    planetScreenPos: (teamId) => {
      const e = app.world.planets.get(teamId);
      return e ? app.world.toScreen(e.home) : null;
    },
    workScreenPos: (workId) => {
      const pw = screen.view.placed.get(workId);
      if (!pw) return null;
      const y = (PLINTH_HEIGHT + Math.min(1, (pw.model?.height ?? 1) / 2)) * pw.placement.scale;
      return app.world.toScreen(pw.root.localToWorld(new THREE.Vector3(0, y, 0)));
    },
    placedIds: () => [...screen.view.placed.keys()],
    teamPlanet: (teamId) => app.teams.find((t) => t.id === teamId)?.planet ?? null,
  };
}
```

`src/env.d.ts`：在 `__thumbReady?: boolean;` 那一行下面加一行：

```ts
  __app?: import('./debug').DebugHooks; // Playwright 脚本用的坐标换算
```

- [ ] **Step 4: 装进入口**

`src/main.ts`：在 import 区末尾加：

```ts
import { installDebugHooks } from './debug';
import { Editor } from './editor/editor';
```

把这一行：

```ts
app.planetLayer = planetScreen;
```

替换为：

```ts
const editor = new Editor(app, planetScreen);
app.planetLayer = { enter: (team) => planetScreen.enter(team), leave: () => { editor.deactivate(); planetScreen.leave(); } };
app.onEdit = () => editor.toggle();
installDebugHooks(app, planetScreen);
```

在 `src/ui/styles.css` 末尾追加：

```css
/* 编辑：作品栏 */
#app > .tray { position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%); max-width: min(920px, calc(100vw - 48px)); padding: 12px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
.tray-head { margin-bottom: 10px; }
.tray-row { display: flex; gap: 10px; }
.tray-items { display: flex; gap: 10px; overflow-x: auto; }
.tray-item { position: relative; flex: 0 0 auto; width: 92px; padding: 6px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.tray-item img, .ti-initials { width: 78px; height: 78px; border-radius: 2px; object-fit: cover; display: grid; place-items: center; background: #1b1c25; font: 500 18px var(--font-ui); }
.ti-name { font-size: 11.5px; line-height: 1.2; max-width: 78px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ti-check { position: absolute; top: 4px; right: 6px; color: var(--accent); font-weight: 600; }
.ti-temp { position: absolute; top: 4px; left: 6px; color: var(--accent); }

/* 编辑条：跟着选中的作品走 */
#app > .edit-bar { position: absolute; left: 0; top: 0; display: grid; gap: 8px; width: 260px; padding: 14px; background: var(--panel-solid); border: 1px solid var(--accent); border-radius: var(--radius); }
.eb-title { font-size: 20px; }
.edit-bar label { display: grid; grid-template-columns: 56px 1fr; align-items: center; }
.edit-bar input[type='range'] { accent-color: var(--accent); width: 100%; }
.eb-hint { color: var(--ink-faint); font-size: 10px; }

/* 星球外观面板 */
#app > .planet-panel { position: absolute; left: 24px; top: 50%; transform: translateY(-50%); width: 200px; display: grid; gap: 10px; padding: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
.pp-presets { display: grid; gap: 6px; }
.pp-presets button { text-align: left; display: flex; align-items: center; gap: 8px; }
.pp-presets button::before { content: ''; width: 10px; height: 10px; border-radius: 50%; background: var(--swatch); }
.pp-toggles { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.planet-panel hr { border: none; border-top: 1px solid var(--line); margin: 4px 0; width: 100%; }
```

- [ ] **Step 5: 写编辑器自查脚本**

`scripts/check-editor.mjs`：

```js
// 编辑器自查：进入编辑 → 选中并删除一件作品 → 从作品栏摆回去 → 按 E 旋转 → 刷新后检查存档
import { readFileSync } from 'node:fs';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const team = seed.teams.find((t) => t.id === seed.you.teamId);
const target = team.works[0];
const { server, base } = await startServer();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = watchErrors(page);
const ready = () => page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
const planetOf = () => page.evaluate((id) => window.__app.teamPlanet(id), team.id);
const results = [];
const check = (name, ok) => results.push(`${ok ? '✓' : '✗'} ${name}`);

await page.goto(`${base}/#/t/${team.id}`);
await ready();
await page.evaluate(() => localStorage.removeItem('gbn:v1:planets'));
await page.reload();
await ready();
await page.locator('.topbar button.primary').click();
check('进入编辑后出现作品栏和外观面板', (await page.locator('.tray').isVisible()) && (await page.locator('.planet-panel').isVisible()));

const at = await page.evaluate((id) => window.__app.workScreenPos(id), target.id);
await page.mouse.click(at.x, at.y);
await page.waitForTimeout(200);
check('点作品后出现编辑条', await page.locator('.edit-bar').isVisible());
await page.keyboard.press('Delete');
await page.waitForTimeout(200);
check('Delete 删除作品', !(await page.evaluate(() => window.__app.placedIds())).includes(target.id));

await page.locator('.tray-item', { hasText: target.title }).click();
await page.waitForTimeout(400);
const center = await page.evaluate((id) => window.__app.planetScreenPos(id), team.id);
await page.mouse.move(center.x, center.y);
await page.waitForTimeout(100);
await page.mouse.click(center.x, center.y);
await page.waitForTimeout(600);
check('从作品栏摆回星球', (await page.evaluate(() => window.__app.placedIds())).includes(target.id));

const before = (await planetOf()).placements.find((p) => p.workId === target.id).yaw;
await page.keyboard.press('e');
await page.waitForTimeout(200);
const after = (await planetOf()).placements.find((p) => p.workId === target.id).yaw;
const turned = Math.abs(after - before);
check('按 E 旋转 15°', Math.abs(turned - Math.PI / 12) < 1e-6 || Math.abs(turned - (2 * Math.PI - Math.PI / 12)) < 1e-6);
await page.screenshot({ path: 'shots/editor.png' });

await page.reload();
await ready();
const saved = (await planetOf()).placements.find((p) => p.workId === target.id);
check('刷新后摆放和旋转都还在', !!saved && Math.abs(saved.yaw - after) < 1e-9);

console.log(results.join('\n'));
if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
const ok = results.every((r) => r.startsWith('✓')) && errors.length === 0;
console.log(ok ? 'EDITOR OK' : 'EDITOR FAIL');
await page.evaluate(() => localStorage.removeItem('gbn:v1:planets'));
await browser.close();
await server.close();
process.exitCode = ok ? 0 : 1;
```

- [ ] **Step 6: 运行自查**

Run: `node scripts/check-editor.mjs`
Expected: 6 行全是 `✓`，最后 `EDITOR OK`。用 Read 打开 `shots/editor.png`：底部作品栏、左侧外观面板、选中作品上方的编辑条都在，被选中作品的展台在发光

排错：「从作品栏摆回星球」失败时，先确认点击位置打中了地表（`planetScreenPos` 是星球中心，镜头正对它）；拖动时镜头跟着转，说明 `pointerdown` 的捕获监听没有先于 OrbitControls 执行，检查 `{ capture: true }`

- [ ] **Step 7: 截图检查外观面板**

Run: `node scripts/shot.mjs "index.html#/t/lumen-guild" shots/edit-panel.png --click ".topbar button.primary"`
Expected: `页面无报错`；左侧面板 5 个预设按钮（当前预设高亮）、Ring / Atmosphere 开关、Reroll terrain、Reset demo

- [ ] **Step 8: 全部测试 + 类型检查，然后提交**

Run: `npm test`，然后 `npm run typecheck`
Expected: 全部 PASS；0 退出

```bash
git add src/ui/editPanel.ts src/editor/editor.ts src/debug.ts src/env.d.ts src/main.ts src/ui/styles.css scripts/check-editor.mjs
git commit -m "feat: 编辑模式：摆放、拖动、旋转、缩放、删除、星球外观与自动保存" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 从电脑拖入 GLB（临时作品）

**Files:**
- Create: `src/editor/dropGlb.ts`, `scripts/lib/fixture.mjs`, `scripts/check-drop.mjs`
- Modify: `src/editor/editor.ts`, `src/ui/editPanel.ts`, `src/ui/styles.css`（末尾追加）
- Test: `tests/dropGlb.test.ts`

**Interfaces:**
- Consumes: `Editor`、`EditPanel`（Task 12）；`toast`（Task 8）；`window.__app`（Task 12）
- Produces:
  - `MAX_DROP_BYTES = 100 * 1024 * 1024`；`type DropCheck = { ok: true } | { ok: false; reason: string }`；`checkDrop(file: { name: string; size: number }): DropCheck`；`listenForDrops(handlers: { active(): boolean; drop(file: File): void; hover(on: boolean): void; inactiveDrop(): void }): void`
  - `Editor.addTempWork(file: File): Promise<void>`；`EditPanel.setDropHover(on: boolean): void`
  - `scripts/lib/fixture.mjs`：`makeBoxGlb({ textureSize?: number }): Promise<Uint8Array>`（Task 14 复用）

- [ ] **Step 1: 写失败的测试**

`tests/dropGlb.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { checkDrop, MAX_DROP_BYTES } from '../src/editor/dropGlb';

describe('checkDrop', () => {
  it('接受 100 MB 以内的 .glb（扩展名不分大小写）', () => {
    expect(checkDrop({ name: 'robot.GLB', size: 5_000_000 })).toEqual({ ok: true });
    expect(checkDrop({ name: 'a.glb', size: MAX_DROP_BYTES })).toEqual({ ok: true });
  });
  it('拒绝其他格式', () => {
    expect(checkDrop({ name: 'scene.gltf', size: 10 })).toEqual({ ok: false, reason: 'Only .glb files can be dropped here' });
  });
  it('拒绝超过 100 MB 的文件', () => {
    expect(checkDrop({ name: 'huge.glb', size: MAX_DROP_BYTES + 1 })).toEqual({ ok: false, reason: 'That file is over 100 MB' });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/dropGlb.test.ts`
Expected: FAIL，找不到 `../src/editor/dropGlb`

- [ ] **Step 3: 实现检查和监听**

`src/editor/dropGlb.ts`：

```ts
export const MAX_DROP_BYTES = 100 * 1024 * 1024;

export type DropCheck = { ok: true } | { ok: false; reason: string };

export function checkDrop(file: { name: string; size: number }): DropCheck {
  if (!/\.glb$/i.test(file.name)) return { ok: false, reason: 'Only .glb files can be dropped here' };
  if (file.size > MAX_DROP_BYTES) return { ok: false, reason: 'That file is over 100 MB' };
  return { ok: true };
}

// 整个窗口都能接住拖进来的文件；无论是否在编辑模式，都阻止浏览器直接打开文件
export function listenForDrops(handlers: { active(): boolean; drop(file: File): void; hover(on: boolean): void; inactiveDrop(): void }): void {
  addEventListener('dragover', (e) => {
    e.preventDefault();
    if (handlers.active()) handlers.hover(true);
  });
  addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) handlers.hover(false); // 拖出窗口
  });
  addEventListener('drop', (e) => {
    e.preventDefault();
    handlers.hover(false);
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    if (handlers.active()) handlers.drop(file);
    else handlers.inactiveDrop();
  });
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/dropGlb.test.ts`
Expected: PASS（3 个测试）

- [ ] **Step 5: 作品栏加上拖放区**

`src/ui/editPanel.ts`：在 `private readonly trayItems = el('div', { className: 'tray-items' });` 下面加一行：

```ts
  private readonly dropZone = el('div', { className: 'drop-zone mono', textContent: 'Drop GLB here' });
```

把构造函数里的：

```ts
    this.trayRow.append(this.trayItems);
```

替换为：

```ts
    this.trayRow.append(this.trayItems, this.dropZone);
```

在 `syncAppearance` 方法后面（类的最后一个 `}` 之前）加：

```ts

  setDropHover(on: boolean): void {
    this.dropZone.classList.toggle('hover', on);
  }
```

- [ ] **Step 6: 编辑器接收拖入的文件**

`src/editor/editor.ts`：

在 import 区加两行：

```ts
import { toast } from '../ui/toast';
import { checkDrop, listenForDrops } from './dropGlb';
```

在 `private dragging = false;` 下面加一行：

```ts
  private tempCount = 0;
```

在构造函数里 `app.world.frameHooks.add(() => this.placeBar());` 下面加：

```ts
    listenForDrops({
      active: () => this.active,
      drop: (file) => void this.addTempWork(file),
      hover: (on) => this.panel.setDropHover(on),
      inactiveDrop: () => toast("Open Edit on your team's planet to drop a GLB"),
    });
```

在 `deactivate()` 方法后面加：

```ts

  // 拖进来的 GLB 变成临时作品：只在当前页面有效，不进存档、不进 Museum
  async addTempWork(file: File): Promise<void> {
    const check = checkDrop(file);
    if (!check.ok) {
      toast(check.reason);
      return;
    }
    const work: Work = { id: `tmp-${++this.tempCount}`, title: file.name.replace(/\.glb$/i, ''), authorId: this.app.you.memberId, file: URL.createObjectURL(file), thumb: '', tris: 0 };
    const model = await this.view.library.load(work);
    if (model.failed) {
      URL.revokeObjectURL(work.file);
      toast('Could not read that GLB');
      return;
    }
    this.view.extraWorks.set(work.id, work);
    toast(`${work.title} added. Click the planet to place it.`);
    await this.pickFromTray(work);
  }
```

在 `src/ui/styles.css` 末尾追加：

```css
/* 拖放区 */
.drop-zone { flex: 0 0 auto; width: 92px; display: grid; place-items: center; text-align: center; padding: 8px; border: 1px dashed var(--line); border-radius: var(--radius); color: var(--ink-faint); }
.drop-zone.hover { border-color: var(--accent); color: var(--accent); }
```

- [ ] **Step 7: 写测试用 GLB 生成器和拖放自查脚本**

`scripts/lib/fixture.mjs`：

```js
// 生成一个带贴图的竖直方片 GLB，给拖入检查和模型处理脚本当测试数据
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';

export async function makeBoxGlb({ textureSize = 64 } = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const png = await sharp({ create: { width: textureSize, height: textureSize, channels: 3, background: { r: 200, g: 120, b: 60 } } }).png().toBuffer();
  const texture = doc.createTexture('base').setImage(new Uint8Array(png)).setMimeType('image/png');
  const material = doc.createMaterial('mat').setBaseColorTexture(texture).setDoubleSided(true);
  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', accessor('VEC3', new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0])))
    .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])))
    .setIndices(accessor('SCALAR', new Uint16Array([0, 1, 2, 0, 2, 3])))
    .setMaterial(material);
  const node = doc.createNode('quad').setMesh(doc.createMesh('quad').addPrimitive(prim));
  doc.createScene('scene').addChild(node);
  return new NodeIO().writeBinary(doc);
}
```

`scripts/check-drop.mjs`：

```js
// 拖放自查：编辑模式下拖入 GLB → 作品栏出现临时作品 → 摆上星球 → 存档里没有它；拖入 .txt 被拒绝
import { readFileSync } from 'node:fs';
import { launch, startServer, watchErrors } from './lib/browser.mjs';
import { makeBoxGlb } from './lib/fixture.mjs';

const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const glb = Buffer.from(await makeBoxGlb()).toString('base64');
const { server, base } = await startServer();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = watchErrors(page);
await page.goto(`${base}/#/t/${seed.you.teamId}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
await page.locator('.topbar button.primary').click();

// 在页面里造一个 File，派发 drop 事件
const drop = (name, b64) => page.evaluate(([n, data]) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], n));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, [name, b64]);

await drop('Dropped Sign.glb', glb);
await page.waitForTimeout(800);
const tempInTray = await page.locator('.tray-item .ti-temp').count();
const center = await page.evaluate((id) => window.__app.planetScreenPos(id), seed.you.teamId);
await page.mouse.move(center.x, center.y);
await page.mouse.click(center.x, center.y);
await page.waitForTimeout(600);
const placed = await page.evaluate(() => window.__app.placedIds());
const saved = await page.evaluate((id) => window.__app.teamPlanet(id), seed.you.teamId);
await page.screenshot({ path: 'shots/drop.png' });
await drop('notes.txt', btoa('hello'));
await page.waitForTimeout(300);
const toastText = (await page.locator('.toast').textContent()) ?? '';

const results = [
  [tempInTray === 1, '作品栏出现 1 件临时作品'],
  [placed.some((id) => id.startsWith('tmp-')), '临时作品摆上了星球'],
  [!saved.placements.some((p) => p.workId.startsWith('tmp-')), '存档里没有临时作品'],
  [/Only \.glb/.test(toastText), '.txt 被拒绝并提示'],
];
for (const [ok, name] of results) console.log(`${ok ? '✓' : '✗'} ${name}`);
if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
const ok = results.every(([pass]) => pass) && errors.length === 0;
console.log(ok ? 'DROP OK' : 'DROP FAIL');
await browser.close();
await server.close();
process.exitCode = ok ? 0 : 1;
```

- [ ] **Step 8: 运行自查**

Run: `node scripts/check-drop.mjs`
Expected: 4 行全是 `✓`，最后 `DROP OK`。打开 `shots/drop.png`：星球正中立着一块橙色方片（拖进来的临时作品），作品栏里它带 `temp` 标记

- [ ] **Step 9: 全部测试 + 类型检查，然后提交**

Run: `npm test`，然后 `npm run typecheck`
Expected: 全部 PASS；0 退出

```bash
git add src/editor/dropGlb.ts src/editor/editor.ts src/ui/editPanel.ts src/ui/styles.css scripts/lib/fixture.mjs scripts/check-drop.mjs tests/dropGlb.test.ts
git commit -m "feat: 编辑模式下拖入 GLB 作为临时作品" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: 模型处理脚本（压缩、缩略图、作品清单）

**Files:**
- Create: `scripts/lib/gltf.mjs`, `scripts/inspect-glb.mjs`, `scripts/make-fixture.mjs`, `scripts/prep-models.mjs`, `dev/thumb.html`, `dev/thumb.ts`

**Interfaces:**
- Consumes: `parseCsv`、`slugify`（Task 6，Node 直接 import `.ts`）；`startServer(overrides)`、`launch()`（Task 2）；`makeBoxGlb`（Task 13）；`ModelLibrary`（Task 9）；`frameModel`（Task 11）；`addStudioLights`（Task 7）
- Produces:
  - `scripts/lib/gltf.mjs`：`createIO(): Promise<NodeIO>`（已注册全部扩展和 meshopt 编解码器）、`countTris(doc): number`
  - `npm run prep`：读 `models-in/`（GLB + `works.csv`，列为 `file,title,author,description`），写 `public/models/<id>.glb`、`public/thumbs/<id>.webp`、`src/data/works.json`、`models-in/prep-report.json`；环境变量 `PREP_IN`、`PREP_OUT`、`WORKS_OUT` 可以换目录
  - `node scripts/inspect-glb.mjs <file>`：打印大小、三角面数、每张贴图的格式和尺寸

- [ ] **Step 1: 写 gltf 共用模块、查看脚本和测试数据脚本**

`scripts/lib/gltf.mjs`：

```js
// gltf-transform 共用：带 meshopt 编解码器的读写器、三角面计数
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

export async function createIO() {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
}

// 只数 TRIANGLES 模式（4）的图元
export function countTris(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const idx = prim.getIndices();
      n += Math.floor((idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3);
    }
  }
  return n;
}
```

`scripts/inspect-glb.mjs`：

```js
// 查看 GLB：文件大小、三角面数、每张贴图的格式和尺寸。node scripts/inspect-glb.mjs <file.glb>
import { statSync } from 'node:fs';
import sharp from 'sharp';
import { countTris, createIO } from './lib/gltf.mjs';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/inspect-glb.mjs <file.glb>');
  process.exit(2);
}
const doc = await (await createIO()).read(file);
console.log(`${file}  ${(statSync(file).size / 1048576).toFixed(2)} MB  ${countTris(doc).toLocaleString('en-US')} tris`);
for (const tex of doc.getRoot().listTextures()) {
  const meta = await sharp(Buffer.from(tex.getImage())).metadata();
  console.log(`  texture ${tex.getMimeType()} ${meta.width}×${meta.height}`);
}
```

`scripts/make-fixture.mjs`：

```js
// 生成模型处理脚本的测试数据：.tmp/fixture/ 下两个 GLB（一个带 4096 贴图）+ works.csv（含一行找不到的文件）
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeBoxGlb } from './lib/fixture.mjs';

mkdirSync('.tmp/fixture', { recursive: true });
writeFileSync('.tmp/fixture/big-texture.glb', await makeBoxGlb({ textureSize: 4096 }));
writeFileSync('.tmp/fixture/small.glb', await makeBoxGlb({ textureSize: 64 }));
writeFileSync('.tmp/fixture/works.csv', 'file,title,author,description\nbig-texture.glb,"Big Texture, Test",tester,Fixture with a 4096 texture\nsmall.glb,Small,tester2,\nmissing.glb,Missing,nobody,\n');
console.log('测试数据写到 .tmp/fixture/');
```

- [ ] **Step 2: 写缩略图页面**

`dev/thumb.html`：

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>thumbnail</title>
    <style>html, body { margin: 0; background: #1a1b22; } #c { width: 512px; height: 512px; display: block; }</style>
  </head>
  <body>
    <canvas id="c"></canvas>
    <script type="module" src="./thumb.ts"></script>
  </body>
</html>
```

`dev/thumb.ts`：

```ts
import * as THREE from 'three/webgpu';
import { ModelLibrary } from '../src/assets/models';
import { frameModel } from '../src/museum/framing';
import { addStudioLights } from '../src/scenes/lights';

// 只渲染一个模型，给 prep-models 截缩略图：?file=<public/models 下的文件名>
const file = new URLSearchParams(location.search).get('file') ?? '';
const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
await renderer.init();
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.setPixelRatio(1);
renderer.setSize(512, 512, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#1a1b22');
addStudioLights(scene);
const model = await new ModelLibrary().load({ id: file, file });
model.object.rotation.y = -Math.PI / 6;
scene.add(model.object);
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
frameModel(camera, model.height);
renderer.setAnimationLoop(() => renderer.render(scene, camera));
requestAnimationFrame(() => requestAnimationFrame(() => { window.__thumbReady = true; }));
```

- [ ] **Step 3: 写处理脚本**

`scripts/prep-models.mjs`：

```js
// 处理社区作品：压缩 GLB（不减面）、截缩略图、写 works.json 和处理报告
// 默认读 models-in/（GLB + works.csv），输出到 public/models、public/thumbs、src/data/works.json
// 测试时可用环境变量换目录：PREP_IN、PREP_OUT、WORKS_OUT
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dedup, meshopt, prune, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { parseCsv, slugify } from '../src/lib/csv.ts';
import { launch, startServer } from './lib/browser.mjs';
import { countTris, createIO } from './lib/gltf.mjs';

const IN = process.env.PREP_IN ?? 'models-in';
const OUT = process.env.PREP_OUT ?? 'public';
const WORKS = process.env.WORKS_OUT ?? 'src/data/works.json';
const MAX_TRIS = 500_000;
const MAX_MB = 15;
const MB = 1024 * 1024;

const io = await createIO();
const rows = parseCsv(readFileSync(path.join(IN, 'works.csv'), 'utf8'));
mkdirSync(path.join(OUT, 'models'), { recursive: true });
mkdirSync(path.join(OUT, 'thumbs'), { recursive: true });
const works = [];
const report = [];
const used = new Set();

for (const row of rows) {
  const src = path.join(IN, row.file ?? '');
  if (!row.file || !existsSync(src)) {
    console.warn(`跳过：找不到 ${row.file}`);
    continue;
  }
  let id = slugify(row.file);
  while (used.has(id)) id = `${id}-2`;
  used.add(id);
  let doc;
  try {
    doc = await io.read(src);
    await doc.transform(
      dedup(),
      prune(),
      weld(),
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [2048, 2048] }),
      meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
    );
  } catch (err) {
    // Draco 压缩的文件需要先 npm i -D draco3dgltf（先核实版本和许可），再在 scripts/lib/gltf.mjs 里注册 'draco3d.decoder'
    console.warn(`跳过：${row.file} 处理失败：${err.message}`);
    report.push({ id, file: row.file, error: err.message, flag: true });
    continue;
  }
  const out = path.join(OUT, 'models', `${id}.glb`);
  await io.write(out, doc);
  const tris = countTris(doc);
  const before = statSync(src).size;
  const after = statSync(out).size;
  const flag = tris > MAX_TRIS || after > MAX_MB * MB;
  report.push({ id, file: row.file, tris, mbBefore: +(before / MB).toFixed(2), mbAfter: +(after / MB).toFixed(2), flag });
  works.push({ id, title: row.title || id, author: row.author || 'unknown', file: `${id}.glb`, thumb: `${id}.webp`, tris, ...(row.description ? { description: row.description } : {}) });
  console.log(`${flag ? '⚠' : '✓'} ${row.file} → ${id}.glb  ${tris.toLocaleString('en-US')} tris  ${(before / MB).toFixed(1)} → ${(after / MB).toFixed(1)} MB`);
}

// 缩略图：Vite 开发服务器把 OUT 当作 public 目录，逐个打开 dev/thumb.html 截图
if (works.length) {
  const { server, base } = await startServer({ publicDir: path.resolve(OUT) });
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  for (const w of works) {
    await page.goto(`${base}/dev/thumb.html?file=${encodeURIComponent(w.file)}`);
    await page.waitForFunction(() => window.__thumbReady === true, null, { timeout: 60000 });
    const dest = path.join(OUT, 'thumbs', w.thumb);
    await sharp(await page.locator('#c').screenshot()).webp({ quality: 82 }).toFile(dest);
    const meta = await sharp(dest).metadata();
    console.log(`缩略图 ${w.thumb} ${meta.width}×${meta.height}`);
  }
  await browser.close();
  await server.close();
}

writeFileSync(WORKS, `${JSON.stringify(works, null, 2)}\n`);
writeFileSync(path.join(IN, 'prep-report.json'), `${JSON.stringify(report, null, 2)}\n`);
const flagged = report.filter((r) => r.flag);
console.log(`works.json：${works.length} 件；需要留意 ${flagged.length} 件${flagged.length ? `（${flagged.map((r) => r.file).join('、')}）` : ''}`);
```

- [ ] **Step 4: 生成测试数据并跑一遍**

Run: `node scripts/make-fixture.mjs`
Expected: `测试数据写到 .tmp/fixture/`

Run（PowerShell）：`$env:PREP_IN='.tmp/fixture'; $env:PREP_OUT='.tmp/out'; $env:WORKS_OUT='.tmp/out/works.json'; node scripts/prep-models.mjs; Remove-Item Env:PREP_IN, Env:PREP_OUT, Env:WORKS_OUT`
Run（Git Bash）：`PREP_IN=.tmp/fixture PREP_OUT=.tmp/out WORKS_OUT=.tmp/out/works.json node scripts/prep-models.mjs`
Expected（顺序可能不同）：

```
✓ big-texture.glb → big-texture.glb  2 tris  … MB
✓ small.glb → small.glb  2 tris  … MB
跳过：找不到 missing.glb
缩略图 big-texture.webp 512×512
缩略图 small.webp 512×512
works.json：2 件；需要留意 0 件
```

- [ ] **Step 5: 检查输出**

Run: `node scripts/inspect-glb.mjs .tmp/out/models/big-texture.glb`
Expected: 一行 `texture image/webp 2048×2048`（原图 4096 被缩到 2048 并转成 WebP）

再用 Read 打开 `.tmp/out/works.json`：第一件的 `title` 是 `Big Texture, Test`（CSV 引号里的逗号保留下来了），`thumb` 是 `big-texture.webp`

- [ ] **Step 6: 类型检查并提交**

Run: `npm run typecheck`
Expected: 0 退出

```bash
git add scripts/lib/gltf.mjs scripts/inspect-glb.mjs scripts/make-fixture.mjs scripts/prep-models.mjs dev/thumb.html dev/thumb.ts
git commit -m "feat: 模型处理脚本：压缩、缩略图、作品清单与报告" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: 用户的 GLB 到了以后（可能在后面任何一个任务之间发生）**

1. 用户把 GLB 和 `works.csv` 放进 `models-in/`（列为 `file,title,author,description`）
2. Run: `npm run prep`；打开 `models-in/prep-report.json`，把 `flag: true` 的文件（面数超过 50 万、处理后超过 15 MB、处理失败）告诉用户，由用户决定换不换
3. Run: `npm run seed`，看输出的团队数和每队作品数（10–12 件是 3 个团队，13 件起是 4–6 个）
4. Run: `npm test`（`assemble.test.ts` 用的是模板和生成的作品，仍应全部通过）
5. Run: `node scripts/shot.mjs "index.html#/t/lumen-guild" shots/real-planet.png --wait 2000` 和 `node scripts/shot.mjs "index.html#/t/lumen-guild/museum" shots/real-museum.png --wait 3000`；检查真实模型都立在展台上、朝向镜头、没有被裁掉
6. 提交：

```bash
git add public/models public/thumbs src/data/works.json src/data/seed.json
git commit -m "feat: 换上社区作品" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: 启动画面、出错兜底和完整冒烟测试

**Files:**
- Create: `scripts/smoke.mjs`
- Modify: `index.html`, `src/main.ts`（整个替换成最终版）, `src/ui/styles.css`（末尾追加）

**Interfaces:**
- Consumes: 前面所有任务的页面和 `window.__app`
- Produces: `#boot` 启动画面（3D 世界建好后淡出；浏览器不能做 3D 时显示提示）；`node scripts/smoke.mjs`（环境变量 `SMOKE_BASE` 可以指向构建预览或线上地址）

- [ ] **Step 1: 加启动画面**

`index.html`：在 `<div id="app"></div>` 下面加一行：

```html
    <div id="boot"><div class="boot-title">Community Planets</div><div class="boot-sub">Preparing the sky…</div></div>
```

在 `src/ui/styles.css` 末尾追加：

```css
/* 启动画面：3D 世界建好后淡出 */
#boot { position: fixed; inset: 0; z-index: 50; display: grid; place-content: center; gap: 10px; text-align: center; background: var(--void); transition: opacity 0.6s ease; }
#boot.done { opacity: 0; pointer-events: none; }
.boot-title { font: 500 46px/1 var(--font-display); }
.boot-sub { font: 11.5px var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-dim); }
```

- [ ] **Step 2: 入口换成最终版**

`src/main.ts`（整个替换；内容等于 Task 9–12 改完的结果，加上启动画面和出错兜底）：

```ts
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
import { installDebugHooks } from './debug';
import { Editor } from './editor/editor';
import { World } from './scenes/world';
import { MembersPage } from './ui/membersPage';
import { MuseumPage } from './ui/museumPage';
import { PlanetScreen } from './ui/planetScreen';

// 启动：读数据 → 建 3D 世界 → 装配各个页面 → 撤掉启动画面 → 按地址显示
const boot = document.getElementById('boot');

async function main(): Promise<void> {
  const seed = seedJson as unknown as Seed;
  const store = new LocalStore(seed, browserStorage());
  const world = await World.create(document.querySelector<HTMLCanvasElement>('#stage')!);
  const app = new App(world, document.querySelector<HTMLDivElement>('#app')!, store, seed.you, await store.listTeams());
  const planetScreen = new PlanetScreen(world, app.root, (teamId, workId) => app.navigate({ view: 'museum', teamId, workId }));
  const editor = new Editor(app, planetScreen);
  app.planetLayer = { enter: (team) => planetScreen.enter(team), leave: () => { editor.deactivate(); planetScreen.leave(); } };
  app.onEdit = () => editor.toggle();
  app.members = new MembersPage(app.root, seed.you.memberId, () => app.closeSheet(), (workId) => {
    const team = app.currentTeam;
    if (team) app.navigate({ view: 'museum', teamId: team.id, workId });
  });
  app.museum = new MuseumPage(app.root, world, () => app.closeSheet(), (workId) => {
    const team = app.currentTeam;
    if (team) app.navigate(workId ? { view: 'museum', teamId: team.id, workId } : { view: 'museum', teamId: team.id });
  });
  installDebugHooks(app, planetScreen);
  boot?.classList.add('done');
  setTimeout(() => boot?.remove(), 700);
  await app.start();
}

main().catch((err: unknown) => {
  console.error(err);
  const sub = boot?.querySelector('.boot-sub');
  if (sub) sub.textContent = 'Your browser could not start 3D graphics. Please try the latest Chrome, Edge, Safari or Firefox.';
});
```

- [ ] **Step 3: 写冒烟测试**

`scripts/smoke.mjs`：

```js
// 冒烟测试：把演示流程完整走一遍，每一步截图到 shots/smoke-NN.png，最后统计页面错误
// 开发服务器：node scripts/smoke.mjs；构建预览或线上：SMOKE_BASE=<地址> node scripts/smoke.mjs
import { readFileSync } from 'node:fs';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const you = seed.teams.find((t) => t.id === seed.you.teamId);
const other = seed.teams.find((t) => t.status === 'active' && t.id !== you.id) ?? you;
const uc = seed.teams.find((t) => t.status === 'under-construction');
const local = process.env.SMOKE_BASE ? null : await startServer();
const base = (process.env.SMOKE_BASE ?? local.base).replace(/\/$/, '');
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = watchErrors(page);
page.on('dialog', (d) => d.accept());
const ready = () => page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 15000 });
const results = [];
let n = 0;

async function step(name, fn) {
  try {
    await fn();
    results.push(`✓ ${name}`);
  } catch (err) {
    results.push(`✗ ${name}: ${String(err.message).split('\n')[0]}`);
  }
  await page.screenshot({ path: `shots/smoke-${String(++n).padStart(2, '0')}.png` });
}

await step('星系页打开', async () => {
  await page.goto(`${base}/`);
  await ready();
  await page.evaluate(() => localStorage.removeItem('gbn:v1:planets'));
  await page.reload();
  await ready();
  await until(() => document.querySelector('.tb-name')?.textContent === 'Community Planets');
});

await step('点星球飞进去，作品全部摆上', async () => {
  const at = await page.evaluate((id) => window.__app.planetScreenPos(id), other.id);
  await page.mouse.click(at.x, at.y);
  await until((id) => location.hash === `#/t/${id}`, other.id);
  await until((count) => window.__app.placedIds().length === count, other.works.length);
});

await step('Members 页列出全部成员，Esc 关闭', async () => {
  await page.getByRole('button', { name: 'Members' }).click();
  await until((count) => document.querySelectorAll('.sheet.members .member').length === count, other.members.length);
  await page.keyboard.press('Escape');
  await until((id) => location.hash === `#/t/${id}`, other.id);
});

await step('Museum 网格和大图查看器', async () => {
  await page.getByRole('button', { name: 'Museum' }).click();
  await until((count) => document.querySelectorAll('.museum-card').length === count, other.works.length);
  await until(() => document.querySelectorAll('.mc-preview.ready').length > 0);
  await page.waitForTimeout(800);
  await page.locator('.museum-card').first().click();
  await until(() => document.querySelector('.viewer')?.hidden === false);
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  await until(() => document.querySelector('.viewer')?.hidden === true);
  await page.keyboard.press('Escape');
  await until((id) => location.hash === `#/t/${id}`, other.id);
});

await step('别的团队没有 Edit 按钮', async () => {
  if (other.id !== you.id && (await page.locator('.topbar button.primary').isVisible())) throw new Error('Edit 按钮不该出现');
});

await step('自己的团队：删除一件再摆回去', async () => {
  await page.evaluate((id) => { location.hash = `#/t/${id}`; }, you.id);
  await until((count) => window.__app.placedIds().length === count, you.works.length);
  await page.locator('.topbar button.primary').click();
  const target = you.works[0];
  const at = await page.evaluate((id) => window.__app.workScreenPos(id), target.id);
  await page.mouse.click(at.x, at.y);
  await page.keyboard.press('Delete');
  await until((id) => !window.__app.placedIds().includes(id), target.id);
  await page.locator('.tray-item', { hasText: target.title }).click();
  await page.waitForTimeout(400);
  const center = await page.evaluate((id) => window.__app.planetScreenPos(id), you.id);
  await page.mouse.move(center.x, center.y);
  await page.mouse.click(center.x, center.y);
  await until((id) => window.__app.placedIds().includes(id), target.id);
});

await step('换外观：Volcanic、切换光环', async () => {
  await page.locator('.planet-panel button', { hasText: 'Volcanic' }).click();
  await page.locator('.planet-panel button', { hasText: 'Ring' }).click();
  await until((id) => window.__app.teamPlanet(id)?.preset === 'volcanic', you.id);
});

await step('Reset demo 恢复初始数据', async () => {
  await Promise.all([page.waitForEvent('load'), page.locator('.planet-panel button', { hasText: 'Reset demo' }).click()]);
  await ready();
  await until(([id, preset]) => window.__app.teamPlanet(id)?.preset === preset, [you.id, you.planet.preset]);
});

await step('回到星系', async () => {
  await page.getByRole('button', { name: '← Galaxy' }).click();
  await until(() => location.hash === '#/');
});

await step('建设中的星球显示提示', async () => {
  await page.evaluate((id) => { location.hash = `#/t/${id}`; }, uc.id);
  await until(() => document.querySelector('.center-note')?.hidden === false);
});

await step('不存在的团队：回到星系并提示', async () => {
  await page.evaluate(() => { location.hash = '#/t/no-such-team'; });
  await until(() => location.hash === '#/' && /does not exist/.test(document.querySelector('.toast')?.textContent ?? ''));
});

console.log(results.join('\n'));
if (errors.length) console.log(`页面错误 ${errors.length} 条：\n${errors.join('\n')}`);
const ok = results.every((r) => r.startsWith('✓')) && errors.length === 0;
console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL');
await browser.close();
await local?.server.close();
process.exitCode = ok ? 0 : 1;
```

- [ ] **Step 4: 运行冒烟测试**

Run: `node scripts/smoke.mjs`
Expected: 11 行全是 `✓`，最后 `SMOKE OK`。用 Read 抽看 `shots/smoke-02.png`（星球页）、`shots/smoke-04.png`（Museum 后回到星球）、`shots/smoke-06.png`（编辑中）

- [ ] **Step 5: 跑一遍所有检查**

Run: `npm test`、`npm run typecheck`、`npm run build`、`node scripts/check-multiview.mjs`、`node scripts/check-editor.mjs`、`node scripts/check-drop.mjs`
Expected: 测试全部 PASS；类型检查和构建 0 退出；三个检查脚本分别输出 `MULTIVIEW OK`、`EDITOR OK`、`DROP OK`

- [ ] **Step 6: Commit**

```bash
git add index.html src/main.ts src/ui/styles.css scripts/smoke.mjs
git commit -m "feat: 启动画面、出错兜底与完整冒烟测试" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: 部署（需要用户明确同意）

**Files:** 无代码改动

**Interfaces:**
- Consumes: `npm run build`、`npm run preview`、`scripts/smoke.mjs`（`SMOKE_BASE`）
- Produces: 一个可以发给别人的网址

- [ ] **Step 1: 先问用户，得到明确答复前不部署**

向用户确认三件事：
1. 用哪个平台、谁的账号（Cloudflare Pages 或 Netlify；GitHub Pages 需要推送到 GitHub，私有仓库开 Pages 要付费账号）
2. 看链接的人里有没有在中国大陆的：调研显示 `vercel.app`、`workers.dev` 在大陆基本被封（spec 第 15 节）；如果有，先在 `https://en.greatfire.org/domain/pages.dev`（或 `netlify.app`）查实时状态再选平台
3. 链接是公开的，拿到链接的人都能看到这些社区作品：作者是否都同意

- [ ] **Step 2: 构建并检查体积**

Run: `npm run build`
Run（PowerShell）：`"{0:N1} MB" -f ((Get-ChildItem dist -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)`
Expected: 构建 0 退出；打印 `dist/` 总大小（大部分是 `models/`）。超过 100 MB 时告诉用户，考虑在 `prep-models.mjs` 里把贴图上限降到 1024

- [ ] **Step 3: 对构建结果跑冒烟测试**

用后台方式启动：`npm run preview`（地址 `http://127.0.0.1:4173`）
Run（PowerShell）：`$env:SMOKE_BASE='http://127.0.0.1:4173'; node scripts/smoke.mjs; Remove-Item Env:SMOKE_BASE`
Run（Git Bash）：`SMOKE_BASE=http://127.0.0.1:4173 node scripts/smoke.mjs`
Expected: `SMOKE OK`；然后停掉预览服务器

- [ ] **Step 4: 部署到用户选的平台**

Cloudflare Pages（wrangler 4.153.0，2026-10-27 查询）：
1. 请用户在自己的终端运行 `! npx wrangler@4.153.0 login` 完成登录
2. 第一次部署前建项目：`npx wrangler@4.153.0 pages project create community-planets --production-branch main`
3. 部署：`npx wrangler@4.153.0 pages deploy dist --project-name community-planets --branch main`
Expected: 输出 `https://….pages.dev` 网址

Netlify（netlify-cli 27.14.2，2026-10-27 查询；首次部署会交互式地建站，所以请用户自己运行）：
1. `! npx netlify-cli@27.14.2 login`
2. `! npx netlify-cli@27.14.2 deploy --dir dist --prod`
Expected: 输出 `https://….netlify.app` 网址

- [ ] **Step 5: 对线上地址跑冒烟测试，然后交付**

Run: `SMOKE_BASE=<线上网址> node scripts/smoke.mjs`（PowerShell 写法同 Step 3）
Expected: `SMOKE OK`

把网址发给用户，并说明：演示前点一次编辑面板里的「Reset demo」可以回到初始状态；从电脑拖进来的 GLB 刷新后就没了。

---

## 时间不够时的砍法（按顺序，见 spec 第 12 节）

1. 先砍全部 P1（本计划本来就不含）
2. Museum 的卡片实时预览改成静态缩略图：`LIVE_CARD_PREVIEWS = false`（Task 11），缩略图由 Task 14 生成
3. 星球外观面板只留 5 个预设，去掉 Ring、Atmosphere、Reroll 按钮（Task 12 的 `EditPanel`）

## 检查点

- 10月27日（周二）晚：Task 1–9 完成，把 `shots/galaxy.png`、`shots/planet.png`、`shots/uc.png` 发给用户确认视觉方向
- 10月28日（周三）晚：Task 10–14 完成；GLB 到了就按 Task 14 Step 7 换上；和用户定好部署平台
- 10月29日（周四）中午前：Task 15–16 完成，交付网址
