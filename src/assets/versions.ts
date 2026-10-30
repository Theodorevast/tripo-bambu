// public/ 下模型、缩略图、品牌素材的内容指纹（键是相对 public/ 的路径，比如 models/castle.glb、models/lod/castle.glb）：
// 构建和开发服务器启动时由 vite.config.ts 的 assetVersions 插件算好塞进来。地址后面加 ?v=<指纹>：
// public/_headers 让这些文件缓存一年、不再询问，换了文件（名字不变）指纹就变，浏览器会去下新的。
// 这张表也是「有没有这个文件」的清单：models/lod/ 下有的作品才用 LOD（assets/models.ts 的 lodUrl）。
// 单元测试不走 vite.config.ts，没有这张表：地址不加指纹，也当作没有 LOD
const VERSIONS: Readonly<Record<string, string>> = typeof __ASSET_VERSIONS__ === 'undefined' ? {} : __ASSET_VERSIONS__;

export function hasAsset(path: string): boolean {
  return Object.hasOwn(VERSIONS, path);
}

// 相对 public/ 的路径 → 加上部署的 base 和 ?v=<指纹>（表里没有就不加）
export function assetUrl(path: string): string {
  const v = hasAsset(path) ? VERSIONS[path] : '';
  return `${import.meta.env.BASE_URL}${path}${v ? `?v=${v}` : ''}`;
}
