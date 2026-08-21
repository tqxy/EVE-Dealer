import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EsiClient } from '../src/esi/client.js';
import { AppDatabase } from '../src/db/database.js';
import { Registry } from '../src/db/registry.js';
import { PriceService } from '../src/prices/priceService.js';
import { SERENITY_DEFAULTS, JITA_SYSTEM_ID } from '../src/config.js';

const config = { ...SERENITY_DEFAULTS };

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-dealer-price-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function jsonResponse(data: unknown) {
  return {
    ok: true, status: 200, statusText: 'OK',
    headers: new Headers(),
    json: async () => data
  } as unknown as Response;
}

function stubEsiFetch() {
  return vi.fn().mockImplementation((url: string) => {
    const u = new URL(url);
    if (u.pathname.includes('/orders/')) {
      return Promise.resolve(jsonResponse([
        { order_id: 1, type_id: 34, location_id: 60003760, system_id: JITA_SYSTEM_ID, price: 6.0, is_buy_order: false },
        { order_id: 2, type_id: 34, location_id: 60003760, system_id: JITA_SYSTEM_ID, price: 5.5, is_buy_order: false },
        // 建筑订单（location_id 很大）应被过滤
        { order_id: 3, type_id: 34, location_id: 1_000_000_000_000 + 1, system_id: JITA_SYSTEM_ID, price: 1.0, is_buy_order: false },
        // 其他星系订单应被过滤
        { order_id: 4, type_id: 34, location_id: 60003760, system_id: 30000144, price: 2.0, is_buy_order: false }
      ]));
    }
    if (u.pathname.includes('/history/')) {
      return Promise.resolve(jsonResponse([
        { date: '2026-08-19', average: 5.0, highest: 6, lowest: 4, order_count: 50, volume: 1000 },
        { date: '2026-08-20', average: 5.2, highest: 6.5, lowest: 4.5, order_count: 60, volume: 2000 }
      ]));
    }
    return Promise.resolve(jsonResponse([]));
  });
}

describe('PriceService', () => {
  it('refreshOne 拉取吉他最低价与最新历史并写缓存', async () => {
    vi.stubGlobal('fetch', stubEsiFetch());
    const registry = new Registry(new AppDatabase(path.join(tmpDir, 't.db')));
    const client = new EsiClient(config, { delayMs: 0 });
    const service = new PriceService(client, registry, { intervalMs: 0 });

    const updates: [number, unknown][] = [];
    const data = await service.refreshOne(34, (typeId, d) => updates.push([typeId, d]));

    expect(data.jita_sell).toBe(5.5); // 最低有效卖单
    expect(data.volume?.date).toBe('2026-08-20'); // 取最新一日
    expect(data.volume?.volume).toBe(2000);
    expect(updates).toHaveLength(1);

    const cached = registry.getPriceCache(34);
    expect(cached?.jita_sell).toBe(5.5);
    registry.close();
  });

  it('startRefresh 只刷新缓存缺失/过期的物品', async () => {
    const fetchMock = stubEsiFetch();
    vi.stubGlobal('fetch', fetchMock);
    const registry = new Registry(new AppDatabase(path.join(tmpDir, 't.db')));
    const client = new EsiClient(config, { delayMs: 0 });
    const service = new PriceService(client, registry, { intervalMs: 0 });

    // 预置一条新鲜缓存
    registry.setPriceCache(35, { type_id: 35, jita_sell: 9.9, cached_at: new Date().toISOString() });

    const count = service.startRefresh([34, 35]);
    expect(count).toBe(1); // 只有 34 需要刷新
    await service.drain();

    expect(registry.getPriceCache(34)?.jita_sell).toBe(5.5);
    expect(registry.getPriceCache(35)?.jita_sell).toBe(9.9); // 未被覆盖
    registry.close();
  });

  it('startGlobalRefresh 跟踪进度', async () => {
    vi.stubGlobal('fetch', stubEsiFetch());
    const registry = new Registry(new AppDatabase(path.join(tmpDir, 't.db')));
    const client = new EsiClient(config, { delayMs: 0 });
    const service = new PriceService(client, registry, { intervalMs: 0 });

    const progress: [number, number][] = [];
    const count = service.startGlobalRefresh([34, 36, 37], undefined, (done, total) => {
      progress.push([done, total]);
    });
    expect(count).toBe(3);
    await service.drain();

    expect(progress.length).toBe(3);
    expect(progress[progress.length - 1]).toEqual([3, 3]);
    registry.close();
  });
});
