/**
 * Item Database - 从 ceve-market.org 下载并解析 evedata.xlsx
 * 提供物品搜索、多级分类查询
 *
 * 数据源: https://www.ceve-market.org/dumps/evedata.xlsx （"物品列表" 工作表）
 */

import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

const { Workbook } = ExcelJS;

export const EVEDATA_URL = 'https://www.ceve-market.org/dumps/evedata.xlsx';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

export interface EveItem {
  type_id: number;
  name: string;
  description: string;
  category_1: string;
  category_2: string;
  category_3: string;
  category_4: string;
  category_5: string;
  category_7: string;
}

/** { 一级分类: { 二级分类: [三级分类...] } } */
export type CategoryTree = Record<string, Record<string, string[]>>;

interface CachePayload {
  items: EveItem[];
  categories: string[];
  categoryTree: CategoryTree;
  updatedAt?: string;
}

/** exceljs 单元格值可能是富文本等复杂结构，统一转成字符串 */
function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    const v = value as { richText?: { text: string }[]; text?: string; result?: unknown };
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
    return String(value);
  }
  return String(value);
}

export class ItemDatabase {
  private items: EveItem[] | null = null;
  private categories: string[] = [];
  private categoryTree: CategoryTree | null = null;

  private readonly xlsxPath: string;
  private readonly cachePath: string;

  constructor(private readonly dataDir: string = path.join(process.cwd(), 'data')) {
    this.xlsxPath = path.join(dataDir, 'evedata.xlsx');
    this.cachePath = path.join(dataDir, 'items_cache.json');
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  private isCacheValid(): boolean {
    if (!fs.existsSync(this.cachePath)) return false;
    const stat = fs.statSync(this.cachePath);
    if (Date.now() - stat.mtime.getTime() >= CACHE_TTL_MS) return false;
    try {
      const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8')) as CachePayload;
      if (!data.items || data.items.length === 0) return false;
      if (!data.items[0].category_1) return false; // 旧缓存缺少多级分类
      if (!data.categoryTree) return false;
      return true;
    } catch {
      return false;
    }
  }

  private loadCache(): boolean {
    if (this.items) return true;
    if (fs.existsSync(this.cachePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8')) as CachePayload;
        this.items = data.items ?? [];
        this.categories = data.categories ?? [];
        this.categoryTree = data.categoryTree ?? null;
        return this.items.length > 0;
      } catch (e) {
        console.warn('[ItemDB] cache load failed:', e instanceof Error ? e.message : e);
      }
    }
    return false;
  }

  private saveCache(): void {
    this.ensureDir();
    const payload: CachePayload = {
      items: this.items ?? [],
      categories: this.categories,
      categoryTree: this.getCategoryTree(),
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(this.cachePath, JSON.stringify(payload), 'utf-8');
  }

  /** 下载 evedata.xlsx（缓存有效时跳过） */
  async downloadXlsx(force = false): Promise<string> {
    this.ensureDir();
    if (!force && fs.existsSync(this.xlsxPath) && this.isCacheValid()) {
      return this.xlsxPath;
    }
    console.log('[ItemDB] Downloading evedata.xlsx...');
    const res = await fetch(EVEDATA_URL, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(this.xlsxPath, buf);
    console.log('[ItemDB] Downloaded', buf.byteLength, 'bytes');
    return this.xlsxPath;
  }

  /** 解析 xlsx 文件（可指定外部文件路径） */
  async parseXlsx(filePath: string): Promise<void> {
    console.log('[ItemDB] Parsing xlsx...');
    const workbook = new Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.getWorksheet('物品列表');
    if (!sheet) throw new Error('Sheet 物品列表 not found');

    const items: EveItem[] = [];
    const categorySet = new Set<string>();
    const tree: Record<string, Record<string, Set<string>>> = {};

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // 表头
      const typeId = Number(row.getCell(1).value);
      if (!typeId) return;
      const item: EveItem = {
        type_id: typeId,
        name: cellText(row.getCell(2).value),
        description: cellText(row.getCell(3).value),
        category_1: cellText(row.getCell(4).value),
        category_2: cellText(row.getCell(5).value),
        category_3: cellText(row.getCell(6).value),
        category_4: cellText(row.getCell(7).value),
        category_5: cellText(row.getCell(8).value),
        category_7: cellText(row.getCell(9).value)
      };
      items.push(item);
      if (item.category_3) categorySet.add(item.category_3);
      if (item.category_1) {
        tree[item.category_1] ??= {};
        if (item.category_2) {
          tree[item.category_1][item.category_2] ??= new Set();
          if (item.category_3) tree[item.category_1][item.category_2].add(item.category_3);
        }
      }
    });

    this.items = items;
    this.categories = Array.from(categorySet).sort();
    this.categoryTree = this.setsToTree(tree);
    this.saveCache();
    console.log('[ItemDB] Parsed', items.length, 'items,', this.categories.length, 'categories');
  }

  private setsToTree(tree: Record<string, Record<string, Set<string>>>): CategoryTree {
    const result: CategoryTree = {};
    for (const [c1, sub] of Object.entries(tree)) {
      result[c1] = {};
      for (const [c2, set] of Object.entries(sub)) {
        result[c1][c2] = Array.from(set).sort();
      }
    }
    return result;
  }

  /** 确保数据已加载（缓存优先，否则下载并解析） */
  async ensureLoaded(force = false): Promise<void> {
    if (!force && this.loadCache() && this.isCacheValid()) return;
    const filePath = await this.downloadXlsx(force);
    await this.parseXlsx(filePath);
  }

  searchItems(query: string, limit = 50): EveItem[] {
    if (!this.items) this.loadCache();
    if (!query || query.trim().length === 0) return [];
    const q = query.toLowerCase();
    const results: EveItem[] = [];
    for (const item of this.items ?? []) {
      if (item.name.toLowerCase().includes(q)) {
        results.push(item);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  getItemById(typeId: number): EveItem | null {
    if (!this.items) this.loadCache();
    return this.items?.find(i => i.type_id === typeId) ?? null;
  }

  getCategories(): string[] {
    if (!this.items) this.loadCache();
    return this.categories;
  }

  getCategoryTree(): CategoryTree {
    if (!this.items) this.loadCache();
    if (this.categoryTree) return this.categoryTree;
    // 缓存缺失时从物品列表重建
    const tree: Record<string, Record<string, Set<string>>> = {};
    for (const item of this.items ?? []) {
      if (!item.category_1) continue;
      tree[item.category_1] ??= {};
      if (item.category_2) {
        tree[item.category_1][item.category_2] ??= new Set();
        if (item.category_3) tree[item.category_1][item.category_2].add(item.category_3);
      }
    }
    this.categoryTree = this.setsToTree(tree);
    return this.categoryTree;
  }

  getAllItems(): EveItem[] {
    if (!this.items) this.loadCache();
    return this.items ?? [];
  }
}
