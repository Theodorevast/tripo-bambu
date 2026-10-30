// Vite 插件：给 public/ 下的模型、缩略图、品牌素材算内容指纹（md5 前 10 位），作为 __ASSET_VERSIONS__ 塞进前端（src/assets/versions.ts）。
// 代码里的地址带 ?v=<指纹>，配合 public/_headers 的长缓存：文件换了（名字不变）地址就变，浏览器不会一直用旧的。
// 每次起开发服务器、构建时现算（约 100 MB，零点几秒），不用手动维护清单
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const DIRS = ['models', 'thumbs', 'brand'];

export function hashPublicAssets(publicDir) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[path.relative(publicDir, full).split(path.sep).join('/')] = createHash('md5').update(readFileSync(full)).digest('hex').slice(0, 10);
    }
  };
  for (const d of DIRS) if (existsSync(path.join(publicDir, d))) walk(path.join(publicDir, d));
  return out;
}

export default function assetVersions() {
  return {
    name: 'asset-versions',
    config(config) {
      const root = config.root ? path.resolve(config.root) : process.cwd();
      const publicDir = config.publicDir === false ? null : path.resolve(root, config.publicDir ?? 'public');
      const versions = publicDir && existsSync(publicDir) ? hashPublicAssets(publicDir) : {};
      return { define: { __ASSET_VERSIONS__: JSON.stringify(versions) } };
    },
  };
}
