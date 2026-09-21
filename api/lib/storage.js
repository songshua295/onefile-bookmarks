// S3(aws4fetch)/ WebDAV 存储适配层,同时供 Vercel API 与本地 serve.js 使用
// 环境变量在每次调用时读取,配置修改后无需重启进程

let _aws = null;
let _awsKey = '';

function getType() {
  const t = (process.env.STORAGE_TYPE || 'none').toLowerCase();
  if (t === 's3' && s3cfg().bucket && s3cfg().ak) return 's3';
  if (t === 'webdav' && webdavCfg().url) return 'webdav';
  return 'none';
}

function s3cfg() {
  const trim = s => String(s || '').replace(/^\/+|\/+$/g, '');
  return {
    endpoint: (process.env.S3_ENDPOINT || '').replace(/\/+$/, ''),
    region: process.env.S3_REGION || 'us-east-1',
    bucket: trim(process.env.S3_BUCKET),
    prefix: trim(process.env.S3_PREFIX),
    ak: process.env.S3_ACCESS_KEY_ID || '',
    sk: process.env.S3_SECRET_ACCESS_KEY || ''
  };
}

function webdavCfg() {
  return {
    url: (process.env.WEBDAV_URL || '').replace(/\/+$/, ''),
    user: process.env.WEBDAV_USERNAME || '',
    pass: process.env.WEBDAV_PASSWORD || ''
  };
}

async function awsClient() {
  const { ak, sk, region } = s3cfg();
  const key = ak + '|' + sk + '|' + region;
  if (!_aws || _awsKey !== key) {
    const { AwsClient } = await import('aws4fetch');
    _aws = new AwsClient({ accessKeyId: ak, secretAccessKey: sk, region, service: 's3' });
    _awsKey = key;
  }
  return _aws;
}

// 计算对象请求路径:兼容两种 endpoint 风格
//  - virtual-hosted: https://BUCKET.s3.xxx.com (桶名已在域名里,路径不再带桶名)
//  - path style:     https://s3.xxx.com         (路径需要带桶名)
// 返回 { listUrl, objectUrl(key) }
function s3Targets() {
  const { endpoint, bucket, prefix } = s3cfg();
  const base = endpoint.replace(/\/+$/, '');
  let host = '';
  try { host = new URL(base).hostname; } catch { /* 非法 endpoint 时按 path 风格处理 */ }
  const virtualHosted = !!bucket && (host === bucket || host.startsWith(bucket + '.'));
  const join = key => {
    const k = [prefix, String(key).replace(/^\/+/, '')].filter(Boolean).join('/');
    return virtualHosted ? `${base}/${k}` : `${base}/${bucket}/${k}`;
  };
  return {
    virtualHosted,
    objectUrl: join,
    listUrl: () => {
      let u = virtualHosted ? `${base}?list-type=2&max-keys=1000` : `${base}/${bucket}?list-type=2&max-keys=1000`;
      if (prefix) u += '&prefix=' + encodeURIComponent(prefix + '/');
      return u;
    }
  };
}

function s3Url(key) {
  return s3Targets().objectUrl(key);
}

function webdavUrl(key) {
  const { url } = webdavCfg();
  const k = key.replace(/^\/+/, '');
  return url ? `${url}/${k}` : '/' + k;
}

function webdavHeaders(extra) {
  const { user, pass } = webdavCfg();
  const auth = Buffer.from(user + ':' + pass).toString('base64');
  return { Authorization: 'Basic ' + auth, ...extra };
}

async function get(key) {
  const type = getType();
  let res;
  if (type === 's3') {
    // aws4fetch 对请求做 SigV4 签名(AK/SK),不是匿名 GET
    res = await (await awsClient()).fetch(s3Url(key));
  } else if (type === 'webdav') {
    res = await fetch(webdavUrl(key), { headers: webdavHeaders({}) });
  } else return null;
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${type.toUpperCase()} GET ${key} 失败: HTTP ${res.status}`);
  return { content: await res.text(), etag: res.headers.get('etag') };
}

async function put(key, content) {
  const type = getType();
  let res;
  if (type === 's3') {
    res = await (await awsClient()).fetch(s3Url(key), { method: 'PUT', body: content });
  } else if (type === 'webdav') {
    res = await fetch(webdavUrl(key), {
      method: 'PUT',
      headers: webdavHeaders({ 'Content-Type': 'text/html; charset=utf-8' }),
      body: content
    });
  } else throw new Error('未配置存储');
  if (!res.ok) throw new Error(`${type.toUpperCase()} PUT ${key} 失败: HTTP ${res.status} ${await safeText(res)}`);
  return res.headers.get('etag');
}

async function safeText(res) { try { return await res.text(); } catch { return ''; } }

// 列举存储中的所有 key(s3 含前缀;webdav 为目录内文件名)
async function listAll() {
  const type = getType();
  if (type === 's3') {
    const client = await awsClient();
    const res = await client.fetch(s3Targets().listUrl());
    if (!res.ok) throw new Error(`S3 LIST 失败: HTTP ${res.status}`);
    const xml = await res.text();
    const { prefix } = s3cfg();
    // 返回去掉前缀的相对名,与 WebDAV 分支一致(get 时会重新拼前缀)
    const strip = k => (prefix && k.startsWith(prefix + '/')) ? k.slice(prefix.length + 1) : k;
    return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => strip(xmlDecode(m[1])));
  }
  if (type === 'webdav') {
    const { url } = webdavCfg();
    const res = await fetch(url + '/', { method: 'PROPFIND', headers: webdavHeaders({ Depth: '1' }) });
    if (!res.ok && res.status !== 207) throw new Error(`WebDAV LIST 失败: HTTP ${res.status}`);
    const xml = await res.text();
    const hrefs = [...xml.matchAll(/<(?:[\w.-]+:)?href>([^<]+)<\/(?:[\w.-]+:)?href>/gi)].map(m => xmlDecode(decodeURIComponent(m[1])));
    return hrefs.map(h => h.replace(/\/+$/, '').split('/').pop()).filter(Boolean);
  }
  return [];
}

function xmlDecode(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 20 * 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = { getType, get, put, listAll, readBody };
