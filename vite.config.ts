import { defineConfig } from 'vite';
import assetVersions from './scripts/lib/assetVersions.mjs';
import tripoProxy from './server/tripo/vite-plugin.mjs';

// base 用相对路径：构建结果放到任何子路径下都能直接打开
// tripoProxy：开发服务器和 vite preview 上挂 /api/tripo（Tripo API 中转，密钥只在服务端，见 docs/TRIPO.md）
// optimizeDeps.include：导入管线的 Worker（src/works/importWorker.ts）才用到这几个包，开发服务器的预构建扫不到 Worker 里的 import，
// 第一次打开上传窗口时才发现、重新预构建，整页刷新一次（自查脚本会被打断）。先列进来，开页时一起预构建
// worker.format：Worker 打成 ES 模块（默认的 iife 不支持拆包）
// assetVersions：public/ 下模型、缩略图、品牌素材的内容指纹，地址带 ?v=<指纹>，配合 public/_headers 的长缓存（src/assets/versions.ts）
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: '127.0.0.1' },
  plugins: [tripoProxy(), assetVersions()],
  optimizeDeps: { include: ['@gltf-transform/core', '@gltf-transform/extensions', '@gltf-transform/functions', 'meshoptimizer'] },
  worker: { format: 'es' },
});
