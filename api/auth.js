const auth = require('./lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  if (!auth.enabled()) { res.status(200).json({ ok: true, token: null }); return; }
  try {
    const body = JSON.parse(await new Promise((resolve, reject) => {
      let d = '';
      req.on('data', c => { d += c; if (d.length > 1e5) reject(new Error('too large')); });
      req.on('end', () => resolve(d));
      req.on('error', reject);
    }));
    if (body.password === process.env.ACCESS_PASSWORD) {
      res.status(200).json({ ok: true, token: auth.token() });
    } else {
      res.status(401).json({ ok: false, error: '密码错误' });
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};
