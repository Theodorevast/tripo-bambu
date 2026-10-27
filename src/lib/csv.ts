// 极简 CSV：支持双引号包裹（内含逗号、换行、"" 转义），第一行是表头，空行跳过
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  const src = text.replace(/^\uFEFF/, '');
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = '';
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
    } else cell += ch;
  }
  endRow();
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, j) => [k, (r[j] ?? '').trim()])));
}

// 文件名 → 作品 id：去扩展名、小写、非字母数字换成 -
export function slugify(name: string): string {
  return name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'work';
}
