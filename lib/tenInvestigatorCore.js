/**
 * TEN Investigator API — cloud log extract (same as ten-investigator.py -from cloud).
 * Token-based auth, no CSTool cookie needed.
 */

const INVESTIGATOR_HOSTS = {
  staging: 'http://ten-investigator-staging.bj2.agoralab.co',
  prod: 'http://ten-investigator-prod.sh3.agoralab.co'
};

const DEFAULT_LOG_PREFIX = 'ten.err';

function getInvestigatorHost(environment) {
  const env = String(environment || 'prod').toLowerCase();
  return INVESTIGATOR_HOSTS[env] || INVESTIGATOR_HOSTS.prod;
}

function buildExtractPayload(agentId, opts) {
  const payload = { agentId };
  if (opts && opts.prefix) payload.prefix = String(opts.prefix);
  if (opts && opts.suffix) payload.suffix = String(opts.suffix);
  if (opts && opts.file) payload.file = String(opts.file);
  if (!payload.prefix && !payload.suffix && !payload.file) {
    payload.prefix = DEFAULT_LOG_PREFIX;
  }
  return payload;
}

function isAllowedDownloadHost(hostname) {
  const h = hostname.toLowerCase();
  return (
    h.endsWith('.aliyuncs.com') ||
    h.endsWith('.aliyun.com') ||
    h.endsWith('.agoralab.co')
  );
}

module.exports = {
  INVESTIGATOR_HOSTS,
  DEFAULT_LOG_PREFIX,
  getInvestigatorHost,
  buildExtractPayload,
  isAllowedDownloadHost
};
