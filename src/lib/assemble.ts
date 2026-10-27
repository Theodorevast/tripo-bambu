import * as THREE from 'three/webgpu';
import type { Member, PresetId, Seed, Team, Work } from '../data/types';
import { faceYaw, SHOWCASE_POLE } from '../planet/placement.ts';

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
const CONE = THREE.MathUtils.degToRad(34); // 作品围着展示方向摆成一圈，和它的夹角

// 团队数 = 作品数 ÷ 3.5 四舍五入，1–6 个
export function activeTeamCount(works: number): number {
  return Math.min(MAX_ACTIVE, Math.max(1, Math.round(works / 3.5)));
}

export function memberId(handle: string): string {
  return `m-${handle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

// 展示位：1 件放在正中，多件均匀排在 34° 的圆锥上，镜头飞到星球时一眼能看全
export function showcaseDirs(n: number): Array<[number, number, number]> {
  const pole = new THREE.Vector3(...SHOWCASE_POLE);
  if (n === 1) return [[pole.x, pole.y, pole.z]];
  const t = new THREE.Vector3().crossVectors(pole, new THREE.Vector3(0, 1, 0)).normalize();
  const b = new THREE.Vector3().crossVectors(t, pole).normalize();
  return Array.from({ length: n }, (_, k) => {
    const phi = (2 * Math.PI * k) / n + Math.PI / 2;
    const d = pole.clone().multiplyScalar(Math.cos(CONE))
      .addScaledVector(t, Math.sin(CONE) * Math.cos(phi))
      .addScaledVector(b, Math.sin(CONE) * Math.sin(phi))
      .normalize();
    return [d.x, d.y, d.z];
  });
}

export function assembleSeed(template: Template, works: WorkInput[]): Seed {
  const active = works.length === 0 ? 0 : activeTeamCount(works.length);
  // 按作者分组，同一作者的作品进同一个团队；大组先放，每次放进当前作品最少的团队
  const groups = new Map<string, WorkInput[]>();
  for (const w of works) groups.set(w.author, [...(groups.get(w.author) ?? []), w]);
  const buckets: WorkInput[][] = Array.from({ length: active }, () => []);
  for (const g of [...groups.values()].sort((a, b) => b.length - a.length)) {
    const i = buckets.reduce((best, bucket, k) => (bucket.length < buckets[best].length ? k : best), 0);
    buckets[i].push(...g);
  }
  const crewOf = (tt: TemplateTeam): Member[] =>
    tt.crew.map((c, k) => ({ id: memberId(c.handle), handle: c.handle, displayName: c.displayName, role: k === 0 ? 'captain' : 'builder' }));

  const teams: Team[] = template.teams.slice(0, active).map((tt, i) => {
    const ws = buckets[i];
    const authors: Member[] = [...new Set(ws.map((w) => w.author))].map((a) => ({ id: memberId(a), handle: a, displayName: a, role: 'builder' }));
    const members = [...crewOf(tt), ...authors];
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
  return { teams, you: { teamId: teams[0]?.id ?? '', memberId: template.you.id } };
}
