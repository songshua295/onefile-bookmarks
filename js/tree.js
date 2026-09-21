import { newId } from './parser.js';
import { state, markDirty, isExpanded, toggleExpanded, recordOpen, clicksClass } from './store.js';
import { icoFolder, icoFolderPlus, icoGlobe, icoPencil, icoTrash, icoPlus, icoCode } from './icons.js';

const index = new Map();      // id -> node
const parentIndex = new Map(); // id -> parent id

export function buildIndex(tree) {
  index.clear();
  parentIndex.clear();
  (function walk(node, parentId) {
    index.set(node.id, node);
    if (parentId) parentIndex.set(node.id, parentId);
    if (node.children) node.children.forEach(c => walk(c, node.id));
  })(tree, null);
}

export function findNode(id) { return index.get(id); }
export function findParent(id) { return index.get(parentIndex.get(id)); }
export function findToolbarFolder() {
  for (const n of index.values()) {
    if (n.type === 'folder' && n.attrs && n.attrs.personal_toolbar_folder === 'true') return n;
  }
  return state.tree;
}
export function pathOf(id) {
  const parts = [];
  let cur = id;
  while (cur) {
    const n = index.get(cur);
    if (!n) break;
    parts.unshift(n.title);
    cur = parentIndex.get(cur);
  }
  parts.shift(); // 去掉 Root
  return parts.join(' / ');
}

// ---- 模型操作(全部标记为待上传) ----
export function moveNode(id, destFolderId, at) {
  const node = index.get(id), dest = index.get(destFolderId);
  if (!node || !dest || dest.type !== 'folder' || node === dest) return false;
  if (isDescendant(dest.id, node.id)) return false;   // 不能放进自己或自己的子文件夹
  const parent = findParent(id);
  if (!parent || parent === node) return false;
  const from = parent.children.indexOf(node);
  parent.children.splice(from, 1);
  let to = (at == null) ? dest.children.length : at;
  if (parent === dest && from < to) to -= 1;   // 同父时,移除后目标索引前移一位
  dest.children.splice(Math.max(0, Math.min(to, dest.children.length)), 0, node);
  buildIndex(state.tree);   // parentIndex 必须先失效重建,否则连续移动会挂错父节点
  markDirty();
  return true;
}

function isDescendant(id, ancestorId) {
  let cur = id;
  while (cur) {
    if (cur === ancestorId) return true;
    cur = parentIndex.get(cur);
  }
  return false;
}

export function parentOf(id) { return parentIndex.get(id) || null; }

export function canMove(id, destId) {
  const node = index.get(id), dest = index.get(destId);
  return !!node && !!dest && dest.type === 'folder' && !isDescendant(dest.id, node.id);
}

// 排到 refId 之前/之后:目标父文件夹不能落在被拖节点自己的子树里
export function canReorder(id, refId) {
  const ref = index.get(refId);
  if (!ref || refId === id) return false;
  const dest = index.get(parentIndex.get(refId));
  return !!dest && dest.type === 'folder' && !isDescendant(dest.id, id);
}

export function deleteNode(id) {
  const parent = findParent(id);
  if (!parent) return;
  parent.children = parent.children.filter(c => c.id !== id);
  markDirty();
}

export function addBookmark(folderId, title, url) {
  const folder = index.get(folderId);
  if (!folder || folder.type !== 'folder') return;
  const node = {
    id: newId(), type: 'bookmark',
    title: title || url, url: url || '',
    attrs: { ADD_DATE: String(Math.floor(Date.now() / 1000)) }
  };
  folder.children.push(node);
  buildIndex(state.tree);
  if (!isExpanded(folderId)) toggleExpanded(folderId);
  markDirty();
  return node;
}

export function addFolder(parentId, title) {
  const parent = index.get(parentId);
  if (!parent || parent.type !== 'folder') return;
  const node = {
    id: newId(), type: 'folder', title: title || '新建文件夹',
    attrs: { ADD_DATE: String(Math.floor(Date.now() / 1000)) }, children: []
  };
  parent.children.push(node);
  buildIndex(state.tree);
  if (!isExpanded(parentId)) toggleExpanded(parentId);
  markDirty();
  return node;
}

// 按名称层级找到或创建文件夹(AI 归类建议的新路径)
export function ensureFolderPath(names, anchorId) {
  let cur = index.get(anchorId) || findToolbarFolder();
  for (const name of names) {
    let next = (cur.children || []).find(c => c.type === 'folder' && c.title === name);
    if (!next) {
      next = {
        id: newId(), type: 'folder', title: name,
        attrs: { ADD_DATE: String(Math.floor(Date.now() / 1000)) }, children: []
      };
      cur.children.push(next);
    }
    cur = next;
  }
  buildIndex(state.tree);
  markDirty();
  return cur.id;
}

export function updateNode(id, patch) {
  const node = index.get(id);
  if (!node) return;
  if (patch.title !== undefined) node.title = patch.title;
  if (patch.url !== undefined) node.url = patch.url;
  markDirty();
}

// ---- 渲染 ----
export function renderTree(container) {
  container.innerHTML = '';
  // 根节点只作为容器:始终渲染其子项,不渲染 Root 行,也不受折叠状态影响
  const kids = document.createElement('div');
  for (const c of state.tree.children || []) {
    if (c.type === 'folder') renderFolder(c, kids, 0);
    else renderBookmark(c, kids);
  }
  container.appendChild(kids);
}

// 只重建某个文件夹的子树(折叠/展开用,避免整棵树全量重渲染)
export function rerenderSubtree(container, folderId) {
  const wrap = container.querySelector('.node.folder-node[data-id="' + (window.CSS && CSS.escape ? CSS.escape(folderId) : folderId) + '"]');
  const folder = findNode(folderId);
  if (!wrap || !folder || folder.type !== 'folder') { renderTree(container); return; }
  const fresh = document.createElement('div');
  renderFolder(folder, fresh, 0);
  wrap.replaceWith(fresh.firstElementChild);
}

function renderFolder(folder, container, depth) {
  const wrap = document.createElement('div');
  wrap.className = 'node folder-node';
  wrap.dataset.id = folder.id;

  const row = document.createElement('div');
  row.className = 'row folder';
  row.dataset.id = folder.id;
  row.dataset.kind = 'folder';
  row.draggable = true;
  const open = isExpanded(folder.id);
  row.innerHTML =
    `<span class="toggle">${folder.children && folder.children.length ? (open ? '▾' : '▸') : '·'}</span>` +
    `<span class="ficon">${icoFolder}</span>` +
    `<span class="name"></span>` +
    `<span class="cnt">${folder.children ? folder.children.length : 0}</span>` +
    `<span class="acts">` +
    `<span class="act-btn" data-act="add-bm" title="在此文件夹添加书签">${icoPlus}</span>` +
    `<span class="act-btn" data-act="add-sub" title="添加子文件夹">${icoFolderPlus}</span>` +
    `<span class="act-btn" data-act="rename" title="重命名">${icoPencil}</span>` +
    `<span class="act-btn" data-act="del" title="删除">${icoTrash}</span>` +
    `</span>`;
  row.querySelector('.name').textContent = folder.title;
  wrap.appendChild(row);

  const kids = document.createElement('div');
  kids.className = 'children';
  if (open && folder.children) {
    for (const c of folder.children) {
      if (c.type === 'folder') renderFolder(c, kids, depth + 1);
      else renderBookmark(c, kids);
    }
  }
  wrap.appendChild(kids);
  container.appendChild(wrap);
}

function renderBookmark(bm, container) {
  const a = document.createElement('a');
  // bookmarklet(javascript: 链接)不能开新标签页:新页面没有可执行上下文,脚本永远不运行
  const isBmlet = /^javascript:/i.test(bm.url || '');
  a.className = 'row bm' + (isBmlet ? ' bmlet' : '');
  a.dataset.id = bm.id;
  a.dataset.kind = 'bm';
  a.href = bm.url;
  if (!isBmlet) { a.target = '_blank'; a.rel = 'noopener'; }
  a.draggable = true;
  a.title = bm.title + '\n' + bm.url + (isBmlet ? '\n(脚本书签:点击在当前页面运行)' : '');
  const icon = document.createElement('span');
  icon.className = 'bicon';
  if (isBmlet) {
    icon.innerHTML = icoCode;
  } else if (bm.attrs && bm.attrs.icon) {
    const img = document.createElement('img');
    img.src = bm.attrs.icon;
    img.loading = 'lazy';
    icon.appendChild(img);
  } else {
    icon.innerHTML = icoGlobe;
  }
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = bm.title;
  const n = clicksOf(bm.url);
  const clicks = document.createElement('span');
  clicks.className = ('cnt-clicks ' + clicksClass(n)).trim();
  if (n > 0) clicks.textContent = n;
  const acts = document.createElement('span');
  acts.className = 'acts';
  acts.innerHTML = `<span class="act-btn" data-act="edit" title="编辑">${icoPencil}</span>` +
    `<span class="act-btn" data-act="del" title="删除">${icoTrash}</span>`;
  a.append(icon, name, clicks, acts);
  container.appendChild(a);
}

function clicksOf(url) {
  const c = state.meta.counts[url];
  return c && c.n > 0 ? c.n : 0;
}

// 点击后即时刷新该行的计数徽标
function refreshCountBadge(rowEl, url) {
  const n = clicksOf(url);
  let el = rowEl.querySelector('.cnt-clicks');
  if (!el) {
    el = document.createElement('span');
    const acts = rowEl.querySelector('.acts');
    rowEl.insertBefore(el, acts || null);
  }
  el.className = ('cnt-clicks ' + clicksClass(n)).trim();
  el.textContent = n > 0 ? String(n) : '';
}

// ---- 事件(委托) ----
let dragId = null;
let hoverEl = null;
let hoverCls = '';

export function wireTreeEvents(container, hooks) {
  container.addEventListener('click', e => {
    const actBtn = e.target.closest('.act-btn');
    const row = e.target.closest('.row[data-id]');
    if (!row) return;
    const id = row.dataset.id;
    const node = findNode(id);
    if (!node) return;

    if (actBtn) {
      e.preventDefault();
      e.stopPropagation();
      hooks.onAction(actBtn.dataset.act, node);
      return;
    }
    if (node.type === 'folder') {
      toggleExpanded(id);
      rerenderSubtree(container, id);
    } else {
      recordOpen(node.url, node.title);
      refreshCountBadge(row, node.url);
      if (hooks.onOpen) hooks.onOpen();
      // 默认行为:新标签页打开
    }
  });

  container.addEventListener('dragstart', e => {
    const row = e.target.closest('.row[data-id]');
    if (!row) return;
    dragId = row.dataset.id;
    e.dataTransfer.setData('text/x-bm-id', dragId);
    e.dataTransfer.effectAllowed = 'copyMove';
    // <a> 元素默认携带 uri-list,可直接拖入浏览器书签栏
  });

  const EDGE = 56;   // 距视口上下边缘多少像素内开始自动滚动
  let scrollDir = 0, scrollRaf = null;

  function rowById(id) {
    if (id === state.tree.id) return null;
    return container.querySelector('.row[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
  }
  function clearHover() {
    if (hoverEl) hoverEl.classList.remove(hoverCls);
    hoverEl = null; hoverCls = '';
  }
  function setHover(el, cls) {
    if (!el) { clearHover(); return; }
    if (hoverEl === el && hoverCls === cls) return;
    clearHover();
    el.classList.add(cls);
    hoverEl = el; hoverCls = cls;
  }

  // 落点解析:行的上/下沿 → 排到它前面/后面(横线);
  // 文件夹行的中部 → 放进该文件夹;书签行的中部 → 放进它所在文件夹;
  // 文件夹容器空白 → 该文件夹;树外空白 → 根目录
  function resolveDrop(e) {
    const row = e.target.closest && e.target.closest('.row[data-id]');
    if (row) {
      const rect = row.getBoundingClientRect();
      const h = rect.height || 24;
      const band = Math.max(4, Math.min(9, h * 0.28));   // 上下各约 1/4 行为排序区,中间仍是"放入"
      const off = (e.clientY || 0) - rect.top;
      if (off <= band) return { kind: 'order', ref: row.dataset.id, pos: 'before', el: row };
      if (off >= h - band) return { kind: 'order', ref: row.dataset.id, pos: 'after', el: row };
      if (row.dataset.kind === 'folder') return { kind: 'into', dest: row.dataset.id, el: row };
      const pid = parentOf(row.dataset.id);
      return { kind: 'into', dest: pid, el: rowById(pid) || row };
    }
    const wrap = e.target.closest && e.target.closest('.node.folder-node');
    if (wrap) {
      const frow = wrap.querySelector(':scope > .row.folder');
      return { kind: 'into', dest: wrap.dataset.id, el: frow };
    }
    return { kind: 'into', dest: state.tree.id, el: container };
  }

  function applyHover(t) {
    if (t.kind === 'order') setHover(t.el, t.pos === 'after' ? 'drop-after' : 'drop-before');
    else setHover(t.el, 'drop-hover');
  }

  function tickScroll() {
    if (!scrollDir) { scrollRaf = null; return; }
    window.scrollBy(0, scrollDir);
    scrollRaf = window.requestAnimationFrame(tickScroll);
  }
  function updateAutoScroll(e) {
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const y = e.clientY || 0;
    if (y < EDGE) scrollDir = -Math.min(22, 5 + (EDGE - y) / 2);
    else if (y > vh - EDGE) scrollDir = Math.min(22, 5 + (y - (vh - EDGE)) / 2);
    else scrollDir = 0;
    if (scrollDir && !scrollRaf) scrollRaf = window.requestAnimationFrame(tickScroll);
  }
  function stopAutoScroll() {
    scrollDir = 0;
    if (scrollRaf) { window.cancelAnimationFrame(scrollRaf); scrollRaf = null; }
  }

  container.addEventListener('dragover', e => {
    if (!dragId) return;
    updateAutoScroll(e);
    const t = resolveDrop(e);
    if (t.kind === 'order') {
      if (!canReorder(dragId, t.ref)) { clearHover(); return; }
    } else if (t.dest === parentOf(dragId) || !canMove(dragId, t.dest)) {
      clearHover(); return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    applyHover(t);
    return t;
  });

  container.addEventListener('dragleave', e => {
    if (e.target === container || !container.contains(e.relatedTarget)) clearHover();
  });

  container.addEventListener('drop', e => {
    if (!dragId) return;
    const t = resolveDrop(e);
    clearHover();
    stopAutoScroll();
    e.preventDefault();
    const id = dragId; dragId = null;
    let destId, ok;
    if (t.kind === 'order' && canReorder(id, t.ref)) {
      const refNode = findNode(t.ref);
      const refParent = findParent(t.ref);
      destId = refParent.id;
      const at = refParent.children.indexOf(refNode) + (t.pos === 'after' ? 1 : 0);
      ok = moveNode(id, destId, at);
    } else if (t.kind === 'into' && canMove(id, t.dest)) {
      destId = t.dest;
      ok = moveNode(id, destId);
    }
    if (ok) {
      if (destId !== state.tree.id && !isExpanded(destId)) toggleExpanded(destId);
      renderTree(container);
      if (hooks.onMoved) hooks.onMoved(id, destId, t.kind === 'order' ? t.ref : null);
    }
  });

  container.addEventListener('dragend', () => {
    dragId = null;
    clearHover();
    stopAutoScroll();
  });

  // 拖拽在树外结束/落下时兜底清理,避免自动滚动停不下来
  document.addEventListener('dragend', () => {
    dragId = null;
    clearHover();
    stopAutoScroll();
  });
  document.addEventListener('drop', e => {
    if (!container.contains(e.target)) { dragId = null; clearHover(); stopAutoScroll(); }
  });
}
