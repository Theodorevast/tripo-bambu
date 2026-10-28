// 页面上给自查脚本用的全局标记
interface Window {
  __ready?: boolean; // 应用启动完、首屏内容加载完
  __mv?: { backend: string }; // dev/multiview 页面实际用的渲染后端
  __thumbReady?: boolean; // dev/thumb 页面渲染完
  __app?: import('./debug').DebugHooks; // Playwright 脚本用的坐标换算
  __world?: import('./scenes/world').World; // 截图、测性能的脚本直接调世界（换天空预设、读绘制统计）
}
