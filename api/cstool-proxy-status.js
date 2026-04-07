/**
 * Probe endpoint: reader uses this to detect same-origin CSTool proxy on Vercel.
 */
module.exports = (req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ cstoolProxy: true, runtime: 'vercel' }));
};
