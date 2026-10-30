// node-adapter.mjs 的类型
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MockAsset, TripoEnv, TripoHandle } from './handler.mjs';

export const DEFAULT_MOCK_MODEL: string;
export function loadEnvFiles(options?: { dir?: string | null; mode?: string; processEnv?: TripoEnv }): TripoEnv;
export function modeBanner(env: TripoEnv): { level: 'info' | 'warn'; text: string };
export function clientIp(req: IncomingMessage, trustProxy?: number): string;
export function toWebRequest(req: IncomingMessage): Request;
export function sendWebResponse(res: ServerResponse, response: Response, method?: string): Promise<void>;
export function createNodeMiddleware(options: {
  handle: TripoHandle;
  getEnv: () => TripoEnv;
  trustProxy?: (env: TripoEnv) => number;
  log?: { error?: (msg: string) => void };
}): (req: IncomingMessage, res: ServerResponse, next?: () => void) => Promise<void>;
export function createFileLoaders(options: { dirs: Array<string | null | undefined> }): {
  loadMockModel(env: TripoEnv): Promise<MockAsset | null>;
  loadMockPreview(env: TripoEnv): Promise<MockAsset | null>;
};
