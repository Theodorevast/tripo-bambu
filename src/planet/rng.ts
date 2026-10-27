// mulberry32：给定种子，产生可复现的 [0, 1) 随机数序列
export type Rng = () => number;

// 种子先经过 >>> 0：小数部分直接丢掉、再按 2^32 取模，所以 [0, 1) 之间的小数种子都会变成 0（同一串数）
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a：把字符串（如作品 id）变成 32 位种子。
// 哈希的是 UTF-16 码元（charCodeAt），不是 UTF-8 字节：ASCII 和标准 FNV-1a 一样，中文、emoji 的结果和按 UTF-8 算的不同
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
