/**
 * /api/ten-investigator-audio
 *
 * The investigator `/agents/extract` endpoint returns a .tgz archive whose
 * name ends in `.wav` or `.pcm`, but inside it there are multiple files
 * (mixed playback, capture, per-vendor ASR input, etc.).
 *
 * Earlier versions of the reader streamed that .tgz straight to the browser
 * and saved it as `audio.wav` / `audio.pcm`, which is why opening the
 * "single file" showed several files.
 *
 * This endpoint fixes that by doing the extraction server-side:
 *
 *   POST /api/ten-investigator-audio
 *     body: { agentId, environment?, suffix: '.wav' | '.pcm' }
 *     returns: {
 *       files: [{ name, base, size, kind, label, url }, ...],
 *       primary: '<basename of the one to play inline>'
 *     }
 *
 *   GET /api/ten-investigator-audio?agentId=...&environment=...&suffix=.wav&file=<basename>
 *     streams that one file as audio/wav or audio/* (or application/octet-stream for .pcm)
 *     with a `Content-Disposition` header using the real basename.
 */

const zlib = require('zlib');
const { pickAllowOrigin, applyCorsToRes, readBodyBuffer } = require('../lib/cstoolProxyCore');
const {
  getInvestigatorHost,
  buildExtractPayload,
  isAllowedDownloadHost,
  parseTar,
  listAudioEntries,
  pickPrimaryAudioEntry,
  findTarEntryByName,
} = require('../lib/tenInvestigatorCore');

function jsonError(res, allow, req, status, msg) {
  applyCorsToRes(res, allow, req, false);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: msg }));
}

async function fetchAndExtract(token, agentId, environment, suffix) {
  const host = getInvestigatorHost(environment);
  const extractUrl = `${host}/agents/extract?token=${encodeURIComponent(token)}`;
  const payload = buildExtractPayload(agentId, { suffix });

  const extractResp = await fetch(extractUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!extractResp.ok) {
    const txt = await extractResp.text().catch(() => '');
    throw Object.assign(new Error('investigator extract ' + extractResp.status + ': ' + txt.slice(0, 200)), { status: extractResp.status });
  }

  const extractData = await extractResp.json().catch(() => ({}));
  const downloadUrl = extractData.url;
  if (!downloadUrl) {
    throw Object.assign(new Error(extractData.message || 'No download URL returned'), { status: 404 });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(downloadUrl);
  } catch (_) {
    throw Object.assign(new Error('Invalid download URL'), { status: 400 });
  }
  if (!isAllowedDownloadHost(parsedUrl.hostname)) {
    throw Object.assign(new Error('Invalid download host'), { status: 400 });
  }

  const archiveResp = await fetch(downloadUrl, { redirect: 'follow' });
  if (!archiveResp.ok) {
    throw Object.assign(new Error('Download failed: ' + archiveResp.status), { status: archiveResp.status });
  }
  const tgzBuffer = Buffer.from(await archiveResp.arrayBuffer());

  let tarBuffer;
  try {
    tarBuffer = zlib.gunzipSync(tgzBuffer);
  } catch (e) {
    // Not gzipped? Try raw tar.
    tarBuffer = tgzBuffer;
  }
  const entries = parseTar(tarBuffer);
  return entries;
}

function mimeFor(base) {
  const lower = base.toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  // PCM is raw samples; browsers can't play it without format hints.
  // Use octet-stream so it downloads cleanly.
  if (lower.endsWith('.pcm')) return 'application/octet-stream';
  return 'application/octet-stream';
}

module.exports = async (req, res) => {
  const allow = pickAllowOrigin(req);

  if (req.method === 'OPTIONS') {
    applyCorsToRes(res, allow, req, true);
    res.statusCode = 204;
    res.end();
    return;
  }

  const token = (process.env.TEN_INVESTIGATOR_TOKEN || '').trim();
  if (!token) {
    return jsonError(res, allow, req, 503, 'TEN_INVESTIGATOR_TOKEN not configured');
  }

  let agentId = '';
  let environment = 'prod';
  let suffix = '.wav';
  let file = null;
  let mode = 'list';

  if (req.method === 'GET') {
    try {
      const host = req.headers.host || 'localhost';
      const reqUrl = new URL(req.url || '/', `http://${host}`);
      agentId = (reqUrl.searchParams.get('agentId') || '').trim();
      environment = (reqUrl.searchParams.get('environment') || 'prod').trim() || 'prod';
      suffix = (reqUrl.searchParams.get('suffix') || '.wav').trim() || '.wav';
      file = reqUrl.searchParams.get('file');
      mode = file ? 'stream' : 'list';
    } catch (e) {
      return jsonError(res, allow, req, 400, 'bad query');
    }
  } else if (req.method === 'POST') {
    try {
      const buf = await readBodyBuffer(req);
      const body = buf && buf.length ? JSON.parse(buf.toString('utf8')) : {};
      agentId = body.agentId ? String(body.agentId).trim() : '';
      environment = body.environment || 'prod';
      suffix = body.suffix || '.wav';
      file = body.file || null;
      mode = file ? 'stream' : 'list';
    } catch {
      return jsonError(res, allow, req, 400, 'invalid JSON');
    }
  } else {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 405;
    res.end('GET or POST only');
    return;
  }

  if (!agentId) {
    return jsonError(res, allow, req, 400, 'missing agentId');
  }
  if (suffix !== '.wav' && suffix !== '.pcm') {
    return jsonError(res, allow, req, 400, 'suffix must be .wav or .pcm');
  }

  let entries;
  try {
    entries = await fetchAndExtract(token, agentId, environment, suffix);
  } catch (e) {
    return jsonError(res, allow, req, e.status || 502, e.message || String(e));
  }

  const audioList = listAudioEntries(entries);
  if (!audioList.length) {
    return jsonError(res, allow, req, 404, 'No ' + suffix + ' files found in archive');
  }

  if (mode === 'stream') {
    const match = findTarEntryByName(entries, file);
    if (!match) {
      return jsonError(res, allow, req, 404, 'file not found in archive: ' + file);
    }
    const base = match.name.replace(/^.*\//, '');
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 200;
    res.setHeader('Content-Type', mimeFor(base));
    res.setHeader('Content-Length', match.data.length);
    res.setHeader('Content-Disposition', 'attachment; filename="' + base.replace(/"/g, '') + '"');
    res.setHeader('Accept-Ranges', 'none');
    res.end(match.data);
    return;
  }

  // List mode: build per-file stream URLs pointing back to this same endpoint.
  const protoHeader = req.headers['x-forwarded-proto'] || (req.connection && req.connection.encrypted ? 'https' : 'http');
  const host = req.headers.host || 'localhost';
  const base = `${protoHeader}://${host}/api/ten-investigator-audio`;
  const files = audioList.map((f) => ({
    name: f.base,
    size: f.size,
    kind: f.kind,
    label: f.label,
    url:
      `${base}?agentId=${encodeURIComponent(agentId)}` +
      `&environment=${encodeURIComponent(environment)}` +
      `&suffix=${encodeURIComponent(suffix)}` +
      `&file=${encodeURIComponent(f.base)}`,
  }));
  const primary = pickPrimaryAudioEntry(entries, suffix);

  applyCorsToRes(res, allow, req, false);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    suffix,
    files,
    primary: primary ? primary.base.replace(/^.*\//, '') : (files[0] ? files[0].name : null),
  }));
};
