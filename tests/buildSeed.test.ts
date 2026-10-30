import { describe, expect, it } from 'vitest';
import { runBuildSeed } from './runBuildSeed.mjs';

// 两个用例都要同步起一个 node 子进程跑 build-seed：机器忙的时候（几个浏览器、开发服务器同时开着）会超过默认的 5 秒，放宽到 30 秒
describe('build-seed.mjs', () => {
  it('输入按仓库位置找：在仓库外的目录运行，结果和在仓库根目录运行一样', () => {
    const elsewhere = runBuildSeed({ cwd: 'elsewhere' });
    expect(elsewhere.stderr).toBe('');
    expect(elsewhere.status).toBe(0);
    const atRoot = runBuildSeed({ cwd: 'repo' });
    expect(atRoot.status).toBe(0);
    expect(elsewhere.stdout).toBe(atRoot.stdout);
    expect(elsewhere.seed).not.toBeNull();
    expect(elsewhere.seed).toBe(atRoot.seed);
  }, 30_000);
  it('works.json 里一件作品都没有时以非零码退出，说明先跑 npm run prep 或检查 models-in/works.csv，不写 seed.json', () => {
    const r = runBuildSeed({ cwd: 'repo', works: [] });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/npm run prep/);
    expect(r.stderr).toMatch(/models-in\/works\.csv/);
    expect(r.seed).toBeNull();
  }, 30_000);
});
