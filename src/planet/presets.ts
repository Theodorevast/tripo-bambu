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
  sand: string; // 沙滩、浅海底（没有水的预设：盆地边上的干湖 / 火山灰）
  deep: string; // 深海底（没有水的预设：盆地中间）
  far: string; // 俯瞰时的底色（星球视图、星系里没有 3D 的草，地面就是远看的草色）：比草叶亮、鲜，绘本里的春绿
  field: string; // 俯瞰时朝阳的大片（黄绿；沙漠是沙丘的赭黄、冰川是雪白、火山是锈红）
}

export interface Preset {
  id: PresetId;
  label: string;
  amp: number; // 地形起伏幅度（相对星球半径）
  freq: number; // 草甸起伏的基础频率
  sea: number | null; // 水面在起伏范围里的位置（-1..1）；null = 没有水
  continentFreq: number; // 大陆噪声的频率：大 → 大陆碎成更多的岛和海湾
  land: number; // 大陆值的偏移：大 → 陆地多、海少（noise.ts）
  basin: number; // 没有水的预设：假想的低地线（-1..1），低于它的盆地着成干湖、灰原；有水的预设不用
  ground: GroundPalette;
  water: string;
  atmosphere: string;
  ring: string;
}

// 「小王子」方向：缓坡草甸，起伏只占半径的 4–6%（半径 30 时 ±1.2–1.8 米，角色 1 米高走起来有起伏，星球轮廓仍是圆的）。
// 水面压得很低，只在最低的洼地里留几个小水塘（星球外面的「海」是云海）
//
// 第二版 [v2-world] 的「大地」色板（art-direction.md）：草是 Sage #8d9c86、Moss #5c6b55、Lichen #a7ab8a，石头 Stone #8f8b84、Slate #6a7389，
// 沙 Sand #c7b69a，水偏灰蓝 Water #5f7f97。不要荧光绿、糖果色。每个键先按色板挑「显示色」，再按第一版同一个键的线性亮度缩放
// （第一版的亮度是按 AgX、tint、farTint 调好的），所以色相、饱和度是色板的，明暗和第一版一样。五个预设靠色相分开：
// 草甸（灰绿）、沙丘（沙色）、霜原（灰蓝、雪白）、玄武岩（深橄榄、锈色田）、海岛（偏青的灰绿、玫瑰色的岸）
export const PRESETS: Record<PresetId, Preset> = {
  verdant: {
    id: 'verdant', label: 'Verdant', amp: 0.06, freq: 1.4, sea: -0.12, continentFreq: 1.15, land: 0.02, basin: 0,
    ground: { grass: '#293e2a', fresh: '#3c553f', dry: '#536345', tip: '#728c67', root: '#101d11', moss: '#233523', soil: '#322c26', path: '#776d5a', rock: '#444241', sand: '#857966', deep: '#233340', far: '#739b75', field: '#b0da9e' },
    water: '#5f7f97', atmosphere: '#c5cdd8', ring: '#d8c08e',
  },
  desert: {
    id: 'desert', label: 'Desert', amp: 0.06, freq: 1.8, sea: null, continentFreq: 1.3, land: 0.06, basin: -0.2,
    ground: { grass: '#69664d', fresh: '#7c785d', dry: '#8b8062', tip: '#9e9578', root: '#322e23', moss: '#52503b', soil: '#5d4d3e', path: '#9a876d', rock: '#61574b', sand: '#b9a98f', deep: '#9e8e75', far: '#9f8c6f', field: '#c8ba9b' },
    water: '#000000', atmosphere: '#d9c9b8', ring: '#d8c08e',
  },
  glacier: {
    id: 'glacier', label: 'Glacier', amp: 0.055, freq: 1.2, sea: -0.1, continentFreq: 1.0, land: -0.02, basin: 0,
    ground: { grass: '#627d75', fresh: '#728a85', dry: '#92a6a8', tip: '#9eb0af', root: '#2a3a39', moss: '#50665f', soil: '#595d63', path: '#9da3aa', rock: '#5f6880', sand: '#acb1b5', deep: '#293d4c', far: '#83a1b0', field: '#dbe8e9' },
    water: '#6d8ea4', atmosphere: '#d3dbe4', ring: '#c9ccd2',
  },
  volcanic: {
    id: 'volcanic', label: 'Volcanic', amp: 0.065, freq: 1.6, sea: null, continentFreq: 1.4, land: 0.04, basin: -0.25,
    ground: { grass: '#384c38', fresh: '#485b43', dry: '#4d553f', tip: '#6d7b5c', root: '#151d16', moss: '#253324', soil: '#231e1b', path: '#4f443c', rock: '#2a2b32', sand: '#565259', deep: '#373340', far: '#5d6c55', field: '#766b5e' },
    water: '#000000', atmosphere: '#c9b3b0', ring: '#a8894f',
  },
  coral: {
    id: 'coral', label: 'Coral', amp: 0.055, freq: 1.5, sea: -0.05, continentFreq: 1.7, land: -0.1, basin: 0,
    ground: { grass: '#567a62', fresh: '#678f77', dry: '#7c916f', tip: '#91af87', root: '#243828', moss: '#436448', soil: '#594a43', path: '#a89185', rock: '#6b6060', sand: '#bea697', deep: '#2f4b5a', far: '#7ba78c', field: '#cdb3a6' },
    water: '#5f8a94', atmosphere: '#d9c8cb', ring: '#d8c08e',
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
