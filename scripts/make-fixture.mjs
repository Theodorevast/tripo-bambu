// 生成模型处理脚本的测试数据：.tmp/fixture/ 下两个 GLB（一个带 4096 贴图）+ works.csv（含一行找不到的文件）
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeBoxGlb } from './lib/fixture.mjs';

mkdirSync('.tmp/fixture', { recursive: true });
writeFileSync('.tmp/fixture/big-texture.glb', await makeBoxGlb({ textureSize: 4096 }));
writeFileSync('.tmp/fixture/small.glb', await makeBoxGlb({ textureSize: 64 }));
writeFileSync('.tmp/fixture/works.csv', 'file,title,author,description\nbig-texture.glb,"Big Texture, Test",tester,Fixture with a 4096 texture\nsmall.glb,Small,tester2,\nmissing.glb,Missing,nobody,\n');
console.log('测试数据写到 .tmp/fixture/');
