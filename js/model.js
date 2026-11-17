// 数据模型:嵌套树 <-> 扁平节点记录;节点级 diff(增量同步的核心)
//
// 节点记录(云端 JSON 的最小单元):
//   { id, parent, type:'folder'|'bookmark', title?, url?, pos, attrs?, updatedAt, deleted? }
//  - id:稳定 UUID,跨设备/跨解析不变,是一切按条合并的前提
//  - parent:父文件夹 id,顶层为 null;pos:兄弟间排序(浮点,插入取中点,避免整段重排)
//  - updatedAt:毫秒时间戳,服务端按条 LWW 合并的依据
//  - deleted:true 为墓碑(删除标记),保留 30 天后服务端清理
import { newId } from './parser.js';
export { newId };

// ---- 树 -> 节点数组 ----
// base 是上次同步的基线(id -> 记录):顺序未变的节点沿用基线 pos,
// 只有移动/插入的节点取邻位中点 —— 这样 reorder 在 diff 里只产生一条变更
export function treeToNodes(tree, base = {}) {
  const out = [];
  emitChildren(tree.children || [], null, base, out);
  return out;
}

function emitChildren(kids, parentId, base, out) {
  let prev = -Infinity;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    const b = base[c.id];
    const nb = i + 1 < kids.length ? base[kids[i + 1].id] : null;
    const nbOk = nb && !nb.deleted && nb.parent === parentId && Number.isFinite(nb.pos);
    let pos;
    if (b && !b.deleted && b.parent === parentId && Number.isFinite(b.pos) && b.pos > prev && (!nbOk || nb.pos > b.pos)) {
      pos = b.pos;                                   // 相对顺序未变:沿用基线
    } else if (nbOk && nb.pos > prev) {
      pos = prev === -Infinity ? nb.pos - 1024 : (prev + nb.pos) / 2;   // 插到邻居之间:取中点
    } else {
      pos = prev === -Infinity ? 0 : prev + 1024;    // 排到末尾(或首位之外)
    }
    prev = pos;
    const rec = { id: c.id, parent: parentId, type: c.type, title: c.title || '', pos };
    if (c.type === 'bookmark') rec.url = c.url || '';
    if (c.attrs && Object.keys(c.attrs).length) rec.attrs = c.attrs;
    out.push(rec);
    if (c.type === 'folder') emitChildren(c.children || [], c.id, base, out);
  }
}

// ---- 节点数组 -> 树 ----
// 跳过墓碑;父节点缺失/已删的孤儿挂到根(容错);兄弟按 pos 排序
export function nodesToTree(nodes) {
  const alive = nodes.filter(n => n && n.id && !n.deleted);
  const map = new Map();
  for (const n of alive) {
    map.set(n.id, {
      id: n.id,
      type: n.type === 'folder' ? 'folder' : 'bookmark',
      title: n.title || '',
      url: n.url || '',
      attrs: n.attrs || {},
      children: n.type === 'folder' ? [] : undefined
    });
  }
  const kidsOf = new Map();
  for (const n of alive) {
    const p = (n.parent && map.has(n.parent)) ? n.parent : null;
    if (!kidsOf.has(p)) kidsOf.set(p, []);
    kidsOf.get(p).push(n.id);
  }
  const posOf = new Map(alive.map(n => [n.id, Number.isFinite(n.pos) ? n.pos : 0]));
  const orderOf = pid => (kidsOf.get(pid) || [])
    .slice()
    .sort((a, b) => (posOf.get(a) - posOf.get(b)) || (a < b ? -1 : 1));
  const seen = new Set();
  const build = pid => {
    const arr = [];
    for (const id of orderOf(pid)) {
      if (seen.has(id)) continue;   // 环防护
      seen.add(id);
      const m = map.get(id);
      if (m.type === 'folder') m.children = build(id);
      arr.push(m);
    }
    return arr;
  };
  const root = { id: 'root', type: 'folder', title: 'Root', attrs: {}, children: build(null) };
  // 兜底:环里漏掉的节点挂根,避免数据静默丢失
  for (const n of alive) {
    if (seen.has(n.id)) continue;
    const m = map.get(n.id);
    if (m.type === 'folder') m.children = [];
    root.children.push(m);
    seen.add(n.id);
  }
  return root;
}

// ---- diff:当前树 vs 基线 -> 增量变更(upsert + 墓碑) ----
// attrs 按键比较:只带变化的键,ICON(数据 URL)未变就不重复传输
export function diffNodes(base, tree, meta, now) {
  const recs = treeToNodes(tree, base);
  const out = [];
  const seen = new Set();
  for (const rec of recs) {
    seen.add(rec.id);
    const b = base[rec.id];
    if (!b || b.deleted) {
      // 新节点(或被远端删除后本地又出现):整条上传
      out.push({
        id: rec.id, parent: rec.parent, type: rec.type,
        title: rec.title, url: rec.url, pos: rec.pos,
        attrs: { ...effectiveAttrs(rec, meta) }, updatedAt: now
      });
      continue;
    }
    const patch = {};
    if (b.parent !== rec.parent) patch.parent = rec.parent;
    if (Math.abs((Number(b.pos) || 0) - rec.pos) > 1e-9) patch.pos = rec.pos;
    if ((b.title || '') !== rec.title) patch.title = rec.title;
    if (rec.type === 'bookmark' && (b.url || '') !== rec.url) patch.url = rec.url;
    const ad = attrDiff(b.attrs || {}, effectiveAttrs(rec, meta));
    if (ad) patch.attrs = ad;
    if (Object.keys(patch).length) { patch.id = rec.id; patch.updatedAt = now; out.push(patch); }
  }
  // 基线里有、树里没有 = 本地删除:发墓碑(含被删文件夹的子孙,由 ids 缺失推得)
  for (const id of Object.keys(base)) {
    if (!seen.has(id) && !base[id].deleted) out.push({ id, deleted: true, updatedAt: now });
  }
  return out;
}

function effectiveAttrs(rec, meta) {
  const a = Object.assign({}, rec.attrs || {});
  if (rec.type === 'bookmark' && rec.url) {
    const c = meta.counts[rec.url];
    if (c && c.n > 0) a.clicks = String(c.n);
    else if ('clicks' in a) delete a.clicks;
  }
  return a;
}

function attrDiff(oldA, newA) {
  const d = {};
  let any = false;
  for (const k of new Set([...Object.keys(oldA), ...Object.keys(newA)])) {
    if (oldA[k] !== newA[k]) { d[k] = newA[k] === undefined ? null : newA[k]; any = true; }
  }
  return any ? d : null;
}
