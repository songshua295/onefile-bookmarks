import { parseBookmarkHTML, serializeBookmarkHTML } from './parser.js';
import { treeToNodes, nodesToTree, diffNodes, newId } from './model.js';
import { state, loadCache, loadMeta, mergeRemoteMeta, recordOpen, syncMetaNow, clearDirty, defaultExpand, collapseAllFolders, applyClicksToAttrs, syncClicksFromAttrs, clicksClass } from './store.js';
import { renderTree, wireTreeEvents, buildIndex, findNode, findParent, findToolbarFolder, pathOf, addBookmark, addFolder, updateNode, deleteNode, ensureFolderPath } from './tree.js';
import { flatten, flattenFolders, searchBookmarks } from './search.js';
import { icoGlobe, icoCode } from './icons.js';

const $ = s => document.querySelector(s);
const LOCAL_FALLBACK = 'favorites_2026_9_20.html';
const AUTH_KEY = 'bm_auth_v1';
// 扁平化缓存 + 索引:按 URL / id 查找 O(1),避免每次线性扫描
let flatCache = null;
function getFlat() {
  if (!flatCache) {
    const list = flatten(state.tree);
    const byUrl = new Map(), byId = new Map();
    for (const i of list) {
      byId.set(i.node.id, i);
      if (i.node.url && !byUrl.has(i.node.url)) byUrl.set(i.node.url, i);
    }
    flatCache = { list, byUrl, byId };
  }
  return flatCache;
}

// 带访问口令的 fetch;401 时清除缓存令牌,响应原样返回由调用方处理
async function api(path, opts = {}) {
  const token = localStorage.getItem(AUTH_KEY) || '';
  opts.headers = Object.assign({}, opts.headers, token ? { 'x-auth': token } : {});
  const r = await fetch(path, opts);
  if (r.status === 401) localStorage.removeItem(AUTH_KEY);
  return r;
}

init();

// 旧版 v1 localStorage 缓存(整树 JSON):迁移时使用
let legacyCache = null;

async function init() {
  loadMeta();

  // 1) 缓存优先:有本地缓存立即渲染首屏,云端校验放到后台,首屏不再等网络
  const cache = await loadCache();
  let booted = false;
  if (cache && cache.v === 2 && Array.isArray(cache.nodes)) {
    state.base = cache.base || {};
    state.since = cache.since || 0;
    state.rev = cache.rev || 0;
    state.lineage = cache.lineage || null;
    state.etag = cache.etag || null;
    state.dirty = !!cache.dirty;
    state.tree = nodesToTree(cache.nodes);
    boot();
    booted = true;
  } else if (cache && cache.tree) {
    legacyCache = cache;   // 旧版 v1 缓存:留给迁移逻辑
    if (cache.dirty) {
      // 带未上传修改的旧缓存:直接以它为工作副本,上传时再与云端按条合并
      state.tree = cache.tree;
      state.dirty = true;
      state.base = {};
      boot();
      booted = true;
    }
  }

  // 2) 配置与云端增量并行拉取;带 If-None-Match,云端未变化时 304 几乎零流量
  const cfgPromise = fetchConfig();
  const syncPromise = state.dirty ? Promise.resolve({ status: 'skip' }) : fetchSyncDelta();
  state.config = await cfgPromise;

  // 可选访问密码:配置了且本地没有记住的令牌时,先解锁
  if (state.config.needAuth && !localStorage.getItem(AUTH_KEY)) {
    const ok = await promptPassword();
    if (!ok) {
      setStatus('未解锁:输入密码后才能读写云端数据');
      if (!booted) return;
    }
  }

  let sync = await syncPromise;
  // 首个并行请求可能发生在解锁前(401):解锁后重试一次
  if ((!sync || sync.status === 401) && state.config.storageType !== 'none' && localStorage.getItem(AUTH_KEY)) {
    sync = state.dirty ? { status: 'skip' } : await fetchSyncDelta();
  }

  if (state.config.storageType !== 'none') {
    if (!sync || sync.status === 'skip' || sync.status === 401) {
      // 网络失败/带 dirty 跳过:保留现有数据
      if (state.dirty) setStatus('⚠ 本地有未上传的修改;点「上传」会与云端按条自动合并');
    } else if (sync.status === 304) {
      // 云端未变化,当前数据即最新
    } else if (sync.status === 404) {
      if (booted) setStatus('⚠ 云端数据文件不存在,点「上传」可重建');
      else await migrateFromLegacy();
    } else if (sync.status === 200) {
      if (state.dirty) {
        setStatus('⚠ 本地有未上传的修改;点「上传」会与云端按条自动合并');
      } else {
        applySyncDelta(sync.j);
        if (!booted) { boot(); booted = true; }
      }
    }
  }

  // 没有任何数据(未配置存储/云端不可用):回退本地文件
  if (!state.tree) await loadLocalFallback();
  if (!state.tree) return;
  if (!booted) boot();

  if (state.dirty && state.config.storageType !== 'none') {
    setStatus('⚠ 本地有未上传的修改;点「上传」会与云端按条自动合并');
  }

  await mergeRemote();
  handleQuickAdd();
}

// 首屏装配:索引、渲染、事件只挂一次;后续数据刷新只重渲染,不重复绑定
function boot() {
  buildIndex(state.tree);
  syncClicksFromAttrs(state.tree);
  defaultExpand(state.tree);
  renderTree($('#tree'));
  wireTreeEvents($('#tree'), { onAction, onOpen: renderRecents, onMoved });
  renderBookmarklet();
  renderRecents();
  // resize 时重建最近打开条很便宜地频繁触发:防抖
  let rzTimer = null;
  window.addEventListener('resize', () => { clearTimeout(rzTimer); rzTimer = setTimeout(renderRecents, 150); });
  wireSearch();
  wireButtons();
  updateDirtyBadge();
}

async function fetchConfig() {
  try {
    const r = await api('/api/config', { cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch { /* file:// 或无后端 */ }
  return { storageType: 'none', uploadMode: 'overwrite', autoUpload: false, aiEnabled: false, needAuth: false, localFile: LOCAL_FALLBACK };
}

// ---------- 云端同步:解析后的节点级增量 ----------
// GET /api/sync?since=<毫秒>&lineage=<谱系>:只返回 since 之后变化的节点;
// 带 If-None-Match 时云端未变化返回 304;lineage 不一致/首次访问返回全量
async function fetchSyncDelta() {
  try {
    const q = new URLSearchParams({ since: String(state.since || 0) });
    if (state.lineage) q.set('lineage', state.lineage);
    const headers = {};
    if (state.etag && !state.dirty) headers['If-None-Match'] = state.etag;
    const r = await api('/api/sync?' + q.toString(), { cache: 'no-store', headers });
    if (r.status === 304) return { status: 304 };
    if (r.status === 404) return { status: 404 };
    if (!r.ok) return { status: r.status };
    return { status: 200, j: await r.json() };
  } catch { return null; }   // 网络失败/无后端
}

// 把云端响应落到本地:更新基线/游标,重建树并重渲染(节点 id 稳定,折叠状态不丢)
function applySyncDelta(j) {
  if (!j) return;
  state.lineage = j.lineage || state.lineage;
  state.rev = typeof j.rev === 'number' ? j.rev : state.rev;
  state.etag = j.etag || null;
  if (typeof j.updatedAt === 'number') state.since = Math.max(state.since, j.updatedAt);
  if (j.full) state.base = {};
  for (const n of (j.nodes || [])) state.base[n.id] = n;
  state.tree = nodesToTree(Object.values(state.base));
  flatCache = null;
  buildIndex(state.tree);
  syncClicksFromAttrs(state.tree);
  renderTree($('#tree'));
  renderRecents();
  updateDirtyBadge();
}

// lineage 分叉(云端被另一端整份重建):以云端为基线,本地修改保留待重新 diff
function rebaseFromServer(j) {
  state.base = {};
  for (const n of (j.nodes || [])) state.base[n.id] = n;
  state.lineage = j.lineage || null;
  state.rev = j.rev || 0;
  state.etag = null;
  state.since = j.updatedAt || 0;
}

async function loadLocalFallback() {
  // 旧版 v1 缓存兜底
  if (legacyCache && legacyCache.tree) {
    state.tree = legacyCache.tree;
    state.dirty = !!legacyCache.dirty;
    state.base = {};
    if (state.config.storageType === 'none') setStatus('未配置远程存储,使用本地缓存(只读模式)');
    return;
  }
  const file = state.config.localFile || LOCAL_FALLBACK;
  try {
    const html = await (await fetch(file)).text();
    state.tree = parseBookmarkHTML(html);
    state.base = {};
    state.etag = null;
    clearDirty();
  } catch { setStatus('无法加载数据:' + file); return; }
  if (state.config.storageType === 'none') setStatus('未配置远程存储,使用本地文件(只读模式)');
}

// 云端还没有 JSON 数据:从旧 HTML(或带未上传修改的 v1 缓存)构建首份数据
async function migrateFromLegacy() {
  let tree = null;          // 工作副本(以后续上传的数据源)
  let baseRecs = null;      // 同步基线(云端 HTML 的解析结果)
  let dirty = false;
  let htmlTree = null;
  try {
    const r = await api('/api/bookmark?type=bookmark', { cache: 'no-store' });
    if (r.ok) htmlTree = parseBookmarkHTML(await r.text());
  } catch { /* 忽略,回退缓存 */ }

  if (legacyCache && legacyCache.tree && legacyCache.dirty) {
    // 本地有未上传的修改:以缓存树为工作副本、云端 HTML 为基线 → diff 恰好是本地改动
    tree = legacyCache.tree;
    baseRecs = htmlTree ? treeToNodes(htmlTree) : treeToNodes(legacyCache.tree);
    dirty = true;
  } else if (htmlTree) {
    tree = htmlTree;
    baseRecs = treeToNodes(htmlTree);
  } else if (legacyCache && legacyCache.tree) {
    tree = legacyCache.tree;
    baseRecs = treeToNodes(legacyCache.tree);
    dirty = !!legacyCache.dirty;
  }
  if (!tree) { await loadLocalFallback(); return; }

  state.tree = tree;
  state.base = {};
  for (const rec of baseRecs) state.base[rec.id] = rec;
  state.since = 0; state.rev = 0; state.lineage = null; state.etag = null;
  flatCache = null;
  buildIndex(tree);
  syncClicksFromAttrs(tree);
  renderTree($('#tree'));
  renderRecents();
  updateDirtyBadge();
  if (dirty) {
    state.dirty = true;
    updateDirtyBadge();
    setStatus('⚠ 检测到旧版未上传的本地修改;点「上传」会写入新版云端数据');
  } else {
    const ok = await seedUpload();
    if (ok) setStatus('✅ 已完成云端数据迁移(HTML → JSON)');
  }
}

// 首次迁移:整份数据推到云端建立 JSON(之后所有上传都是增量)
async function seedUpload() {
  try {
    const recs = treeToNodes(state.tree);
    const now = Date.now();
    for (const r of recs) r.updatedAt = now;
    const r = await api('/api/sync', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ lineage: newId(), replace: true, nodes: recs })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || r.status);
    clearDirty();
    applySyncDelta(j);
    return true;
  } catch (e) {
    setStatus('❌ 初始化云端 JSON 失败:' + e.message);
    return false;
  }
}

async function mergeRemote() {
  if (state.config.storageType === 'none') return;
  try {
    const r = await api('/api/bookmark?type=meta', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (j && j.content) {
      const before = JSON.stringify(state.meta.counts);
      mergeRemoteMeta(j.content);
      if (JSON.stringify(state.meta.counts) !== before) renderRecents();
    }
  } catch { /* 忽略 */ }
}

// ---------- 最近打开 ----------
function renderRecents() {
  const box = $('#recents');
  box.innerHTML = '';
  const entries = Object.entries(state.meta.counts)
    .filter(([, c]) => c.n > 0)
    .sort((a, b) => (b[1].last || 0) - (a[1].last || 0))
    .slice(0, 30);
  if (!entries.length) { box.innerHTML = '<span style="color:var(--muted);font-size:12px">暂无记录</span>'; return; }
  for (const [url, c] of entries) {
    const a = document.createElement('a');
    a.className = 'recent';
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    if (/^javascript:/i.test(url)) { a.removeAttribute('target'); }   // bookmarklet 必须在本页执行
    const node = findByUrl(url);
    const title = c.title || (node ? node.title : url);
    const icon = document.createElement('span');
    if (node && node.attrs && node.attrs.icon) {
      const img = document.createElement('img'); img.src = node.attrs.icon; icon.appendChild(img);
    } else icon.innerHTML = icoGlobe;
    const label = document.createElement('span');
    label.textContent = title;
    a.append(icon, label);
    a.addEventListener('click', () => recordOpen(url));
    box.appendChild(a);
  }
  // 按可用宽度裁剪,只显示放得下的条目;移动端改为横向滚动,不裁剪
  if (!window.matchMedia('(max-width: 640px)').matches) {
    while (box.scrollWidth > box.clientWidth && box.children.length > 1) box.removeChild(box.lastChild);
  }
}

function findByUrl(url) {
  const hit = getFlat().byUrl.get(url);
  return hit ? hit.node : null;
}

// ---------- 搜索 ----------
function wireSearch() {
  const input = $('#search');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => localSearch(input.value), 150);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { input.value = ''; localSearch(''); }
  });
}

function localSearch(q) {
  const treeEl = $('#tree'), resEl = $('#results');
  if (!q.trim()) { resEl.hidden = true; treeEl.hidden = false; return; }
  const results = searchBookmarks(getFlat().list, q);
  resEl.hidden = false; treeEl.hidden = true;
  resEl.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'result-head';
  head.textContent = `共 ${results.length} 条结果(多关键字 AND + 模糊匹配)`;
  // 二次 AI 精搜:只把本地命中的结果交给 AI,省 token;未配置 AI 时不显示
  if (results.length && state.config.aiEnabled) {
    const btn = document.createElement('button');
    btn.className = 'ai-refine';
    btn.textContent = 'AI 精搜';
    btn.title = '把上面的关键字结果交给 AI 二次筛选(只发送这些结果,更准也更省 token)';
    btn.onclick = () => aiSearch(q, results.slice(0, 50).map(r => ({ id: r.node.id, title: r.node.title, path: r.path, url: r.node.url })));
    head.appendChild(btn);
  }
  resEl.appendChild(head);
  if (!results.length) {
    resEl.innerHTML += '<div class="empty">没有匹配的书签,试试更短的关键字</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of results.slice(0, 200)) frag.appendChild(resultRow(r.node, r.path));
  resEl.appendChild(frag);
}

function resultRow(node, path) {
  const isBmlet = /^javascript:/i.test(node.url || '');
  const a = document.createElement('a');
  a.className = 'row bm' + (isBmlet ? ' bmlet' : '');
  a.href = node.url; a.draggable = true;
  if (!isBmlet) { a.target = '_blank'; a.rel = 'noopener'; }
  const icon = document.createElement('span'); icon.className = 'bicon';
  if (isBmlet) icon.innerHTML = icoCode;
  else if (node.attrs && node.attrs.icon) { const img = document.createElement('img'); img.src = node.attrs.icon; icon.appendChild(img); }
  else icon.innerHTML = icoGlobe;
  const name = document.createElement('span'); name.className = 'name'; name.textContent = node.title;
  const p = document.createElement('span'); p.className = 'path'; p.textContent = path || '';
  const n = (state.meta.counts[node.url] || {}).n || 0;
  const clicks = document.createElement('span');
  clicks.className = ('cnt-clicks ' + clicksClass(n)).trim();
  if (n > 0) clicks.textContent = n;
  a.append(icon, name, p, clicks);
  a.addEventListener('click', () => {
    recordOpen(node.url, node.title);
    const m = (state.meta.counts[node.url] || {}).n || 0;
    clicks.className = ('cnt-clicks ' + clicksClass(m)).trim();
    clicks.textContent = m || '';
    renderRecents();
  });
  return a;
}

// 二次精搜:items 是本地关键字搜索已命中的结果(最多 50 条),AI 只从中挑选
async function aiSearch(q, items) {
  if (!q.trim() || !Array.isArray(items) || !items.length) return;
  if (!state.config.aiEnabled) { setStatus('AI 未配置:请设置 AI_BASE_URL / AI_API_KEY / AI_MODEL'); return; }
  const resEl = $('#results'), treeEl = $('#tree');
  treeEl.hidden = true; resEl.hidden = false;
  resEl.innerHTML = `<div class="empty">AI 正在从 ${items.length} 条结果中精搜…</div>`;
  try {
    const r = await api('/api/ai', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, items })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    resEl.innerHTML = '';
    if (j.answer) {
      const d = document.createElement('div');
      d.className = 'ai-answer'; d.textContent = j.answer;
      resEl.appendChild(d);
    }
    const hits = (j.ids || []).map(id => findNode(id)).filter(Boolean);
    if (!hits.length) { resEl.innerHTML += '<div class="empty">AI 没有找到相关书签</div>'; return; }
    const frag = document.createDocumentFragment();
    for (const n of hits) {
      const item = getFlat().byId.get(n.id);
      frag.appendChild(resultRow(n, item ? item.path : ''));
    }
    resEl.appendChild(frag);
  } catch (e) {
    resEl.innerHTML = `<div class="empty">AI 搜索失败:${e.message}</div>`;
  }
}

// ---------- 上传:增量 ----------
// 与基线 diff 出变更节点(新增/修改/移动/删除),只上传这些;服务端按条 LWW 合并
async function upload(silent = false) {
  if (state.config.storageType === 'none') state.config = await fetchConfig();
  if (state.config.storageType === 'none') { setStatus('未配置存储:请在 .env 或 Vercel 环境变量中配置 S3 / WebDAV'); return; }
  if (!state.tree) { setStatus('还没有书签数据'); return; }
  const upserts = diffNodes(state.base, state.tree, state.meta, Date.now());
  if (!upserts.length && !state.dirty) { if (!silent) setStatus('没有需要上传的更改'); return; }
  if (!silent && !confirm('将本次更改上传到云端?\n(增量上传,只传有改动的书签;与其他设备的修改按条自动合并)')) return;
  setStatus(silent ? '自动上传中…' : '上传中…');
  try {
    let j = await putUpserts(upserts);
    if (j && j.conflict) {
      // 云端历史被另一端整份重建:换到云端基线,重算差异再传一次
      rebaseFromServer(j);
      j = await putUpserts(diffNodes(state.base, state.tree, state.meta, Date.now()));
      if (j && j.conflict) throw new Error('云端数据正被其他设备重建,请稍后重试');
    }
    if (!j || !j.ok) throw new Error((j && j.error) || '上传失败');
    clearDirty();
    applySyncDelta(j);   // 响应里带回了我们自己的变更 + 并发端的新变更
    await syncMetaNow();
    setStatus('✅ 已上传(增量 ' + upserts.length + ' 条)');
  } catch (e) { setStatus('❌ 上传失败:' + e.message); }
}

async function putUpserts(nodes) {
  const r = await api('/api/sync', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ lineage: state.lineage, since: state.since, nodes })
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 409) j.conflict = true;
  return j;
}

// ---------- 同步云端到本地 ----------
// 强制拉取云端全量覆盖本地缓存;解决 B 端改过数据后 A 端一直读缓存的问题
async function syncFromCloud() {
  if (state.config.storageType === 'none') state.config = await fetchConfig();
  if (state.config.storageType === 'none') { setStatus('未配置存储:没有云端数据可同步'); return; }
  if (state.dirty && !confirm('本地有未上传的修改。\n同步云端会丢弃这些修改,以云端数据为准。继续?')) return;
  const btn = $('#sync-btn');
  btn.disabled = true;
  setStatus('正在同步云端…');
  try {
    const r = await api('/api/sync?since=0', { cache: 'no-store' });
    if (r.status === 404) {
      await migrateFromLegacy();
      return;
    }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || r.status);
    }
    const j = await r.json();
    clearDirty();
    applySyncDelta(j);
    await mergeRemote();
    // 退出搜索态,直接展示最新树
    $('#search').value = '';
    $('#results').hidden = true;
    $('#tree').hidden = false;
    setStatus('✅ 已同步云端最新数据');
  } catch (e) { setStatus('❌ 同步失败:' + e.message); }
  finally { btn.disabled = false; }
}

// ---------- 导出 / 本地文件覆盖云端 ----------
// 把当前书签导出为浏览器可直接导入的 Netscape HTML
function exportCurrentHtml() {
  if (!state.tree) { setStatus('还没有书签数据'); return; }
  applyClicksToAttrs(state.tree);
  const blob = new Blob([serializeBookmarkHTML(state.tree)], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bookmarks.html';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  setStatus('已导出浏览器书签 HTML(bookmarks.html)');
}

function pickLocalFile() {
  if (state.config.storageType === 'none') { setStatus('未配置存储:请在 .env 或 Vercel 环境变量中配置 S3 / WebDAV'); return; }
  $('#import-file').click();
}

// 支持 HTML(浏览器导出)与 JSON(此前导出的节点数据)两种来源,整份替换云端
async function importLocalFile(file) {
  const btn = $('#import-btn');
  btn.disabled = true;
  try {
    const text = await file.text();
    let recs = null;
    const s = text.trimStart();
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        const j = JSON.parse(text);
        const arr = Array.isArray(j) ? j : (Array.isArray(j.nodes) ? j.nodes : null);
        if (arr && arr.some(n => n && n.id)) recs = arr.filter(n => n && n.id && !n.deleted);
      } catch { /* 不是合法 JSON,按 HTML 处理 */ }
    }
    let tree = null;
    if (recs) tree = nodesToTree(recs);
    else { tree = parseBookmarkHTML(text); recs = treeToNodes(tree); }
    const c = countNodes(tree);
    if (!c.bookmarks && !c.folders) { setStatus('文件解析失败:没有读到任何书签,已取消'); return; }
    const cur = countNodes(state.tree || nodesToTree([]));
    const warn = state.dirty ? '\n⚠ 你当前有未上传的本地修改,会被该文件替换。' : '';
    if (!confirm(`将用文件「${file.name}」覆盖云端:\n书签 ${cur.bookmarks} → ${c.bookmarks},文件夹 ${cur.folders} → ${c.folders}\n(整份替换,云端历史重置)` + warn)) return;
    setStatus('覆盖上传中…');
    const now = Date.now();
    for (const r of recs) r.updatedAt = now;
    const r = await api('/api/sync', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ lineage: newId(), replace: true, nodes: recs })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || r.status);
    clearDirty();
    applySyncDelta(j);
    setStatus('✅ 已覆盖云端:' + file.name + `(书签 ${c.bookmarks} 条)`);
  } catch (e) {
    setStatus('❌ 覆盖失败:' + e.message);
  } finally {
    btn.disabled = false;
  }
}

function countNodes(node) {
  const out = { bookmarks: 0, folders: 0 };
  (function walk(n) {
    for (const c of n.children || []) {
      if (c.type === 'folder') { out.folders++; walk(c); } else out.bookmarks++;
    }
  })(node);
  return out;
}

// ---------- 弹窗 ----------
function openModal(html) {
  const root = $('#modal-root'), box = $('#modal-box');
  box.innerHTML = html;
  root.hidden = false;
  $('#modal-mask').onclick = closeModal;
  return box;
}
function closeModal() { $('#modal-root').hidden = true; }

// 访问密码解锁;成功后令牌存 localStorage,之后无需再输
function promptPassword() {
  return new Promise(resolve => {
    const box = openModal(`
      <h3>访问验证</h3>
      <label>请输入访问密码</label>
      <input type="password" id="auth-pass" autocomplete="current-password" placeholder="密码(在 .env 的 ACCESS_PASSWORD 中配置)">
      <div id="auth-err" class="err-tip" hidden></div>
      <div class="modal-btns">
        <button id="auth-cancel">取消</button>
        <button id="auth-ok" class="primary">解锁</button>
      </div>`);
    const input = box.querySelector('#auth-pass');
    const err = box.querySelector('#auth-err');
    const submit = async () => {
      const password = input.value;
      if (!password) { err.textContent = '请输入密码'; err.hidden = false; return; }
      try {
        const r = await fetch('/api/auth', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        const j = await r.json();
        if (r.ok && j.ok) {
          if (j.token) localStorage.setItem(AUTH_KEY, j.token);
          closeModal();
          resolve(true);
        } else {
          err.textContent = j.error || '密码错误';
          err.hidden = false;
        }
      } catch (e) { err.textContent = '验证失败:' + e.message; err.hidden = false; }
    };
    box.querySelector('#auth-ok').onclick = submit;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    box.querySelector('#auth-cancel').onclick = () => { closeModal(); resolve(false); };
    $('#modal-mask').onclick = null;   // 必须明确选择解锁或取消
    setTimeout(() => input.focus(), 0);
  });
}

// innerHTML 序列化不转义双引号;这里的返回值只用于 value="..." 属性,必须补上,否则含引号的 URL 会截断属性值
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

function folderPickerInline(currentId) {
  // 返回容器元素:显示当前文件夹 + 选择按钮。
  // dataset.selected 为已有文件夹 id;dataset.newPath 为待新建路径(JSON 数组),二者互斥
  const wrap = document.createElement('div');
  wrap.className = 'folder-line';
  wrap.dataset.selected = currentId || findToolbarFolder().id;
  const cur = document.createElement('span'); cur.className = 'cur';
  const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = '选择文件夹';
  let panel = null;
  const closePanel = () => { if (panel) { panel.remove(); panel = null; } };
  const refresh = () => {
    const np = wrap.dataset.newPath ? JSON.parse(wrap.dataset.newPath) : null;
    if (np) { cur.textContent = '将新建：' + np.join(' / '); cur.classList.add('pending-new'); }
    else { cur.textContent = pathOf(wrap.dataset.selected) || '(根目录)'; cur.classList.remove('pending-new'); }
  };
  refresh();
  wrap.selectExisting = id => { wrap.dataset.newPath = ''; wrap.dataset.selected = id; refresh(); closePanel(); };
  wrap.selectNewPath = names => { wrap.dataset.newPath = JSON.stringify(names); refresh(); closePanel(); };
  wrap.targetPathLabel = () => wrap.dataset.newPath
    ? '新建「' + JSON.parse(wrap.dataset.newPath).join(' / ') + '」'
    : (pathOf(wrap.dataset.selected) || '根目录');
  // 在表单内展开/收起选择面板,不替换整个弹窗——选完仍停留在表单,由用户点「添加/取消」
  btn.onclick = () => {
    if (panel) { closePanel(); return; }
    panel = buildFolderPanel(wrap.dataset.newPath ? null : wrap.dataset.selected, id => wrap.selectExisting(id));
    wrap.appendChild(panel);
    panel.querySelector('.pick-search').focus();
  };
  wrap.append(cur, btn);
  return wrap;
}

function buildFolderPanel(currentId, cb) {
  const panel = document.createElement('div');
  panel.className = 'picker-panel';
  panel.innerHTML = '<input type="text" class="pick-search" placeholder="输入关键字搜索文件夹…">' +
    '<div class="picker-list"></div>';
  const list = panel.querySelector('.picker-list');
  const search = panel.querySelector('.pick-search');
  let selected = currentId;

  const render = kw => {
    kw = (kw || '').trim().toLowerCase();
    const folders = flattenFolders(state.tree).filter(f => !kw || f.path.toLowerCase().includes(kw) || f.node.title.toLowerCase().includes(kw));
    list.innerHTML = '';
    const rootItem = document.createElement('div');
    rootItem.className = 'pick-folder' + (selected === state.tree.id ? ' sel' : '');
    rootItem.textContent = '(根目录)';
    rootItem.dataset.id = state.tree.id;
    list.appendChild(rootItem);
    for (const f of folders) {
      const d = document.createElement('div');
      d.className = 'pick-folder' + (selected === f.node.id ? ' sel' : '');
      d.style.paddingLeft = (10 + f.depth * 16) + 'px';
      const name = document.createElement('span');
      name.textContent = f.node.title;
      d.appendChild(name);
      // 显示父级路径,区分不同父文件夹下的同名子文件夹
      if (f.path) {
        const p = document.createElement('span');
        p.className = 'pick-path';
        p.textContent = f.path;
        d.appendChild(p);
      }
      d.title = f.path ? f.path + ' / ' + f.node.title : f.node.title;
      d.dataset.id = f.node.id;
      list.appendChild(d);
    }
  };
  render();
  search.addEventListener('input', () => render(search.value));
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape') { panel.remove(); }
  });
  list.addEventListener('click', e => {
    const item = e.target.closest('.pick-folder');
    if (!item) return;
    selected = item.dataset.id;
    render(search.value);
    cb(selected);   // 内部会收起面板并回到表单
  });
  return panel;
}

function openBookmarkModal({ mode, node, presetFolder }) {
  const isEdit = mode === 'edit';
  const initialFolder = isEdit
    ? (findParent(node.id) || findToolbarFolder()).id
    : (presetFolder || findToolbarFolder().id);
  const box = openModal(`
    <h3>${isEdit ? '编辑书签' : '添加书签'}</h3>
    <label>标题</label>
    <input type="text" id="f-title" value="${esc(isEdit ? node.title : '')}" placeholder="页面标题">
    <label>URL</label>
    <input type="url" id="f-url" value="${esc(isEdit ? node.url : '')}" placeholder="https://…">
    <div id="f-dup" class="dup-tip" hidden></div>
    <label>所在文件夹</label>
    <div id="f-folder"></div>
    ${isEdit ? '' : '<div class="ai-row"><button type="button" id="f-ai">AI 归类</button><span id="f-ai-tip"></span></div>'}
    <div class="modal-btns">
      <button id="f-cancel">取消</button>
      <button id="f-ok" class="primary">${isEdit ? '保存' : '添加'}</button>
    </div>`);
  const picker = folderPickerInline(initialFolder);
  box.querySelector('#f-folder').appendChild(picker);
  box.querySelector('#f-title').focus();
  box.querySelector('#f-cancel').onclick = closeModal;
  // URL 查重:全库按 URL 匹配(不限于当前文件夹),已存在则提示位置;编辑时排除自身
  const dupTip = box.querySelector('#f-dup');
  const urlInput = box.querySelector('#f-url');
  const checkDup = () => {
    const url = urlInput.value.trim();
    const hit = url ? getFlat().byUrl.get(url) : null;
    if (hit && hit.node.id !== (isEdit ? node.id : null)) {
      const p = findParent(hit.node.id);
      dupTip.textContent = '⚠ 这个网址已收藏过:' + hit.node.title +
        '(' + (p ? (pathOf(p.id) || '根目录') : '根目录') + '),仍可再次添加';
      dupTip.hidden = false;
    } else {
      dupTip.hidden = true;
    }
  };
  urlInput.addEventListener('input', checkDup);
  checkDup();
  const aiBtn = box.querySelector('#f-ai');
  if (aiBtn) aiBtn.onclick = () => aiCategorize(box, picker);
  box.querySelector('#f-ok').onclick = () => {
    const title = box.querySelector('#f-title').value.trim();
    const url = box.querySelector('#f-url').value.trim();
    if (!url) { alert('URL 不能为空'); return; }
    // 待新建路径只有在点「添加」时才真正建夹
    let folderId;
    if (picker.dataset.newPath) folderId = ensureFolderPath(JSON.parse(picker.dataset.newPath));
    else folderId = picker.dataset.selected;
    if (isEdit) updateNode(node.id, { title, url });
    else addBookmark(folderId, title, url);
    closeModal();
    renderTree($('#tree'));
    flatCache = null;
    renderRecents();
    updateDirtyBadge();
    setStatus(isEdit ? '已修改(本地已保存,记得上传)' : '已添加到「' + picker.targetPathLabel() + '」' + (isEdit ? '' : '(记得上传)'));
  };
}

// AI 根据标题+URL 建议归档位置;建议的新文件夹需用户点选确认
async function aiCategorize(box, picker) {
  const title = box.querySelector('#f-title').value.trim();
  const url = box.querySelector('#f-url').value.trim();
  if (!title && !url) { setAiTip(box, '请先填写标题或 URL', true); return; }
  const btn = box.querySelector('#f-ai');
  if (!state.config.aiEnabled) {
    setAiTip(box, 'AI 未配置:在 .env 或环境变量中设置 AI_BASE_URL / AI_API_KEY 后可用', true);
    return;
  }
  btn.disabled = true; btn.textContent = '判断中…';
  setAiTip(box, '');
  try {
    getFlat();
    const folders = flattenFolders(state.tree).map(f => ({ id: f.node.id, path: f.path }));
    const r = await api('/api/categorize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      cache: 'no-store', body: JSON.stringify({ title, url, folders })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    if (j.folderId) {
      picker.selectExisting(j.folderId);
      setAiTip(box, '→ ' + (pathOf(j.folderId) || '根目录') + (j.reason ? '(' + j.reason + ')' : ''));
    } else if (j.newPath) {
      const suggest = box.querySelector('#f-ai-suggest') || (() => {
        const d = document.createElement('div');
        d.id = 'f-ai-suggest'; d.className = 'ai-suggest';
        box.querySelector('#f-folder').after(d);
        return d;
      })();
      suggest.textContent = '建议新建文件夹：' + j.newPath.join(' / ') + '（点击选用）';
      suggest.onclick = () => { picker.selectNewPath(j.newPath); suggest.classList.add('sel'); setAiTip(box, j.reason || ''); };
      setAiTip(box, '该文件夹尚不存在,点上方建议后再「添加」才会创建');
    } else {
      setAiTip(box, 'AI 没有合适的归类建议,请手动选择文件夹', true);
    }
  } catch (e) {
    setAiTip(box, '归类失败:' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'AI 归类';
  }
}

function setAiTip(box, msg, isErr) {
  const tip = box.querySelector('#f-ai-tip');
  if (!tip) return;
  tip.textContent = msg;
  tip.classList.toggle('err', !!isErr);
}

function openFolderModal({ mode, node }) {
  const isRename = mode === 'rename';
  const initialParent = isRename ? (findParent(node.id) || state.tree).id : findToolbarFolder().id;
  const box = openModal(`
    <h3>${isRename ? '重命名文件夹' : '添加文件夹'}</h3>
    <label>名称</label>
    <input type="text" id="f-name" value="${esc(isRename ? node.title : '')}" placeholder="文件夹名称">
    ${isRename ? '' : '<label>父文件夹</label><div id="f-folder"></div>'}
    <div class="modal-btns">
      <button id="f-cancel">取消</button>
      <button id="f-ok" class="primary">${isRename ? '保存' : '添加'}</button>
    </div>`);
  let picker = null;
  if (!isRename) {
    picker = folderPickerInline(initialParent);
    box.querySelector('#f-folder').appendChild(picker);
  }
  box.querySelector('#f-name').focus();
  box.querySelector('#f-cancel').onclick = closeModal;
  box.querySelector('#f-ok').onclick = () => {
    const name = box.querySelector('#f-name').value.trim();
    if (!name) { alert('名称不能为空'); return; }
    if (isRename) updateNode(node.id, { title: name });
    else addFolder(picker.dataset.selected, name);
    closeModal();
    renderTree($('#tree'));
    setStatus(isRename ? '已重命名(记得上传)' : '已添加文件夹(记得上传)');
  };
}

function onAction(act, node) {
  if (act === 'edit') openBookmarkModal({ mode: 'edit', node });
  else if (act === 'add-bm') openBookmarkModal({ mode: 'add', node, presetFolder: node.id });
  else if (act === 'add-sub') openFolderModal({ mode: 'add', node });
  else if (act === 'rename') openFolderModal({ mode: 'rename', node });
  else if (act === 'del') {
    const what = node.type === 'folder' ? `文件夹「${node.title}」及其 ${node.children ? node.children.length : 0} 个子项` : `书签「${node.title}」`;
    if (!confirm('确定删除' + what + '?')) return;
    deleteNode(node.id);
    renderTree($('#tree'));
    flatCache = null;
    updateDirtyBadge();
    setStatus('已删除(记得上传)');
  }
}

// 拖拽移动后:缓存失效 + 提示未上传
function onMoved(id, destId, refId) {
  flatCache = null;
  updateDirtyBadge();
  const dest = findNode(destId);
  const where = dest ? dest.title : '根目录';
  const ref = refId ? findNode(refId) : null;
  setStatus(ref
    ? `已排到「${ref.title}」旁边 · ${where}(记得上传)`
    : `已移动到「${where}」(记得上传)`);
}

// ---------- 按钮 ----------
function wireButtons() {
  $('#add-bm-btn').onclick = () => openBookmarkModal({ mode: 'add' });
  $('#add-folder-btn').onclick = () => openFolderModal({ mode: 'add' });
  $('#upload-btn').onclick = () => upload();
  $('#sync-btn').onclick = () => syncFromCloud();
  // 更多菜单:低频功能(导出/覆盖/快速添加)收进下拉
  const moreBtn = $('#more-btn'), moreMenu = $('#more-menu');
  moreBtn.onclick = e => { e.stopPropagation(); moreMenu.hidden = !moreMenu.hidden; };
  document.addEventListener('click', e => {
    if (!e.target.closest('.more-wrap')) moreMenu.hidden = true;
  });
  $('#download-btn').onclick = () => { moreMenu.hidden = true; exportCurrentHtml(); };
  $('#import-btn').onclick = () => { moreMenu.hidden = true; pickLocalFile(); };
  $('#import-file').onchange = e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) importLocalFile(f);
  };
  $('#collapse-btn').onclick = () => { collapseAllFolders(state.tree); renderTree($('#tree')); };
  window.addEventListener('beforeunload', e => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ---------- 快速添加 bookmarklet ----------
function renderBookmarklet() {
  const code = `javascript:(function(){var u='${location.origin}/?quickadd='+encodeURIComponent(document.title)+'&url='+encodeURIComponent(location.href);try{window.open(u,'_blank')}catch(e){location.href=u}})();`;
  $('#bookmarklet').href = code;
}

function handleQuickAdd() {
  const p = new URLSearchParams(location.search);
  const title = p.get('quickadd'), url = p.get('url');
  if (!url) return;
  history.replaceState(null, '', location.pathname);
  openBookmarkModal({ mode: 'add' });
  $('#f-title').value = title || '';
  $('#f-url').value = url;
  // 查重挂在 input 事件上,脚本赋值不会触发:手动派发一次,快速添加也要走同一套「已收藏过」提示
  $('#f-url').dispatchEvent(new Event('input', { bubbles: true }));
  setStatus('快速添加:确认后保存' + (state.config.autoUpload ? ',将自动上传' : ''));
  const okBtn = $('#f-ok');
  okBtn.addEventListener('click', () => {
    if (state.config.autoUpload && state.config.storageType !== 'none') {
      // 保存后自动上传,不弹确认框
      setTimeout(() => upload(true), 300);
    }
  }, { once: true });
}

// ---------- 工具 ----------
function updateDirtyBadge() { $('#dirty-badge').hidden = !state.dirty; }
let statusTimer = null;
function setStatus(msg) {
  $('#status').textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { $('#status').textContent = ''; }, 8000);
}
