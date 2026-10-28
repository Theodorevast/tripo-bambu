// 水面（小水塘）：材质、几何都在 nature/water.ts（按地表网格挑出水塘、带水深；浅深渐变、岸边白沫、闪光、水底光斑）
export { waterMaterial } from '../nature/water';

// 大气光晕、光环（planet 角色）：搬到 nature/planetLook.ts——光晕是普通混合的薄晕（晨昏线偏暖、厚度沿轮廓起伏），
// 光环换成一圈慢慢转的苔藓石头带（PlanetLookParts）。这里原来的叠加光晕、条纹光环不再用，删掉了
