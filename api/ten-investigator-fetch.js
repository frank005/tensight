/**
 * POST /api/ten-investigator-fetch
 * Body: { agentId, environment?, prefix?, suffix? }
 * 
 * Lightweight resolution step:
 * 1. Call investigator extract API
 * 2. Return the archive URL and metadata so the browser can do the long
 *    download/extraction work without a serverless timeout.
 */
const { pickAllowOrigin, applyCorsToRes, readBodyBuffer } = require('../lib/cstoolProxyCore');
const {
  getInvestigatorHost,
  buildExtractPayload,
  isAllowedDownloadHost,
} = require('../lib/tenInvestigatorCore');

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
  const extractUrl = `${host}/agents/extract?token=${encodeURIComponent(token)}`;
  const payload = buildExtractPayload(agentId, body);

  // Step 1: Call investigator extract API
  let extractResp;
  try {
    extractResp = await fetch(extractUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to contact investigator: ' + (e.message || e) }));
    return;
  }

  const extractText = await extractResp.text();
  if (!extractResp.ok) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = extractResp.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(extractText);
    return;
  }

  let extractData;
  try {
    extractData = JSON.parse(extractText);
  } catch {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid response from investigator' }));
    return;
  }

  const downloadUrl = extractData.url;
  if (!downloadUrl) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: extractData.message || 'No download URL returned' }));
    return;
  }

  // Validate download URL
  let parsedUrl;
  try {
    parsedUrl = new URL(downloadUrl);
  } catch {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid download URL' }));
    return;
  }

  if (!isAllowedDownloadHost(parsedUrl.hostname)) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Download host not allowed' }));
    return;
  }

  // Return a lightweight result so the browser can do the long fetch and
  // archive extraction without a serverless timeout.
  applyCorsToRes(res, allow, req, false);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    success: true,
    agentId,
    environment,
    downloadUrl,
    fileName: extractData.fileName || null,
    files: Array.isArray(extractData.files) ? extractData.files : undefined
  }));
};
