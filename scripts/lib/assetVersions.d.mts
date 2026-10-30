// assetVersions.mjs 的类型
import type { Plugin } from 'vite';

export function hashPublicAssets(publicDir: string): Record<string, string>;
export default function assetVersions(): Plugin;
