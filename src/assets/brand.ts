import { assetUrl } from './versions';

// 品牌素材（Tripo、MakerWorld 的）都放在 public/brand/，开发和构建版都从这里读，跟着 dist/ 一起发布：
// - triboo.glb：翠宝（首页右边缘、开场探头、星球上站桩的、漫游的角色）
// - tripo-logo.png、makerworld-logo.png：联名标志（ui/cobrand.ts）
// - triboo01.gif、boom01.gif：启动画面的像素翠宝（ui/boot.ts）
// 地址按 import.meta.env.BASE_URL 拼：vite.config.ts 的 base 是 './'（相对路径），构建时用 --base=/子路径/ 也找得到。
// 地址带 ?v=<内容指纹>（assets/versions.ts）：public/_headers 让品牌素材缓存一年，换了文件地址跟着变。
// 文件下不来时各自退回原来的替身（代码拼的翠宝、胶囊体、文字的联名、三个圆点），不报错
export function brandUrl(file: string): string {
  return assetUrl(`brand/${file}`);
}

// 翠宝的 GLB：转成完整网址（ModelLibrary 遇到完整网址原样用，不拼到 models/ 下）。
// 几处都用这一个网址：同一个 ModelLibrary 里只下载、解析一次
export function tribooUrl(): string {
  return new URL(brandUrl('triboo.glb'), location.href).href;
}
