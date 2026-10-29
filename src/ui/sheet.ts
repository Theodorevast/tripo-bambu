import type { Team } from '../data/types';
import { el } from './dom';
import { icon } from './icons';

// Members、Museum 共用的页头：团队名牌（像贴上去的小标签）、大标题（下面一道手绘波浪线）、一行说明、圆形关闭按钮
export function sheetHead(team: Team, title: string, sub: string, onClose: () => void): HTMLElement {
  const name = el('span', { className: 'sheet-tag', textContent: team.name });
  name.style.setProperty?.('--team', team.color);
  const close = el('button', { className: 'sheet-close', type: 'button', title: 'Close (Esc)', onclick: () => onClose() }, icon('close'));
  close.setAttribute('aria-label', 'Close');
  return el('header', { className: 'sheet-head' },
    el('div', { className: 'sheet-titles' }, name, el('h1', { className: 'display', textContent: title }), el('div', { className: 'sheet-sub', textContent: sub })),
    close,
  );
}

// 团队色上的字用深墨色还是纸白：哪个对比度高用哪个（团队色有浅有深）
export function inkOn(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  if (!Number.isFinite(n)) return '#4a4058';
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  const onInk = (L + 0.05) / (0.061 + 0.05); // 墨色 #4a4058 的相对亮度约 0.061
  const onPaper = (0.912 + 0.05) / (L + 0.05); // 纸白 #fbf5e8 约 0.912
  return onInk >= onPaper ? '#4a4058' : '#fbf5e8';
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
