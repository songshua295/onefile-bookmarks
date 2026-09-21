export const state = {
  tree: null,
  config: { storageType: 'none', uploadMode: 'overwrite', autoUpload: false, aiEnabled: false },
  meta: { counts: {} },
  etag: null,
  dirty: false
};

const CK = 'bm_cache_v1';
const MK = 'bm_meta_v1';
const EK = 'bm_expand_v1';

export function loadCache() {
  try { return JSON.parse(localStorage.getItem(CK)); } catch { return null; }
}
// 整棵树 stringify 开销大:变更后防抖写入,页面隐藏/关闭前立即 flush
let saveTimer = null;
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    localStorage.setItem(CK, JSON.stringify({ tree: state.tree, etag: state.etag, dirty: state.dirty, savedAt: Date.now() }));
  } catch (e) { console.warn('本地缓存写入失败(可能超出容量)', e); }
}
export function saveCache() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 500);
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { if (state.dirty) saveNow(); });
}

export function markDirty() { state.dirty = true; saveCache(); }
export function clearDirty() { state.dirty = false; saveNow(); }

export function loadMeta() {
  try { state.meta = JSON.parse(localStorage.getItem(MK)) || { counts: {} }; }
  catch { state.meta = { counts: {} }; }
  if (!state.meta.counts) state.meta.counts = {};
}
export function persistMeta() {
  localStorage.setItem(MK, JSON.stringify(state.meta));
}

let syncTimer = null;
export function recordOpen(url, title) {
  if (!url || url.startsWith('javascript:')) return;
  const c = state.meta.counts[url] || (state.meta.counts[url] = { n: 0, last: 0 });
  c.n += 1;
  c.last = Date.now();
  if (title) c.title = title;
  persistMeta();
  scheduleMetaSync();
}

function scheduleMetaSync() {
  if (state.config.storageType === 'none') return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncMetaNow, 3000);
}
export async function syncMetaNow() {
  if (state.config.storageType === 'none') return;
  try {
    const token = localStorage.getItem('bm_auth_v1') || '';
    await fetch('/api/bookmark?type=meta', {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'x-auth': token } : {}),
      body: JSON.stringify({ type: 'meta', content: state.meta })
    });
  } catch (e) { console.warn('meta 同步失败', e); }
}

export function mergeRemoteMeta(remote) {
  if (!remote || !remote.counts) return;
  for (const [url, c] of Object.entries(remote.counts)) {
    const local = state.meta.counts[url];
    if (!local || c.n > local.n || (c.last || 0) > (local.last || 0)) {
      state.meta.counts[url] = { n: Math.max(c.n || 0, local ? local.n || 0 : 0), last: Math.max(c.last || 0, local ? local.last || 0 : 0), title: local && local.title ? local.title : c.title };
    }
  }
  persistMeta();
}

// ---- 点击次数 <-> HTML 属性 ----
// 点击次数 → 颜色分档(越大越深)
export function clicksClass(n) {
  if (!n || n <= 0) return '';
  if (n === 1) return 'ct1';
  if (n < 5) return 'ct2';
  if (n < 10) return 'ct3';
  if (n < 20) return 'ct4';
  return 'ct5';
}

// 上传前调用:把本地点击次数写入节点属性,序列化成 CLICKS="n"。
// 浏览器导入书签时会忽略这个未知属性,不受影响。
export function applyClicksToAttrs(tree) {
  (function walk(n) {
    if (n.type === 'bookmark' && n.url) {
      const c = state.meta.counts[n.url];
      if (c && c.n > 0) n.attrs = Object.assign({}, n.attrs, { clicks: String(c.n) });
    }
    (n.children || []).forEach(walk);
  })(tree);
}

// 加载/导入后调用:从属性恢复点击次数,与本地记录取较大值
export function syncClicksFromAttrs(tree) {
  (function walk(n) {
    if (n.type === 'bookmark' && n.url) {
      const v = parseInt(n.attrs && n.attrs.clicks, 10);
      if (v > 0) {
        const cur = state.meta.counts[n.url] || (state.meta.counts[n.url] = { n: 0, last: 0 });
        if (v > cur.n) {
          cur.n = v;
          if (!cur.title) cur.title = n.title;
        }
      }
    }
    (n.children || []).forEach(walk);
  })(tree);
  persistMeta();
}

// ---- 折叠状态 ----
let expanded = new Set();
try { expanded = new Set(JSON.parse(localStorage.getItem(EK) || '[]')); } catch { /* ignore */ }
export function isExpanded(id) { return expanded.has(id); }
export function toggleExpanded(id) {
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  localStorage.setItem(EK, JSON.stringify([...expanded]));
}
export function defaultExpand(tree) {
  if (localStorage.getItem(EK)) return;
  for (const c of tree.children || []) if (c.type === 'folder') expanded.add(c.id);
  localStorage.setItem(EK, JSON.stringify([...expanded]));
}
export function collapseAllFolders(tree) {
  expanded.clear();
  // 一级文件夹保持展开,只收缩二级及更深的文件夹
  for (const c of tree.children || []) if (c.type === 'folder') expanded.add(c.id);
  localStorage.setItem(EK, JSON.stringify([...expanded]));
}
