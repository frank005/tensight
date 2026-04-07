/**
 * Cloudflare Worker: CSTool reverse proxy for TEN Log Reader (GitHub Pages, etc.)
 *
 * Why: Browsers do not expose rtsc-tools cookies to github.io and block cross-origin
 * API responses without CORS. Postman can set Cookie because it is not a web page;
 * in-page JavaScript cannot (forbidden header). This Worker adds the Cookie server-side,
 * like Postman — same role as proxy/local-server.mjs but hosted on HTTPS.
 *
 * No Wrangler? Use the Cloudflare dashboard → Workers → Create → paste this file.
 *
 * Setup:
 * 1. Create a Worker, paste this file as the module entry.
 * 2. wrangler secret put CSTOOL_COOKIE
 *    → In Chrome: DevTools → Application → Cookies → rtsc-tools, OR Network → any
 *    authenticated request → Request Headers → copy full "Cookie:" value (can be long).
 *    Re-copy when the session expires.
 * 3. wrangler secret put ALLOWED_ORIGIN
 *    → e.g. https://frank005.github.io  (no trailing slash; comma-separate for multiple)
 *    → Or * for testing only (not recommended in production).
 * 4. Deploy; paste https://<your-worker>.workers.dev into the reader’s “CSTool proxy” field.
 *
 * Env bindings (secrets or vars):
 *   CSTOOL_COOKIE   — required for authenticated CSTool API
 *   ALLOWED_ORIGIN — required for CORS (your GitHub Pages origin)
 *   UPSTREAM       — optional var, default https://rtsc-tools.sh3.agoralab.co
 */

const DEFAULT_UPSTREAM = 'https://rtsc-tools.sh3.agoralab.co';

/** poll-ten-err/:jobId → upstream ten_err_status/:jobId (same as CSTool status_url). */
function cstoolUpstreamSuffixFromPublicSegments(segments) {
  if (!segments || !segments.length) return '';
  if (segments[0] === 'poll-ten-err' && segments.length >= 2) {
    return ['ten_err_status'].concat(segments.slice(1)).join('/');
  }
  return segments.join('/');
}

function pickAllowOrigin(env, request) {
  const origin = request.headers.get('Origin') || '';
  const raw = (env.ALLOWED_ORIGIN != null ? String(env.ALLOWED_ORIGIN) : '*').trim();
  if (raw === '*' || raw === '') return origin || '*';
  const list = raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (list.indexOf(origin) !== -1) return origin;
  return list[0] || origin || '*';
}

function withCorsHeaders(res, allow, extra) {
  const h = new Headers(res.headers);
  h.delete('access-control-allow-origin');
  h.delete('access-control-allow-credentials');
  h.set('Access-Control-Allow-Origin', allow);
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  if (extra) {
    Object.keys(extra).forEach(function (k) {
      h.set(k, extra[k]);
    });
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: h
  });
}

export default {
  async fetch(request, env) {
    const allow = pickAllowOrigin(env, request);
    const corsPreflight = {
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsPreflight });
    }

    const url = new URL(request.url);
    const upstreamBase = (env.UPSTREAM && String(env.UPSTREAM).trim()) || DEFAULT_UPSTREAM;
    const upstreamOrigin = upstreamBase.replace(/\/$/, '');

    if (url.pathname === '/_oss_tunnel' && request.method === 'GET') {
      const u = url.searchParams.get('u');
      if (!u) {
        return new Response('missing u', { status: 400, headers: corsPreflight });
      }
      let parsed;
      try {
        parsed = new URL(u);
      } catch (e) {
        return new Response('bad url', { status: 400, headers: corsPreflight });
      }
      if (parsed.protocol !== 'https:') {
        return new Response('https only', { status: 403, headers: corsPreflight });
      }
      const host = parsed.hostname.toLowerCase();
      if (!host.endsWith('.aliyuncs.com') && !host.endsWith('.aliyun.com')) {
        return new Response('forbidden host', { status: 403, headers: corsPreflight });
      }
      const r = await fetch(u, {
        headers: { 'User-Agent': 'ten-log-reader-cstool-proxy/1' },
        redirect: 'follow'
      });
      return withCorsHeaders(r, allow);
    }

    if (!url.pathname.startsWith('/cstoolconvoai/')) {
      return new Response(
        'Expected /cstoolconvoai/... or /_oss_tunnel?u=',
        { status: 404, headers: corsPreflight }
      );
    }

    const rest = url.pathname.slice('/cstoolconvoai/'.length);
    const segments = rest.split('/').filter(Boolean);
    const suffix = cstoolUpstreamSuffixFromPublicSegments(segments);
    if (!suffix) {
      return new Response('missing path', { status: 404, headers: corsPreflight });
    }
    const target = `${upstreamOrigin}/cstoolconvoai/${suffix}${url.search}`;
    const headers = new Headers(request.headers);
    const upHost = new URL(upstreamOrigin).host;
    headers.set('Host', upHost);
    if (env.CSTOOL_COOKIE) {
      headers.set('Cookie', env.CSTOOL_COOKIE);
    }
    headers.delete('cf-connecting-ip');

    const init = {
      method: request.method,
      headers: headers,
      redirect: 'follow'
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    const res = await fetch(target, init);
    return withCorsHeaders(res, allow);
  }
};
