/**
 * MemoryCache - 进程内 TTL 缓存
 * 用于热数据（实时价格、订单簿）的快速读写；过期即丢弃，绝不返回陈旧数据。
 */

interface CacheEntry<V> {
  value: V;
  /** 写入时刻（epoch ms） */
  storedAt: number;
  /** 过期时刻（epoch ms） */
  expiresAt: number;
}

export class MemoryCache<V> {
  private store = new Map<string, CacheEntry<V>>();

  /**
   * 读取。过期条目会被删除并返回 null。
   */
  get(key: string | number): V | null {
    const k = String(key);
    const entry = this.store.get(k);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(k);
      return null;
    }
    return entry.value;
  }

  /** 读取并附带写入时间（用于展示"数据获取于 xx:xx"） */
  getWithMeta(key: string | number): { value: V; storedAt: number; ageMs: number } | null {
    const k = String(key);
    const entry = this.store.get(k);
    if (!entry) return null;
    const now = Date.now();
    if (now >= entry.expiresAt) {
      this.store.delete(k);
      return null;
    }
    return { value: entry.value, storedAt: entry.storedAt, ageMs: now - entry.storedAt };
  }

  set(key: string | number, value: V, ttlMs: number): void {
    const now = Date.now();
    this.store.set(String(key), { value, storedAt: now, expiresAt: now + ttlMs });
  }

  has(key: string | number): boolean {
    return this.get(key) !== null;
  }

  delete(key: string | number): void {
    this.store.delete(String(key));
  }

  /** 清理全部过期条目，返回清理数量 */
  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, entry] of this.store) {
      if (now >= entry.expiresAt) {
        this.store.delete(k);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
