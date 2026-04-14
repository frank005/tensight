/**
 * Probe endpoint: reader uses this to detect proxy capabilities.
 */
module.exports = (req, res) => {
  const token = (process.env.TEN_INVESTIGATOR_TOKEN || '').trim();
  const hasInvestigator = !!token;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  // Show token length and first/last chars for debugging (not the full token)
  const tokenDebug = token ? `${token.length}:${token.slice(0,4)}...${token.slice(-4)}` : 'none';
  res.end(JSON.stringify({ cstoolProxy: true, investigator: hasInvestigator, runtime: 'vercel', tokenDebug }));
};
