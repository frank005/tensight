/**
 * Server-side log redaction to remove sensitive API keys and tokens.
 */

const REDACT_PLACEHOLDER = '[REDACTED]';

const PATTERNS = [
  // OpenAI API keys: sk-proj-..., sk-api-..., sk-...
  { regex: /sk-(?:proj|api|)[a-zA-Z0-9_-]{20,}/g, name: 'openai_key' },
  
  // Generic API keys in JSON: "api_key": "...", "key": "...", etc
  { regex: /"(api_key|apikey|api-key|key|secret|secret_key|secretkey|password)"\s*:\s*"([^"]{8,})"/gi, replace: '"$1": "' + REDACT_PLACEHOLDER + '"' },
  
  // Single-quoted variants: 'api_key': '...'
  { regex: /'(api_key|apikey|api-key|key|secret|secret_key|secretkey|password)'\s*:\s*'([^']{8,})'/gi, replace: "'$1': '" + REDACT_PLACEHOLDER + "'" },
  
  // Authorization headers: 'Authorization': 'Bearer ...'
  { regex: /'Authorization'\s*:\s*'Bearer\s+[^']+'/gi, replace: "'Authorization': 'Bearer " + REDACT_PLACEHOLDER + "'" },
  { regex: /"Authorization"\s*:\s*"Bearer\s+[^"]+"/gi, replace: '"Authorization": "Bearer ' + REDACT_PLACEHOLDER + '"' },
  
  // Agora tokens: 007eJx... (base64-ish, 50+ chars)
  { regex: /007eJx[a-zA-Z0-9+/=]{40,}/g, name: 'agora_token' },
  
  // Generic long base64 that look like tokens (64+ chars, in quotes)
  { regex: /"token"\s*:\s*"([a-zA-Z0-9+/=_-]{50,})"/gi, replace: '"token": "' + REDACT_PLACEHOLDER + '"' },
  { regex: /'token'\s*:\s*'([a-zA-Z0-9+/=_-]{50,})'/gi, replace: "'token': '" + REDACT_PLACEHOLDER + "'" },
  
  // Deepgram-style hex keys (32+ hex chars)
  { regex: /"key"\s*:\s*"([a-f0-9]{32,})"/gi, replace: '"key": "' + REDACT_PLACEHOLDER + '"' },
  
  // HeyGen base64 keys
  { regex: /"api_key"\s*:\s*"([A-Za-z0-9+/=]{30,})"/gi, replace: '"api_key": "' + REDACT_PLACEHOLDER + '"' },
  
  // Minimax keys: sk-api-...
  { regex: /sk-api-[a-zA-Z0-9_-]{20,}/g, name: 'minimax_key' },
];

function redactLog(text) {
  if (!text || typeof text !== 'string') return text;
  
  let result = text;
  
  for (const pattern of PATTERNS) {
    if (pattern.replace) {
      result = result.replace(pattern.regex, pattern.replace);
    } else {
      result = result.replace(pattern.regex, REDACT_PLACEHOLDER);
    }
  }
  
  return result;
}

module.exports = { redactLog, REDACT_PLACEHOLDER };
