import type { PresetId } from '../data/types';

// 星球半径（世界单位 = 米）：全局常量，?tune 面板可以实时拖（15–60）。导出的是活绑定：别的模块 import 进去的值跟着变。
// 角色身高约 1 米、作品最长边约 1.6 米（placement.ts），这里定星球多大：默认 30，角色 ÷ 星球直径 ≈ 1/60。
// 地形起伏、展台贴地、碰撞、镜头距离都按它换算；改了以后由 setPlanetRadius 通知各处重建
export let PLANET_RADIUS = 30;
export const PLANET_RADIUS_MIN = 15;
export const PLANET_RADIUS_MAX = 60;
// 旧版的星球半径：摆放方向（单位向量）当初按它排的，展示位的间距（assemble.ts）还按它算，种子数据不用重新生成
export const LAYOUT_RADIUS = 10;

const radiusListeners = new Set<(r: number) => void>();

// 半径变了要重建的东西在这里登记（星球地形、草、石头、作品贴地、星系布局、镜头）；返回取消登记的函数
export function onPlanetRadius(fn: (r: number) => void): () => void {
  radiusListeners.add(fn);
  return () => radiusListeners.delete(fn);
}

export function setPlanetRadius(r: number): void {
  const next = Math.min(PLANET_RADIUS_MAX, Math.max(PLANET_RADIUS_MIN, r));
  if (next === PLANET_RADIUS) return;
  PLANET_RADIUS = next;
  for (const fn of radiusListeners) fn(next);
}

// 地面配色：地表着色器按噪声遮罩在这几种颜色之间平滑混合（草地、干草、苔藓、泥土、土路），石头用 rock
// 草叶（nature/grass.ts）也用这一组颜色（集成时统一的）：lush = grass、dry = dry，另加 fresh、tip、root；
// 地表远看的草色和草叶的色斑走同一条公式（grassTint），草淡出的地方接得上。都是在 AgX（曝光 1.4）下调的
export interface GroundPalette {
  grass: string; // 主草色（草叶的 lush）
  fresh: string; // 嫩草色：一片一片地和主草色交替（草叶的 fresh）
  dry: string; // 偏黄的干草：大块噪声混进来，草地不是一个颜色
  tip: string; // 草尖（亮、偏暖）
  root: string; // 草根、草丛深处（近处地面从草缝里露出来的颜色也往它靠）
  moss: string; // 苔藓斑块：低洼、背阴处多
  soil: string; // 泥土：草稀的地方露出来
  path: string; // 土路
  rock: string; // 石头
}

export interface Preset {
  id: PresetId;
  label: string;
  amp: number; // 地形起伏幅度（相对星球半径）
  freq: number; // 噪声基础频率
  sea: number | null; // 水面在起伏范围里的位置（-1..1）；null = 没有水。「小王子」方向只留低洼处的小水塘
  ground: GroundPalette;
  water: string;
  atmosphere: string;
  ring: string;
}

// 「小王子」方向：缓坡草甸，起伏只占半径的 4–6%（半径 30 时 ±1.2–1.8 米，角色 1 米高走起来有起伏，星球轮廓仍是圆的）。
// 水面压得很低，只在最低的洼地里留几个小水塘（星球外面的「海」是云海）
export const PRESETS: Record<PresetId, Preset> = {
  verdant: {
    id: 'verdant', label: 'Verdant', amp: 0.05, freq: 1.4, sea: -0.62,
    ground: { grass: '#293412', fresh: '#3c4816', dry: '#555327', tip: '#6f7938', root: '#11160a', moss: '#222c10', soil: '#3a2a18', path: '#745a3a', rock: '#4b463f' },
    water: '#3c7f8c', atmosphere: '#bfe0f0', ring: '#e8dcc0',
  },
  desert: {
    id: 'desert', label: 'Desert', amp: 0.05, freq: 1.8, sea: null,
    ground: { grass: '#66610a', fresh: '#7b721a', dry: '#8e7637', tip: '#998d51', root: '#322b0d', moss: '#4d4d12', soil: '#6f4723', path: '#957c53', rock: '#715946' },
    water: '#000000', atmosphere: '#f6cfa0', ring: '#e6c49c',
  },
  glacier: {
    id: 'glacier', label: 'Glacier', amp: 0.045, freq: 1.2, sea: -0.45,
    ground: { grass: '#597464', fresh: '#6b8274', dry: '#8f9a97', tip: '#98a29d', root: '#26362f', moss: '#426054', soil: '#595d61', path: '#8d9496', rock: '#686e72' },
    water: '#5d9db3', atmosphere: '#dff2f6', ring: '#c8d6dc',
  },
  volcanic: {
    id: 'volcanic', label: 'Volcanic', amp: 0.06, freq: 1.6, sea: null,
    ground: { grass: '#3a4512', fresh: '#495411', dry: '#574b27', tip: '#717138', root: '#151a0c', moss: '#242f0d', soil: '#261d18', path: '#4b3b30', rock: '#312d2a' },
    water: '#000000', atmosphere: '#e7b39c', ring: '#9d8478',
  },
  coral: {
    id: 'coral', label: 'Coral', amp: 0.05, freq: 1.5, sea: -0.4,
    ground: { grass: '#456d31', fresh: '#5a7f39', dry: '#8c7852', tip: '#90985e', root: '#1a3215', moss: '#2f5931', soil: '#6a4434', path: '#9e7d66', rock: '#7a645b' },
    water: '#4fa3a0', atmosphere: '#f8d6dc', ring: '#efd6cb',
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
