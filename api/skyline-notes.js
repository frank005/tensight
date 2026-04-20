const {
  appendAuditRecord,
  getAuditStorageInfo,
  getClientMetadata,
  isAllowedPostOrigin,
  isAuthorized,
  readAuditRecords,
  readBody,
  recordsToCsv
} = require('../lib/auditLog');

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.end(JSON.stringify(payload));
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAuditPage(records, storage) {
  const recent = records.slice().reverse();
  const storageLabel = storage && storage.durable
    ? 'Durable storage: Vercel KV'
    : 'Volatile storage: in-memory fallback';
  const storageDetail = storage && storage.durable
    ? 'Keeping newest ' + storage.maxRows + ' records in key ' + storage.key + '.'
    : 'Records can disappear on refresh, cold start, redeploy, or when requests hit another serverless instance. Configure KV_REST_API_URL and KV_REST_API_TOKEN for durable history.';
  const rows = recent.map(function (record) {
    const client = record.client || {};
    const meta = record.meta || {};
    const where = [record.city, record.region, record.country].filter(Boolean).join(', ');
    return '<tr>' +
      '<td>' + escapeHtml(record.timestamp) + '</td>' +
      '<td>' + escapeHtml(record.event) + '</td>' +
      '<td>' + escapeHtml(record.ip) + '</td>' +
      '<td>' + escapeHtml(where) + '</td>' +
      '<td>' + escapeHtml(client.path || '') + '</td>' +
      '<td>' + escapeHtml(meta.agentId || '') + '</td>' +
      '<td>' + escapeHtml(meta.environment || '') + '</td>' +
      '<td>' + escapeHtml(meta.fileName || '') + '</td>' +
      '<td class="ua">' + escapeHtml(record.userAgent || '') + '</td>' +
      '</tr>';
  }).join('');

  return '<!doctype html>' +
    '<html lang="en"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    '<meta name="robots" content="noindex,nofollow,noarchive" />' +
    '<title>Usage Records</title>' +
    '<style>' +
    ':root{color-scheme:dark;--bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--accent:#58a6ff}' +
    '*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
    'header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}' +
    'h1{font-size:22px;margin:0}.meta{color:var(--muted);font-size:12px;margin-top:4px}' +
    '.actions{display:flex;gap:8px;flex-wrap:wrap}a.button{color:var(--bg);background:var(--accent);text-decoration:none;border-radius:6px;padding:8px 10px;font-weight:650}' +
    '.table-wrap{border:1px solid var(--border);border-radius:8px;overflow:auto;background:var(--surface)}' +
    '.storage{border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:0 0 14px;background:var(--surface)}.storage.warn{border-color:#d29922;background:rgba(210,153,34,.12)}.storage strong{display:block;margin-bottom:2px}.storage span{color:var(--muted);font-size:12px}' +
    'table{width:100%;border-collapse:collapse;min-width:1120px}th,td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}' +
    'th{position:sticky;top:0;background:#1f2630;font-size:12px;color:var(--muted);font-weight:650}td{font-size:12px}tr:last-child td{border-bottom:0}.ua{max-width:360px;word-break:break-word}' +
    '.empty{padding:24px;color:var(--muted)}' +
    '</style></head><body>' +
    '<header><div><h1>Usage Records</h1><div class="meta">' + records.length + ' total records. Newest first.</div></div>' +
    '<div class="actions"><a class="button" href="?format=json">Download JSON</a><a class="button" href="?format=csv">Download CSV</a></div></header>' +
    '<div class="storage' + (storage && storage.durable ? '' : ' warn') + '"><strong>' + escapeHtml(storageLabel) + '</strong><span>' + escapeHtml(storageDetail) + '</span></div>' +
    (records.length
      ? '<div class="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>IP</th><th>Location</th><th>Path</th><th>Agent ID</th><th>Env</th><th>File</th><th>User agent</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<div class="table-wrap"><div class="empty">No usage records yet.</div></div>') +
    '</body></html>';
}

function sanitizeClientPayload(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  [
    'path',
    'pageTitle',
    'referrer',
    'language',
    'timezone',
    'screen',
    'visibility'
  ].forEach(function (key) {
    if (raw[key] != null) out[key] = String(raw[key]).slice(0, 500);
  });
  return out;
}

function sanitizeMeta(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  [
    'agentId',
    'environment',
    'fileName',
    'fileSize',
    'fileType',
    'entryCount',
    'errorCount',
    'warningCount'
  ].forEach(function (key) {
    if (raw[key] != null) out[key] = String(raw[key]).slice(0, 500);
  });
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === 'POST') {
    if (!isAllowedPostOrigin(req)) {
      sendJson(res, 403, { error: 'origin not allowed' });
      return;
    }

    let body = {};
    try {
      const text = await readBody(req, 32768);
      body = text ? JSON.parse(text) : {};
    } catch (e) {
      sendJson(res, 400, { error: 'invalid JSON' });
      return;
    }

    const metadata = getClientMetadata(req);
    const record = {
      timestamp: new Date().toISOString(),
      event: body && body.event ? String(body.event).slice(0, 80) : 'page_view',
      ip: metadata.ip,
      userAgent: metadata.userAgent,
      referrer: metadata.referrer,
      origin: metadata.origin,
      acceptLanguage: metadata.acceptLanguage,
      country: metadata.country,
      region: metadata.region,
      city: metadata.city,
      host: metadata.host,
      vercelId: metadata.vercelId,
      requestUrl: metadata.requestUrl,
      client: sanitizeClientPayload(body && body.client),
      meta: sanitizeMeta(body && body.meta)
    };

    try {
      const result = await appendAuditRecord(record);
      sendJson(res, 200, { ok: true, durable: result.durable });
    } catch (e) {
      sendJson(res, 500, { error: 'failed to write log' });
    }
    return;
  }

  if (req.method === 'GET') {
    if (!isAuthorized(req)) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Unauthorized');
      return;
    }

    let records;
    try {
      records = await readAuditRecords();
    } catch (e) {
      sendJson(res, 500, { error: 'failed to read log' });
      return;
    }

    const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
    const format = (url.searchParams.get('format') || 'html').toLowerCase();
    const storage = getAuditStorageInfo();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (format === 'csv') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="usage-${stamp}.csv"`);
      res.end(recordsToCsv(records));
      return;
    }

    if (format === 'json') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="usage-${stamp}.json"`);
      res.end(JSON.stringify({ count: records.length, storage, records }, null, 2));
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderAuditPage(records, storage));
    return;
  }

  sendJson(res, 405, { error: 'method not allowed' });
};
