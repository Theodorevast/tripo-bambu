// 全部数据类型（对应 spec 第 4.1、5 节）
export type PresetId = 'verdant' | 'desert' | 'glacier' | 'volcanic' | 'coral';

export interface Placement {
  workId: string;
  dir: [number, number, number]; // 单位向量：作品在球面上的方向（星球本地坐标）
  yaw: number; // 绕法线的旋转，弧度
  scale: number; // 0.5–2
}

export interface PlanetRecipe {
  seed: number;
  preset: PresetId;
  ring: boolean;
  atmosphere: boolean;
  placements: Placement[];
}

export interface Member {
  id: string;
  handle: string; // 不带 @
  displayName: string;
  role: 'captain' | 'builder';
}

export interface Work {
  id: string;
  title: string;
  authorId: string; // 指向 Member.id
  file: string; // public/models/ 下的文件名；空字符串 = 占位模型；blob: 开头 = 拖进来的临时作品
  thumb: string; // public/thumbs/ 下的文件名；空字符串 = 纯色块
  tris: number;
  description?: string;
}

export interface Team {
  id: string;
  name: string;
  motto: string;
  color: string; // 团队主色，十六进制
  status: 'active' | 'under-construction';
  foundedDaysAgo: number;
  members: Member[];
  works: Work[];
  planet: PlanetRecipe;
}

export interface Seed {
  teams: Team[];
  you: { teamId: string; memberId: string }; // 演示身份
}
