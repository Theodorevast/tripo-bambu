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
