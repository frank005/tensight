#!/usr/bin/env node
/**
 * Local CSTool proxy — adds the Cookie header server-side (like curl/Postman).
 *
 * Optional: TEN Log Reader can send X-CSTOOL-Cookie per request (browser cannot set
 * Cookie on rtsc-tools cross-origin). If absent, CSTOOL_COOKIE env is used.
 *
 * Usage (Node 18+):
 *   export ALLOWED_ORIGIN='https://your-id.github.io'
 *   export CSTOOL_COOKIE='…'   # optional if the app sends X-CSTOOL-Cookie
 *   node proxy/local-server.mjs
 *
 * Then paste http://127.0.0.1:8787 into the reader’s “CSTool proxy” field.
 *
 * Do not open the reader as file:// — use http://127.0.0.1:PORT (e.g. python3 -m http.server)
 * and set ALLOWED_ORIGIN to that origin, or ALLOWED_ORIGIN=* for local-only testing.
 */

import http from 'http';
import { URL } from 'url';

const PORT = Number(process.env.PORT) || 8787;
const UPSTREAM = (process.env.UPSTREAM || 'https://rtsc-tools.sh3.agoralab.co').replace(/\/$/, '');
const COOKIE = process.env.CSTOOL_COOKIE || '';
const ALLOWED_RAW = process.env.ALLOWED_ORIGIN || '*';

function pickAllowOrigin(req) {
  const origin = req.headers.origin || '';
  const raw = String(ALLOWED_RAW).trim();
  if (raw === '*' || raw === '') {
    if (origin === 'null' || origin === '') return '*';
    return origin;
  }
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes(origin)) return origin;
  if (origin === 'null' && list.includes('null')) return 'null';
  return list[0] || '*';
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {{ preflight?: boolean }} opts
 */
function corsHeaders(allow, req, opts) {
  const preflight = !!(opts && opts.preflight);
  const h = {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
    'Access-Control-Max-Age': '86400'
  };
  const arh = req && req.headers['access-control-request-headers'];
  if (preflight && arh) {
    h['Access-Control-Allow-Headers'] = arh;
  } else {
    h['Access-Control-Allow-Headers'] = 'Content-Type, X-CSTOOL-Cookie';
  }
  if (
    preflight &&
    req &&
    String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true'
  ) {
    h['Access-Control-Allow-Private-Network'] = 'true';
  }
  return h;
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function effectiveCookie(req) {
  const xh = req.headers['x-cstool-cookie'];
  if (typeof xh === 'string' && xh.trim()) return xh.trim();
  return COOKIE;
}

async function handleOssTunnel(u, res, allow, req) {
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
    res.end('bad url');
    return;
  }
  if (parsed.protocol !== 'https:') {
    res.writeHead(403, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
    res.end('https only');
    return;
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith('.aliyuncs.com') && !host.endsWith('.aliyun.com')) {
    res.writeHead(403, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
    res.end('forbidden host');
    return;
  }
  const r = await fetch(u, {
    headers: { 'User-Agent': 'ten-log-reader-local-proxy/1' },
    redirect: 'follow'
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') || 'application/octet-stream';
  res.writeHead(r.status, {
    'Content-Type': ct,
    'Content-Length': buf.length,
    ...corsHeaders(allow, req, {})
  });
  res.end(buf);
}

http
  .createServer(async (req, res) => {
    const allow = pickAllowOrigin(req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(allow, req, { preflight: true }));
      res.end();
      return;
    }

    const host = req.headers.host || 'localhost';
    let url;
    try {
      url = new URL(req.url || '/', `http://${host}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
      res.end('bad request');
      return;
    }

    if (url.pathname === '/_oss_tunnel' && req.method === 'GET') {
      const u = url.searchParams.get('u');
      if (!u) {
        res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
        res.end('missing u');
        return;
      }
      try {
        await handleOssTunnel(u, res, allow, req);
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
        res.end(String(e && e.message ? e.message : e));
      }
      return;
    }

    if (!url.pathname.startsWith('/cstoolconvoai/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
      res.end('Use /cstoolconvoai/... or /_oss_tunnel?u=');
      return;
    }

    const cookie = effectiveCookie(req);
    if (!cookie) {
      res.writeHead(500, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
      res.end('Set CSTOOL_COOKIE env and/or paste Cookie in the reader dialog (sent as X-CSTOOL-Cookie).');
      return;
    }

    const target = UPSTREAM + url.pathname + url.search;

    const headers = {
      cookie,
      'user-agent': 'ten-log-reader-local-proxy/1'
    };
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    if (req.headers['accept']) headers['accept'] = req.headers['accept'];
    if (req.headers['accept-language']) headers['accept-language'] = req.headers['accept-language'];

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = await collectBody(req);
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
      res.writeHead(502, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
      res.end(String(e && e.message ? e.message : e));
      return;
    }

    const out = Buffer.from(await r.arrayBuffer());
    const outHeaders = {
      ...corsHeaders(allow, req, {}),
      'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
      'Content-Length': out.length
    };
    res.writeHead(r.status, outHeaders);
    res.end(out);
  })
  .listen(PORT, '127.0.0.1', () => {
    console.error(
      `CSTool proxy listening on http://127.0.0.1:${PORT}\nPaste that URL into TEN Log Reader → CSTool proxy.\nALLOWED_ORIGIN=${ALLOWED_RAW}`
    );
    if (!COOKIE) {
      console.error('Note: CSTOOL_COOKIE is empty — use Cookie paste in the reader, or set the env var.');
    }
  });
