const {
  pickAllowOrigin,
  applyCorsToRes,
  effectiveCookie,
  upstreamBase,
  readBodyBuffer
} = require('../../lib/cstoolProxyCore');

function pathSegments(req) {
  let p = req.query.path;
  if (p == null) return [];
  return Array.isArray(p) ? p : [p];
}

module.exports = async (req, res) => {
  const allow = pickAllowOrigin(req);

  if (req.method === 'OPTIONS') {
    applyCorsToRes(res, allow, req, true);
    res.statusCode = 204;
    res.end();
    return;
  }

  const segments = pathSegments(req);
  const suffix = segments.join('/');
  if (!suffix) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('missing path');
    return;
  }

  const cookie = effectiveCookie(req);
  if (!cookie) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Set CSTOOL_COOKIE in Vercel env and/or paste Cookie in the reader (X-CSTOOL-Cookie).');
    return;
  }

  const base = upstreamBase();
  let search = '';
  const q = (req.url || '').indexOf('?');
  if (q >= 0) search = req.url.slice(q);
  const target = `${base}/cstoolconvoai/${suffix}${search}`;

  const headers = {
    cookie,
    'user-agent': 'ten-log-reader-vercel-proxy/1'
  };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers['accept']) headers['accept'] = req.headers['accept'];
  if (req.headers['accept-language']) headers['accept-language'] = req.headers['accept-language'];

  let body;
  try {
    body = await readBodyBuffer(req);
  } catch (e) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.end('bad body');
    return;
  }

  let r;
  try {
    r = await fetch(target, {
      method: req.method,
      headers,
      body: body && body.length ? body : undefined,
      redirect: 'follow'
    });
  } catch (e) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain');
    res.end(String(e && e.message ? e.message : e));
    return;
  }

  const out = Buffer.from(await r.arrayBuffer());
  applyCorsToRes(res, allow, req, false);
  res.statusCode = r.status;
  res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
  res.setHeader('Content-Length', out.length);
  res.end(out);
};
