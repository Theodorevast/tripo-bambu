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
  it('引号到文件末尾都没闭合时报错，带开引号那一行在文件里的行号', () => {
    expect(() => parseCsv('file,title\r\na.glb,"Lamp\r\nshade"\r\nb.glb,"Bench\r\nc.glb,Chair\r\n')).toThrow(/第 4 行/);
  });
  it('比表头多出非空格子时报错，带行号；多出来的空格子不算', () => {
    expect(() => parseCsv('file,title\n\na.glb,Lamp\nb.glb,Bench, oak\n')).toThrow(/第 4 行/);
    expect(parseCsv('file,title\na.glb,Lamp,,\n')).toEqual([{ file: 'a.glb', title: 'Lamp' }]);
  });
});

describe('slugify', () => {
  it('文件名转 id', () => {
    expect(slugify('My Robot (v2).GLB')).toBe('my-robot-v2');
    expect(slugify('???.glb')).toBe('work');
  });
});
