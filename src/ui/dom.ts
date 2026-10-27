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
