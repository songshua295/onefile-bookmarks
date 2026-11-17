// 节点级 JSON 同步接口:解析后的增量上传/下载,不再整份 HTML 传输
//
// 数据文件 bookmarks.json(扁平节点记录,见 js/model.js 顶部注释):
//   { v:2, lineage, rev, updatedAt, nodes:[ { id, parent, type, title?, url?, pos, attrs?, updatedAt, deleted? } ] }
//
// GET  /api/sync?since=<毫秒>&lineage=<谱系>
//      只返回 updatedAt > since 的节点(含墓碑);lineage 缺失或不一致 → 全量;
//      支持 If-None-Match → 304(内容未变化时几乎零流量)
// PUT  /api/sync  body: { lineage, since, nodes:[增量变更] }
//      服务端按 id 逐条 LWW 合并(updatedAt 新者胜,attrs 按键合并);
//      文件夹墓碑级联到其下子孙;If-Match 条件写,412 时重读重合并(最多 3 次);
//      lineage 不一致返回 409 + 云端全量,客户端换基线后重传
// PUT  { replace:true, lineage, nodes } → 整份替换(本地 HTML/JSON 覆盖云端),重置 lineage
const { getType, get, put, readBody } = require('./lib/storage');
const auth = require('./lib/auth');
const crypto = require('crypto');

const TOMBSTONE_TTL = 30 * 24 * 3600 * 1000;   // 墓碑保留期,过期清理,防止文件无限膨胀
const dataFile = () => process.env.DATA_FILE || 'bookmarks.json';
const etagOf = s => 'W/"' + crypto.createHash('md5').update(s).digest('hex') + '"';

function emptyDoc(lineage) {
  return { v: 2, lineage: lineage || crypto.randomUUID(), rev: 0, updatedAt: Date.now(), nodes: [] };
}

module.exports = async (req, res) => {
  try {
    if (!auth.check(req)) { auth.reject(res); return; }
    if (getType() === 'none') {
      res.status(200).json({ disabled: true, error: '未配置存储(STORAGE_TYPE)' });
      return;
    }
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET') {
      const raw = await get(dataFile());
      if (!raw) { res.status(404).json({ error: 'no data yet' }); return; }
      const etag = etagOf(raw.content);
      if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
      const doc = JSON.parse(raw.content);
      const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
      const lineage = url.searchParams.get('lineage') || null;
      const full = !since || !lineage || lineage !== doc.lineage;
      const nodes = full ? doc.nodes : doc.nodes.filter(n => (n.updatedAt || 0) > since);
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        ok: true, full,
        lineage: doc.lineage, rev: doc.rev, updatedAt: doc.updatedAt, etag, nodes
      });
      return;
    }

    if (req.method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      const since = Number(body.since) || 0;
      const incoming = Array.isArray(body.nodes) ? body.nodes.filter(n => n && n.id) : [];

      // 整份替换:用于「用本地文件覆盖云端」与首次迁移;重置 lineage
      if (body.replace) {
        const doc = {
          v: 2, lineage: body.lineage || crypto.randomUUID(), rev: 1,
          updatedAt: Date.now(), nodes: []
        };
        for (const n of incoming) {
          if (n.deleted) continue;
          doc.nodes.push({
            id: n.id,
            parent: n.parent ?? null,
            type: n.type === 'folder' ? 'folder' : 'bookmark',
            title: n.title || '',
            url: n.url || '',
            pos: Number(n.pos) || 0,
            attrs: n.attrs && typeof n.attrs === 'object' ? Object.assign({}, n.attrs) : {},
            updatedAt: doc.updatedAt,          // 服务端盖戳:增量游标的唯一时钟
            editedAt: n.updatedAt || doc.updatedAt   // 客户端声称的编辑时间:仅用于 LWW
          });
        }
        const content = JSON.stringify(doc);
        await put(dataFile(), content);
        res.status(200).json({
          ok: true, replace: true, full: true,
          lineage: doc.lineage, rev: doc.rev, updatedAt: doc.updatedAt,
          etag: etagOf(content), nodes: doc.nodes
        });
        return;
      }

      let payload = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await get(dataFile());
        let doc, rawEtag;
        if (raw) {
          doc = JSON.parse(raw.content);
          rawEtag = raw.etag;
          if (doc.lineage !== body.lineage) {
            // 历史分叉(云端被另一端重建/覆盖):不写入,返回云端全量让客户端换基线
            res.status(409).json({
              ok: false, conflict: true,
              lineage: doc.lineage, rev: doc.rev, updatedAt: doc.updatedAt, nodes: doc.nodes
            });
            return;
          }
        } else {
          doc = emptyDoc(body.lineage);
          rawEtag = null;
        }
        const changed = mergeRecs(doc, incoming);
        if (!changed && raw) {
          // 没有有效变更:不写入、不推进 rev,只返回基线之后云端的新变更
          payload = {
            ok: true, lineage: doc.lineage, rev: doc.rev, updatedAt: doc.updatedAt,
            etag: etagOf(JSON.stringify(doc)),
            nodes: doc.nodes.filter(n => (n.updatedAt || 0) > since)
          };
          break;
        }
        doc.rev = (doc.rev || 0) + 1;
        doc.updatedAt = Date.now();
        pruneTombstones(doc);
        const content = JSON.stringify(doc);
        try {
          await put(dataFile(), content, rawEtag ? { ifMatch: rawEtag } : {});
          payload = {
            ok: true, lineage: doc.lineage, rev: doc.rev, updatedAt: doc.updatedAt,
            etag: etagOf(content),
            nodes: doc.nodes.filter(n => (n.updatedAt || 0) > since)
          };
          break;
        } catch (e) {
          if (e && e.code === 'PRECONDITION') continue;   // 并发写入:重读、重合并再试
          throw e;
        }
      }
      if (!payload) throw new Error('云端并发写入冲突,请重试');
      res.status(200).json(payload);
      return;
    }

    res.status(405).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// 按 id 逐条合并。
// 双时钟设计:
//   updatedAt = 服务端写入时刻(增量游标 since 的唯一时钟;各设备时钟偏斜不影响增量完整性)
//   editedAt  = 客户端声称的编辑时刻(仅用于 LWW:同一条节点两边都改时新者胜)
// attrs 按键合并(删除的键传 null);无实际变化的记录不重打时间戳、不触发写入
function mergeRecs(doc, incoming) {
  if (!incoming.length) return false;
  const map = new Map(doc.nodes.map(n => [n.id, n]));
  const now = Date.now();
  let changed = false;
  for (const rec of incoming) {
    const editedAt = Number(rec.updatedAt) || now;
    if (rec.deleted) {
      changed = tombstone(map, rec.id, editedAt, now) || changed;
      continue;
    }
    const cur = map.get(rec.id);
    if (!cur) {
      map.set(rec.id, {
        id: rec.id,
        parent: rec.parent ?? null,
        type: rec.type === 'folder' ? 'folder' : 'bookmark',
        title: rec.title || '',
        url: rec.url || '',
        pos: Number(rec.pos) || 0,
        attrs: rec.attrs && typeof rec.attrs === 'object' ? Object.assign({}, rec.attrs) : {},
        updatedAt: now,
        editedAt
      });
      changed = true;
      continue;
    }
    if (editedAt <= (cur.editedAt || 0)) continue;   // 过期/重复变更,LWW 落败,跳过
    let touched = false;
    for (const k of ['parent', 'title', 'url']) {
      if (rec[k] !== undefined && rec[k] !== cur[k]) { cur[k] = rec[k]; touched = true; }
    }
    if (rec.pos !== undefined && Number(rec.pos) !== cur.pos) { cur.pos = Number(rec.pos); touched = true; }
    if (rec.attrs && typeof rec.attrs === 'object') {
      for (const [k, v] of Object.entries(rec.attrs)) {
        if (v === null || v === undefined) {
          if (k in cur.attrs) { delete cur.attrs[k]; touched = true; }
        } else if (cur.attrs[k] !== v) { cur.attrs[k] = v; touched = true; }
      }
    }
    if (cur.deleted) { cur.deleted = false; touched = true; }   // 远端删除后本地又恢复
    if (touched) {
      cur.editedAt = editedAt;
      cur.updatedAt = now;   // 服务端盖戳
      changed = true;
    }
  }
  doc.nodes = [...map.values()];
  return changed;
}

// 墓碑级联:子孙节点仍挂在被删文件夹下 → 一并标记;
// editedAt 晚于删除时间戳的子孙除外(它可能刚被另一端移出该文件夹,保留并由前端挂根兜底)
function tombstone(map, id, ts, now) {
  let changed = false;
  const queue = [id];
  while (queue.length) {
    const cur = queue.pop();
    const n = map.get(cur);
    if (n && !n.deleted) {
      n.deleted = true;
      n.editedAt = Math.max(ts, n.editedAt || 0);
      n.updatedAt = now;
      changed = true;
    }
    if (!n || (n.editedAt || 0) <= ts) {
      for (const m of map.values()) {
        if (m.parent === cur && !m.deleted) queue.push(m.id);
      }
    }
  }
  return changed;
}

function pruneTombstones(doc) {
  const now = Date.now();
  doc.nodes = doc.nodes.filter(n => !(n.deleted && now - (n.updatedAt || 0) > TOMBSTONE_TTL));
}
