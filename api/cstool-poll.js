/**
 * Dedicated handler for GET /cstoolconvoai/ten_err_status/:jobId (rewritten here with ?job=).
 * Upstream JSON is NOT the same as CSTool's status_url HTML page: call api/ten_err_status.
 */

const {
  pickAllowOrigin,
  applyCorsToRes,
  effectiveCookie,
  upstreamBase
} = require('../lib/cstoolProxyCore');

function sanitizeJobId(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.length > 128) return '';
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return '';
  return s;
}

module.exports = async (req, res) => {
  const allow = pickAllowOrigin(req);

  if (req.method === 'OPTIONS') {
    applyCorsToRes(res, allow, req, true);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 405;
    res.setHeader('Content-Type', 'text/plain');
    res.end('method not allowed');
    return;
  }

  let job = req.query && req.query.job;
  if (Array.isArray(job)) job = job[0];
  job = sanitizeJobId(job);
  if (!job) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.end('missing or bad job');
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
  const qi = (req.url || '').indexOf('?');
  if (qi >= 0) {
    const qs = new URLSearchParams(req.url.slice(qi + 1));
    qs.delete('job');
    const tail = qs.toString();
    if (tail) search = '?' + tail;
  }
  const target = `${base}/cstoolconvoai/api/ten_err_status/${encodeURIComponent(job)}${search}`;

  const headers = {
    cookie,
    'user-agent': 'ten-log-reader-vercel-proxy/1'
  };
  headers.accept = req.headers.accept || 'application/json';
  if (req.headers['accept-language']) headers['accept-language'] = req.headers['accept-language'];

  let r;
  try {
    r = await fetch(target, {
      method: req.method,
      headers,
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
  res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
  res.setHeader('Content-Length', out.length);
  res.end(out);
};
