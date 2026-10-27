// 极简 CSV：支持双引号包裹（内含逗号、换行、"" 转义），第一行是表头，空行跳过。
// 引号只在格子开头才算包裹（12" Lamp 里的 " 是普通字符）；引号到文件末尾都没闭合、
// 或者一行比表头多出非空格子（多半是没加引号的逗号）时报错，报错带文件里的行号（从 1 数）
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: Array<{ cells: string[]; line: number }> = [];
  const src = text.replace(/^\uFEFF/, '');
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1; // 当前字符在第几行
  let rowLine = 1; // 当前这一行数据从第几行开始（引号里可以换行）
  let quoteLine = 1; // 当前引号从第几行开始
  const endRow = () => {
    row.push(cell);
    cell = '';
    if (row.some((c) => c.trim() !== '')) rows.push({ cells: row, line: rowLine });
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else {
        cell += ch;
        if (ch === '\n' || (ch === '\r' && src[i + 1] !== '\n')) line++;
      }
    } else if (ch === '"' && cell.trim() === '') { quoted = true; quoteLine = line; }
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
      rowLine = ++line;
    } else cell += ch;
  }
  if (quoted) throw new Error(`CSV 第 ${quoteLine} 行：这里开始的引号到文件末尾都没有闭合`);
  endRow();
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.cells.map((h) => h.trim());
  return body.map((r) => {
    const extra = r.cells.slice(keys.length).find((c) => c.trim() !== '');
    if (extra !== undefined) {
      throw new Error(`CSV 第 ${r.line} 行：表头只有 ${keys.length} 列，这一行多出了「${extra.trim()}」（格子里有逗号时要用双引号把整格包起来）`);
    }
    return Object.fromEntries(keys.map((k, j) => [k, (r.cells[j] ?? '').trim()]));
  });
}

// 文件名 → 作品 id：去扩展名、小写、非字母数字换成 -
export function slugify(name: string): string {
  return name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'work';
}
