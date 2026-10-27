// 测试用：在子进程里跑 scripts/build-seed.mjs，输出写进临时目录，不碰仓库里的 seed.json。
// 写成 .mjs（类型在 .d.mts 里）：tsconfig 的 types 只有 vite/client，不把 Node 的全局类型带给 src 里的浏览器代码
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

export function runBuildSeed({ cwd, works }) {
  const dir = mkdtempSync(join(tmpdir(), 'build-seed-'));
  try {
    const env = { ...process.env, SEED_OUT: join(dir, 'seed.json') };
    delete env.WORKS_IN;
    if (works !== undefined) {
      env.WORKS_IN = join(dir, 'works.json');
      writeFileSync(env.WORKS_IN, JSON.stringify(works));
    }
    const r = spawnSync(process.execPath, [join(repo, 'scripts', 'build-seed.mjs')], { cwd: cwd === 'repo' ? repo : dir, env, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, seed: existsSync(env.SEED_OUT) ? readFileSync(env.SEED_OUT, 'utf8') : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
