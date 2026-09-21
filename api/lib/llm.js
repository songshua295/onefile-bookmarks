// OpenAI 兼容接口(可自定义 AI_BASE_URL)的公共调用:返回解析后的 JSON 对象
// 供 /api/ai(语义搜索)与 /api/categorize(自动归类)复用
async function chatJson(system, userContent, { temperature = 0.2 } = {}) {
  if (!process.env.AI_API_KEY || !process.env.AI_BASE_URL) {
    const e = new Error('未配置 AI:需要 AI_BASE_URL 和 AI_API_KEY 环境变量');
    e.code = 'NO_AI';
    throw e;
  }
  const base = process.env.AI_BASE_URL.replace(/\/+$/, '');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + process.env.AI_API_KEY
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL || 'gpt-4o-mini',
      temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent }
      ]
    })
  });
  if (!r.ok) {
    throw new Error('AI 接口返回 HTTP ' + r.status + ': ' + (await safeText(r)).slice(0, 300));
  }
  const data = await r.json();
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  const text = msg ? msg.content : '';
  try { return JSON.parse(text); }
  catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    const e = new Error('AI 未返回合法 JSON');
    e.rawText = String(text).slice(0, 200);
    throw e;
  }
}

async function safeText(res) { try { return await res.text(); } catch { return ''; } }

module.exports = { chatJson };
