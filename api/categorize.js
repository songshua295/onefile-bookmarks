const { readBody } = require('./lib/storage');
const auth = require('./lib/auth');
const { chatJson } = require('./lib/llm');

const SYSTEM_PROMPT =
  '你是书签整理助手。用户会给出一条待归档书签的标题与 URL,以及已有书签文件夹清单(JSON 数组,含 id 与 path)。' +
  '请判断它应放入哪个文件夹,返回严格 JSON 对象:' +
  '{"folder_id":"命中的已有文件夹 id 或 null","new_path":["新建层级","子层级"] 或 null,"reason":"一句中文理由"}。' +
  '规则:优先从清单中挑选语义最贴切的已有文件夹(此时 new_path 为 null);' +
  '只有当清单里确实没有一个合适的归宿时,才给出新的层级路径(此时 folder_id 为 null),' +
  '新路径最多两级,用简洁的中文分类名(如 "开发"、"前端工具"),不要包含斜杠、不要复用清单里已存在的完整路径。' +
  '无法判断时 folder_id 与 new_path 都返回 null。不要输出 JSON 以外的内容。';

// 校验模型返回:folder_id 必须在清单里(防幻觉),new_path 必须是 1~2 级干净名称
function sanitize(out, folders) {
  const validIds = new Set(folders.map(f => f.id));
  let folderId = typeof out.folder_id === 'string' && validIds.has(out.folder_id) ? out.folder_id : null;

  let newPath = null;
  if (!folderId && Array.isArray(out.new_path)) {
    const parts = out.new_path
      .filter(p => typeof p === 'string')
      .map(p => p.trim().replace(/[\\/]+/g, ' ').replace(/^\.+|\.+$/g, '').trim())
      .filter(Boolean)
      .slice(0, 2);
    if (parts.length) newPath = parts;
  }
  // 两者都给了时以已有文件夹为准,避免无谓建夹
  if (folderId) newPath = null;
  return { folderId, newPath, reason: typeof out.reason === 'string' ? out.reason.slice(0, 200) : '' };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  if (!auth.check(req)) { auth.reject(res); return; }
  try {
    const { title, url, folders } = JSON.parse(await readBody(req));
    if (!Array.isArray(folders) || (!title && !url)) { res.status(400).json({ error: '参数错误' }); return; }

    const slim = folders.slice(0, 400).map(f => ({ id: f.id, path: f.path }));
    const user = '标题:' + (title || '') + '\nURL:' + (url || '') + '\n\n已有文件夹:\n' + JSON.stringify(slim);

    let out;
    try {
      out = await chatJson(SYSTEM_PROMPT, user);
    } catch (e) {
      if (e.code === 'NO_AI') { res.status(500).json({ error: e.message }); return; }
      res.status(500).json({ error: 'AI 归类失败:' + (e.rawText || e.message) });
      return;
    }
    res.status(200).json(sanitize(out || {}, folders));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.sanitize = sanitize;
