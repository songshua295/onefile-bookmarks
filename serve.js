// 本地开发服务器:静态文件 + 与 Vercel API 相同的 /api 处理器(读取 .env)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// 载入 .env(每次请求都会重新读取,改完配置无需重启)
const envPath = path.join(ROOT, '.env');
function loadEnv() {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { getType } = require('./api/lib/storage');
const auth = require('./api/lib/auth');
const configHandler = require('./api/config');
const authHandler = require('./api/auth');
const bookmarkHandler = require('./api/bookmark');
const aiHandler = require('./api/ai');
const categorizeHandler = require('./api/categorize');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};

// Vercel 的 res 带 .status/.json/.send,原生 http 没有,这里补齐
function shim(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status = c => { res.statusCode = c; return res; };
  res.json = o => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(o));
    return res;
  };
  res.send = b => { res.end(b); return res; };
  return res;
}

const server = http.createServer(async (req, res) => {
  loadEnv();
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/api/config') return configHandler(req, shim(req, res));
  if (u.pathname === '/api/auth') return authHandler(req, shim(req, res));
  // 其余 API 需要访问口令(未配置 ACCESS_PASSWORD 时 auth.check 直接放行)
  if (!auth.check(req)) { auth.reject(shim(req, res)); return; }
  if (u.pathname === '/api/bookmark') return bookmarkHandler(req, shim(req, res));
  if (u.pathname === '/api/ai') return aiHandler(req, shim(req, res));
  if (u.pathname === '/api/categorize') return categorizeHandler(req, shim(req, res));

  // 静态文件
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.status(403).end(); return; }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  // no-cache:JS 模块有更新时立即生效,避免新旧模块混搭导致页面空白
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(file).pipe(res);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  loadEnv();   // 先读 .env 再打印横幅,否则显示的存储类型是错的
  console.log(`书签页面已启动: http://localhost:${PORT}`);
  console.log(`存储类型: ${getType()}${getType() === 'none' ? '(未配置远程存储,只读本地文件)' : ''}`);
  if (!fs.existsSync(envPath)) console.log('提示:复制 .env.example 为 .env 并填写配置后重启');
});
