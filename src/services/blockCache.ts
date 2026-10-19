/**
 * 预览里"重活"结果的缓存。
 *
 * 背景：代码高亮（Shiki）与图表渲染（Mermaid）都很贵——`mermaid.render()` 要先做
 * 布局计算再生成 SVG。而预览每次更新都会重建整棵 DOM 树，于是**内容没变的块
 * 也会被重新渲染一遍**：一边打字一边重画所有图表，输入必然发滞。
 *
 * 做法：渲染时给每个块带上"内容指纹"，增强阶段按指纹复用上一次的 DOM 节点。
 * 指纹只跟内容有关，所以改一个字只会重渲染那一个块。
 */

/** 稳定的字符串指纹（FNV-1a 32 位），只需用于缓存键，不需要抗碰撞 */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // 乘以 FNV 质数 16777619，用移位避免超出 32 位精度
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(36);
}

export interface CacheStats {
  hit: number;
  miss: number;
}

/**
 * 求两个 HTML 块序列的**公共前缀/后缀长度**，用于把"整棵重建"降级为"只换中间变化的几块"。
 *
 * 为什么有效：编辑通常只影响一小段内容——改一个字、按一次回车。
 * 前缀/后缀都不变时，中间那一段就是真正需要替换的部分。
 * 实测整棵替换要 19–33ms（大文档更久），而它跑在输入路径上。
 */
export function commonEdges(prev: string[], next: string[]): { prefix: number; suffix: number } {
  const maxPrefix = Math.min(prev.length, next.length);
  let prefix = 0;
  while (prefix < maxPrefix && prev[prefix] === next[prefix]) prefix++;

  const maxSuffix = Math.min(prev.length, next.length) - prefix;
  let suffix = 0;
  while (suffix < maxSuffix && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) {
    suffix++;
  }

  return { prefix, suffix };
}

/** 有容量上限的缓存。
 * 上限存在的意义：长文档可能有很多代码块，无上限会一直涨；
 * 用 Map 的插入顺序做简单的 LRU（命中时删了再插，把最近用的放到末尾）。
 */
export class BlockCache<T> {
  private store = new Map<string, T>();
  readonly stats: CacheStats = { hit: 0, miss: 0 };

  constructor(private readonly maxSize = 200) {}

  get(key: string): T | undefined {
    const value = this.store.get(key);
    if (value === undefined) {
      this.stats.miss++;
      return undefined;
    }
    this.stats.hit++;
    // 命中后挪到末尾，保持 LRU 顺序
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    this.store.delete(key);
    this.store.set(key, value);
    while (this.store.size > this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
    this.stats.hit = 0;
    this.stats.miss = 0;
  }
}
