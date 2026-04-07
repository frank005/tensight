const {
  pickAllowOrigin,
  applyCorsToRes,
  effectiveCookie,
  upstreamBase,
  readBodyBuffer
} = require('../../lib/cstoolProxyCore');

const CSTOOL_API_PREFIX = '/api/cstool';

/**
 * Catch-all segments from the URL. Vercel usually sets req.query.path for
 * api/cstool/[...path].js, but rewrites and some Node runtimes leave it empty;
 * pathname on req.url is reliable (e.g. /api/cstool/parse_ten_err).
 */
function pathSegments(req) {
  const q = req.query && req.query.path;
  if (q != null) {
    const fromQuery = Array.isArray(q) ? q.filter(Boolean) : [q].filter(Boolean);
    if (fromQuery.length) return fromQuery;
  }
  let pathname = '';
  try {
    const raw = req.url || '/';
    const u = /^https?:\/\//i.test(raw)
      ? new URL(raw)
      : new URL(raw, `http://${req.headers.host || 'localhost'}`);
    pathname = u.pathname || '';
  } catch {
    pathname = (req.url || '').split('?')[0] || '';
  }
  if (!pathname.startsWith(CSTOOL_API_PREFIX)) return [];
  const rest = pathname.slice(CSTOOL_API_PREFIX.length).replace(/^\/+/, '');
  if (!rest) return [];
  return rest.split('/').filter(Boolean);
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
