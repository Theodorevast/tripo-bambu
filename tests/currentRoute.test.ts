import { describe, expect, it } from 'vitest';
import { isCurrentRoute } from '../src/lib/currentRoute';

describe('isCurrentRoute', () => {
  it('地址栏还是这条路由', () => {
    expect(isCurrentRoute({ view: 'planet', teamId: 'nope' }, '#/t/nope')).toBe(true);
    expect(isCurrentRoute({ view: 'museum', teamId: 'x', workId: 'w-9' }, '#/t/x/museum/w-9')).toBe(true);
  });

  it('#/ 和空地址都算星系', () => {
    expect(isCurrentRoute({ view: 'galaxy' }, '')).toBe(true);
    expect(isCurrentRoute({ view: 'galaxy' }, '#/')).toBe(true);
  });

  it('同一条路由的不同写法（结尾斜杠、转义）也算', () => {
    expect(isCurrentRoute({ view: 'planet', teamId: 'nope' }, '#/t/nope/')).toBe(true);
    expect(isCurrentRoute({ view: 'planet', teamId: 'a:b' }, '#/t/a:b')).toBe(true);
    expect(isCurrentRoute({ view: 'planet', teamId: 'a b' }, '#/t/a%20b')).toBe(true);
  });

  it('用户已经去了别处：不算', () => {
    expect(isCurrentRoute({ view: 'planet', teamId: 'nope' }, '#/t/a/members')).toBe(false);
    expect(isCurrentRoute({ view: 'museum', teamId: 'x', workId: 'w-9' }, '#/t/x/members')).toBe(false);
    expect(isCurrentRoute({ view: 'museum', teamId: 'x', workId: 'w-9' }, '#/t/x/museum')).toBe(false);
    expect(isCurrentRoute({ view: 'planet', teamId: 'nope' }, '#/')).toBe(false);
  });
});
