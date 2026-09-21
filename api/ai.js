const { readBody } = require('./lib/storage');
const auth = require('./lib/auth');
const { chatJson } = require('./lib/llm');

const SYSTEM_PROMPT =
  '你是一个书签搜索助手。用户会给出搜索需求和一组书签(JSON 数组,含 id/title/path/url 字段)。' +
  '请挑选与需求最相关的书签(最多 15 条),并返回严格的 JSON 对象:' +
  '{"answer":"一句话中文说明你的筛选思路","ids":["命中书签的 id", ...]}。' +
  '不要输出 JSON 以外的任何内容。';

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  if (!auth.check(req)) { auth.reject(res); return; }
  try {
    const { query, items } = JSON.parse(await readBody(req));
    if (!query || !Array.isArray(items)) { res.status(400).json({ error: '参数错误' }); return; }
    let out;
    try {
      out = await chatJson(SYSTEM_PROMPT, '搜索需求:' + query + '\n\n书签列表:\n' + JSON.stringify(items));
    } catch (e) {
      if (e.code === 'NO_AI') { res.status(500).json({ error: e.message }); return; }
      out = { ids: [], answer: e.rawText || e.message };
    }
    res.status(200).json({ ids: out.ids || [], answer: out.answer || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
