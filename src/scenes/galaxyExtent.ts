// 首页螺旋星系的星尘什么时候要重撒（v2-ui，main 批准）：星系的外沿（最外那颗星球离中心多远，maxR）只是一点点变化时不重撒。
// 臂本来就画到最外那颗星球外面 extra 个半径（homeGalaxy.ts 的 HOME_DUST.extra），新加的一颗（造星以后）还在星尘里面；
// 重撒要重算几万粒、整段重传 4 个属性，原来正好落在造星 Launch 的那一帧上。
// 外沿扩大超过 extra · R / 2（新星球快要出了星尘的范围）才重撒；缩小的阈值更紧：超过 extra · R / 4 就重撒
// （星系变小了还留着原来的星尘，臂会伸出去一截空着的；Reset demo 是整页重新载入，本来就会按新的大小重撒）。
// 版式还会把整个星系在平面里转一点（主轴跟着星球分布变，多一颗就变一点，实测造星时 6° 左右）：整片星尘跟着转，不重撒。
// 宽屏（没有拉长）转多少都和重撒出来的一样；手机竖屏星尘沿纵深拉长过，转了再拉长不完全对得上，所以只容许转一点点

export interface GalaxyBuild {
  maxR: number;
  stretch: number; // 手机竖屏沿纵深拉长多少
  rotation: number; // 版式把星系转了多少（弧度）
  params: string; // 螺旋臂、星尘的参数（?tune 改了就重撒）
}

export const KEEP_TURN = 0.3; // 弧度（约 17°）：宽屏
export const KEEP_TURN_STRETCHED = 0.06; // 弧度（约 3.4°）：手机竖屏（拉长过）

export function galaxyNeedsRebuild(builtMaxR: number, maxR: number, radius: number, extra: number): boolean {
  if (!(builtMaxR >= 0)) return true; // 还没撒过
  const grow = (extra * radius) / 2;
  const shrink = (extra * radius) / 4;
  return maxR > builtMaxR + grow || maxR < builtMaxR - shrink;
}

// 现在这片星尘能不能沿用（不能就按 next 重撒）
export function keepGalaxy(built: GalaxyBuild | null, next: GalaxyBuild, radius: number, extra: number): boolean {
  const turn = next.stretch === 1 ? KEEP_TURN : KEEP_TURN_STRETCHED;
  return built !== null && built.stretch === next.stretch && built.params === next.params
    && Math.abs(next.rotation - built.rotation) < turn && !galaxyNeedsRebuild(built.maxR, next.maxR, radius, extra);
}
