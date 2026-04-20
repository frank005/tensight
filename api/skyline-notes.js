const {
  appendAuditRecord,
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
    const format = (url.searchParams.get('format') || 'json').toLowerCase();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (format === 'csv') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="usage-${stamp}.csv"`);
      res.end(recordsToCsv(records));
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="usage-${stamp}.json"`);
    res.end(JSON.stringify({ count: records.length, records }, null, 2));
    return;
  }

  sendJson(res, 405, { error: 'method not allowed' });
};
