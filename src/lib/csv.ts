// 极简 CSV：支持双引号包裹（内含逗号、换行、"" 转义），第一行是表头，空行跳过。
// 引号只在格子开头才算包裹（12" Lamp 里的 " 是普通字符）。表头里空着的列（表格软件补齐出来的）不算列名；
// 格子比表头少时缺的列补空字符串。下面几种情况报错，报错带文件里的行号（从 1 数）：
// 引号到文件末尾都没闭合；闭合引号后面除了空格还有别的字；一行的格子比表头多（多半是没加引号的逗号）；
// 表头空着的那一列里有内容
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: Array<{ cells: string[]; line: number }> = [];
  const src = text.replace(/^\uFEFF/, '');
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closed = false; // 这一格的引号已经闭合：后面只能有空格或制表符，然后是逗号或换行
  let line = 1; // 当前字符在第几行
  let rowLine = 1; // 当前这一行数据从第几行开始（引号里可以换行）
  let quoteLine = 1; // 当前引号从第几行开始
  const endCell = () => {
    row.push(cell);
    cell = '';
    closed = false;
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== '')) rows.push({ cells: row, line: rowLine });
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else {
        cell += ch;
        if (ch === '\n' || (ch === '\r' && src[i + 1] !== '\n')) line++;
      }
    } else if (ch === ',') endCell();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
      rowLine = ++line;
    } else if (closed) {
      if (ch !== ' ' && ch !== '\t') {
        const rest = src.slice(i, i + 20).split(/[,\r\n]/)[0];
        throw new Error(`CSV 第 ${quoteLine} 行：这里开始的引号在第 ${line} 行闭合，后面紧跟着「${rest}」（引号要包住整格；是不是少了闭合引号？）`);
      }
    } else if (ch === '"' && cell.trim() === '') { quoted = true; quoteLine = line; }
    else cell += ch;
  }
  if (quoted) throw new Error(`CSV 第 ${quoteLine} 行：这里开始的引号到文件末尾都没有闭合`);
  endRow();
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.cells.map((h) => h.trim());
  return body.map((r) => {
    if (r.cells.length > keys.length) {
      throw new Error(`CSV 第 ${r.line} 行：有 ${r.cells.length} 格，比表头的 ${keys.length} 列多（格子里有逗号时要用双引号把整格包起来）`);
    }
    const record: Record<string, string> = {};
    for (const [j, k] of keys.entries()) {
      const value = (r.cells[j] ?? '').trim();
      if (k !== '') record[k] = value;
      else if (value !== '') throw new Error(`CSV 第 ${r.line} 行：第 ${j + 1} 列的表头是空的，这一格却有「${value}」`);
    }
    return record;
  });
}

// 文件名 → 作品 id：去扩展名、小写、非字母数字换成 -
export function slugify(name: string): string {
  return name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'work';
}
