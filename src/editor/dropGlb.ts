export const MAX_DROP_BYTES = 100 * 1024 * 1024;

export type DropCheck = { ok: true } | { ok: false; reason: string };

export function checkDrop(file: { name: string; size: number }): DropCheck {
  if (!/\.glb$/i.test(file.name)) return { ok: false, reason: 'Only .glb files can be dropped here' };
  if (file.size > MAX_DROP_BYTES) return { ok: false, reason: 'That file is over 100 MB' };
  return { ok: true };
}

// 整个窗口都能接住拖进来的文件（一次可以拖好几个，全部交给 drop）；无论是否在编辑模式，都阻止浏览器直接打开文件
export function listenForDrops(handlers: { active(): boolean; drop(files: File[]): void; hover(on: boolean): void; inactiveDrop(): void }): void {
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
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    if (handlers.active()) handlers.drop(files);
    else handlers.inactiveDrop();
  });
}
