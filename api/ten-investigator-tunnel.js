/**
 * GET /api/ten-investigator-tunnel?u=<url>
 * Proxies download URLs from investigator (OSS/agoralab) to bypass CORS.
 */
const { pickAllowOrigin, applyCorsToRes } = require('../lib/cstoolProxyCore');
const { isAllowedDownloadHost } = require('../lib/tenInvestigatorCore');

module.exports = async (req, res) => {
  const allow = pickAllowOrigin(req);

  if (req.method === 'OPTIONS') {
    applyCorsToRes(res, allow, req, true);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 405;
    res.end('GET only');
    return;
  }

  let parsed;
  try {
    const host = req.headers.host || 'localhost';
    const reqUrl = new URL(req.url || '/', `http://${host}`);
    const u = reqUrl.searchParams.get('u');
    if (!u) throw new Error('missing u');
    parsed = new URL(u);
  } catch (e) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 400;
    res.end(e.message || 'bad url');
    return;
  }

  if (!isAllowedDownloadHost(parsed.hostname)) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 403;
    res.end('forbidden host');
    return;
  }

  let r;
  try {
    r = await fetch(parsed.toString(), { redirect: 'follow' });
  } catch (e) {
    applyCorsToRes(res, allow, req, false);
    res.statusCode = 502;
    res.end(String(e.message || e));
    return;
  }

  const buf = Buffer.from(await r.arrayBuffer());
  applyCorsToRes(res, allow, req, false);
  res.statusCode = r.status;
  res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
};
