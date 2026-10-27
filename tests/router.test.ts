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
    ['#/t/100%', { view: 'galaxy' }],
    ['#/t/%E0%A4%A', { view: 'galaxy' }],
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
});
