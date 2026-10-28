import * as THREE from 'three/webgpu';

// 色调映射和曝光：三个渲染器（主画面、Museum 卡片、查看器）共用。?tune 面板改 LOOK，再调 applyLook() 立刻生效。
// 渲染器总是先画到中间缓冲再做色调映射输出（输出要转 sRGB），换色调映射只重建输出那一步，物体的着色器不受影响
export const TONE_MAPPINGS = {
  None: THREE.NoToneMapping,
  Linear: THREE.LinearToneMapping,
  Reinhard: THREE.ReinhardToneMapping,
  Cineon: THREE.CineonToneMapping,
  ACESFilmic: THREE.ACESFilmicToneMapping,
  AgX: THREE.AgXToneMapping,
  Neutral: THREE.NeutralToneMapping,
} as const;

export type ToneMappingName = keyof typeof TONE_MAPPINGS;

// 「小王子」方向回到真实光照：ACES 电影感的色调映射（暖色的高光不发灰，暗部有层次），曝光 1
export const LOOK_DEFAULTS: { toneMapping: ToneMappingName; exposure: number } = { toneMapping: 'ACESFilmic', exposure: 1 };
export const LOOK: { toneMapping: ToneMappingName; exposure: number } = { ...LOOK_DEFAULTS };

// 还在用的渲染器（弱引用）
const renderers = new Set<WeakRef<THREE.WebGPURenderer>>();

function set(renderer: THREE.WebGPURenderer): void {
  renderer.toneMapping = TONE_MAPPINGS[LOOK.toneMapping];
  renderer.toneMappingExposure = LOOK.exposure;
}

// 渲染器初始化后调一次：按 LOOK 设好，以后 applyLook() 也会更新它
export function useLook(renderer: THREE.WebGPURenderer): void {
  renderers.add(new WeakRef(renderer));
  set(renderer);
}

export function applyLook(): void {
  for (const ref of renderers) {
    const renderer = ref.deref();
    if (renderer) set(renderer);
    else renderers.delete(ref);
  }
}
