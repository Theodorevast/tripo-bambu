// 生成 src/data/seed.json：团队模板 + 作品清单（works.json 由 prep-models 写；GLB 到之前是占位作品）
import { readFileSync, writeFileSync } from 'node:fs';
import { assembleSeed } from '../src/lib/assemble.ts';

const template = JSON.parse(readFileSync('src/data/teams.template.json', 'utf8'));
const works = JSON.parse(readFileSync('src/data/works.json', 'utf8'));
const seed = assembleSeed(template, works);
writeFileSync('src/data/seed.json', `${JSON.stringify(seed, null, 2)}\n`);
const active = seed.teams.filter((t) => t.status === 'active');
console.log(`seed.json：${seed.teams.length} 个团队（有作品 ${active.length} 个：${active.map((t) => `${t.name} ${t.works.length}`).join('、')}），作品 ${works.length} 件`);
