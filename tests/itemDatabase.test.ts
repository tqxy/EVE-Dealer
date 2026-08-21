import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';

const { Workbook } = ExcelJS;
import { ItemDatabase } from '../src/items/itemDatabase.js';

let tmpDir: string;
let xlsxPath: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-dealer-items-'));
  xlsxPath = path.join(tmpDir, 'evedata.xlsx');

  // 生成一个小型 evedata.xlsx 测试夹具（与真实格式一致："物品列表" 表 + 9 列）
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('物品列表');
  sheet.addRow(['typeID', 'name', 'description', 'cat1', 'cat2', 'cat3', 'cat4', 'cat5', 'cat7']);
  sheet.addRow([34, 'Tritanium', '最常见的矿物', '材料', '矿物', '标准矿物', '', '', '']);
  sheet.addRow([35, 'Pyerite', '', '材料', '矿物', '标准矿物', '', '', '']);
  sheet.addRow([11399, 'Morphite', '', '材料', '矿物', '稀有矿物', '', '', '']);
  sheet.addRow([35834, 'Keepstar', '超大建筑', '建筑', '堡垒', '超大型堡垒', '', '', '']);
  await workbook.xlsx.writeFile(xlsxPath);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ItemDatabase', () => {
  it('解析 xlsx 并支持搜索/分类/按 ID 查询', async () => {
    const itemDb = new ItemDatabase(tmpDir);
    await itemDb.parseXlsx(xlsxPath);

    expect(itemDb.getAllItems()).toHaveLength(4);

    const results = itemDb.searchItems('tri');
    expect(results).toHaveLength(1);
    expect(results[0].type_id).toBe(34);

    expect(itemDb.getItemById(35834)?.name).toBe('Keepstar');
    expect(itemDb.getItemById(999999)).toBeNull();

    expect(itemDb.getCategories()).toEqual(['标准矿物', '稀有矿物', '超大型堡垒'].sort());

    const tree = itemDb.getCategoryTree();
    expect(tree['材料']['矿物']).toContain('标准矿物');
    expect(tree['建筑']['堡垒']).toContain('超大型堡垒');
  });

  it('解析后写缓存，二次实例直接读缓存', async () => {
    const itemDb = new ItemDatabase(tmpDir);
    await itemDb.parseXlsx(xlsxPath);
    expect(fs.existsSync(path.join(tmpDir, 'items_cache.json'))).toBe(true);

    const itemDb2 = new ItemDatabase(tmpDir);
    await itemDb2.ensureLoaded(); // 缓存有效，不应重新下载
    expect(itemDb2.getAllItems()).toHaveLength(4);
    expect(itemDb2.searchItems('keepstar')[0].type_id).toBe(35834);
  });
});
