// 启动画面：index.html 里的 #boot（样式在 boot.css），页面一打开就显示，不等 JS。main.ts 按启动的进度推进三个阶段：
// 建天空（建 World、装配各个页面）→ 预热（编译着色器）→ 落地（进入第一条路由）；3D 准备好后天体仪的环散开、夜空淡掉、撤掉。
// 第二版：夜空、细金色的天体仪环（正中是香槟金细线一笔笔画出来的 Tripo 标志，都画在 index.html 里），三个阶段是三个月相（boot.css）。
// 起不来时停在启动画面上：浏览器做不了 3D（没有 WebGPU 也没有 WebGL2）时提示换浏览器或设备，别的错误提示刷新。
// 顺带在后台预加载界面的三种字体（Cinzel、Cormorant Garamond 正体和斜体、Inter；都是可变字重，一种一个文件）：
// 星系页的标题卡片、名牌一开始就要用，第一次进星球时作品卡、按钮也不用再现下载、换一次字体

export type BootPhase = 'sky' | 'warm' | 'land';
export type StepState = 'done' | 'now' | 'todo';
type Failure = 'unsupported' | 'error';
interface GpuLike {
  requestAdapter(): Promise<unknown>;
}

const PHASES: readonly BootPhase[] = ['sky', 'warm', 'land'];
// 界面用到的字体（ui/fonts-v2.css 的 @font-face）：每种要一次，浏览器就把那个可变字重的文件整个下好
export const FONT_FACES = ['600 1em Cinzel', "500 1em 'Cormorant Garamond'", "italic 500 1em 'Cormorant Garamond'", '500 1em Inter'] as const;
// 3D 准备好时字体还没到：最多再等这么久就开始散开（字体在启动一开始就在下载，一般早就到了）
const FONT_WAIT_MS = 300;
// boot.css 里散开的几段过渡都在这之内结束（最长的是云：1.1 秒）：到点撤掉整个 #boot
const LEAVE_MS = 1150;

const COPY: Record<Failure, { title: string; body: string }> = {
  unsupported: {
    title: "This browser can't show 3D",
    body: 'Try the latest Chrome, Edge, Firefox or Safari, or open this page on another device.',
  },
  error: {
    title: "The planets didn't load",
    body: 'Something stopped the 3D world from starting. Reload the page to try again.',
  },
};

declare global {
  interface Window {
    // 只给自查脚本（scripts/smoke.mjs）截各阶段的图用：有它时每进一个阶段先等它放行；平时没有，不等
    __bootHold?: (phase: BootPhase) => Promise<void>;
  }
}

// 某个阶段时三步各自的状态；null：还没开始
export function stepStates(phase: BootPhase | null): StepState[] {
  const at = phase ? PHASES.indexOf(phase) : -1;
  return PHASES.map((_, i) => (i < at ? 'done' : i === at ? 'now' : 'todo'));
}

// p 在 ms 毫秒内结束（成功、失败都算）返回 true，超时返回 false；不抛
export function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    p.then(done, done);
  });
}

// 预加载界面的几种字体（只有拉丁字符子集，界面全是英文）。全部到了返回 true，有失败的返回 false；不抛
export function preloadFonts(fonts: Pick<FontFaceSet, 'load'> | undefined = globalThis.document?.fonts): Promise<boolean> {
  if (!fonts) return Promise.resolve(false);
  return Promise.all(FONT_FACES.map((f) => fonts.load(f))).then(() => true, () => false);
}

// 能不能做 3D：拿得到 WebGPU 适配器，或者建得出 WebGL2 上下文（three 的 WebGPURenderer 没有 WebGPU 时自己退到 WebGL2）
export async function has3D(gpu: GpuLike | undefined, webgl2: () => boolean): Promise<boolean> {
  try {
    if (gpu && (await gpu.requestAdapter())) return true;
  } catch {
    // 当作没有 WebGPU
  }
  try {
    return webgl2();
  } catch {
    return false;
  }
}

function canWebGL2(): boolean {
  const gl = document.createElement('canvas').getContext('webgl2');
  gl?.getExtension('WEBGL_lose_context')?.loseContext(); // 探测完马上还掉，不占着上下文
  return gl !== null;
}

function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

export interface Boot {
  // 进入一个阶段：更新进度；自查脚本挂了 window.__bootHold 时等它放行
  phase(p: BootPhase): Promise<void>;
  // 3D 准备好了：等字体（最多 FONT_WAIT_MS）和开场飞行的头两帧，云散开、淡出、撤掉。立即返回，不挡开场飞行；从这一刻起不挡鼠标
  reveal(): void;
  // 建 3D 世界失败：停在启动画面上提示。返回的 Promise 永远不结束，main.ts 后面的装配不再执行
  fail(err: unknown): Promise<never>;
}

export function startBoot(root: HTMLElement | null = document.getElementById('boot')): Boot {
  const fonts = preloadFonts().then((ok) => {
    performance.mark('boot:fonts');
    return ok;
  });
  let state: 'loading' | 'leaving' | 'failed' = 'loading';
  const steps = root ? [...root.querySelectorAll<HTMLElement>('.boot-steps > li')] : [];
  const live = root?.querySelector<HTMLElement>('.boot-now') ?? null;
  const center = root?.querySelector<HTMLElement>('.boot-center') ?? null;

  // 中间的图：第二版不放像素翠宝动图了，天体仪和中间的 Tripo 标志都是 index.html 里现成的线稿（data-art="orrery"：
  // 图已经在画面上，自查脚本认这个属性）
  if (root) root.dataset.art = 'orrery';

  const showFailure = (kind: Failure): void => {
    if (!root || state !== 'loading') return;
    state = 'failed';
    removeEventListener('error', onError);
    root.dataset.state = kind; // 天体仪停下、变暗（boot.css）
    const title = root.querySelector('.boot-title');
    if (title) title.textContent = COPY[kind].title;
    if (live) live.textContent = '';
    const msg = Object.assign(document.createElement('p'), { className: 'boot-msg', textContent: COPY[kind].body });
    msg.setAttribute('role', 'alert');
    center?.append(msg);
    if (kind === 'error') {
      center?.append(Object.assign(document.createElement('button'), {
        className: 'primary',
        type: 'button',
        textContent: 'Reload',
        onclick: () => location.reload(),
      }));
    }
  };

  // 启动期间没接住的错误（main.ts 顶层 await 被拒绝时浏览器在 window 上报 error 事件）：停在启动画面上提示刷新，不留一片空白
  const onError = (): void => showFailure('error');
  addEventListener('error', onError);

  return {
    async phase(p) {
      performance.mark(`boot:${p}`);
      if (root && state === 'loading') {
        root.dataset.phase = p;
        const states = stepStates(p);
        steps.forEach((li, i) => {
          li.className = `is-${states[i]}`;
          if (states[i] === 'now') li.setAttribute('aria-current', 'step');
          else li.removeAttribute('aria-current');
        });
        if (live) live.textContent = steps[PHASES.indexOf(p)]?.textContent ?? '';
      }
      await window.__bootHold?.(p);
    },

    reveal() {
      if (state !== 'loading') return;
      state = 'leaving';
      removeEventListener('error', onError);
      if (!root) return;
      root.style.pointerEvents = 'none';
      void (async () => {
        await settleWithin(fonts, FONT_WAIT_MS);
        await frames(2);
        root.dataset.state = 'leaving';
        performance.mark('boot:leave');
        setTimeout(() => {
          root.remove();
          performance.mark('boot:done');
        }, LEAVE_MS);
      })();
    },

    async fail(err) {
      const supported = await has3D((navigator as Navigator & { gpu?: GpuLike }).gpu, canWebGL2);
      if (supported) console.error(err);
      else console.warn('Community Planets: no WebGPU or WebGL 2 in this browser.', err);
      showFailure(supported ? 'error' : 'unsupported');
      return new Promise<never>(() => {});
    },
  };
}
