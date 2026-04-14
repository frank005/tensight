/**
 * POST /api/ten-investigator-extract
 * Body: { agentId, environment?, prefix?, suffix? }
 * Returns investigator response (contains download url)
 */
const { pickAllowOrigin, applyCorsToRes, readBodyBuffer } = require('../lib/cstoolProxyCore');
const { getInvestigatorHost, buildExtractPayload } = require('../lib/tenInvestigatorCore');

module.exports = async (req, res) => {
  const allow = pickAllowOrigin(req);

  if (req.method === 'OPTIONS') {
    applyCorsToRes(res, allow, req, true);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 405;
    res.end('POST only');
    return;
  }

  const token = (process.env.TEN_INVESTIGATOR_TOKEN || '').trim();
  if (!token) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'TEN_INVESTIGATOR_TOKEN not configured' }));
    return;
  }

  let body;
  try {
    const buf = await readBodyBuffer(req);
    body = buf && buf.length ? JSON.parse(buf.toString('utf8')) : {};
  } catch {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 400;
    res.end('invalid JSON');
    return;
  }

  const agentId = body.agentId ? String(body.agentId).trim() : '';
  if (!agentId) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'missing agentId' }));
    return;
  }

  const environment = body.environment || 'prod';
  const host = getInvestigatorHost(environment);
  const url = `${host}/agents/extract?token=${encodeURIComponent(token)}`;
  const payload = buildExtractPayload(agentId, body);

  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 502;
    res.end(String(e.message || e));
    return;
  }

  const text = await r.text();
  applyCorsToRes(res, allow, req, false);
  res.statusCode = r.status;
  res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
  res.end(text);
};
