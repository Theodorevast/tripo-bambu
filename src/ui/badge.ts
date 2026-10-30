import './badge.css';
import { el } from './dom';

// 角落里的「Made with Tripo」小徽章：圆体字，左边一个小翠宝（黑色圆球、白色 V、翠宝黄的 T，和 3D 翠宝胸前的标志同一套线段），
// 点了在新标签页打开 Tripo 官网。编辑、漫游、Members / Museum 页开着时先藏起来（badge.css），不和作品栏、提示条抢位置
export const TRIPO_URL = 'https://www.tripo3d.ai';

// 翠宝的标志（身体半径 = 1，y 朝下）：V 是白色两笔，T 的横和斜着的竖是黄色（triboo.ts 的 tribooLogo 同样的坐标，y 翻过来）。
// 固定的标记，不含任何外部数据
const MARK = '<svg viewBox="-1.04 -1.04 2.08 2.08" aria-hidden="true" focusable="false">'
  + '<circle class="mw-body" r="1"/>'
  + '<path class="mw-v" d="M-0.5 -0.3 L-0.03 0.4 L0.44 -0.1"/>'
  + '<path class="mw-t" d="M-0.1 -0.36 L0.46 -0.36 M0.05 -0.36 L-0.12 -0.05"/>'
  + '</svg>';

// 小翠宝标志（同一个 SVG）：Museum 卡片、查看器上「Made with Tripo」的小贴纸也用它
export function tripoMark(className = 'mw-mark'): HTMLSpanElement {
  const span = el('span', { className });
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = MARK;
  return span;
}

export function installBadge(root: HTMLElement): HTMLAnchorElement {
  const link = el('a', { className: 'made-with', href: TRIPO_URL, target: '_blank', rel: 'noopener noreferrer', title: 'tripo3d.ai (opens in a new tab)' });
  link.setAttribute('aria-label', 'Made with Tripo (opens tripo3d.ai in a new tab)');
  const icon = el('span', { className: 'mw-mark' });
  icon.innerHTML = MARK;
  link.append(icon, el('span', { className: 'mw-text' }, 'Made with ', el('b', { textContent: 'Tripo' })));
  root.append(link);
  return link;
}
