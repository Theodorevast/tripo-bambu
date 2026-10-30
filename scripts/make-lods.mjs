// 出星球视图用的轻量模型（LOD）：public/models/<id>.glb → public/models/lod/<id>.glb，只减面、贴图不动。规则见 scripts/lib/lod.mjs。
// 用法：npm run lods（换了、加了作品以后跑；npm run prep 最后会自动跑）。LOD 文件提交进仓库，构建和部署不用再跑
import { main } from './lib/lod.mjs';

await main();
