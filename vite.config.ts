import { defineConfig } from 'vite';

// base 用相对路径：构建结果放到任何子路径下都能直接打开
// optimizeDeps.include：导入管线的 Worker（src/works/importWorker.ts）才用到这几个包，开发服务器的预构建扫不到 Worker 里的 import，
// 第一次打开上传窗口时才发现、重新预构建，整页刷新一次（自查脚本会被打断）。先列进来，开页时一起预构建
// worker.format：Worker 打成 ES 模块（默认的 iife 不支持拆包）
// TRIPO_PROXY_TARGET：开发时把 /api/tripo 转给本机的中转服务（T1 的服务端，例如 http://127.0.0.1:8787）；不设时不转
const tripoTarget = process.env.TRIPO_PROXY_TARGET;

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: {
    host: '127.0.0.1',
    ...(tripoTarget ? { proxy: { '/api/tripo': { target: tripoTarget, changeOrigin: true } } } : {}),
  },
  optimizeDeps: { include: ['@gltf-transform/core', '@gltf-transform/extensions', '@gltf-transform/functions', 'meshoptimizer'] },
  worker: { format: 'es' },
});
