// 翠宝是品牌资产：只在开发环境从本机的 .tmp/triboo/triboo.glb 读（.tmp/ 在 .gitignore 里），不提交、不打包。
// import.meta.glob 由开发服务器按磁盘匹配：文件不在时结果是空的，页面不发请求，也就没有 404。
// 生产构建里 import.meta.env.DEV 是 false，这一支连同 glob 一起被去掉，构建结果里没有这个模型
export async function localTribooUrl(): Promise<string | null> {
  if (!import.meta.env.DEV) return null;
  const files = import.meta.glob<string>('/.tmp/triboo/triboo.glb', { query: '?url', import: 'default' });
  const load = Object.values(files)[0];
  return load ? load() : null;
}
