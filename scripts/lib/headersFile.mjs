// Cloudflare 的 _headers 文件（Workers Static Assets 和 Pages 同一套写法，public/_headers 构建时拷进 dist/）：
// 不缩进的一行是地址规则，下面缩进的「名字: 值」是要加的响应头，「! 名字」是去掉；# 开头是注释。
// 规则里的 * 匹配任意一段（贪婪），:名字 匹配一段路径（不含 /）。一个地址可以命中好几条规则，同一个头出现几次就用逗号连起来（和 Cloudflare 一样）。
// 只认路径规则（不支持带域名的完整网址）。给 scripts/perf-load.mjs 的本机预览和 tests/cacheHeaders.test.ts 用

export function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/:[A-Za-z]\w*/g, '[^/]+');
      current = { pattern, re: new RegExp(`^${source}$`), set: [], unset: [] };
      rules.push(current);
      continue;
    }
    if (!current) throw new Error(`_headers：「${line.trim()}」前面没有地址规则`);
    const body = line.trim();
    if (body.startsWith('!')) {
      current.unset.push(body.slice(1).trim().toLowerCase());
      continue;
    }
    const colon = body.indexOf(':');
    if (colon <= 0) throw new Error(`_headers：「${body}」不是「名字: 值」`);
    current.set.push([body.slice(0, colon).trim(), body.slice(colon + 1).trim()]);
  }
  return rules;
}

// 一个路径命中的所有规则合起来：{ set: { 小写名字: [原名, 值] }, unset: Set<小写名字> }
export function headersFor(rules, pathname) {
  const set = new Map();
  const unset = new Set();
  for (const rule of rules) {
    if (!rule.re.test(pathname)) continue;
    for (const [name, value] of rule.set) {
      const key = name.toLowerCase();
      const prev = set.get(key);
      set.set(key, prev ? [prev[0], `${prev[1]}, ${value}`] : [name, value]);
    }
    for (const key of rule.unset) unset.add(key);
  }
  return { set, unset };
}
