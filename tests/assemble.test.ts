import { describe, expect, it } from 'vitest';
import templateJson from '../src/data/teams.template.json';
import { activeTeamCount, assembleSeed, memberId, showcaseDirs, UNDER_CONSTRUCTION, type Template, type WorkInput } from '../src/lib/assemble';

const template = templateJson as unknown as Template;
const works = (n: number, authors = n): WorkInput[] =>
  Array.from({ length: n }, (_, i) => ({ id: `w${i}`, title: `Work ${i}`, author: `artist${i % authors}`, file: '', thumb: '', tris: 1000 }));
const work = (id: string, author: string): WorkInput => ({ id, title: id, author, file: '', thumb: '', tris: 1000 });

describe('activeTeamCount', () => {
  it('10–24 件作品时每个团队平均 3–4 件，最多 6 个团队', () => {
    for (let n = 10; n <= 24; n++) {
      const t = activeTeamCount(n);
      expect(t).toBeLessThanOrEqual(6);
      expect(n / t).toBeGreaterThanOrEqual(3);
      expect(n / t).toBeLessThanOrEqual(4);
    }
  });
});

describe('assembleSeed', () => {
  it('每件作品恰好分到一个团队，同一作者的作品不拆开', () => {
    const input = works(14, 9);
    const seed = assembleSeed(template, input);
    expect(seed.teams.flatMap((t) => t.works.map((w) => w.id)).sort()).toEqual(input.map((w) => w.id).sort());
    for (const a of new Set(input.map((w) => w.author))) {
      expect(seed.teams.filter((t) => t.works.some((w) => w.authorId === memberId(a)))).toHaveLength(1);
    }
  });
  it('作者都不重复时，每个团队 3–4 件作品', () => {
    for (let n = 10; n <= 24; n++) {
      for (const t of assembleSeed(template, works(n)).teams.filter((x) => x.status === 'active')) {
        expect(t.works.length).toBeGreaterThanOrEqual(3);
        expect(t.works.length).toBeLessThanOrEqual(4);
      }
    }
  });
  it('有作品的团队之外，另有 10 个 under construction 团队，它们没有作品', () => {
    const seed = assembleSeed(template, works(14));
    expect(seed.teams.filter((t) => t.status === 'active')).toHaveLength(4);
    const uc = seed.teams.filter((t) => t.status === 'under-construction');
    expect(uc).toHaveLength(UNDER_CONSTRUCTION);
    expect(uc.every((t) => t.works.length === 0 && t.planet.placements.length === 0)).toBe(true);
  });
  it('作者比团队数少时，团队数跟着作者数走：没有空的有作品团队，作品一件不少', () => {
    const active = assembleSeed(template, works(14, 3)).teams.filter((t) => t.status === 'active');
    expect(active.every((t) => t.works.length > 0)).toBe(true);
    expect(active.flatMap((t) => t.works)).toHaveLength(14);
  });
  it('handle 的不同写法（大小写、_ 和 -）算同一个人：进同一个团队，只算一个成员，用第一次出现的写法', () => {
    const ids = ['x1', 'x2', 'x3'];
    const seed = assembleSeed(template, [...works(9), work('x1', 'Mia_Makes'), work('x2', 'mia-makes'), work('x3', 'MIA_MAKES')]);
    const homes = seed.teams.filter((t) => t.works.some((w) => ids.includes(w.id)));
    expect(homes).toHaveLength(1);
    expect(homes[0].works.filter((w) => ids.includes(w.id))).toHaveLength(3);
    expect(homes[0].members.filter((m) => m.id === memberId('mia_makes'))).toEqual([
      { id: memberId('mia_makes'), handle: 'Mia_Makes', displayName: 'Mia_Makes', role: 'builder' },
    ]);
  });
  it('handle 前面的 @ 不存进成员', () => {
    const seed = assembleSeed(template, [...works(9), work('x1', '@kenji_polys')]);
    expect(seed.teams.flatMap((t) => t.members).filter((m) => m.id === memberId('kenji_polys'))).toEqual([
      { id: memberId('kenji_polys'), handle: 'kenji_polys', displayName: 'kenji_polys', role: 'builder' },
    ]);
  });
  it('同一个团队里成员 id 重复时报错（比如作者和虚构成员同名）', () => {
    expect(() => assembleSeed(template, [work('x1', 'Hexa_Ines')])).toThrow(/m-hexa-ines/);
  });
  it('演示身份在第一个团队里', () => {
    const seed = assembleSeed(template, works(10));
    expect(seed.you.teamId).toBe(seed.teams[0].id);
    expect(seed.teams[0].members.some((m) => m.id === seed.you.memberId)).toBe(true);
  });
  it('每件作品都有摆放，方向是单位向量；作者都在成员里；团队 id 不重复', () => {
    const seed = assembleSeed(template, works(12));
    expect(new Set(seed.teams.map((t) => t.id)).size).toBe(seed.teams.length);
    for (const t of seed.teams) {
      expect(t.planet.placements.map((p) => p.workId)).toEqual(t.works.map((w) => w.id));
      for (const p of t.planet.placements) expect(Math.hypot(...p.dir)).toBeCloseTo(1, 6);
      for (const w of t.works) expect(t.members.some((m) => m.id === w.authorId)).toBe(true);
      expect(t.members.filter((m) => m.role === 'captain')).toHaveLength(1);
    }
  });
});

describe('memberId', () => {
  it('中文名保留原字，两个不同的名字得到两个不同的 id', () => {
    expect(memberId('李明')).toBe('m-李明');
    expect(memberId('王芳')).not.toBe(memberId('李明'));
  });
  it('只差一个组合附标（天城文、泰文的元音符号）的两个名字，id 也不同', () => {
    expect(memberId('मीना')).not.toBe(memberId('मोना'));
    expect(memberId('สุดา')).not.toBe(memberId('สีดา'));
  });
  it('emoji 后面的变体选择符（U+FE0F，也算附标）没挂在字母数字上，不进 id', () => {
    const heart = '\u2764\uFE0F'; // ❤️
    const sun = '\u2600\uFE0F'; // ☀️
    expect(memberId(heart)).toMatch(/^m-[a-z0-9]+$/);
    expect(memberId(heart)).not.toBe(memberId(sun));
    expect(memberId(`mia ${heart} makes`)).toBe(memberId('mia_makes'));
  });
  it('全角按半角算；全是符号时用哈希兜底：非空，不同的输入不同', () => {
    expect(memberId('＠Ｍｉａ＿Ｍａｋｅｓ')).toBe(memberId('mia_makes'));
    expect(memberId('🦊')).toMatch(/^m-[a-z0-9]+$/);
    expect(memberId('🦊')).not.toBe(memberId('🐱'));
  });
});

describe('showcaseDirs', () => {
  it('n 个方向在半径 10 的星球上两两相距 3 以上', () => {
    for (let n = 1; n <= 7; n++) {
      const d = showcaseDirs(n);
      expect(d).toHaveLength(n);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          expect(10 * Math.hypot(d[i][0] - d[j][0], d[i][1] - d[j][1], d[i][2] - d[j][2])).toBeGreaterThan(3);
        }
      }
    }
  });
});
