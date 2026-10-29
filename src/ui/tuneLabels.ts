// 调参面板上的参数名改成人话（tuneShell 给每个 addBinding 套一层）：
// 常量名 PLANET_RADIUS → Planet radius；驼峰 seaHeight → Sea height；本来就是一句话的只把首字母大写（rocks at rim × → Rocks at rim ×）。
// 单位、符号、括号照旧；几个缩写写成大写（fov → FOV）
const ACRONYMS: Array<[RegExp, string]> = [
  [/\bfov\b/gi, 'FOV'],
  [/\bcpu\b/gi, 'CPU'],
  [/\bgpu\b/gi, 'GPU'],
  [/\bagx\b/gi, 'AgX'],
  [/\buv\b/gi, 'UV'],
  [/\brgb\b/gi, 'RGB'],
];

export function friendlyLabel(raw: string): string {
  let s = raw.trim();
  if (!s) return raw;
  if (/^[A-Z][A-Z0-9_]*$/.test(s)) s = s.toLowerCase().replace(/_+/g, ' ').trim();
  else if (/^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*$/.test(s)) s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  for (const [re, word] of ACRONYMS) s = s.replace(re, word);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
