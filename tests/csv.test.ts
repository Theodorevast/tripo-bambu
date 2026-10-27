import { describe, expect, it } from 'vitest';
import { parseCsv, slugify } from '../src/lib/csv';

describe('parseCsv', () => {
  it('解析表头和普通行', () => {
    expect(parseCsv('file,title,author,description\nlighthouse.glb,Old Lighthouse,mia,\n')).toEqual([
      { file: 'lighthouse.glb', title: 'Old Lighthouse', author: 'mia', description: '' },
    ]);
  });
  it('支持引号里的逗号、转义引号、CRLF 和 BOM', () => {
    expect(parseCsv('\uFEFFfile,title\r\na.glb,"Hello, ""World"""\r\n')).toEqual([{ file: 'a.glb', title: 'Hello, "World"' }]);
  });
  it('跳过空行，缺的列补空字符串', () => {
    expect(parseCsv('file,title\n\na.glb\n\n')).toEqual([{ file: 'a.glb', title: '' }]);
  });
  it('引号里的换行留在格子里', () => {
    expect(parseCsv('file,description\na.glb,"line one\nline two"\nb.glb,plain\n')).toEqual([
      { file: 'a.glb', description: 'line one\nline two' },
      { file: 'b.glb', description: 'plain' },
    ]);
  });
  it('格子中间的引号（英寸号）是普通字符，不会吞掉后面的行', () => {
    expect(parseCsv('file,title\nlamp.glb,12" Lamp\nb.glb,Bench\n')).toEqual([
      { file: 'lamp.glb', title: '12" Lamp' },
      { file: 'b.glb', title: 'Bench' },
    ]);
  });
  it('闭合引号后面只能有空格或制表符，然后是逗号或换行；否则报错，带开引号那一行的行号', () => {
    const csv = 'file,title,author,description\na.glb,"Big Lamp,mia,\nb.glb,Bench,zoe,\nc.glb,"Hello, World",kai,\n';
    expect(() => parseCsv(csv)).toThrow(/第 2 行：这里开始的引号在第 4 行闭合/);
    expect(parseCsv('file,title,author\na.glb,"Lamp" \t,mia\n')).toEqual([{ file: 'a.glb', title: 'Lamp', author: 'mia' }]);
  });
  it('引号到文件末尾都没闭合时报错，带开引号那一行在文件里的行号', () => {
    expect(() => parseCsv('file,title\r\na.glb,"Lamp\r\nshade"\r\nb.glb,"Bench\r\nc.glb,Chair\r\n')).toThrow(/第 4 行/);
  });
  it('一行的格子比表头多就报错（多出来的是空格子也算），带行号', () => {
    expect(() => parseCsv('file,title\n\na.glb,Lamp\nb.glb,Bench, oak\n')).toThrow(/第 4 行/);
    expect(() => parseCsv('file,title\na.glb,Lamp,,\n')).toThrow(/第 2 行/);
  });
  it('描述空着、末尾带逗号的行里，标题有没加引号的逗号：报错，不让列错位', () => {
    expect(() => parseCsv('file,title,author,description\nlamp.glb,Lamp, brass,mia,\n')).toThrow(/第 2 行/);
  });
  it('表格软件把表头补齐出来的空列不算列名：每行同样补齐时照常解析，空列里有内容就报错', () => {
    expect(parseCsv('file,title,author,description,,\na.glb,Lamp,mia,,,\n')).toEqual([
      { file: 'a.glb', title: 'Lamp', author: 'mia', description: '' },
    ]);
    expect(() => parseCsv('file,title,,\na.glb,Lamp,oops,\n')).toThrow(/第 2 行/);
  });
  it('表头叫 __proto__ 的列也是自有属性、值不丢，返回的仍是普通对象', () => {
    const [row] = parseCsv('file,__proto__\na.glb,x\n');
    expect(Object.hasOwn(row, '__proto__')).toBe(true);
    expect(row['__proto__']).toBe('x');
    expect(Object.keys(row)).toEqual(['file', '__proto__']);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });
  it('少了闭合引号、后面某行逗号之后的引号（英寸号）紧挨逗号或换行：报错，不把几行悄悄并成一格', () => {
    // 第 2 行的 "Big Lamp 没闭合；第 3 行 12" 后面紧跟逗号，被当成了闭合引号，合并后的行和表头一样宽
    expect(() => parseCsv('file,title,author,description\na.glb,"Big Lamp,mia,\nb.glb,Bench 12",zoe,\nc.glb,Chair,kai,\n'))
      .toThrow(/第 2 行：这里开始的引号一直到第 3 行的「b\.glb,Bench 12"」才闭合/);
    // 引号紧挨换行（最后一列），中间整行被吞掉，CRLF 也一样
    expect(() => parseCsv('file,title,author,description\r\na.glb,Lamp,mia,"A brass lamp\r\nb.glb,Bench,zoe,\r\nc.glb,Chair,kai,Oak 12"\r\n'))
      .toThrow(/第 2 行：这里开始的引号一直到第 4 行/);
    // 真正跨行的格子照常解析：最后一行里没有逗号
    expect(parseCsv('file,title,author\na.glb,"Big Lamp, brass\nsecond line",mia\n')).toEqual([
      { file: 'a.glb', title: 'Big Lamp, brass\nsecond line', author: 'mia' },
    ]);
  });
});

describe('slugify', () => {
  it('文件名转 id', () => {
    expect(slugify('My Robot (v2).GLB')).toBe('my-robot-v2');
    expect(slugify('???.glb')).toBe('work');
  });
});
