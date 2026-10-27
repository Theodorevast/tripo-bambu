import { describe, expect, it } from 'vitest';
import type { Team, Work } from '../src/data/types';
import { authorLine, workNumber } from '../src/ui/workCard';

const work = (id: string, authorId = 'm-mia'): Work => ({ id, title: id, authorId, file: '', thumb: '', tris: 12840 });

const team: Team = {
  id: 'lumen-guild',
  name: 'Lumen Guild',
  motto: '',
  color: '#d9b77e',
  status: 'active',
  foundedDaysAgo: 3,
  members: [{ id: 'm-mia', handle: 'mia_makes', displayName: 'Mia', role: 'captain' }],
  works: [work('ph-01'), work('ph-02')],
  planet: { seed: 1, preset: 'verdant', ring: false, atmosphere: false, placements: [] },
};

describe('workNumber', () => {
  it('团队作品：三位序号 + 面数', () => {
    expect(workNumber(team.works[1], team)).toBe('No. 002 · 12,840 tris');
  });

  it('不在团队作品里（拖进来的临时作品）', () => {
    expect(workNumber(work('tmp-1'), team)).toBe('Temporary · not saved');
  });
});

describe('authorLine', () => {
  it('找得到作者时用 handle，找不到时 unknown', () => {
    expect(authorLine(team.works[0], team)).toBe('by @mia_makes');
    expect(authorLine(work('ph-09', 'm-nobody'), team)).toBe('by @unknown');
  });
});
