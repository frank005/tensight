/**
 * Probe endpoint: reader uses this to detect proxy capabilities.
 */
module.exports = (req, res) => {
  const hasInvestigator = !!(process.env.TEN_INVESTIGATOR_TOKEN || '').trim();
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ cstoolProxy: true, investigator: hasInvestigator, runtime: 'vercel' }));
};
