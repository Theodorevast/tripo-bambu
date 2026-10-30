// worker.mjs 的类型
export interface WorkerEnv {
  [name: string]: unknown;
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

declare const worker: { fetch(request: Request, env: WorkerEnv): Promise<Response> };
export default worker;
