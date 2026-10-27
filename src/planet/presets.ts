import type { PresetId } from '../data/types';

export const BASE_RADIUS = 10;

export interface Preset {
  id: PresetId;
  label: string;
  amp: number; // 地形起伏幅度（相对基础半径）
  freq: number; // 噪声基础频率
  sea: number | null; // 海平面在起伏范围里的位置（-1..1）；null = 没有海
  bands: Array<[number, string]>; // [归一化高度上限, 颜色]，从低到高；最后一档上限 > 1
  water: string;
  atmosphere: string;
  ring: string;
}

// 配色整体压低饱和度：星球是展台，作品才是主角
export const PRESETS: Record<PresetId, Preset> = {
  verdant: {
    id: 'verdant', label: 'Verdant', amp: 0.09, freq: 1.4, sea: -0.05,
    bands: [[-0.15, '#8a7d5c'], [0.25, '#5f7a4e'], [0.55, '#4e6340'], [0.8, '#7a6a55'], [1.01, '#e8e4dc']],
    water: '#2f5d7c', atmosphere: '#9cc7e8', ring: '#c9bfa8',
  },
  desert: {
    id: 'desert', label: 'Desert', amp: 0.08, freq: 1.8, sea: null,
    bands: [[-0.4, '#a0603f'], [0.1, '#c08a5a'], [0.5, '#d4a974'], [1.01, '#e3c69a']],
    water: '#000000', atmosphere: '#f0b27a', ring: '#d9b28a',
  },
  glacier: {
    id: 'glacier', label: 'Glacier', amp: 0.07, freq: 1.2, sea: 0,
    bands: [[0.1, '#9fb7c4'], [0.45, '#c9dbe3'], [1.01, '#f2f5f6']],
    water: '#1f3f5a', atmosphere: '#d8f0f5', ring: '#b8c8d0',
  },
  volcanic: {
    id: 'volcanic', label: 'Volcanic', amp: 0.11, freq: 1.6, sea: null,
    bands: [[-0.55, '#c4552b'], [-0.2, '#3a3433'], [0.4, '#2b2727'], [1.01, '#4a4241']],
    water: '#000000', atmosphere: '#b0533c', ring: '#7d6a62',
  },
  coral: {
    id: 'coral', label: 'Coral', amp: 0.08, freq: 1.5, sea: 0.1,
    bands: [[0.2, '#e8b4a0'], [0.5, '#f0c9a8'], [0.75, '#a8d5ba'], [1.01, '#f4e1d2']],
    water: '#3f8f8a', atmosphere: '#f3c4cf', ring: '#e9cfc4',
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
