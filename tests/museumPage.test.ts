import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Team } from '../src/data/types';
import type { World } from '../src/scenes/world';
import { FakeElement, FakeLocation, installFakeDom } from './fakeDom';

vi.mock('../src/ui/toast', () => ({ toast: vi.fn() }));
const { toast } = await import('../src/ui/toast');
const { MuseumPage } = await import('../src/ui/museumPage');

// 没有作品的团队：网格不建预览渲染器，node 里也能跑
const team: Team = {
  id: 'x', name: 'X', motto: '', color: '#d9b77e', status: 'active', foundedDaysAgo: 1,
  members: [], works: [],
  planet: { seed: 1, preset: 'desert', ring: false, atmosphere: false, placements: [] },
};

function setup(hash: string) {
  new FakeLocation(hash).install();
  const history = { state: null, replaceState: vi.fn() };
  vi.stubGlobal('history', history);
  const page = new MuseumPage(new FakeElement('div') as unknown as HTMLElement, { paused: false } as unknown as World, () => {}, () => {});
  return { page, history };
}

beforeEach(() => {
  installFakeDom();
  vi.mocked(toast).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('MuseumPage：地址里的作品不在这个 Museum', () => {
  it('地址栏还是这条坏地址：提示，并就地改成网格的地址', () => {
    const { page, history } = setup('#/t/x/museum/nope');
    page.open(team, { view: 'museum', teamId: 'x', workId: 'nope' });
    expect(toast).toHaveBeenCalledWith('That work is not in this museum');
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '#/t/x/museum');
  });

  it('轮到它执行时用户已经去了别处（比如 Members）：照样提示，但不改那条新记录', () => {
    const { page, history } = setup('#/t/x/members');
    page.open(team, { view: 'museum', teamId: 'x', workId: 'nope' });
    expect(toast).toHaveBeenCalledWith('That work is not in this museum');
    expect(history.replaceState).not.toHaveBeenCalled();
  });
});
