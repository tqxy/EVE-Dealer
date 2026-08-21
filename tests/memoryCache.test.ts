import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryCache } from '../src/cache/memoryCache.js';

describe('MemoryCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('写入后可读取', () => {
    const cache = new MemoryCache<number>();
    cache.set('a', 42, 60_000);
    expect(cache.get('a')).toBe(42);
    expect(cache.has('a')).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('过期后丢弃并返回 null', () => {
    vi.useFakeTimers();
    const cache = new MemoryCache<string>();
    cache.set('x', 'data', 15 * 60 * 1000);

    vi.advanceTimersByTime(14 * 60 * 1000);
    expect(cache.get('x')).toBe('data'); // 14 分钟仍有效

    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(cache.get('x')).toBeNull(); // 16 分钟已丢弃
    expect(cache.size).toBe(0);
  });

  it('getWithMeta 返回写入时间与年龄', () => {
    vi.useFakeTimers();
    const cache = new MemoryCache<number>();
    cache.set(34, 9.82, 60_000);
    vi.advanceTimersByTime(5000);
    const meta = cache.getWithMeta(34);
    expect(meta?.value).toBe(9.82);
    expect(meta?.ageMs).toBe(5000);
  });

  it('prune 清理过期条目', () => {
    vi.useFakeTimers();
    const cache = new MemoryCache<number>();
    cache.set('a', 1, 1000);
    cache.set('b', 2, 60_000);
    vi.advanceTimersByTime(2000);
    expect(cache.prune()).toBe(1);
    expect(cache.get('b')).toBe(2);
  });

  it('delete / clear', () => {
    const cache = new MemoryCache<number>();
    cache.set('a', 1, 1000);
    cache.delete('a');
    expect(cache.get('a')).toBeNull();
    cache.set('b', 2, 1000);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
