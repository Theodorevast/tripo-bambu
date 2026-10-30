// 界面小图标：24×24，圆头粗线（stroke 跟着文字颜色），一部分带半透明的填色，像贴纸上的简笔画。
// 用 innerHTML 塞进一个 span（常量字符串，没有用户数据）；测试的假 DOM 里也能建
const PATHS = {
  planet: '<circle cx="12" cy="12" r="6.2" fill="currentColor" fill-opacity=".22"/><circle cx="12" cy="12" r="6.2"/><path d="M4.7 15.5C2.4 17.7 1.7 19.6 2.6 20.3c1.5 1.2 6.9-1.6 12-6.2s8.4-9.4 6.9-10.6c-.8-.6-2.6 0-4.9 1.5"/>',
  drop: '<path d="M12 3.2c3.4 4.1 6 7.4 6 10.6a6 6 0 0 1-12 0c0-3.2 2.6-6.5 6-10.6z" fill="currentColor" fill-opacity=".22"/><path d="M12 3.2c3.4 4.1 6 7.4 6 10.6a6 6 0 0 1-12 0c0-3.2 2.6-6.5 6-10.6z"/><path d="M9.3 14.3a2.9 2.9 0 0 0 2.3 2.6"/>',
  flower: '<path d="M12 21v-7.2"/><path d="M12 18.4c-2.5.3-4.2-.7-4.8-3 2.5-.3 4.2.7 4.8 3z" fill="currentColor" fill-opacity=".22"/><circle cx="12" cy="5.6" r="2.5" fill="currentColor" fill-opacity=".22"/><circle cx="15.4" cy="9" r="2.5" fill="currentColor" fill-opacity=".22"/><circle cx="8.6" cy="9" r="2.5" fill="currentColor" fill-opacity=".22"/><circle cx="12" cy="12" r="2.5" fill="currentColor" fill-opacity=".22"/><circle cx="12" cy="9" r="1.5" fill="currentColor"/>',
  grass: '<path d="M3.5 20.5h17"/><path d="M6.5 20.5c0-4.8 1.2-8.6 4.2-12.4"/><path d="M12 20.5c0-6 .3-10.4 1.3-15"/><path d="M17.5 20.5c0-4.2-1.2-7.6-4-10.6"/>',
  sun: '<circle cx="9" cy="9" r="3.2" fill="currentColor" fill-opacity=".22"/><circle cx="9" cy="9" r="3.2"/><path d="M9 2.6v1.3M2.6 9h1.3M4.5 4.5l.9.9M13.5 4.5l-.9.9M4.5 13.5l.9-.9"/><path d="M9.5 20h8a3.3 3.3 0 0 0 .3-6.6 4.6 4.6 0 0 0-8.8 1.4 2.6 2.6 0 0 0 .5 5.2z" fill="currentColor" fill-opacity=".22"/><path d="M9.5 20h8a3.3 3.3 0 0 0 .3-6.6 4.6 4.6 0 0 0-8.8 1.4 2.6 2.6 0 0 0 .5 5.2z"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-1 1.6-2.2-.5-1.4.4-2.6 1.9-2.6h1.9a3.5 3.5 0 0 0 3.5-3.5c0-4.9-4-8.7-8.9-8.7z" fill="currentColor" fill-opacity=".22"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-1 1.6-2.2-.5-1.4.4-2.6 1.9-2.6h1.9a3.5 3.5 0 0 0 3.5-3.5c0-4.9-4-8.7-8.9-8.7z"/><circle cx="7.7" cy="11" r="1.3" fill="currentColor"/><circle cx="10.2" cy="7.2" r="1.3" fill="currentColor"/><circle cx="14.6" cy="7.2" r="1.3" fill="currentColor"/>',
  leaf: '<path d="M5 19c0-8.3 5.5-14 15-14 0 9.5-5.7 15-14 15z" fill="currentColor" fill-opacity=".22"/><path d="M5 19c0-8.3 5.5-14 15-14 0 9.5-5.7 15-14 15z"/><path d="M5 19l8.5-8.5"/>',
  cloud: '<path d="M8 18.5h9.5a3.8 3.8 0 0 0 .6-7.5 5.4 5.4 0 0 0-10.4 1.2A3.2 3.2 0 0 0 8 18.5z" fill="currentColor" fill-opacity=".22"/><path d="M8 18.5h9.5a3.8 3.8 0 0 0 .6-7.5 5.4 5.4 0 0 0-10.4 1.2A3.2 3.2 0 0 0 8 18.5z"/><path d="M1.8 12.5h2.6M2.8 16h1.6"/>',
  camera: '<rect x="3" y="7" width="18" height="13" rx="3.5" fill="currentColor" fill-opacity=".22"/><rect x="3" y="7" width="18" height="13" rx="3.5"/><circle cx="12" cy="13.5" r="3.4"/><path d="M8.6 7l1.3-2.4h4.2L15.4 7"/>',
  frame: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M7 16.8l3.5-4.4 2.6 3 1.9-2.1 2.4 3.5z" fill="currentColor" fill-opacity=".5"/><circle cx="15.6" cy="8.4" r="1.5" fill="currentColor"/>',
  gauge: '<path d="M4.3 17.5a8.6 8.6 0 1 1 15.4 0" fill="none"/><path d="M12 13.6l3.8-4.3"/><circle cx="12" cy="13.8" r="1.6" fill="currentColor"/><path d="M6.6 11.2l.9.6M12 6.5v1M17.4 11.2l-.9.6"/>',
  sparkle: '<path d="M12 3l1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9z" fill="currentColor" fill-opacity=".22"/><path d="M12 3l1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9z"/>',
  ticket: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h14a1.5 1.5 0 0 1 1.5 1.5V10a2 2 0 0 0 0 4v2.5A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5V14a2 2 0 0 0 0-4z" fill="currentColor" fill-opacity=".22"/><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h14a1.5 1.5 0 0 1 1.5 1.5V10a2 2 0 0 0 0 4v2.5A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5V14a2 2 0 0 0 0-4z"/><path d="M14.5 6.5v1.6M14.5 11.2v1.6M14.5 15.9v1.6"/>',
  sliders: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/><circle cx="9" cy="6.5" r="2.4" fill="var(--icon-fill, #fff)"/><circle cx="15.5" cy="12" r="2.4" fill="var(--icon-fill, #fff)"/><circle cx="7.5" cy="17.5" r="2.4" fill="var(--icon-fill, #fff)"/>',
  minus: '<path d="M6.5 12h11"/>',
  grip: '<circle cx="9" cy="7" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="7" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="17" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="1.4" fill="currentColor" stroke="none"/>',
  clipboard: '<rect x="5" y="4.5" width="14" height="16.5" rx="3"/><rect x="8.5" y="2.6" width="7" height="4" rx="1.6" fill="var(--icon-fill, #fff)"/><path d="M8.5 11h7M8.5 14.5h7M8.5 18h4"/>',
  check: '<path d="M5 12.5l4.3 4.3L19 7.2"/>',
  close: '<path d="M6.8 6.8l10.4 10.4M17.2 6.8L6.8 17.2"/>',
  flip: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.6 3.6v4.8h-4.8"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" fill="currentColor" fill-opacity=".18"/><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  crown: '<path d="M4.2 17.5L3 8.6l5 3.9 4-6.5 4 6.5 5-3.9-1.2 8.9z" fill="currentColor" fill-opacity=".3"/><path d="M4.2 17.5L3 8.6l5 3.9 4-6.5 4 6.5 5-3.9-1.2 8.9z"/><path d="M4.5 20.5h15"/>',
  pencil: '<path d="M4 20l1-4.6L15.6 4.8a2.1 2.1 0 0 1 3 0l.6.6a2.1 2.1 0 0 1 0 3L8.6 19z" fill="currentColor" fill-opacity=".22"/><path d="M4 20l1-4.6L15.6 4.8a2.1 2.1 0 0 1 3 0l.6.6a2.1 2.1 0 0 1 0 3L8.6 19z"/><path d="M13.6 6.8l3.6 3.6"/>',
  star: '<path d="M12 3.2l2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8-5.3 2.8 1-6-4.4-4.2 6-.9z" fill="currentColor" fill-opacity=".3"/><path d="M12 3.2l2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8-5.3 2.8 1-6-4.4-4.2 6-.9z"/>',
  orbit: '<path d="M20.2 9.5A8.5 8.5 0 0 0 5 7.2"/><path d="M3.8 14.5A8.5 8.5 0 0 0 19 16.8"/><path d="M4.6 3.6v3.8h3.8M19.4 20.4v-3.8h-3.8"/>',
  mouse: '<rect x="7" y="3.5" width="10" height="17" rx="5"/><path d="M12 7.3v3"/>',
  arrow: '<path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5"/>',
  // 上传、Tripo 生成窗口（ui/genaiDialog.ts）用的几个
  upload: '<path d="M4.5 15.5v2.2a2.3 2.3 0 0 0 2.3 2.3h10.4a2.3 2.3 0 0 0 2.3-2.3v-2.2" fill="none"/><path d="M12 15V4.5M7.5 8.8L12 4.3l4.5 4.5"/>',
  quote: '<path d="M4 6.5h16v9.2H11l-4.6 3.8v-3.8H4z" fill="currentColor" fill-opacity=".22"/><path d="M4 6.5h16v9.2H11l-4.6 3.8v-3.8H4z"/><path d="M8 10.2h8M8 13h5"/>',
  views: '<rect x="3.5" y="3.5" width="7.4" height="7.4" rx="2" fill="currentColor" fill-opacity=".22"/><rect x="3.5" y="3.5" width="7.4" height="7.4" rx="2"/><rect x="13.1" y="3.5" width="7.4" height="7.4" rx="2"/><rect x="3.5" y="13.1" width="7.4" height="7.4" rx="2"/><rect x="13.1" y="13.1" width="7.4" height="7.4" rx="2"/>',
  alert: '<path d="M12 3.6l9 15.6H3z" fill="currentColor" fill-opacity=".18"/><path d="M12 3.6l9 15.6H3z"/><path d="M12 9.6v4.4"/><circle cx="12" cy="16.9" r="1.1" fill="currentColor" stroke="none"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function iconSvg(name: IconName): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
}

export function icon(name: IconName, className = ''): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `icon${className ? ` ${className}` : ''}`;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = iconSvg(name);
  return span;
}
