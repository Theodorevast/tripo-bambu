// 生成 src/data/seed.json：团队模板 + 作品清单（works.json 由 prep-models 写；GLB 到之前是占位作品）
// 路径按仓库位置算，在哪个目录运行都一样；测试时可用环境变量换文件（相对当前目录）：WORKS_IN、SEED_OUT
import { readFileSync, writeFileSync } from 'node:fs';
import { assembleSeed } from '../src/lib/assemble.ts';

const data = (name) => new URL(`../src/data/${name}`, import.meta.url);
const template = JSON.parse(readFileSync(data('teams.template.json'), 'utf8'));
const works = JSON.parse(readFileSync(process.env.WORKS_IN ?? data('works.json'), 'utf8'));
// 一件作品都没有时生成的 seed 里没有「有作品的团队」，演示身份也不在任何团队里：直接停下
if (!Array.isArray(works) || works.length === 0) {
  console.error(`错误：${process.env.WORKS_IN ?? 'src/data/works.json'} 里一件作品都没有。已停止，没有写 seed.json。先跑 npm run prep，或检查 models-in/works.csv。`);
  process.exit(1);
}
const seed = assembleSeed(template, works);
writeFileSync(process.env.SEED_OUT ?? data('seed.json'), `${JSON.stringify(seed, null, 2)}\n`);
const active = seed.teams.filter((t) => t.status === 'active');
console.log(`seed.json：${seed.teams.length} 个团队（有作品 ${active.length} 个：${active.map((t) => `${t.name} ${t.works.length}`).join('、')}），作品 ${works.length} 件`);
