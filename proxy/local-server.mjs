#!/usr/bin/env node
/**
 * Local proxy for TEN Log Reader.
 * - TEN Investigator (token-based, no cookie) — uses TEN_INVESTIGATOR_TOKEN from .env or env
 * - CSTool fallback (cookie-based) — uses CSTOOL_COOKIE
 *
 * Usage (Node 18+):
 *   # Put TEN_INVESTIGATOR_TOKEN in .env (auto-loaded) or export it
 *   export ALLOWED_ORIGIN='http://127.0.0.1:8080'
 *   node proxy/local-server.mjs
 */

import http from 'http';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { fileURLToPath, URL } from 'url';

// Load .env from repo root
function loadEnvFile() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = join(__dirname, '..', '.env');
  if (!existsSync(envPath)) return;
  try {
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}
loadEnvFile();

const require = createRequire(import.meta.url);
const { cstoolUpstreamSuffixFromPublicSegments } = require('../lib/cstoolProxyCore.js');
const { getInvestigatorHost, buildExtractPayload, isAllowedDownloadHost } = require('../lib/tenInvestigatorCore.js');

const PORT = Number(process.env.PORT) || 8787;
const UPSTREAM = (process.env.UPSTREAM || 'https://rtsc-tools.sh3.agoralab.co').replace(/\/$/, '');
const COOKIE = process.env.CSTOOL_COOKIE || '';
const TEN_TOKEN = (process.env.TEN_INVESTIGATOR_TOKEN || '').trim();
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
  if (preflight && req && String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true') {
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
  const r = await fetch(u, { redirect: 'follow' });
  const buf = Buffer.from(await r.arrayBuffer());
  res.writeHead(r.status, {
    'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
    'Content-Length': buf.length,
    ...corsHeaders(allow, req, {})
  });
  res.end(buf);
}

http.createServer(async (req, res) => {
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

  // Probe endpoint — tells the client what's available
  if (url.pathname === '/api/cstool-proxy-status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(allow, req, {}) });
    res.end(JSON.stringify({ cstoolProxy: true, investigator: !!TEN_TOKEN }));
    return;
  }

  // TEN Investigator extract
  if (url.pathname === '/api/ten-investigator-extract' && req.method === 'POST') {
    if (!TEN_TOKEN) {
      res.writeHead(503, { 'Content-Type': 'application/json', ...corsHeaders(allow, req, {}) });
      res.end(JSON.stringify({ error: 'TEN_INVESTIGATOR_TOKEN not set' }));
      return;
    }
    let body;
    try {
      const chunks = await collectBody(req);
      body = chunks.length ? JSON.parse(chunks.toString('utf8')) : {};
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
      res.end('invalid JSON');
      return;
    }
    const agentId = body.agentId ? String(body.agentId).trim() : '';
    if (!agentId) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders(allow, req, {}) });
      res.end(JSON.stringify({ error: 'missing agentId' }));
      return;
    }
    const environment = body.environment || 'prod';
    const invHost = getInvestigatorHost(environment);
    const extractUrl = `${invHost}/agents/extract?token=${encodeURIComponent(TEN_TOKEN)}`;
    const payload = buildExtractPayload(agentId, body);
    let r;
    try {
      r = await fetch(extractUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
      res.end(String(e.message || e));
      return;
    }
    const text = await r.text();
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json', ...corsHeaders(allow, req, {}) });
    res.end(text);
    return;
  }

  // TEN Investigator download tunnel
  if (url.pathname === '/api/ten-investigator-tunnel' && req.method === 'GET') {
    const u = url.searchParams.get('u');
    if (!u) {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
      res.end('missing u');
      return;
    }
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
      res.end('bad url');
      return;
    }
    if (!isAllowedDownloadHost(parsed.hostname)) {
      res.writeHead(403, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
      res.end('forbidden host');
      return;
    }
    let r;
    try {
      r = await fetch(parsed.toString(), { redirect: 'follow' });
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
      res.end(String(e.message || e));
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, {
      'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
      'Content-Length': buf.length,
      ...corsHeaders(allow, req, {})
    });
    res.end(buf);
    return;
  }

  // OSS tunnel (for CSTool downloads)
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

  // CSTool proxy (fallback, needs cookie)
  if (!url.pathname.startsWith('/cstoolconvoai/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
    res.end('Not found');
    return;
  }

  const cookie = effectiveCookie(req);
  if (!cookie) {
    res.writeHead(500, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
    res.end('Set CSTOOL_COOKIE env and/or paste Cookie in the reader dialog.');
    return;
  }

  const rest = url.pathname.slice('/cstoolconvoai/'.length);
  const segments = rest.split('/').filter(Boolean);
  const suffix = cstoolUpstreamSuffixFromPublicSegments(segments);
  if (!suffix) {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...corsHeaders(allow, req, {}) });
    res.end('missing path');
    return;
  }
  const target = `${UPSTREAM}/cstoolconvoai/${suffix}${url.search}`;

  const headers = { cookie, 'user-agent': 'ten-log-reader-local-proxy/1' };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers['accept']) headers['accept'] = req.headers['accept'];

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
  res.writeHead(r.status, {
    ...corsHeaders(allow, req, {}),
    'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
    'Content-Length': out.length
  });
  res.end(out);
}).listen(PORT, '127.0.0.1', () => {
  console.error(`Proxy listening on http://127.0.0.1:${PORT}`);
  console.error(`ALLOWED_ORIGIN=${ALLOWED_RAW}`);
  if (TEN_TOKEN) {
    console.error('TEN_INVESTIGATOR_TOKEN is set — Fetch log will use investigator (no cookie needed).');
  } else {
    console.error('TEN_INVESTIGATOR_TOKEN not set — will need CSTool cookie for Fetch log.');
  }
});
