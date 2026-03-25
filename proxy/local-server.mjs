#!/usr/bin/env node
/**
 * Local CSTool proxy — same idea as Postman: your machine adds the Cookie header.
 *
 * Why not in the browser? JavaScript on github.io is NOT allowed to set the "Cookie"
 * header on requests to rtsc-tools (forbidden header list). Postman is not a web page,
 * so it has no such restriction.
 *
 * Usage (Node 18+):
 *   export CSTOOL_COOKIE='paste full Cookie header value from DevTools → Network'
 *   export ALLOWED_ORIGIN='https://frank005.github.io'
 *   node proxy/local-server.mjs
 *
 * Then in TEN Log Reader → "CSTool proxy", paste:  http://127.0.0.1:8787
 * Keep this terminal open while you use Fetch log.
 *
 * Env:
 *   CSTOOL_COOKIE  (required) — same string you’d use in Postman
 *   ALLOWED_ORIGIN (required for Pages) — your reader origin, e.g. https://frank005.github.io
 *   PORT           (optional) — default 8787
 *   UPSTREAM       (optional) — default https://rtsc-tools.sh3.agoralab.co
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
  if (raw === '*' || raw === '') return origin || '*';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes(origin)) return origin;
  return list[0] || origin || '*';
}

function corsHeaders(allow) {
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleOssTunnel(u, res, allow) {
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders(allow) });
    res.end('bad url');
    return;
  }
  if (parsed.protocol !== 'https:') {
    res.writeHead(403, { 'Content-Type': 'text/plain', ...corsHeaders(allow) });
    res.end('https only');
    return;
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith('.aliyuncs.com') && !host.endsWith('.aliyun.com')) {
    res.writeHead(403, { 'Content-Type': 'text/plain', ...corsHeaders(allow) });
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
    ...corsHeaders(allow)
  });
  res.end(buf);
}

http
  .createServer(async (req, res) => {
    const allow = pickAllowOrigin(req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(allow));
      res.end();
      return;
    }

    const host = req.headers.host || 'localhost';
    let url;
    try {
      url = new URL(req.url || '/', `http://${host}`);
    } catch {
      res.writeHead(400, corsHeaders(allow));
      res.end('bad request');
      return;
    }

    if (url.pathname === '/_oss_tunnel' && req.method === 'GET') {
      const u = url.searchParams.get('u');
      if (!u) {
        res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders(allow) });
        res.end('missing u');
        return;
      }
      try {
        await handleOssTunnel(u, res, allow);
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'text/plain', ...corsHeaders(allow) });
        res.end(String(e && e.message ? e.message : e));
      }
      return;
    }

    if (!url.pathname.startsWith('/cstoolconvoai/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...corsHeaders(allow) });
      res.end('Use /cstoolconvoai/... or /_oss_tunnel?u=');
      return;
    }

    if (!COOKIE) {
      res.writeHead(500, { 'Content-Type': 'text/plain', ...corsHeaders(allow) });
      res.end('Set CSTOOL_COOKIE env var (same as Postman)');
      return;
    }

    const target = UPSTREAM + url.pathname + url.search;

    const headers = {
      cookie: COOKIE,
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
        headers: headers,
        body: body && body.length ? body : undefined,
        redirect: 'follow'
      });
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain', ...corsHeaders(allow) });
      res.end(String(e && e.message ? e.message : e));
      return;
    }

    const out = Buffer.from(await r.arrayBuffer());
    const outHeaders = {
      ...corsHeaders(allow),
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
    if (!COOKIE) console.error('WARNING: CSTOOL_COOKIE is empty — set it like in Postman.');
  });
