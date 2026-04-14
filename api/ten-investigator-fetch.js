/**
 * POST /api/ten-investigator-fetch
 * Body: { agentId, environment?, prefix?, suffix? }
 * 
 * Full server-side pipeline:
 * 1. Call investigator extract API
 * 2. Download the .tgz
 * 3. Extract ten.err
 * 4. Redact sensitive keys
 * 5. Return redacted log text
 */
const { pickAllowOrigin, applyCorsToRes, readBodyBuffer } = require('../lib/cstoolProxyCore');
const { getInvestigatorHost, buildExtractPayload, isAllowedDownloadHost } = require('../lib/tenInvestigatorCore');
const { redactLog } = require('../lib/logRedaction');
const zlib = require('zlib');

function parseTar(buffer) {
  const entries = [];
  let offset = 0;
  const buf = Buffer.from(buffer);
  
  while (offset < buf.length - 512) {
    const header = buf.slice(offset, offset + 512);
    if (header[0] === 0) break;
    
    const name = header.slice(0, 100).toString('utf8').replace(/\0+$/, '');
    const sizeOctal = header.slice(124, 136).toString('utf8').replace(/\0+$/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    
    offset += 512;
    
    if (size > 0 && name) {
      const data = buf.slice(offset, offset + size);
      entries.push({ name, data });
    }
    
    offset += Math.ceil(size / 512) * 512;
  }
  
  return entries;
}

function pickErrEntry(entries) {
  if (!entries || !entries.length) return null;
  const candidates = entries.filter(e => {
    const n = (e.name || '').toLowerCase();
    return /\.err$/i.test(n) || n.includes('ten.err');
  });
  if (candidates.length) {
    candidates.sort((a, b) => b.data.length - a.data.length);
    return candidates[0];
  }
  if (entries.length) {
    entries.sort((a, b) => b.data.length - a.data.length);
    return entries[0];
  }
  return null;
}

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

  // Step 2: Download the .tgz
  let downloadResp;
  try {
    downloadResp = await fetch(downloadUrl, { redirect: 'follow' });
  } catch (e) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to download archive: ' + (e.message || e) }));
    return;
  }

  if (!downloadResp.ok) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = downloadResp.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Download failed: ' + downloadResp.status }));
    return;
  }

  const tgzBuffer = Buffer.from(await downloadResp.arrayBuffer());

  // Step 3: Extract .tgz (gunzip then parse tar)
  let tarBuffer;
  try {
    tarBuffer = zlib.gunzipSync(tgzBuffer);
  } catch (e) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to decompress archive: ' + (e.message || e) }));
    return;
  }

  const entries = parseTar(tarBuffer);
  const errEntry = pickErrEntry(entries);

  if (!errEntry) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'No .err file found in archive', files: entries.map(e => e.name) }));
    return;
  }

  // Step 4: Redact sensitive keys
  const rawText = errEntry.data.toString('utf8');
  const redactedText = redactLog(rawText);

  // Step 5: Return redacted log
  applyCorsToRes(res, allow, req, false);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    success: true,
    fileName: errEntry.name,
    text: redactedText
  }));
};
