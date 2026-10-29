import type { Member, PresetId, Team } from '../data/types';
import { PRESET_IDS } from '../planet/presets';

// 「建一颗星球」的数据部分（P3）：草稿、字数限制和提示、团队 id、邀请链接、最后拼成 Team。
// 不碰 DOM、不碰 3D，单元测试直接测（tests/createPlanet.test.ts）

export const LIMITS = {
  nameMin: 2,
  nameMax: 24,
  mottoMax: 60,
  friendMax: 20, // 一个昵称最多几个字
  friends: 5, // 最多邀请几个
};

// 团队色：绘本里的几种糖果色（和界面的翠宝黄、莓红、天蓝、叶绿一个调子），每个带一个名字（读屏、悬停提示用）
export const TEAM_COLORS: ReadonlyArray<{ name: string; hex: string }> = [
  // 第二版（v2-ui）：同样的八种色相，饱和度降下来，和夜空、香槟金放在一起不刺眼（不要糖果色）
  { name: 'Sunflower', hex: '#d6b35e' },
  { name: 'Peach', hex: '#dea283' },
  { name: 'Berry', hex: '#b9868f' },
  { name: 'Lilac', hex: '#8e84b6' },
  { name: 'Sky', hex: '#6f8db0' },
  { name: 'Lagoon', hex: '#5f8f8c' },
  { name: 'Leaf', hex: '#8d9c6c' },
  { name: 'Clay', hex: '#b48766' },
];

// 每种星球一句话（第二步预设旁边的小字）
// 第二版 [v2-world]：跟着新的大地色改了说法
export const PRESET_BLURBS: Record<PresetId, string> = {
  verdant: 'Sage meadows and quiet ponds',
  desert: 'Pale dunes and dry lake beds',
  glacier: 'Frosted fields and slate-blue water',
  volcanic: 'Dark basalt and rust-red fields',
  coral: 'Rose-sand shores and lagoons',
};

export const DEFAULT_MOTTO = 'Freshly launched, still unpacking.';

export interface Draft {
  name: string;
  motto: string;
  preset: PresetId;
  color: string;
  seed: number;
  ring: boolean;
  friends: string[];
  invite: string; // 邀请码（假的：没有后端）
}

export type Rng = () => number;

// 一份新草稿：星球样子、颜色、地形随机（每次打开都不一样），名字留空
export function newDraft(rng: Rng = Math.random): Draft {
  return {
    name: '',
    motto: '',
    preset: PRESET_IDS[Math.floor(rng() * PRESET_IDS.length)] ?? 'verdant',
    color: TEAM_COLORS[Math.floor(rng() * TEAM_COLORS.length)]?.hex ?? TEAM_COLORS[0].hex,
    seed: randomSeed(rng),
    ring: true,
    friends: [],
    invite: inviteCode(rng),
  };
}

// 地形种子（Reroll）：和编辑器的 Reroll terrain 同一个范围
export function randomSeed(rng: Rng = Math.random): number {
  return Math.floor(rng() * 1e9);
}

// 按字（码点）数：表情、中文都算一个
export function charCount(s: string): number {
  return [...s].length;
}

const squash = (s: string) => s.trim().replace(/\s+/g, ' ');

export interface Check {
  ok: boolean;
  message: string; // ok 时是提示（字数、建议），不 ok 时是原因
}

// 团队名：去掉首尾空白后 2–24 个字，至少有一个字母或数字，不能和已有的团队重名（不分大小写、多个空格算一个）
export function checkName(name: string, takenNames: readonly string[]): Check {
  const n = squash(name);
  const len = charCount(n);
  if (len === 0) return { ok: false, message: 'Every planet needs a name.' };
  if (len < LIMITS.nameMin) return { ok: false, message: `A little longer, please: at least ${LIMITS.nameMin} characters.` };
  if (len > LIMITS.nameMax) return { ok: false, message: `Keep it under ${LIMITS.nameMax + 1} characters.` };
  if (!/[\p{L}\p{N}]/u.test(n)) return { ok: false, message: 'Use at least one letter or number.' };
  const key = n.toLowerCase();
  if (takenNames.some((t) => squash(t).toLowerCase() === key)) return { ok: false, message: 'Another team already flies under that name.' };
  return { ok: true, message: `${len}/${LIMITS.nameMax} · short names read best on the name plate` };
}

// 口号：可以不填（用 DEFAULT_MOTTO），最多 60 个字
export function checkMotto(motto: string): Check {
  const len = charCount(squash(motto));
  if (len > LIMITS.mottoMax) return { ok: false, message: `Trim it to ${LIMITS.mottoMax} characters.` };
  return { ok: true, message: len ? `${len}/${LIMITS.mottoMax}` : 'Optional. One line about what you make.' };
}

// 好友昵称：1–20 个字，不能重复（不分大小写），不能是你自己，最多 5 个
export function checkFriend(nick: string, friends: readonly string[], youHandle: string): Check {
  const n = squash(nick);
  const len = charCount(n);
  if (len === 0) return { ok: false, message: 'Type a nickname first.' };
  if (len > LIMITS.friendMax) return { ok: false, message: `Nicknames stop at ${LIMITS.friendMax} characters.` };
  if (friends.length >= LIMITS.friends) return { ok: false, message: `That's a full crew: ${LIMITS.friends} friends max for now.` };
  const key = n.replace(/^@/, '').toLowerCase();
  if (key === youHandle.toLowerCase()) return { ok: false, message: "That's you! You're already the captain." };
  if (friends.some((f) => f.replace(/^@/, '').toLowerCase() === key)) return { ok: false, message: 'Already on the crew.' };
  return { ok: true, message: '' };
}

// 团队名 → 地址里用的 id：小写字母、数字、连字符；拼不出来（全是中文、表情）时用 planet；和已有的 id 重了加 -2、-3……
export function teamIdFor(name: string, takenIds: readonly string[]): string {
  const base = squash(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '') || 'planet';
  const taken = new Set(takenIds);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

// 好友昵称 → 成员的 handle（不带 @）：小写，空格换成下划线，只留字母、数字、下划线、点、连字符
export function handleFor(nick: string, index: number): string {
  const h = squash(nick).replace(/^@/, '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_.-]/g, '').slice(0, LIMITS.friendMax);
  return h || `friend_${index + 1}`;
}

// 邀请码：6 个字，去掉容易看错的 0 O 1 I L
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function inviteCode(rng: Rng = Math.random): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(rng() * CODE_CHARS.length)] ?? 'X';
  return s;
}

// 邀请链接（假的，没有后端）：打开后直接到这颗星球；?invite= 只是个记号，路由不看它。
// base：页面地址去掉查询和 # 的部分（location.origin + location.pathname）
export function inviteLink(base: string, teamId: string, code: string): string {
  return `${base}?invite=${code}#/t/${encodeURIComponent(teamId)}`;
}

export interface Captain {
  memberId: string;
  handle: string;
  displayName: string;
}

// 草稿 → 团队：你是队长，好友是建设者；还没有作品（编辑模式里摆，或者拖 GLB 进来）
export function buildTeam(draft: Draft, id: string, captain: Captain): Team {
  const you: Member = { id: captain.memberId, handle: captain.handle, displayName: captain.displayName, role: 'captain' };
  const crew: Member[] = draft.friends.map((nick, i) => ({ id: `m-${id}-${i + 1}`, handle: handleFor(nick, i), displayName: squash(nick).replace(/^@/, ''), role: 'builder' }));
  return {
    id,
    name: squash(draft.name),
    motto: squash(draft.motto) || DEFAULT_MOTTO,
    color: draft.color,
    status: 'active',
    foundedDaysAgo: 0,
    members: [you, ...crew],
    works: [],
    planet: { seed: draft.seed, preset: draft.preset, ring: draft.ring, atmosphere: true, placements: [] },
    createdByYou: true,
  };
}
