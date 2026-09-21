const { getType, get, put, listAll, readBody } = require('./lib/storage');
const auth = require('./lib/auth');
const crypto = require('crypto');

const LATEST = 'latest.json';
const META = 'bookmarks_meta.json';
const DATED_RE = /^favorites_(\d{4})_(\d{1,2})_(\d{1,2})\.html$/;

function bookmarkFile() {
  return process.env.BOOKMARK_FILE || 'favorites_2026_9_20.html';
}
function uploadMode() {
  return (process.env.UPLOAD_MODE || 'overwrite').toLowerCase();
}
function etagOf(content) {
  return 'W/"' + crypto.createHash('md5').update(content).digest('hex') + '"';
}

// 从 key 列表中挑出日期最大的 dated 文件
function pickLatestDated(keys) {
  let best = null, bestT = -1;
  for (const key of keys) {
    const m = key.split('/').pop().match(DATED_RE);
    if (!m) continue;
    const t = (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]);
    if (t > bestT) { bestT = t; best = key; }
  }
  return best;
}

module.exports = async (req, res) => {
  try {
    if (!auth.check(req)) { auth.reject(res); return; }
    if (getType() === 'none') {
      res.status(200).json({ disabled: true, error: '未配置存储(STORAGE_TYPE)' });
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const type = url.searchParams.get('type') || 'bookmark';

    if (req.method === 'GET') {
      if (req.headers['if-none-match'] && req.headers['if-none-match'] === req._bmEtag) {
        res.status(304).end();
        return;
      }
      if (type === 'meta') {
        const m = await get(META);
        if (!m) { res.status(404).json({ error: 'no meta yet' }); return; }
        res.setHeader('ETag', etagOf(m.content));
        res.status(200).json({ content: JSON.parse(m.content), etag: etagOf(m.content) });
        return;
      }
      // 书签文件:overwrite 模式固定读 BOOKMARK_FILE;
      // dated 模式取最新 —— 优先 latest.json 指针,指针缺失时扫描目录取日期最大者
      let file;
      if (uploadMode() === 'dated') {
        const latest = await get(LATEST);
        if (latest) {
          try { file = JSON.parse(latest.content).file || null; } catch { /* ignore */ }
        }
        if (!file) {
          try {
            file = pickLatestDated(await listAll());
          } catch { /* 列举失败则继续回退 */ }
        }
      }
      file = file || bookmarkFile();
      const r = await get(file);
      if (!r) { res.status(404).json({ error: '远程不存在文件: ' + file }); return; }
      const etag = etagOf(r.content);
      if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
      res.setHeader('ETag', etag);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // download=1:作为附件下载(浏览器"下载云端书签"功能)
      if (url.searchParams.get('download') === '1') {
        res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(file) + '"');
      }
      res.status(200).send(r.content);
      return;
    }

    if (req.method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      if (body.type === 'meta') {
        await put(META, JSON.stringify(body.content || { counts: {} }));
        res.status(200).json({ ok: true });
        return;
      }
      const content = body.content || '';
      const filename = bookmarkFile();
      // body.overwrite=true:忽略 UPLOAD_MODE,强制覆盖主文件(本地文件覆盖云端场景)
      if (uploadMode() === 'dated' && body.overwrite !== true) {
        const d = new Date();
        const dated = 'favorites_' + d.getFullYear() + '_' + (d.getMonth() + 1) + '_' + d.getDate() + '.html';
        // 先写内容文件,成功后再更新指针,避免指针指向不存在的文件
        await put(dated, content);
        await put(LATEST, JSON.stringify({ file: dated, updatedAt: Date.now() }));
        res.status(200).json({ ok: true, file: dated, mode: 'dated', etag: etagOf(content) });
        return;
      }
      await put(filename, content);
      // dated 模式下强制覆盖后,把指针指回主文件,否则读取仍跟随旧的 dated 文件
      if (uploadMode() === 'dated') {
        await put(LATEST, JSON.stringify({ file: filename, updatedAt: Date.now() }));
      }
      res.status(200).json({ ok: true, file: filename, mode: uploadMode(), etag: etagOf(content) });
      return;
    }

    res.status(405).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.pickLatestDated = pickLatestDated;
