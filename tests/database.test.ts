import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppDatabase } from '../src/db/database.js';

let tmpDir: string;
let db: AppDatabase;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-dealer-test-'));
  db = new AppDatabase(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AppDatabase', () => {
  it('config 读写删', () => {
    db.setConfigValue('client_id', 'abc');
    expect(db.getConfigValue('client_id')).toBe('abc');
    db.setConfigValue('client_id', 'def');
    expect(db.getAllConfig()).toEqual({ client_id: 'def' });
    db.deleteConfigValue('client_id');
    expect(db.getConfigValue('client_id')).toBeNull();
  });

  it('structures 增删改查', () => {
    db.upsertStructure({
      id: 1001, name: '堡垒A', system_id: 30000142, system_name: 'Jita',
      region_id: 10000002, region_name: 'The Forge', type_id: 35834, type_name: 'Keepstar',
      tags: ['吉他'], notes: '', accessible: true, last_scan: null
    });
    db.upsertStructure({
      id: 1002, name: '堡垒B', system_id: null, system_name: null,
      region_id: null, region_name: null, type_id: null, type_name: null,
      tags: [], notes: '', accessible: false, last_scan: null
    });
    expect(db.getAllStructures()).toHaveLength(2);
    const st = db.getStructure(1001);
    expect(st?.name).toBe('堡垒A');
    expect(st?.tags).toEqual(['吉他']);
    expect(db.getStructure(1002)?.accessible).toBe(false);

    // upsert 覆盖
    db.upsertStructure({ ...st!, name: '堡垒A2' });
    expect(db.getStructure(1001)?.name).toBe('堡垒A2');
    expect(db.getAllStructures()).toHaveLength(2);

    db.deleteStructure(1002);
    expect(db.getAllStructures()).toHaveLength(1);
  });

  it('price_cache 读写与批量查询', () => {
    db.setPriceCache(34, {
      type_id: 34, jita_sell: 5.5, jita_buy: 5.0,
      volume: { date: '2026-08-20', average: 5.2, highest: 6, lowest: 4.5, order_count: 100, volume: 999999 },
      cached_at: new Date().toISOString()
    });
    db.setPriceCache(35, { type_id: 35, jita_sell: 10.1, cached_at: new Date().toISOString() });

    const p34 = db.getPriceCache(34);
    expect(p34?.jita_sell).toBe(5.5);
    expect(p34?.volume?.volume).toBe(999999);
    expect(db.getPriceCache(35)?.volume).toBeUndefined();
    expect(db.getPriceCache(999)).toBeNull();

    const batch = db.getBatchPriceCache([34, 35, 999]);
    expect(Object.keys(batch).sort()).toEqual(['34', '35']);
    expect(db.getBatchPriceCache([])).toEqual({});

    db.clearPriceCache();
    expect(db.getPriceCache(34)).toBeNull();
  });

  it('structure_order_cache 读写', () => {
    db.setStructureOrderCache(1001, {
      structure_name: '堡垒A',
      orders: { '34': 5.5, '35': 10 },
      order_count: 2,
      scanned_at: new Date().toISOString(),
      success: true
    });
    const cached = db.getStructureOrderCache(1001);
    expect(cached?.orders).toEqual({ '34': 5.5, '35': 10 });
    expect(cached?.success).toBe(true);

    db.setStructureOrderCache(1002, {
      structure_name: '堡垒B', success: false, error: 'HTTP 403', statusCode: 403
    });
    const failed = db.getStructureOrderCache(1002);
    expect(failed?.success).toBe(false);
    expect(failed?.statusCode).toBe(403);

    db.clearAllCache();
    expect(db.getStructureOrderCache(1001)).toBeNull();
  });
});
