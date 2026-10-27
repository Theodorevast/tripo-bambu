import { describe, expect, it } from 'vitest';
import { parseRoute, toHash, type Route } from '../src/router';

describe('parseRoute', () => {
  it.each<[string, Route]>([
    ['', { view: 'galaxy' }],
    ['#/', { view: 'galaxy' }],
    ['#/t/nebula', { view: 'planet', teamId: 'nebula' }],
    ['#/t/nebula/members', { view: 'members', teamId: 'nebula' }],
    ['#/t/nebula/museum', { view: 'museum', teamId: 'nebula' }],
    ['#/t/nebula/museum/w-3', { view: 'museum', teamId: 'nebula', workId: 'w-3' }],
    ['#/nope', { view: 'galaxy' }],
    ['#/t/x/what', { view: 'galaxy' }],
    ['#/t/nebula/museum/w-3/x', { view: 'galaxy' }],
    // 某一段的 % 转义是坏的：只有这一段保留原样，交给 App / Museum 提示「团队不存在」「作品不在这里」
    ['#/t/100%', { view: 'planet', teamId: '100%' }],
    ['#/t/%E0%A4%A', { view: 'planet', teamId: '%E0%A4%A' }],
    ['#/t/nebula/museum/%E0%A4%A', { view: 'museum', teamId: 'nebula', workId: '%E0%A4%A' }],
    ['#/t/x/%E0%A4%A', { view: 'galaxy' }],
  ])('%s', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });
});

describe('toHash', () => {
  it('和 parseRoute 互逆', () => {
    const routes: Route[] = [
      { view: 'galaxy' },
      { view: 'planet', teamId: 'a b' },
      { view: 'members', teamId: 'x' },
      { view: 'museum', teamId: 'x' },
      { view: 'museum', teamId: 'x', workId: 'w/1' },
    ];
    for (const r of routes) expect(parseRoute(toHash(r))).toEqual(r);
  });
  it('正常地址 toHash(parseRoute(x)) 原样回来', () => {
    for (const x of ['#/', '#/t/nebula', '#/t/nebula/members', '#/t/nebula/museum', '#/t/nebula/museum/w-3', '#/t/a%20b/museum/w%2F1']) {
      expect(toHash(parseRoute(x))).toBe(x);
    }
  });
});
