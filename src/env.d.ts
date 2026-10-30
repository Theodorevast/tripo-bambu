// 构建时塞进来的公共素材内容指纹（vite.config.ts 的 assetVersions；src/assets/versions.ts 读）。单元测试里没有
declare const __ASSET_VERSIONS__: Record<string, string> | undefined;

// 页面上给自查脚本用的全局标记
interface Window {
  __ready?: boolean; // 应用启动完、首屏内容加载完
  __mv?: { backend: string }; // dev/multiview 页面实际用的渲染后端
  __thumbReady?: boolean; // dev/thumb 页面渲染完
  __app?: import('./debug').DebugHooks; // Playwright 脚本用的坐标换算
  __world?: import('./scenes/world').World; // 截图、测性能的脚本直接调世界（换天空预设、读绘制统计）
  __cursorFx?: import('./ui/cursor').CursorFx; // 鼠标跟随层：测性能时开关、读每帧花的时间（ui/cursor.ts）
}
