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
export interface GroundPalette {
  grass: string; // 主草色
  dry: string; // 偏黄的干草：大块噪声混进来，草地不是一个颜色
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
    id: 'verdant', label: 'Verdant', amp: 0.05, freq: 1.4, sea: -0.5,
    ground: { grass: '#5b8a35', dry: '#a3a24c', moss: '#3f6b2a', soil: '#6e5236', path: '#b08f63', rock: '#8c857b' },
    water: '#3c7f8c', atmosphere: '#bfe0f0', ring: '#e8dcc0',
  },
  desert: {
    id: 'desert', label: 'Desert', amp: 0.05, freq: 1.8, sea: null,
    ground: { grass: '#9a9447', dry: '#cdb06c', moss: '#77763d', soil: '#a3714a', path: '#d6b98d', rock: '#a8866a' },
    water: '#000000', atmosphere: '#f6cfa0', ring: '#e6c49c',
  },
  glacier: {
    id: 'glacier', label: 'Glacier', amp: 0.045, freq: 1.2, sea: -0.45,
    ground: { grass: '#8fae9c', dry: '#d6e2df', moss: '#6f9283', soil: '#8a8f93', path: '#d2dadc', rock: '#9ba4aa' },
    water: '#5d9db3', atmosphere: '#dff2f6', ring: '#c8d6dc',
  },
  volcanic: {
    id: 'volcanic', label: 'Volcanic', amp: 0.06, freq: 1.6, sea: null,
    ground: { grass: '#5d6a37', dry: '#80724a', moss: '#3d4a27', soil: '#3c312c', path: '#6e5c50', rock: '#4c4643' },
    water: '#000000', atmosphere: '#e7b39c', ring: '#9d8478',
  },
  coral: {
    id: 'coral', label: 'Coral', amp: 0.05, freq: 1.5, sea: -0.4,
    ground: { grass: '#76a463', dry: '#cbb388', moss: '#58875a', soil: '#9c6c5a', path: '#e2bba2', rock: '#b59689' },
    water: '#4fa3a0', atmosphere: '#f8d6dc', ring: '#efd6cb',
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
