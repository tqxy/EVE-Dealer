/**
 * EVE-Dealer 前端逻辑
 * 价格查询：星域选择 + 物品搜索（防抖自动补全）
 * → 实时价格卡 + 订单明细（每 60 秒自动刷新）+ 历史价格曲线（uPlot）
 */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const searchInput = $('searchInput');
  const regionSelect = $('regionSelect');
  const regionLabel = $('regionLabel');
  const dropdown = $('searchDropdown');
  const resultArea = $('resultArea');
  const emptyState = $('emptyState');
  const warningBar = $('warningBar');

  const AUTO_REFRESH_MS = 15 * 1000;

  let currentItem = null;
  let currentRegion = 10000002; // The Forge
  let chart = null;
  let fullHistory = null;
  let autoRefreshTimer = null;

  // ---------- 工具 ----------

  function formatIsk(n) {
    if (n == null || isNaN(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M';
    if (n >= 1e4) return (n / 1e3).toFixed(2) + ' K';
    return Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }

  function formatQty(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('zh-CN');
  }

  function formatTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  }

  function formatOrderAge(iso) {
    if (!iso) return '—';
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    return days + ' 天前';
  }

  function showWarning(msg) {
    warningBar.textContent = msg;
    warningBar.classList.remove('hidden');
    clearTimeout(showWarning._t);
    showWarning._t = setTimeout(() => warningBar.classList.add('hidden'), 6000);
  }

  async function api(path) {
    const res = await fetch(path);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function iconUrl(typeId, size = 32) {
    return `https://images.evetech.net/types/${typeId}/icon?size=${size}`;
  }

  function regionParam() {
    return '?region=' + currentRegion;
  }

  // ---------- 星域选择 ----------

  async function loadRegions() {
    try {
      const { regions } = await api('/api/regions');
      regionSelect.innerHTML = '<option value="0">全星域</option>' + regions.map(r =>
        `<option value="${r.region_id}"${r.region_id === currentRegion ? ' selected' : ''}>${escapeHtml(r.name)}</option>`
      ).join('');
      regionSelect.value = String(currentRegion);
      updateRegionLabel();
    } catch (err) {
      updateRegionLabel();
      showWarning('星域列表加载失败: ' + err.message);
    }
  }

  function updateRegionLabel() {
    if (currentRegion === 0) {
      regionLabel.textContent = '全星域（各星域订单聚合 + 公开合同）';
      return;
    }
    const text = regionSelect.options[regionSelect.selectedIndex]?.text || '未知星域';
    regionLabel.textContent = text + (currentRegion === 10000002 ? '（Jita 4-4 空间站）' : '（全星域订单）');
  }

  regionSelect.addEventListener('change', () => {
    currentRegion = Number(regionSelect.value);
    updateRegionLabel();
    if (currentItem) {
      resetRowSigs(); // 换星域后行身份不同，避免误报变动
      refreshAll(true);
    }
  });

  // ---------- 搜索 ----------

  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length === 0) {
      dropdown.classList.add('hidden');
      return;
    }
    searchTimer = setTimeout(() => doSearch(q), 250);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dropdown.classList.add('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && e.target !== searchInput) {
      dropdown.classList.add('hidden');
    }
  });

  async function doSearch(q) {
    try {
      const { results } = await api('/api/search?q=' + encodeURIComponent(q));
      renderDropdown(results);
    } catch (err) {
      showWarning('搜索失败: ' + err.message);
    }
  }

  function renderDropdown(results) {
    if (!results || results.length === 0) {
      dropdown.innerHTML = '<div class="search-empty">未找到匹配物品</div>';
      dropdown.classList.remove('hidden');
      return;
    }
    dropdown.innerHTML = results.map(item => `
      <div class="search-item" data-id="${item.type_id}">
        <img src="${iconUrl(item.type_id)}" alt="" onerror="this.style.visibility='hidden'">
        <span class="s-name">${escapeHtml(item.name)}</span>
        <span class="s-cat">${escapeHtml(item.category || '')}</span>
      </div>
    `).join('');
    dropdown.classList.remove('hidden');
    dropdown.querySelectorAll('.search-item').forEach(el => {
      el.addEventListener('click', () => {
        dropdown.classList.add('hidden');
        searchInput.value = el.querySelector('.s-name').textContent;
        selectItem(Number(el.dataset.id));
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ---------- 物品详情 ----------

  async function selectItem(typeId) {
    currentItem = typeId;
    emptyState.classList.add('hidden');
    resultArea.classList.remove('hidden');
    lastOrders = null;
    lastContracts = null;
    resetRowSigs();
    clearTimeout(contractPollTimer);

    $('itemName').textContent = '加载中…';
    $('itemCategory').textContent = '';
    $('itemId').textContent = 'TYPE ' + typeId;
    $('itemIcon').src = iconUrl(typeId, 64);
    $('itemIcon').onerror = () => { $('itemIcon').style.visibility = 'hidden'; };
    $('itemIcon').onload = () => { $('itemIcon').style.visibility = 'visible'; };
    ['priceSell', 'priceBuy', 'priceVolume', 'priceAvg'].forEach(id => { $(id).textContent = '…'; });

    api('/api/item/' + typeId).then(({ item }) => {
      $('itemName').textContent = item.name;
      const cats = [item.category_1, item.category_2, item.category_3].filter(Boolean);
      $('itemCategory').textContent = cats.join(' / ');
    }).catch(() => {});

    refreshAll(true);
  }

  /** 重新加载价格/订单/合同/历史；withHistory=false 时仅刷实时数据（自动刷新用） */
  function refreshAll(withHistory) {
    if (!currentItem) return;
    loadPrice(currentItem);
    loadOrders(currentItem);
    loadContracts(currentItem);
    if (withHistory) loadHistory(currentItem);
    scheduleAutoRefresh();
  }

  // ---------- 实时价格 ----------

  async function loadPrice(typeId) {
    try {
      const { price, fromCache } = await api('/api/price/' + typeId + regionParam());
      if (currentItem !== typeId) return;
      setWithFlash($('priceSell'), formatIsk(price.sell) + (price.sell != null ? ' ISK' : '') +
        (price.sell_region_name ? `<span class="region-hint">${escapeHtml(price.sell_region_name)}</span>` : ''));
      setWithFlash($('priceBuy'), formatIsk(price.buy) + (price.buy != null ? ' ISK' : '') +
        (price.buy_region_name ? `<span class="region-hint">${escapeHtml(price.buy_region_name)}</span>` : ''));
      setWithFlash($('priceVolume'), price.volume ? formatQty(price.volume.volume) : '—');
      setWithFlash($('priceAvg'), price.volume ? formatIsk(price.volume.average) + ' ISK' : '—');
      $('priceUpdatedAt').textContent =
        `价格更新于 ${formatTime(price.updatedAt)}${fromCache ? '（缓存）' : '（实时拉取）'}`;
    } catch (err) {
      showWarning('价格获取失败: ' + err.message);
    }
  }

  // ---------- 数据变动特效 ----------

  /** 元素内容变化时播放闪烁特效 */
  function setWithFlash(el, html) {
    const prev = el.textContent;
    el.innerHTML = html;
    const next = el.textContent;
    if (prev && prev !== '…' && prev !== '—' && next !== prev) {
      el.classList.remove('flash-change');
      void el.offsetWidth; // 重启动画
      el.classList.add('flash-change');
    }
  }

  /** 各订单表上一轮的行签名：id → "价格|数量" */
  const prevRowSigs = { sell: new Map(), buy: new Map() };

  function rowSigChanged(side, id, sig) {
    const map = prevRowSigs[side];
    const changed = map.has(id) && map.get(id) !== sig;
    map.set(id, sig);
    return changed;
  }

  function resetRowSigs() {
    prevRowSigs.sell.clear();
    prevRowSigs.buy.clear();
  }

  let lastOrders = null;    // { sell:[], buy:[], updatedAt }
  let lastContracts = null; // { contracts:[], ready, scanning, scannedRegions }
  let contractPollTimer = null;

  async function loadOrders(typeId) {
    try {
      const { orders, fromCache } = await api('/api/orders/' + typeId + regionParam());
      if (currentItem !== typeId) return;
      lastOrders = orders;
      renderMergedOrders();
      $('ordersUpdatedAt').textContent =
        `订单更新于 ${formatTime(orders.updatedAt)}${fromCache ? '（缓存）' : '（实时拉取）'}`;
    } catch (err) {
      showWarning('订单获取失败: ' + err.message);
    }
  }

  async function loadContracts(typeId) {
    clearTimeout(contractPollTimer);
    $('contractsNote').textContent = '合同索引加载中…';
    try {
      const data = await api('/api/contracts/' + typeId + regionParam());
      if (currentItem !== typeId) return;
      lastContracts = data;
      renderMergedOrders();

      const note = $('contractsNote');
      if (!data.ready && data.scanning) {
        note.textContent = '合同索引构建中（首次约需几分钟），稍后自动更新…';
        contractPollTimer = setTimeout(() => {
          if (currentItem === typeId) loadContracts(typeId);
        }, 20000);
      } else if (data.ready) {
        const est = data.contracts.filter(c => c.estimated).length;
        const regionText = currentRegion === 0 ? `，覆盖 ${data.scannedRegions.length} 个星域` : '';
        note.textContent =
          `公开合同 ${data.contracts.length} 份（含估算 ${est} 份${regionText}` +
          `${data.scanning ? '，后台续扫中' : ''}）`;
        if (data.scanning) {
          contractPollTimer = setTimeout(() => {
            if (currentItem === typeId) loadContracts(typeId);
          }, 30000);
        }
      } else {
        note.textContent = '暂无合同数据';
      }
    } catch (err) {
      $('contractsNote').textContent = '';
      showWarning('合同获取失败: ' + err.message);
    }
  }

  /** 订单 + 合同合并渲染：卖侧升序、买侧降序，各取前 20 */
  function renderMergedOrders() {
    const sellContracts = (lastContracts?.contracts ?? [])
      .filter(c => c.side === 'sell')
      .map(c => ({ kind: 'contract', price: c.unit_price, quantity: c.quantity, contract: c }));
    const buyContracts = (lastContracts?.contracts ?? [])
      .filter(c => c.side === 'buy')
      .map(c => ({ kind: 'contract', price: c.unit_price, quantity: c.quantity, contract: c }));

    const sellRows = [
      ...(lastOrders?.sell ?? []).map(o => ({ kind: 'order', price: o.price, quantity: o.volume_remain, order: o })),
      ...sellContracts
    ].sort((a, b) => a.price - b.price).slice(0, 20);

    const buyRows = [
      ...(lastOrders?.buy ?? []).map(o => ({ kind: 'order', price: o.price, quantity: o.volume_remain, order: o })),
      ...buyContracts
    ].sort((a, b) => b.price - a.price).slice(0, 20);

    renderRows($('sellOrdersBody'), sellRows, 'sell');
    renderRows($('buyOrdersBody'), buyRows, 'buy');
  }

  function renderRows(tbody, rows, side) {
    if (!rows || rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="orders-empty">暂无数据</td></tr>';
      return;
    }
    const priceCls = side === 'sell' ? 'o-price-sell' : 'o-price-buy';
    const valuation = lastContracts?.valuation;
    const basisText = valuation?.basis === 'sell' ? '最低卖单价' : '最高收单价';
    const discountText = valuation?.discount ?? 0.9;
    tbody.innerHTML = rows.map(r => {
      if (r.kind === 'contract') {
        const c = r.contract;
        const flash = rowSigChanged(side, 'c' + c.contract_id, `${c.unit_price}|${c.quantity}`) ? ' class="row-flash"' : '';
        const priceHtml = c.estimated
          ? `<span class="price-estimated" title="合同含其他物品：总价已扣除其他物品估值（该星域${basisText}×${discountText}）后折算">≈${formatQty(c.unit_price)}</span>`
          : formatQty(c.unit_price);
        const loc = c.region_name ? `<span class="o-loc">${escapeHtml(c.region_name)}</span>` : '<span class="o-loc">—</span>';
        return `<tr${flash}>
          <td class="${priceCls}">${priceHtml}<span class="tag-contract" title="公开合同${c.title ? '：' + escapeHtml(c.title) : ''}">合同</span></td>
          <td>${formatQty(c.quantity)}</td>
          <td>${loc}</td>
          <td class="o-time">${formatExpiry(c.date_expired)}</td>
        </tr>`;
      }
      const o = r.order;
      const flash = rowSigChanged(side, 'o' + o.order_id, `${o.price}|${o.volume_remain}`) ? ' class="row-flash"' : '';
      const sysLoc = o.system_name || (o.system_id ? '星系 ' + o.system_id : '—');
      const locText = o.region_name ? `${o.region_name} · ${sysLoc}` : sysLoc;
      const locHtml = o.is_structure
        ? `<span class="o-structure" title="玩家建筑订单">${escapeHtml(locText)} ⧉</span>`
        : `<span class="o-loc">${escapeHtml(locText)}</span>`;
      return `<tr${flash}>
        <td class="${priceCls}">${formatQty(o.price)}</td>
        <td>${formatQty(o.volume_remain)}</td>
        <td>${locHtml}</td>
        <td class="o-time">${formatOrderAge(o.issued)}</td>
      </tr>`;
    }).join('');
  }

  function formatExpiry(iso) {
    if (!iso) return '—';
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return '已到期';
    const hours = Math.floor(ms / 3600000);
    if (hours < 24) return `剩 ${hours} 小时`;
    return `剩 ${Math.floor(hours / 24)} 天`;
  }

  // ---------- 自动刷新 ----------

  function scheduleAutoRefresh() {
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = setTimeout(() => {
      // 仅刷新实时数据（价格 + 订单 + 合同），历史曲线不频繁重拉
      if (currentItem) {
        loadPrice(currentItem);
        loadOrders(currentItem);
        loadContracts(currentItem);
      }
      scheduleAutoRefresh();
    }, AUTO_REFRESH_MS);
  }

  // ---------- 历史价格 ----------

  async function loadHistory(typeId) {
    const chartPanel = document.querySelector('.chart-panel');
    if (currentRegion === 0) {
      chartPanel.classList.add('hidden');
      return;
    }
    chartPanel.classList.remove('hidden');
    try {
      const { history } = await api('/api/history/' + typeId + regionParam());
      if (currentItem !== typeId) return;
      if (!history || history.length === 0) {
        showWarning('该物品在此星域没有市场历史数据');
        fullHistory = null;
        if (chart) { chart.destroy(); chart = null; }
        return;
      }
      fullHistory = {
        dates: history.map(h => Math.floor(new Date(h.date + 'T00:00:00Z').getTime() / 1000)),
        avg: history.map(h => h.average),
        high: history.map(h => h.highest),
        low: history.map(h => h.lowest),
        volume: history.map(h => h.volume)
      };
      const activeBtn = document.querySelector('.range-btn.active');
      renderChart(activeBtn ? Number(activeBtn.dataset.days) : 0);
    } catch (err) {
      showWarning('历史数据获取失败: ' + err.message);
    }
  }

  function sliceHistory(days) {
    if (!fullHistory) return null;
    if (!days || days <= 0) return fullHistory;
    const cutoff = fullHistory.dates[fullHistory.dates.length - 1] - days * 86400;
    let start = fullHistory.dates.findIndex(d => d >= cutoff);
    if (start < 0) start = 0;
    return {
      dates: fullHistory.dates.slice(start),
      avg: fullHistory.avg.slice(start),
      high: fullHistory.high.slice(start),
      low: fullHistory.low.slice(start),
      volume: fullHistory.volume.slice(start)
    };
  }

  function renderChart(days) {
    const h = sliceHistory(days);
    if (!h) return;
    const data = [h.dates, h.avg, h.high, h.low, h.volume];

    const opts = {
      width: $('chart').clientWidth,
      height: 380,
      padding: [12, 8, 0, 8],
      cursor: { drag: { x: true, y: false } },
      legend: { show: false },
      scales: {
        x: { time: true },
        vol: { range: (u, min, max) => [0, max * 3] }
      },
      axes: [
        {
          stroke: 'rgba(255,255,255,0.5)',
          grid: { stroke: '#1e2022', width: 1 },
          ticks: { stroke: '#213841', width: 1 },
          font: '11px "Segoe UI", sans-serif'
        },
        {
          stroke: '#58a7bf',
          grid: { stroke: '#1e2022', width: 1 },
          ticks: { stroke: '#213841', width: 1 },
          font: '11px "Segoe UI", sans-serif',
          values: (u, vals) => vals.map(v => formatIsk(v)),
          size: 70
        },
        {
          side: 1,
          scale: 'vol',
          stroke: 'rgba(255,255,255,0.35)',
          grid: { show: false },
          ticks: { show: false },
          font: '11px "Segoe UI", sans-serif',
          values: (u, vals) => vals.map(v => formatIsk(v)),
          size: 60
        }
      ],
      series: [
        {},
        { stroke: '#58a7bf', width: 2, points: { show: false } },
        { stroke: '#8dc169', width: 1, points: { show: false } },
        { stroke: '#ff454b', width: 1, points: { show: false } },
        {
          scale: 'vol',
          stroke: 'rgba(64,113,150,0.5)',
          fill: 'rgba(64,113,150,0.3)',
          paths: uPlot.paths.bars({ size: [0.6, 20] }),
          points: { show: false }
        }
      ]
    };

    if (chart) chart.destroy();
    chart = new uPlot(opts, data, $('chart'));
  }

  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderChart(Number(btn.dataset.days));
    });
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (chart) chart.setSize({ width: $('chart').clientWidth, height: 380 });
    }, 150);
  });

  // ---------- 页面导航 ----------

  let countdownTimer = null;

  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', () => {
      if (item.classList.contains('disabled')) return;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('.page').forEach(pg => pg.classList.add('hidden'));
      $('page-' + item.dataset.page).classList.remove('hidden');
      if (item.dataset.page === 'settings') {
        loadAuthStatus();
        loadValuationConfig();
      }
    });
  });

  // ---------- 设置 / ESI 凭证 ----------

  let currentAuthUrl = null;

  function authWarn(msg) {
    const bar = $('authWarningBar');
    bar.textContent = msg;
    bar.classList.remove('hidden');
    clearTimeout(authWarn._t);
    authWarn._t = setTimeout(() => bar.classList.add('hidden'), 8000);
  }

  function renderAuthStatus(status) {
    const badge = $('authBadge');
    const charName = $('authCharName');
    const statusLine = $('authStatusLine');
    const scopesEl = $('authScopes');
    const avatar = $('authAvatar');

    clearInterval(countdownTimer);
    countdownTimer = null;

    if (!status.loggedIn) {
      charName.textContent = '未登录';
      statusLine.textContent = '尚未持有 ESI 凭证';
      scopesEl.textContent = '';
      badge.textContent = '无凭证';
      badge.className = 'auth-badge badge-none';
      avatar.classList.add('hidden');
      return;
    }

    charName.textContent = status.character_name || '未知角色';
    if (status.character_id) {
      avatar.src = `https://images.evetech.net/characters/${status.character_id}/portrait?size=128`;
      avatar.classList.remove('hidden');
      avatar.onerror = () => avatar.classList.add('hidden');
    } else {
      avatar.classList.add('hidden');
    }
    scopesEl.textContent = status.scopes ? '权限: ' + status.scopes : '';

    const updateLine = () => {
      const sec = Math.max(0, Math.floor((new Date(status.expires_at).getTime() - Date.now()) / 1000));
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      const modeText = status.can_refresh ? '授权码模式 · 到期自动刷新' : '隐式模式 · 无法自动刷新，到期需重新登录';
      statusLine.textContent = `到期时间 ${new Date(status.expires_at).toLocaleString('zh-CN')}（剩余 ${mm}:${ss}）· ${modeText}`;
      if (sec <= 0) {
        badge.textContent = '已过期';
        badge.className = 'auth-badge badge-expired';
      }
    };

    if (status.valid) {
      badge.textContent = '有效';
      badge.className = 'auth-badge badge-valid';
    } else {
      badge.textContent = '已过期';
      badge.className = 'auth-badge badge-expired';
    }
    updateLine();
    countdownTimer = setInterval(updateLine, 1000);
  }

  async function loadAuthStatus() {
    try {
      const status = await api('/api/auth/status');
      renderAuthStatus(status);
    } catch (err) {
      authWarn('凭证状态获取失败: ' + err.message);
    }
  }

  $('openAuthBtn').addEventListener('click', async () => {
    try {
      const { url } = await api('/api/auth/url');
      currentAuthUrl = url;
      const urlLine = $('authUrlLine');
      urlLine.textContent = url;
      urlLine.classList.remove('hidden');
      $('copyAuthUrlBtn').classList.remove('hidden');
      window.open(url, '_blank');
    } catch (err) {
      authWarn('授权链接生成失败: ' + err.message);
    }
  });

  $('copyAuthUrlBtn').addEventListener('click', async () => {
    if (!currentAuthUrl) return;
    try {
      await navigator.clipboard.writeText(currentAuthUrl);
      authWarn('授权链接已复制');
    } catch {
      authWarn('复制失败，请手动选中链接复制');
    }
  });

  $('saveCallbackBtn').addEventListener('click', async () => {
    const url = $('callbackInput').value.trim();
    if (!url) { authWarn('请先粘贴回调地址'); return; }
    try {
      const res = await fetch('/api/auth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      $('callbackInput').value = '';
      renderAuthStatus(data.status);
      authWarn('凭证已保存' + (data.status.character_name ? '：' + data.status.character_name : ''));
    } catch (err) {
      authWarn('凭证保存失败: ' + err.message);
    }
  });

  $('refreshTokenBtn').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.refreshed) throw new Error(data.error || `HTTP ${res.status}`);
      renderAuthStatus(data.status);
      authWarn('凭证已刷新');
    } catch (err) {
      authWarn('刷新失败: ' + err.message);
    }
  });

  $('clearTokenBtn').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/auth/clear', { method: 'POST' });
      const data = await res.json();
      renderAuthStatus(data.status);
      authWarn('凭证已清除');
    } catch (err) {
      authWarn('清除失败: ' + err.message);
    }
  });

  // ---------- 设置 / 合同单价公式 ----------

  async function loadValuationConfig() {
    try {
      const cfg = await api('/api/config/valuation');
      $('basisSelect').value = cfg.basis;
      $('discountInput').value = cfg.discount;
      updateBasisText();
    } catch (err) {
      authWarn('公式配置加载失败: ' + err.message);
    }
  }

  function updateBasisText() {
    $('basisText').textContent =
      $('basisSelect').value === 'sell' ? '该星域最低卖单价' : '该星域最高收单价';
  }

  $('basisSelect').addEventListener('change', updateBasisText);

  $('saveValuationBtn').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/config/valuation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          basis: $('basisSelect').value,
          discount: Number($('discountInput').value)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const saved = $('valuationSaved');
      saved.classList.remove('hidden');
      setTimeout(() => saved.classList.add('hidden'), 3000);
      // 公式变了，重新拉取当前物品的合同估值
      if (currentItem) loadContracts(currentItem);
    } catch (err) {
      authWarn('公式保存失败: ' + err.message);
    }
  });

  // 支持 ?type=<typeId> 深链，直接打开某物品
  const deepLink = new URLSearchParams(location.search).get('type');
  if (deepLink && /^\d+$/.test(deepLink)) {
    selectItem(Number(deepLink));
  }

  loadRegions();
  searchInput.focus();
})();
