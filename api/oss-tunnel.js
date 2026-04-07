const { pickAllowOrigin, applyCorsToRes } = require('../lib/cstoolProxyCore');

function parseUrl(req) {
  try {
    const host = req.headers.host || 'localhost';
    const u = new URL(req.url || '/', `http://${host}`);
    return u;
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  const allow = pickAllowOrigin(req);

  if (req.method === 'OPTIONS') {
    applyCorsToRes(res, allow, req, true);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 405;
    res.setHeader('Content-Type', 'text/plain');
    res.end('method not allowed');
    return;
  }

  const url = parseUrl(req);
  const u = url && url.searchParams.get('u');
  if (!u) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.end('missing u');
    return;
  }

  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.end('bad url');
    return;
  }
  if (parsed.protocol !== 'https:') {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain');
    res.end('https only');
    return;
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith('.aliyuncs.com') && !host.endsWith('.aliyun.com')) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain');
    res.end('forbidden host');
    return;
  }

  let r;
  try {
    r = await fetch(u, {
      headers: { 'User-Agent': 'ten-log-reader-vercel-proxy/1' },
      redirect: 'follow'
    });
  } catch (e) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain');
    res.end(String(e && e.message ? e.message : e));
    return;
  }

  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') || 'application/octet-stream';
  applyCorsToRes(res, allow, req, false);
  res.statusCode = r.status;
  res.setHeader('Content-Type', ct);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
};
