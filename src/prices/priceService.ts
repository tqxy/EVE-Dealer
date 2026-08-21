/**
 * Price Service - 吉他价格/销量批量刷新服务
 * 批量缓存读取、后台并发队列刷新、逐条回调通知、全局进度跟踪
 */

import type { EsiClient } from '../esi/client.js';
import type { Registry } from '../db/registry.js';
import type { PriceCacheEntry } from '../db/database.js';
import { getRegionOrders, getMarketHistory } from '../esi/endpoints/market.js';
import { JITA_REGION_ID, JITA_SYSTEM_ID } from '../config.js';
import { sleep } from '../esi/client.js';

export type PriceUpdateCallback = (typeId: number, data: PriceCacheEntry) => void;
export type ProgressCallback = (done: number, total: number) => void;

interface RefreshTask {
  typeId: number;
  onUpdate?: PriceUpdateCallback;
  isGlobal?: boolean;
}

export interface PriceServiceOptions {
  /** 每个 worker 两次刷新之间的间隔（毫秒） */
  intervalMs?: number;
  /** 并发 worker 数 */
  concurrency?: number;
  /** 缓存有效期（分钟），超过则刷新 */
  maxAgeMinutes?: number;
}

export class PriceService {
  private queue: RefreshTask[] = [];
  private isRunning = false;
  private globalTotal = 0;
  private globalDone = 0;
  private globalOnProgress: ProgressCallback | null = null;

  private readonly intervalMs: number;
  private readonly concurrency: number;
  private readonly maxAgeMinutes: number;

  constructor(
    private readonly client: EsiClient,
    private readonly registry: Registry,
    options: PriceServiceOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? 20;
    this.concurrency = options.concurrency ?? 5;
    this.maxAgeMinutes = options.maxAgeMinutes ?? 30;
  }

  /** 批量读取已有缓存 */
  getBatchCached(typeIds: number[]): Record<string, PriceCacheEntry> {
    return this.registry.getBatchPriceCache(typeIds);
  }

  /** 筛选出缓存缺失或过期的 typeId */
  private findStale(typeIds: number[], maxAgeMinutes: number): number[] {
    const stale: number[] = [];
    for (const typeId of typeIds) {
      const cached = this.registry.getPriceCache(typeId);
      if (!cached?.cached_at) {
        stale.push(typeId);
        continue;
      }
      const age = (Date.now() - new Date(cached.cached_at).getTime()) / 1000 / 60;
      if (age < 0 || age >= maxAgeMinutes) stale.push(typeId);
    }
    return stale;
  }

  /**
   * 启动后台刷新，立即返回待刷新数量。
   * 每刷新完一条通过 onUpdate 回调通知。
   */
  startRefresh(typeIds: number[], onUpdate?: PriceUpdateCallback, maxAgeMinutes?: number): number {
    const stale = this.findStale(typeIds, maxAgeMinutes ?? this.maxAgeMinutes);
    for (const typeId of stale) {
      this.queue.push({ typeId, onUpdate });
    }
    if (!this.isRunning && this.queue.length > 0) {
      void this.processQueue();
    }
    return stale.length;
  }

  /** 全局刷新：额外跟踪总进度 */
  startGlobalRefresh(
    typeIds: number[],
    onUpdate?: PriceUpdateCallback,
    onProgress?: ProgressCallback,
    maxAgeMinutes?: number
  ): number {
    const stale = this.findStale(typeIds, maxAgeMinutes ?? this.maxAgeMinutes);
    this.globalTotal = stale.length;
    this.globalDone = 0;
    this.globalOnProgress = onProgress ?? null;
    for (const typeId of stale) {
      this.queue.push({ typeId, onUpdate, isGlobal: true });
    }
    if (!this.isRunning && this.queue.length > 0) {
      void this.processQueue();
    }
    return stale.length;
  }

  /** 等待当前队列全部处理完（测试/脚本用） */
  async drain(): Promise<void> {
    while (this.isRunning || this.queue.length > 0) {
      await sleep(50);
    }
  }

  private async processQueue(): Promise<void> {
    this.isRunning = true;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < this.concurrency; i++) {
      workers.push(this.workerLoop());
    }
    await Promise.all(workers);
    this.isRunning = false;
  }

  private async workerLoop(): Promise<void> {
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;
      try {
        await this.refreshOne(task.typeId, task.onUpdate);
      } catch (err) {
        console.error('[PriceService] Refresh failed for', task.typeId, err instanceof Error ? err.message : err);
      }
      if (task.isGlobal) {
        this.globalDone++;
        this.globalOnProgress?.(this.globalDone, this.globalTotal);
      }
      if (this.intervalMs > 0) await sleep(this.intervalMs);
    }
  }

  /** 拉取单个物品的吉他卖价 + 最新一日市场历史，写入缓存 */
  async refreshOne(typeId: number, onUpdate?: PriceUpdateCallback): Promise<PriceCacheEntry> {
    const [sellResult, histResult] = await Promise.allSettled([
      getRegionOrders(this.client, JITA_REGION_ID, typeId, 'sell'),
      getMarketHistory(this.client, JITA_REGION_ID, typeId)
    ]);

    let jitaSell: number | null = null;
    if (sellResult.status === 'fulfilled' && sellResult.value.success && Array.isArray(sellResult.value.data)) {
      const orders = sellResult.value.data
        .filter(o => o.system_id === JITA_SYSTEM_ID && o.location_id < 1_000_000_000_000)
        .sort((a, b) => a.price - b.price);
      jitaSell = orders.length > 0 ? orders[0].price : null;
    }

    let volume: PriceCacheEntry['volume'] = null;
    if (histResult.status === 'fulfilled' && histResult.value.success &&
        Array.isArray(histResult.value.data) && histResult.value.data.length > 0) {
      const latest = histResult.value.data[histResult.value.data.length - 1];
      volume = {
        date: latest.date,
        average: latest.average,
        highest: latest.highest,
        lowest: latest.lowest,
        order_count: latest.order_count,
        volume: latest.volume
      };
    }

    const data: PriceCacheEntry = {
      type_id: typeId,
      jita_sell: jitaSell,
      volume,
      cached_at: new Date().toISOString()
    };
    this.registry.setPriceCache(typeId, data);
    onUpdate?.(typeId, data);
    return data;
  }
}
