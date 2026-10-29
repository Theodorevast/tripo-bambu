import type { World } from '../scenes/world';
import type { Topbar } from './topbar';
import type { TuneShell } from './tuneShell';

// 左上角标题卡片上的「Tune」小按钮：打开、关上右边的调参面板（原来只有地址带 ?tune 才看得到）。
// - 第一次打开才动态加载 ../tune（Tweakpane 和面板打成单独的包，平时不下载）；再点一下整块藏起来，再点又出来
// - 开着还是关着记在 localStorage，刷新后照旧（开着的话开页就加载、照上次收没收着摆出来）
// - 地址带 ?tune：和以前一样，开页就加载、打开（不改记下的开关）
// 只用 import type：这个文件进主包，tune / tuneShell / Tweakpane 不进

const KEY = 'community-planets:tune-open';

function readOpen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function writeOpen(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // 存不了（隐私模式）：这次照样开关，只是刷新后不记得
  }
}

export interface TuneToggle {
  readonly open: boolean;
  set(open: boolean): Promise<void>;
}

export function installTuneToggle(topbar: Topbar, world: World): TuneToggle {
  let shell: TuneShell | null = null;
  let loading: Promise<TuneShell | null> | null = null;
  let want = false;
  const load = (): Promise<TuneShell | null> =>
    (loading ??= import('../tune').then(
      (m) => (shell = m.installTune(world)),
      (err: unknown) => {
        console.error(err);
        loading = null; // 下次点再试
        return null;
      },
    ));
  // expand：点按钮打开时收着的也展开；开页还原时照上次的样子
  const apply = async (open: boolean, remember: boolean, expand: boolean): Promise<void> => {
    want = open;
    topbar.setTuneOpen(open);
    if (remember) writeOpen(open);
    if (!open) {
      shell?.setOpen(false);
      return;
    }
    const s = await load();
    if (!s) {
      want = false;
      topbar.setTuneOpen(false);
      return;
    }
    if (want) s.setOpen(true, expand); // 加载的时候又点了一下（关上）：不打开
  };
  topbar.enableTune(() => void apply(!want, true, true));
  if (new URLSearchParams(location.search).has('tune')) void apply(true, false, false);
  else if (readOpen()) void apply(true, false, false);
  return {
    get open() {
      return want;
    },
    set: (open) => apply(open, true, true),
  };
}
