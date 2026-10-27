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
});

describe('slugify', () => {
  it('文件名转 id', () => {
    expect(slugify('My Robot (v2).GLB')).toBe('my-robot-v2');
    expect(slugify('???.glb')).toBe('work');
  });
});
