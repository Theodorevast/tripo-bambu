import * as THREE from 'three/webgpu';
import type { Member, PresetId, Seed, Team, Work } from '../data/types';
import { faceYaw, SHOWCASE_POLE, SHOWCASE_UP } from '../planet/placement.ts';
import { BASE_RADIUS } from '../planet/presets.ts';
import { hashString } from '../planet/rng.ts';

export interface WorkInput {
  id: string;
  title: string;
  author: string; // 作者 handle
  file: string;
  thumb: string;
  tris: number;
  description?: string;
}

export interface TemplateTeam {
  id: string;
  name: string;
  motto: string;
  color: string;
  preset: PresetId;
  seed: number;
  ring: boolean;
  foundedDaysAgo: number;
  crew: Array<{ handle: string; displayName: string }>; // 虚构成员，第一位是队长
}

export interface Template {
  you: { id: string; handle: string; displayName: string };
  teams: TemplateTeam[]; // 前 6 个可以成为有作品的团队，第 7–16 个是 under construction
}

export const MAX_ACTIVE = 6;
export const UNDER_CONSTRUCTION = 10;

// 展示位的弧（小王子式取景，见 showcaseDirs）
export const ARC_POLAR = THREE.MathUtils.degToRad(60); // 后排和展示方向的夹角：比到达镜头看到的轮廓线（约 65°）靠前一点，展台露在地平线上
export const FRONT_POLAR = THREE.MathUtils.degToRad(36); // 前排（6 件起才有）
export const ARC_FAN_MAX = THREE.MathUtils.degToRad(50); // 一排最多向左右各张开这么多
const ARC_GAP = 3.9; // 相邻两件的间距（半径 10 的星球上量）；再宽，4 件时两边的作品斜得像要滑下去
const ARC_MIN_GAP = 3.7; // 一排张不开时最多挤到这么近：两件作品最大的展台（半径约 0.95 × √2/2 × WORK_SIZE ≈ 1.75）也碰不到
const ARC_ROW_MAX = 5; // 一排最多几件

// 团队数 = 作品数 ÷ 3.5 四舍五入，1–6 个
export function activeTeamCount(works: number): number {
  return Math.min(MAX_ACTIVE, Math.max(1, Math.round(works / 3.5)));
}

// handle → 成员 id：NFKC 归一（全角变半角）、小写、去掉开头的 @，字母、组合附标、数字以外的连续字符换成 -。
// 中文等 Unicode 字母、挂在字母上的附标（天城文、泰文的元音符号）原样保留；
// 全是符号（比如只有 emoji）时用哈希兜底，id 不会是空的
export function memberId(handle: string): string {
  const base = handle.normalize('NFKC').toLowerCase().replace(/^@+/, '');
  const slug = base
    .replace(/(?<![\p{L}\p{M}\p{N}])\p{M}+/gu, '') // 没挂在字母数字上的附标（比如 emoji 后的变体选择符 U+FE0F）不算名字
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return `m-${slug || hashString(base).toString(36)}`;
}

// 一个作者：id 是 memberId，handle 用第一次出现的写法（去掉开头的 @）
interface AuthorGroup {
  id: string;
  handle: string;
  works: WorkInput[];
}

// 同一个团队里成员 id 必须唯一：作者 handle 归一后可能和虚构成员撞上
function assertUniqueMembers(team: Team): void {
  const seen = new Map<string, string>();
  for (const m of team.members) {
    const first = seen.get(m.id);
    if (first !== undefined) {
      throw new Error(`团队 ${team.id} 里有两个成员的 id 都是 ${m.id}（${first} 和 ${m.handle}）：改 works.json 的 author 或 teams.template.json 的 crew`);
    }
    seen.set(m.id, m.handle);
  }
}

// 展示位（小王子式取景）：作品沿到达镜头看到的星球上缘排成一道弧，立在地平线上、衬着星空，星球是脚下的舞台。
// 方向 = cos(polar)·展示方向 + sin(polar)·(cos(fan)·屏幕上方 + sin(fan)·屏幕右方)：
// polar 是和展示方向的夹角，fan 是相对屏幕正上方的扇角，一排里左右对称、相邻两件隔 ARC_GAP。
// 5 件以内排一排；6 件起分前后两排，前排更靠近镜头、在画面里低一些
export function showcaseDirs(n: number): Array<[number, number, number]> {
  const pole = new THREE.Vector3(...SHOWCASE_POLE);
  const up = new THREE.Vector3(...SHOWCASE_UP);
  const right = pole.clone().negate().cross(up); // 镜头朝 -pole 看、头顶朝 up 时的屏幕右方
  const row = (count: number, polar: number): Array<[number, number, number]> => {
    const ring = BASE_RADIUS * Math.sin(polar); // 这一排所在小圆的半径
    const stepFor = (gap: number) => 2 * Math.asin(Math.min(1, gap / (2 * ring))); // 小圆上弦长为 gap 的圆心角
    let step = stepFor(ARC_GAP);
    if (count > 1) step = Math.max(Math.min(step, (2 * ARC_FAN_MAX) / (count - 1)), stepFor(ARC_MIN_GAP));
    return Array.from({ length: count }, (_, k) => {
      const fan = (k - (count - 1) / 2) * step;
      const d = pole.clone().multiplyScalar(Math.cos(polar))
        .addScaledVector(up, Math.sin(polar) * Math.cos(fan))
        .addScaledVector(right, Math.sin(polar) * Math.sin(fan))
        .normalize();
      return [d.x, d.y, d.z];
    });
  };
  if (n <= ARC_ROW_MAX) return row(n, ARC_POLAR);
  const back = Math.ceil(n / 2);
  return [...row(back, ARC_POLAR), ...row(n - back, FRONT_POLAR)];
}

export function assembleSeed(template: Template, works: WorkInput[]): Seed {
  // 按作者分组：比的是 memberId，所以大小写、@、_ 和 - 不同的写法算同一个人
  const groups = new Map<string, AuthorGroup>();
  for (const w of works) {
    const id = memberId(w.author);
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { id, handle: w.author.replace(/^@+/, ''), works: [] }));
    g.works.push(w);
  }
  // 团队数不超过作者数，否则会分出没有作品的「有作品团队」；没有作品时是 0
  const active = Math.min(activeTeamCount(works.length), groups.size);
  // 同一作者的作品进同一个团队；大组先放，每次放进当前作品最少的团队
  const buckets: Array<{ authors: AuthorGroup[]; works: WorkInput[] }> = Array.from({ length: active }, () => ({ authors: [], works: [] }));
  for (const g of [...groups.values()].sort((a, b) => b.works.length - a.works.length)) {
    const i = buckets.reduce((best, bucket, k) => (bucket.works.length < buckets[best].works.length ? k : best), 0);
    buckets[i].authors.push(g);
    buckets[i].works.push(...g.works);
  }
  const crewOf = (tt: TemplateTeam): Member[] =>
    tt.crew.map((c, k) => ({ id: memberId(c.handle), handle: c.handle, displayName: c.displayName, role: k === 0 ? 'captain' : 'builder' }));

  const teams: Team[] = template.teams.slice(0, active).map((tt, i) => {
    const { authors, works: ws } = buckets[i];
    const members = [...crewOf(tt), ...authors.map((g): Member => ({ id: g.id, handle: g.handle, displayName: g.handle, role: 'builder' }))];
    if (i === 0) members.push({ id: template.you.id, handle: template.you.handle, displayName: template.you.displayName, role: 'builder' });
    const dirs = showcaseDirs(ws.length);
    return {
      id: tt.id, name: tt.name, motto: tt.motto, color: tt.color, status: 'active', foundedDaysAgo: tt.foundedDaysAgo, members,
      works: ws.map((w): Work => ({
        id: w.id, title: w.title, authorId: memberId(w.author), file: w.file, thumb: w.thumb, tris: w.tris,
        ...(w.description ? { description: w.description } : {}),
      })),
      planet: {
        seed: tt.seed, preset: tt.preset, ring: tt.ring, atmosphere: true,
        placements: ws.map((w, k) => ({ workId: w.id, dir: dirs[k], yaw: faceYaw(dirs[k], SHOWCASE_POLE), scale: 1 })),
      },
    };
  });
  for (const tt of template.teams.slice(MAX_ACTIVE, MAX_ACTIVE + UNDER_CONSTRUCTION)) {
    teams.push({
      id: tt.id, name: tt.name, motto: tt.motto, color: tt.color, status: 'under-construction', foundedDaysAgo: tt.foundedDaysAgo,
      members: crewOf(tt), works: [],
      planet: { seed: tt.seed, preset: tt.preset, ring: tt.ring, atmosphere: true, placements: [] },
    });
  }
  for (const t of teams) assertUniqueMembers(t);
  return { teams, you: { teamId: teams[0]?.id ?? '', memberId: template.you.id } };
}
