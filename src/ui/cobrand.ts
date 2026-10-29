import './cobrand.css';
import { brandUrl } from '../assets/brand';
import { el } from './dom';

// 联名（tripo × MakerWorld，GBN 活动）：首页标题卡片上的联名标志和活动名、领券窗口顶上的小标志。
// 标志图是品牌素材，放在 public/brand/（tripo-logo.png、makerworld-logo.png），开发和构建版都从这里读（assets/brand.ts）
// 图到之前、或者下不来时：显示文字「tripo × MakerWorld」（Nunito）
// tripo 用黑底方块的那张（tripo-logo.png）：去掉黑底的那张 V 是白色的，放在暖白纸面上看不见

// 活动名：活动页 campaign.makerworld.com/gbn/ 的标题是「GBN | Great Benchy Nations」
export const EVENT_SHORT = 'GBN';
export const EVENT_NAME = 'Great Benchy Nations';

export interface BrandArt {
  tripo: string; // tripo 的标志（黑底方块）
  makerworld: string; // MakerWorld 的标志（黑字透明底）
}

export function brandArt(): BrandArt {
  return { tripo: brandUrl('tripo-logo.png'), makerworld: brandUrl('makerworld-logo.png') };
}

// 一张图先下好、解码好再换上（换的那一下不闪）；下不来返回 null。node 里跑测试时没有 Image，也当作下不来
function decoded(src: string): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null);
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
  const a = brandArt();
  void Promise.all([decoded(a.tripo), decoded(a.makerworld)]).then(([tripo, mw]) => {
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
