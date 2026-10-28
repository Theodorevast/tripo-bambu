import type { Seed } from '../data/types';

// 用户的真实模型是私有的：只在开发环境、本机放了 .tmp/local-models/ 时用（.tmp/ 在 .gitignore 里），不提交、不打包。
// .tmp/local-models/works.json 写「团队 id → [{ id, title, file }]」：把种子里那个团队的同 id 作品换成真实模型
// （file 是同一目录下的 GLB 文件名）。摆放、作者都不动，存档的指纹只看作品 id，换了也不会作废本地修改。
// import.meta.glob 由开发服务器按磁盘匹配：目录不在时结果是空的，页面不发请求；生产构建里 import.meta.env.DEV 是 false，整支连同 glob 一起去掉
interface LocalWork {
  id: string;
  title?: string;
  file: string;
}

// 地址带 ?nolocal 时不换（自查脚本按提交进仓库的种子数据核对作品名，用占位作品）
export async function applyLocalWorks(seed: Seed): Promise<Seed> {
  if (!import.meta.env.DEV || new URLSearchParams(location.search).has('nolocal')) return seed;
  const lists = import.meta.glob<Record<string, LocalWork[]>>('/.tmp/local-models/works.json', { import: 'default' });
  const loadList = Object.values(lists)[0];
  if (!loadList) return seed;
  const files = import.meta.glob<string>('/.tmp/local-models/*.glb', { query: '?url', import: 'default' });
  const urlOf = async (name: string): Promise<string | null> => {
    const load = files[`/.tmp/local-models/${name}`];
    return load ? new URL(await load(), location.href).href : null;
  };
  try {
    const byTeam = await loadList();
    const teams = await Promise.all(seed.teams.map(async (team) => {
      const list = byTeam[team.id];
      if (!list) return team;
      const works = await Promise.all(team.works.map(async (w) => {
        const local = list.find((l) => l.id === w.id);
        const url = local ? await urlOf(local.file) : null;
        return local && url ? { ...w, title: local.title ?? w.title, file: url } : w;
      }));
      return { ...team, works };
    }));
    return { ...seed, teams };
  } catch (err) {
    console.warn('local works skipped', err);
    return seed;
  }
}
