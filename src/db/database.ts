/**
 * Database - SQLite 数据持久化层（better-sqlite3）
 * 存储：应用配置、建筑名单、价格缓存、建筑订单缓存
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export interface StructureRecord {
  id: number;
  name: string;
  system_id: number | null;
  system_name: string | null;
  region_id: number | null;
  region_name: string | null;
  type_id: number | null;
  type_name: string | null;
  tags: string[];
  notes: string;
  accessible: boolean;
  last_scan: string | null;
}

export interface PriceCacheEntry {
  type_id: number;
  jita_sell: number | null;
  jita_buy?: number | null;
  volume?: {
    date: string;
    average: number;
    highest: number;
    lowest: number;
    order_count: number;
    volume: number;
  } | null;
  cached_at: string | null;
}

export interface StructureOrderCacheEntry {
  structure_id: number;
  structure_name: string;
  /** type_id -> 最低卖价 */
  orders: Record<string, number>;
  order_count: number;
  scanned_at: string | null;
  success: boolean;
  error?: string | null;
  statusCode?: number | null;
}

function safeJsonParse<T>(str: string | null | undefined, defaultValue: T): T {
  try {
    return JSON.parse(str as string) as T;
  } catch {
    return defaultValue;
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS structures (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    system_id INTEGER,
    system_name TEXT,
    region_id INTEGER,
    region_name TEXT,
    type_id INTEGER,
    type_name TEXT,
    tags TEXT DEFAULT '[]',
    notes TEXT DEFAULT '',
    accessible INTEGER DEFAULT 1,
    last_scan TEXT
  );

  CREATE TABLE IF NOT EXISTS price_cache (
    type_id INTEGER PRIMARY KEY,
    jita_sell REAL,
    jita_buy REAL,
    volume_date TEXT,
    volume_average REAL,
    volume_highest REAL,
    volume_lowest REAL,
    volume_order_count INTEGER,
    volume_volume INTEGER,
    cached_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_price_cache_cached_at ON price_cache(cached_at);

  CREATE TABLE IF NOT EXISTS structure_order_cache (
    structure_id INTEGER PRIMARY KEY,
    structure_name TEXT DEFAULT '',
    orders TEXT DEFAULT '{}',
    order_count INTEGER DEFAULT 0,
    scanned_at TEXT,
    success INTEGER DEFAULT 1,
    error TEXT,
    status_code INTEGER
  );
`;

interface StructureRow {
  id: number;
  name: string;
  system_id: number | null;
  system_name: string | null;
  region_id: number | null;
  region_name: string | null;
  type_id: number | null;
  type_name: string | null;
  tags: string;
  notes: string;
  accessible: number;
  last_scan: string | null;
}

interface PriceRow {
  type_id: number;
  jita_sell: number | null;
  jita_buy: number | null;
  volume_date: string | null;
  volume_average: number | null;
  volume_highest: number | null;
  volume_lowest: number | null;
  volume_order_count: number | null;
  volume_volume: number | null;
  cached_at: string | null;
}

interface OrderRow {
  structure_id: number;
  structure_name: string;
  orders: string;
  order_count: number;
  scanned_at: string | null;
  success: number;
  error: string | null;
  status_code: number | null;
}

function rowToStructure(row: StructureRow): StructureRecord {
  return {
    id: row.id,
    name: row.name,
    system_id: row.system_id,
    system_name: row.system_name,
    region_id: row.region_id,
    region_name: row.region_name,
    type_id: row.type_id,
    type_name: row.type_name,
    tags: safeJsonParse(row.tags, []),
    notes: row.notes,
    accessible: row.accessible === 1,
    last_scan: row.last_scan
  };
}

function rowToPriceCache(row: PriceRow): PriceCacheEntry {
  const result: PriceCacheEntry = {
    type_id: row.type_id,
    jita_sell: row.jita_sell,
    cached_at: row.cached_at
  };
  if (row.jita_buy != null) result.jita_buy = row.jita_buy;
  if (row.volume_date) {
    result.volume = {
      date: row.volume_date,
      average: row.volume_average ?? 0,
      highest: row.volume_highest ?? 0,
      lowest: row.volume_lowest ?? 0,
      order_count: row.volume_order_count ?? 0,
      volume: row.volume_volume ?? 0
    };
  }
  return result;
}

function rowToStructureOrder(row: OrderRow): StructureOrderCacheEntry {
  return {
    structure_id: row.structure_id,
    structure_name: row.structure_name,
    orders: safeJsonParse(row.orders, {}),
    order_count: row.order_count,
    scanned_at: row.scanned_at,
    success: row.success === 1,
    error: row.error,
    statusCode: row.status_code
  };
}

export class AppDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(process.cwd(), 'data', 'eve_dealer.db');
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  // ---------- Config ----------

  getConfigValue(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setConfigValue(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
  }

  deleteConfigValue(key: string): void {
    this.db.prepare('DELETE FROM config WHERE key = ?').run(key);
  }

  getAllConfig(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM config').all() as { key: string; value: string }[];
    const config: Record<string, string> = {};
    for (const row of rows) config[row.key] = row.value;
    return config;
  }

  // ---------- Structures ----------

  getAllStructures(): StructureRecord[] {
    const rows = this.db.prepare('SELECT * FROM structures ORDER BY id').all() as StructureRow[];
    return rows.map(rowToStructure);
  }

  getStructure(id: number): StructureRecord | null {
    const row = this.db.prepare('SELECT * FROM structures WHERE id = ?').get(id) as StructureRow | undefined;
    return row ? rowToStructure(row) : null;
  }

  upsertStructure(st: StructureRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO structures
        (id, name, system_id, system_name, region_id, region_name, type_id, type_name, tags, notes, accessible, last_scan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      st.id, st.name ?? '', st.system_id ?? null, st.system_name ?? null,
      st.region_id ?? null, st.region_name ?? null, st.type_id ?? null, st.type_name ?? null,
      JSON.stringify(st.tags ?? []), st.notes ?? '', st.accessible ? 1 : 0, st.last_scan ?? null
    );
  }

  deleteStructure(id: number): void {
    this.db.prepare('DELETE FROM structures WHERE id = ?').run(id);
  }

  // ---------- Price cache ----------

  getPriceCache(typeId: number): PriceCacheEntry | null {
    const row = this.db.prepare('SELECT * FROM price_cache WHERE type_id = ?').get(typeId) as PriceRow | undefined;
    return row ? rowToPriceCache(row) : null;
  }

  setPriceCache(typeId: number, data: PriceCacheEntry): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO price_cache
        (type_id, jita_sell, jita_buy, volume_date, volume_average, volume_highest, volume_lowest, volume_order_count, volume_volume, cached_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      typeId,
      data.jita_sell ?? null,
      data.jita_buy ?? null,
      data.volume?.date ?? null,
      data.volume?.average ?? null,
      data.volume?.highest ?? null,
      data.volume?.lowest ?? null,
      data.volume?.order_count ?? null,
      data.volume?.volume ?? null,
      data.cached_at ?? null
    );
  }

  getBatchPriceCache(typeIds: number[]): Record<string, PriceCacheEntry> {
    if (!typeIds || typeIds.length === 0) return {};
    const rows = this.db.prepare(
      'SELECT * FROM price_cache WHERE type_id IN (SELECT value FROM json_each(?))'
    ).all(JSON.stringify(typeIds.map(String))) as PriceRow[];
    const results: Record<string, PriceCacheEntry> = {};
    for (const row of rows) {
      results[String(row.type_id)] = rowToPriceCache(row);
    }
    return results;
  }

  clearPriceCache(): void {
    this.db.prepare('DELETE FROM price_cache').run();
  }

  // ---------- Structure order cache ----------

  getStructureOrderCache(structureId: number): StructureOrderCacheEntry | null {
    const row = this.db.prepare('SELECT * FROM structure_order_cache WHERE structure_id = ?').get(structureId) as OrderRow | undefined;
    return row ? rowToStructureOrder(row) : null;
  }

  setStructureOrderCache(structureId: number, data: Partial<StructureOrderCacheEntry>): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO structure_order_cache
        (structure_id, structure_name, orders, order_count, scanned_at, success, error, status_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      structureId,
      data.structure_name ?? '',
      JSON.stringify(data.orders ?? {}),
      data.order_count ?? 0,
      data.scanned_at ?? null,
      data.success !== false ? 1 : 0,
      data.error ?? null,
      data.statusCode ?? null
    );
  }

  clearStructureOrderCache(): void {
    this.db.prepare('DELETE FROM structure_order_cache').run();
  }

  clearAllCache(): void {
    const clear = this.db.transaction(() => {
      this.db.prepare('DELETE FROM price_cache').run();
      this.db.prepare('DELETE FROM structure_order_cache').run();
    });
    clear();
  }

  close(): void {
    this.db.close();
  }
}
