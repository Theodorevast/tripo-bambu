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
  file: string; // public/models/ 下的文件名；空字符串 = 占位模型；blob: 开头 = 拖进来的临时作品，或用户作品（存在 IndexedDB 里，启动时注册成 blob URL）
  thumb: string; // public/thumbs/ 下的文件名；空字符串 = 纯色块；blob: 开头 = 用户作品的缩略图
  tris: number;
  description?: string;
  // —— 用户作品（上传的、用 Tripo 生成的，src/works/）才有下面这几个；种子里的作品没有 ——
  source?: 'upload' | 'tripo';
  prompt?: string; // Tripo 文字生成的提示词（Museum 卡片上显示）
  mode?: 'text' | 'image' | 'multiview'; // Tripo 生成方式
  authorHandle?: string; // 作者的 @handle（不带 @）：作者不在这个团队的成员里时（演示里每颗星球都能加作品）用它显示作者
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
  // 这个浏览器里用「Create a planet」建的团队（存在本地，不在 seed.json 里），归「你」：可以编辑。种子里的团队没有这个字段
  createdByYou?: boolean;
}

export interface Seed {
  teams: Team[];
  you: { teamId: string; memberId: string }; // 演示身份
}
