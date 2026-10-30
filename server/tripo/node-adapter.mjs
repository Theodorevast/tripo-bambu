// Node 外壳共用的部分（vite-plugin.mjs、node-server.mjs）：Node 的 req/res 和 Web 标准的 Request/Response 互转、
// 取客户端 IP、模拟模式下从本地读模型和预览图。只用 Node 自带模块。
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseEnv } from 'node:util';
import { isTripoPath, readConfig } from './handler.mjs';

// 模拟模式默认用的模型：public/models/ 里最小的几个之一
export const DEFAULT_MOCK_MODEL = 'models/tufted-armchair.glb';

// 读 env 文件（和 Vite 同一个顺序，后面的盖前面的：.env < .env.local < .env.[mode] < .env.[mode].local），
// 最后用进程环境变量整个盖上去：进程环境变量优先级最高。命令行上的 TRIPO_MOCK=1 一定生效，.env.local 里有密钥也照样走模拟
export function loadEnvFiles({ dir, mode, processEnv = process.env } = {}) {
  const names = ['.env', '.env.local', ...(mode ? [`.env.${mode}`, `.env.${mode}.local`] : [])];
  const merged = {};
  if (dir) {
    for (const name of names) {
      let text;
      try {
        text = readFileSync(resolve(dir, name), 'utf8');
      } catch {
        continue;
      }
      Object.assign(merged, parseEnv(text));
    }
  }
  for (const [k, v] of Object.entries(processEnv ?? {})) {
    if (v !== undefined) merged[k] = v;
  }
  return merged;
}

// 启动时打一行：真实模式要醒目（会花额度）。只说有没有密钥，绝不打出密钥或它的任何一部分
export function modeBanner(env) {
  const cfg = readConfig(env);
  if (cfg.mock) {
    const why = cfg.key ? 'TRIPO_MOCK=1' : '没有 TRIPO_API_KEY';
    return { level: 'info', text: `[tripo] /api/tripo 模拟模式（${why}），不花额度` };
  }
  const limits = `每个 IP 每小时 ${cfg.tasksPerIpPerHour} 个任务，24 小时内最多 ${cfg.tasksPerDay} 个`;
  return { level: 'warn', text: `⚠ Tripo 真实模式：会消耗额度（${limits}）。只想自测请用 TRIPO_MOCK=1 启动` };
}

// 客户端 IP。trustProxy = 前面有几层自己的反向代理（Nginx、平台的负载均衡）；0 表示直连，不看 X-Forwarded-For（可以伪造）
export function clientIp(req, trustProxy = 0) {
  const socketIp = req.socket?.remoteAddress ?? '';
  if (!trustProxy) return socketIp;
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const chain = [...forwarded, socketIp]; // 越靠右离我们越近；最右边 trustProxy 个是自己的代理
  return chain[Math.max(0, chain.length - 1 - trustProxy)] || socketIp;
}

export function toWebRequest(req) {
  const host = String(req.headers.host ?? 'localhost');
  const url = new URL(req.originalUrl ?? req.url ?? '/', `http://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k.startsWith(':')) continue;
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else headers.set(k, String(v));
  }
  const method = req.method ?? 'GET';
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

export async function sendWebResponse(res, response, method = 'GET') {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body || method === 'HEAD') {
    await response.body?.cancel().catch(() => {});
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (err) {
    // 浏览器中途断开很常见，不算错
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err;
  }
}

// 连接中间件（Vite 的 connect、或者自己的 http.createServer 里调）：不是 /api/tripo 的请求交给 next
export function createNodeMiddleware({ handle, getEnv, trustProxy = () => 0, log = console }) {
  return async function tripoMiddleware(req, res, next) {
    const pathname = String(req.originalUrl ?? req.url ?? '').split('?')[0];
    if (!isTripoPath(pathname)) return next?.();
    try {
      const env = getEnv();
      const request = toWebRequest(req);
      const response = await handle(request, env, { ip: clientIp(req, trustProxy(env)) });
      await sendWebResponse(res, response, req.method);
    } catch (err) {
      log.error?.(`[tripo] 中间件出错：${err?.message ?? err}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, code: 'upstream', message: '服务端出错，请稍后再试' }));
      } else res.destroy();
    }
  };
}

// 模拟模式：从本地文件读模型和预览图。相对路径依次在这些目录里找：public/、dist/、当前目录
export function createFileLoaders({ dirs }) {
  const find = async (rel) => {
    const candidates = isAbsolute(rel) ? [rel] : dirs.filter(Boolean).map((d) => resolve(d, rel));
    for (const file of candidates) {
      const st = await stat(file).catch(() => null);
      if (st?.isFile()) return { file, size: st.size };
    }
    return null;
  };
  const open = ({ file, size }, contentType) => ({ body: Readable.toWeb(createReadStream(file)), size, contentType });
  const modelPath = (env) => String(env.TRIPO_MOCK_MODEL_FILE ?? '').trim() || DEFAULT_MOCK_MODEL;
  return {
    async loadMockModel(env) {
      const hit = await find(modelPath(env));
      return hit ? open(hit, 'model/gltf-binary') : null;
    },
    // 预览图默认用 public/thumbs/ 里和模型同名的缩略图
    async loadMockPreview(env) {
      const name = basename(modelPath(env), extname(modelPath(env)));
      for (const [rel, type] of [[`thumbs/${name}.webp`, 'image/webp'], [`thumbs/${name}.png`, 'image/png']]) {
        const hit = await find(rel);
        if (hit) return open(hit, type);
      }
      return null;
    },
  };
}
