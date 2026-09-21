import { parseBookmarkHTML, serializeBookmarkHTML } from './parser.js';
import { state, loadMeta, mergeRemoteMeta, recordOpen, syncMetaNow, clearDirty, saveCache, markDirty, defaultExpand, collapseAllFolders, applyClicksToAttrs, syncClicksFromAttrs, clicksClass } from './store.js';
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

// 带访问口令的 fetch;401 时清除缓存令牌并提示重新输入
async function api(path, opts = {}) {
  const token = localStorage.getItem(AUTH_KEY) || '';
  opts.headers = Object.assign({}, opts.headers, token ? { 'x-auth': token } : {});
  const r = await fetch(path, opts);
  if (r.status === 401) {
    localStorage.removeItem(AUTH_KEY);
    throw new Error('需要访问密码,请刷新页面重新输入');
  }
  return r;
}

init();

async function init() {
  loadMeta();
  state.config = await fetchConfig();

  // 可选访问密码:配置了且本地没有记住的令牌时,先解锁
  if (state.config.needAuth && !localStorage.getItem(AUTH_KEY)) {
    const ok = await promptPassword();
    if (!ok) { setStatus('未解锁:输入密码后才能读写云端数据'); return; }
  }

  await loadData();
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
  await mergeRemote();
  handleQuickAdd();
}

async function fetchConfig() {
  try {
    const r = await api('/api/config', { cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch { /* file:// 或无后端 */ }
  return { storageType: 'none', uploadMode: 'overwrite', autoUpload: false, aiEnabled: false, needAuth: false, localFile: LOCAL_FALLBACK };
}

async function loadData() {
  const cache = JSON.parse(localStorage.getItem('bm_cache_v1') || 'null');
  let html = null, etag = null;

  if (state.config.storageType !== 'none') {
    try {
      const r = await api('/api/bookmark?type=bookmark', { cache: 'no-store' });
      if (r.ok) { etag = r.headers.get('ETag'); html = await r.text(); }
    } catch { /* 忽略,回退本地文件 */ }
  }
  if (!html) {
    const file = state.config.localFile || LOCAL_FALLBACK;
    try { html = await (await fetch(file)).text(); }
    catch { setStatus('无法加载数据:' + file); return; }
    if (state.config.storageType === 'none') setStatus('未配置远程存储,使用本地文件(只读模式)');
  }

  if (cache && cache.tree && cache.dirty) {
    state.tree = cache.tree;
    state.dirty = true;
    state.etag = cache.etag;
    if (etag && cache.etag !== etag) setStatus('⚠ 远程文件已有更新,当前显示的是本地未上传的修改');
  } else if (cache && cache.tree && cache.etag && cache.etag === etag) {
    state.tree = cache.tree;
    state.etag = etag;
  } else {
    state.tree = parseBookmarkHTML(html);
    state.etag = etag;
    clearDirty();
  }
  updateDirtyBadge();
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
  // 按可用宽度裁剪,只显示放得下的条目
  while (box.scrollWidth > box.clientWidth && box.children.length > 1) box.removeChild(box.lastChild);
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

// ---------- 上传 ----------
// silent=true 时不弹确认框(快速添加自动上传场景)
async function upload(silent = false) {
  // 页面加载后配置可能已变化:先重新拉一次再判断
  if (state.config.storageType === 'none') state.config = await fetchConfig();
  if (state.config.storageType === 'none') { setStatus('未配置存储:请在 .env 或 Vercel 环境变量中配置 S3 / WebDAV'); return; }
  if (!silent && !confirm('将当前书签数据上传到远程存储?' + (state.config.uploadMode === 'dated' ? '\n(带日期后缀模式,会生成新文件)' : '\n(覆盖模式,将覆盖远程文件)'))) return;
  setStatus(silent ? '自动上传中…' : '上传中…');
  try {
    applyClicksToAttrs(state.tree);
    const content = serializeBookmarkHTML(state.tree);
    const r = await api('/api/bookmark', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bookmark', content })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || r.status);
    await syncMetaNow();
    if (j.etag) state.etag = j.etag;
    clearDirty();
    updateDirtyBadge();
    setStatus('✅ 已上传:' + j.file);
  } catch (e) { setStatus('❌ 上传失败:' + e.message); }
}

// ---------- 本地文件覆盖云端 ----------
function pickLocalFile() {
  if (state.config.storageType === 'none') { setStatus('未配置存储:请在 .env 或 Vercel 环境变量中配置 S3 / WebDAV'); return; }
  $('#import-file').click();
}

// 下载云端最新的书签 HTML(服务端带 Content-Disposition,文件名为云端实际文件名)
function downloadCloud() {
  if (state.config.storageType === 'none') { setStatus('未配置存储:没有云端数据可下载'); return; }
  const token = localStorage.getItem(AUTH_KEY) || '';
  const a = document.createElement('a');
  a.href = '/api/bookmark?type=bookmark&download=1' + (token ? '&auth=' + encodeURIComponent(token) : '');
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setStatus('已开始下载云端书签文件');
}

async function importLocalFile(file) {
  const btn = $('#import-btn');
  btn.disabled = true;
  try {
    const content = await file.text();
    const tree = parseBookmarkHTML(content);
    const c = countNodes(tree);
    if (!c.bookmarks && !c.folders) { setStatus('文件解析失败:没有读到任何书签,已取消'); return; }
    const cur = countNodes(state.tree);
    const warn = state.dirty ? '\n⚠ 你当前有未上传的本地修改,会被该文件替换。' : '';
    if (!confirm(`将用本地文件「${file.name}」覆盖云端:\n书签 ${cur.bookmarks} → ${c.bookmarks},文件夹 ${cur.folders} → ${c.folders}` +
      (state.config.uploadMode === 'dated' ? '\n(强制覆盖主文件,并把 latest.json 指针指回它)' : '\n(覆盖模式)') + warn)) return;
    setStatus('覆盖上传中…');
    const r = await api('/api/bookmark', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ type: 'bookmark', content, overwrite: true })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || r.status);
    // 云端已等于该文件:同步页面数据树,清 dirty,避免两边分叉
    state.tree = tree;
    buildIndex(state.tree);
    syncClicksFromAttrs(state.tree);
    state.etag = j.etag || null;
    clearDirty();
    flatCache = null;
    renderTree($('#tree'));
    renderRecents();
    updateDirtyBadge();
    setStatus('✅ 已覆盖云端:' + j.file + `(书签 ${c.bookmarks} 条)`);
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
  // 更多菜单:低频功能(下载/覆盖/快速添加)收进下拉
  const moreBtn = $('#more-btn'), moreMenu = $('#more-menu');
  moreBtn.onclick = e => { e.stopPropagation(); moreMenu.hidden = !moreMenu.hidden; };
  document.addEventListener('click', e => {
    if (!e.target.closest('.more-wrap')) moreMenu.hidden = true;
  });
  $('#download-btn').onclick = () => { moreMenu.hidden = true; downloadCloud(); };
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
