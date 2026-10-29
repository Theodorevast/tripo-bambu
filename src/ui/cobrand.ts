import './cobrand.css';
import { el } from './dom';

// 联名（tripo × MakerWorld，GBN 活动）：首页标题卡片上的联名标志和活动名、领券窗口顶上的小标志。
// 品牌素材和翠宝一样只在本机用，不提交、不打包：
// - 开发：从仓库根目录的 tripo/cobrand/ 读（.gitignore 里的 Tripo/）。import.meta.glob 按磁盘匹配，文件不在时结果是空的，不发请求
// - 上线（品牌方同意以后）：把 tripo-logo.png、makerworld-logo.png 放进 public/brand/，构建时设 VITE_COBRAND=1（不设就不请求，没有 404）
// - 都没有：显示文字「tripo × MakerWorld」（Nunito）
// tripo 用黑底方块的那张（tripo-logo.png）：去掉黑底的那张 V 是白色的，放在暖白纸面上看不见

// 活动名：活动页 campaign.makerworld.com/gbn/ 的标题是「GBN | Great Benchy Nations」
export const EVENT_SHORT = 'GBN';
export const EVENT_NAME = 'Great Benchy Nations';

export interface BrandArt {
  tripo: string | null; // tripo 的标志（黑底方块）
  makerworld: string | null; // MakerWorld 的标志（黑字透明底）
}

let art: Promise<BrandArt> | null = null;

export function brandArt(): Promise<BrandArt> {
  return (art ??= loadArt().catch(() => ({ tripo: null, makerworld: null })));
}

async function loadArt(): Promise<BrandArt> {
  if (import.meta.env.DEV) {
    const files = import.meta.glob<string>('/tripo/cobrand/*.png', { query: '?url', import: 'default' });
    const pick = (name: string) => {
      const key = Object.keys(files).find((k) => k.toLowerCase().endsWith(`/${name}`));
      return key ? files[key]() : Promise.resolve(null);
    };
    const [tripo, makerworld] = await Promise.all([pick('tripo-logo.png'), pick('makerworld-logo.png')]);
    return { tripo, makerworld };
  }
  if (import.meta.env.VITE_COBRAND === '1') return { tripo: 'brand/tripo-logo.png', makerworld: 'brand/makerworld-logo.png' };
  return { tripo: null, makerworld: null };
}

// 一张图先下好、解码好再换上（换的那一下不闪）；下不来返回 null
function decoded(src: string): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.decoding = 'async';
  img.alt = '';
  img.src = src;
  return img.decode().then(() => img, () => null);
}

// 联名标志：[tripo 的标志 + 「tripo」字样] × [MakerWorld 的标志]，两边一样高，tripo 在左。
// 图到之前（或者没有图）是文字「tripo × MakerWorld」；图都下好了才换成图（不会一边是图一边是字）
export function cobrandLockup(size: 'lg' | 'sm'): HTMLDivElement {
  const root = el('div', { className: `cobrand cobrand-${size}` });
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', 'tripo × MakerWorld');
  const text = el('span', { className: 'cb-text' }, el('b', { textContent: 'tripo' }), el('i', { textContent: '×' }), 'MakerWorld');
  text.setAttribute('aria-hidden', 'true');
  root.append(text);
  void brandArt().then(async (a) => {
    if (!a.tripo || !a.makerworld) return;
    const [tripo, mw] = await Promise.all([decoded(a.tripo), decoded(a.makerworld)]);
    if (!tripo || !mw) return;
    tripo.className = 'cb-tripo-mark';
    mw.className = 'cb-mw';
    const word = el('span', { className: 'cb-tripo' }, tripo, el('span', { className: 'cb-tripo-word', textContent: 'tripo' }));
    const x = el('span', { className: 'cb-x', textContent: '×' });
    for (const n of [word, x, mw]) (n as HTMLElement).setAttribute('aria-hidden', 'true');
    root.replaceChildren(word, x, mw);
    root.dataset.art = '';
  });
  return root;
}

// 小船（GBN 的 Benchy）：活动的主题是一艘艘 Benchy 小船航行在世界地图上。标题卡片里活动名前面一只很小的，轻轻上下漂
const BENCHY = '<svg viewBox="0 0 28 20" aria-hidden="true" focusable="false">'
  + '<path class="bb-water" d="M1 17.5c2.2 0 2.2-1.4 4.4-1.4s2.2 1.4 4.4 1.4 2.2-1.4 4.4-1.4 2.2 1.4 4.4 1.4 2.2-1.4 4.4-1.4 2.2 1.4 4.4 1.4" fill="none"/>'
  + '<path class="bb-hull" d="M2.5 11.2h22.6c.6 0 1 .6.7 1.1l-1.9 3.4c-.3.6-.9.9-1.5.9H6.6c-.7 0-1.3-.4-1.6-1z"/>'
  + '<path class="bb-cabin" d="M9.4 11.2V6.4c0-.6.5-1.1 1.1-1.1h7.6c.6 0 1.1.5 1.1 1.1v4.8z"/>'
  + '<rect class="bb-window" x="12.2" y="7" width="3.6" height="2.6" rx="1"/>'
  + '<path class="bb-stack" d="M15.6 5.3V2.4c0-.4.3-.7.7-.7h1.2c.4 0 .7.3.7.7v2.9z"/>'
  + '</svg>';

// 首页标题卡片上的一块：联名标志 + 一行活动名（前面一只小船）
export function cobrandHeader(): HTMLDivElement {
  const boat = el('span', { className: 'cb-boat' });
  boat.innerHTML = BENCHY;
  const event = el('p', { className: 'cb-event' }, boat, el('b', { textContent: EVENT_SHORT }), ` · ${EVENT_NAME}`);
  return el('div', { className: 'cb-head' }, cobrandLockup('lg'), event);
}
