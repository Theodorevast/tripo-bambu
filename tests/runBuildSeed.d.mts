// runBuildSeed.mjs 的类型
export interface SeedRun {
  status: number | null;
  stdout: string;
  stderr: string;
  seed: string | null; // 写出来的 seed.json 全文；没写就是 null
}

// cwd：'repo' 在仓库根目录运行，'elsewhere' 在仓库外的临时目录运行；works 给了就代替仓库里的 works.json
export function runBuildSeed(options: { cwd: 'repo' | 'elsewhere'; works?: unknown }): SeedRun;
