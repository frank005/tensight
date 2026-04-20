const crypto = require('crypto');

const DEFAULT_KEY = 'ten-log-reader:audit-log';
const MAX_LOG_ROWS = 5000;

function getStoreKey() {
  return (process.env.AUDIT_LOG_KEY || DEFAULT_KEY).trim();
}

function hasKv() {
  return !!((process.env.KV_REST_API_URL || '').trim() && (process.env.KV_REST_API_TOKEN || '').trim());
}

async function kvCommand(args) {
  const url = (process.env.KV_REST_API_URL || '').trim();
  const token = (process.env.KV_REST_API_TOKEN || '').trim();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  if (!resp.ok) {
    const detail = data && data.error ? data.error : text;
    throw new Error(`KV command failed: ${resp.status} ${detail || ''}`.trim());
  }
  return data ? data.result : null;
}

function memoryStore() {
  if (!globalThis.__TEN_LOG_READER_AUDIT_LOGS) {
    globalThis.__TEN_LOG_READER_AUDIT_LOGS = [];
  }
  return globalThis.__TEN_LOG_READER_AUDIT_LOGS;
}

async function appendAuditRecord(record) {
  const row = JSON.stringify(record);
  if (hasKv()) {
    const key = getStoreKey();
    await kvCommand(['RPUSH', key, row]);
    await kvCommand(['LTRIM', key, String(-MAX_LOG_ROWS), '-1']);
    return { durable: true };
  }

  const rows = memoryStore();
  rows.push(row);
  if (rows.length > MAX_LOG_ROWS) rows.splice(0, rows.length - MAX_LOG_ROWS);
  return { durable: false };
}

async function readAuditRecords() {
  let rows;
  if (hasKv()) {
    rows = await kvCommand(['LRANGE', getStoreKey(), '0', '-1']);
  } else {
    rows = memoryStore();
  }
  if (!Array.isArray(rows)) return [];
  return rows.map(function (row) {
    if (!row || typeof row !== 'string') return null;
    try { return JSON.parse(row); } catch (_) { return null; }
  }).filter(Boolean);
}

function getConfiguredPassword() {
  return (process.env.AUDIT_LOG_PASSWORD || '').trim();
}

function timingSafeEqualString(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function getPasswordFromReq(req) {
  const header = req.headers.authorization || '';
  if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
  if (/^Basic\s+/i.test(header)) {
    try {
      const decoded = Buffer.from(header.replace(/^Basic\s+/i, '').trim(), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      return idx >= 0 ? decoded.slice(idx + 1) : decoded;
    } catch (_) {
      return '';
    }
  }
  return String(req.headers['x-audit-password'] || '').trim();
}

function isAuthorized(req) {
  const expected = getConfiguredPassword();
  if (!expected) return false;
  return timingSafeEqualString(getPasswordFromReq(req), expected);
}

function readBody(req, maxBytes) {
  const limit = maxBytes || 32768;
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let total = 0;
    req.on('data', function (chunk) {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function firstHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function getClientIp(req) {
  const forwarded = firstHeader(req, 'x-forwarded-for');
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return firstHeader(req, 'x-real-ip') || (req.socket && req.socket.remoteAddress) || '';
}

function getClientMetadata(req) {
  return {
    ip: getClientIp(req),
    userAgent: firstHeader(req, 'user-agent') || '',
    referrer: firstHeader(req, 'referer') || '',
    origin: firstHeader(req, 'origin') || '',
    acceptLanguage: firstHeader(req, 'accept-language') || '',
    host: firstHeader(req, 'host') || '',
    forwardedFor: firstHeader(req, 'x-forwarded-for') || '',
    vercelId: firstHeader(req, 'x-vercel-id') || '',
    country: firstHeader(req, 'x-vercel-ip-country') || '',
    region: firstHeader(req, 'x-vercel-ip-country-region') || '',
    city: firstHeader(req, 'x-vercel-ip-city') || '',
    requestUrl: req.url || '',
    method: req.method || ''
  };
}

function isAllowedPostOrigin(req) {
  const origin = firstHeader(req, 'origin');
  if (!origin) return true;
  const host = firstHeader(req, 'host');
  const allowed = (process.env.ALLOWED_ORIGIN || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (allowed.indexOf(origin) !== -1) return true;
  try {
    return !!host && new URL(origin).host === host;
  } catch (_) {
    return false;
  }
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function recordsToCsv(records) {
  const cols = [
    'timestamp', 'event', 'path', 'pageTitle', 'ip', 'country', 'region', 'city',
    'userAgent', 'referrer', 'origin', 'language', 'timezone', 'screen',
    'agentId', 'environment', 'fileName', 'fileSize', 'host', 'vercelId'
  ];
  const lines = [cols.join(',')];
  records.forEach(function (record) {
    const client = record.client || {};
    const meta = record.meta || {};
    const row = {
      timestamp: record.timestamp,
      event: record.event,
      path: client.path,
      pageTitle: client.pageTitle,
      ip: record.ip,
      country: record.country,
      region: record.region,
      city: record.city,
      userAgent: record.userAgent,
      referrer: record.referrer,
      origin: record.origin,
      language: client.language,
      timezone: client.timezone,
      screen: client.screen,
      agentId: meta.agentId,
      environment: meta.environment,
      fileName: meta.fileName,
      fileSize: meta.fileSize,
      host: record.host,
      vercelId: record.vercelId
    };
    lines.push(cols.map(function (col) { return csvEscape(row[col]); }).join(','));
  });
  return lines.join('\n') + '\n';
}

module.exports = {
  appendAuditRecord,
  getClientMetadata,
  isAllowedPostOrigin,
  isAuthorized,
  readAuditRecords,
  readBody,
  recordsToCsv
};
