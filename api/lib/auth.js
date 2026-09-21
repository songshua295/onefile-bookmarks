const crypto = require('crypto');

// 访问口令令牌:由明文密码派生,浏览器只需持有 token,不用回传密码
function token() {
  const p = process.env.ACCESS_PASSWORD;
  return p ? crypto.createHash('md5').update('bm-gate:' + p).digest('hex') : null;
}

// 是否已配置口令
function enabled() { return !!process.env.ACCESS_PASSWORD; }

// 校验请求:支持 x-auth 头或 ?auth= 参数
function check(req) {
  const t = token();
  if (!t) return true;
  if (req.headers['x-auth'] === t) return true;
  const u = new URL(req.url, 'http://x');
  return u.searchParams.get('auth') === t;
}

function reject(res) {
  res.status(401).json({ error: '需要访问密码' });
}

module.exports = { token, enabled, check, reject };
