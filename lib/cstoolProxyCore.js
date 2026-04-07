/**
 * Shared CSTool reverse-proxy logic for Vercel serverless routes.
 * Env: CSTOOL_COOKIE (optional if clients send X-CSTOOL-Cookie),
 *      ALLOWED_ORIGIN (comma-separated; use * only for testing),
 *      VERCEL_URL is auto-added by Vercel — we allow https://${VERCEL_URL} when ALLOWED_ORIGIN unset.
 *      CSTOOL_UPSTREAM optional, default https://rtsc-tools.sh3.agoralab.co
 */

const DEFAULT_UPSTREAM = 'https://rtsc-tools.sh3.agoralab.co';

function allowedOriginList() {
  const raw = (process.env.ALLOWED_ORIGIN || '').trim();
  const fromEnv = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const vercel = process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : [];
  if (fromEnv.length) return [...new Set([...vercel, ...fromEnv])];
  return vercel.length ? vercel : ['*'];
}

function pickAllowOrigin(req) {
  const origin = req.headers.origin || '';
  const list = allowedOriginList();
  if (list.includes('*')) {
    if (!origin || origin === 'null') return '*';
    return origin;
  }
  if (list.includes(origin)) return origin;
  if (origin === 'null' && list.includes('null')) return 'null';
  return list[0] || '*';
}

function corsHeaders(allow, req, opts) {
  const preflight = !!(opts && opts.preflight);
  const h = {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
    'Access-Control-Max-Age': '86400'
  };
  const arh = req.headers['access-control-request-headers'];
  if (preflight && arh) {
    h['Access-Control-Allow-Headers'] = arh;
  } else {
    h['Access-Control-Allow-Headers'] = 'Content-Type, X-CSTOOL-Cookie';
  }
  if (
    preflight &&
    String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true'
  ) {
    h['Access-Control-Allow-Private-Network'] = 'true';
  }
  return h;
}

function effectiveCookie(req) {
  const xh = req.headers['x-cstool-cookie'];
  if (typeof xh === 'string' && xh.trim()) return xh.trim();
  return (process.env.CSTOOL_COOKIE || '').trim();
}

function upstreamBase() {
  return (process.env.CSTOOL_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/$/, '');
}

function readBodyBuffer(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      resolve(buf.length ? buf : null);
    });
    req.on('error', reject);
  });
}

function applyCorsToRes(res, allow, req, preflight) {
  const ch = corsHeaders(allow, req, { preflight });
  Object.keys(ch).forEach((k) => res.setHeader(k, ch[k]));
}

module.exports = {
  pickAllowOrigin,
  corsHeaders,
  effectiveCookie,
  upstreamBase,
  readBodyBuffer,
  applyCorsToRes,
  DEFAULT_UPSTREAM
};
