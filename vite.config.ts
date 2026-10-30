import { defineConfig } from 'vite';
import tripoProxy from './server/tripo/vite-plugin.mjs';

// base 用相对路径：构建结果放到任何子路径下都能直接打开
// tripoProxy：开发服务器和 vite preview 上挂 /api/tripo（Tripo API 中转，密钥只在服务端，见 docs/TRIPO.md）
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: '127.0.0.1' },
  plugins: [tripoProxy()],
});
