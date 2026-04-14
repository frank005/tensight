/**
 * Server-side log redaction to remove sensitive API keys and tokens.
 */

const REDACT_PLACEHOLDER = '[REDACTED]';

const PATTERNS = [
  // ===== Provider-specific key patterns =====
  
  // OpenAI keys: sk-proj-..., sk-... (but not sk-api- which is Minimax)
  { regex: /sk-proj-[a-zA-Z0-9_-]{20,}/g, name: 'openai_key' },
  { regex: /\bsk-[a-zA-Z0-9_-]{40,}\b/g, name: 'openai_key_long' },
  
  // Minimax keys: sk-api-...
  { regex: /sk-api-[a-zA-Z0-9_-]{20,}/g, name: 'minimax_key' },
  
  // Anthropic Claude keys: sk-ant-api03-...
  { regex: /sk-ant-[a-zA-Z0-9_-]{20,}/g, name: 'anthropic_key' },
  
  // Groq keys: gsk_...
  { regex: /gsk_[a-zA-Z0-9]{20,}/g, name: 'groq_key' },
  
  // Google/Gemini keys: AIza...
  { regex: /AIza[A-Za-z0-9_-]{35}/g, name: 'google_key' },
  
  // Deepgram keys: dg.xxx... (hex)
  { regex: /dg\.[a-zA-Z0-9]{7,}/g, name: 'deepgram_key' },
  
  // AWS access keys: AKIA..., ASIA... (for Bedrock, Transcribe, Polly)
  { regex: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, name: 'aws_access_key' },
  
  // Agora tokens: 007eJx... (base64-ish, 50+ chars)
  { regex: /007eJx[a-zA-Z0-9+/=]{40,}/g, name: 'agora_token' },
  
  // ===== Generic JSON field patterns =====
  
  // Double-quoted: "api_key": "...", "key": "...", etc
  { regex: /"(api_key|apikey|api-key|key|secret|secret_key|secretkey|password|access_key|accesskey)"\s*:\s*"([^"]{8,})"/gi, replace: '"$1": "' + REDACT_PLACEHOLDER + '"' },
  
  // Single-quoted: 'api_key': '...'
  { regex: /'(api_key|apikey|api-key|key|secret|secret_key|secretkey|password|access_key|accesskey)'\s*:\s*'([^']{8,})'/gi, replace: "'$1': '" + REDACT_PLACEHOLDER + "'" },
  
  // ===== Header patterns =====
  
  // Authorization: Bearer ...
  { regex: /'Authorization'\s*:\s*'Bearer\s+[^']+'/gi, replace: "'Authorization': 'Bearer " + REDACT_PLACEHOLDER + "'" },
  { regex: /"Authorization"\s*:\s*"Bearer\s+[^"]+"/gi, replace: '"Authorization": "Bearer ' + REDACT_PLACEHOLDER + '"' },
  
  // X-Api-Key header (ElevenLabs, HeyGen, etc)
  { regex: /'[Xx]-[Aa]pi-[Kk]ey'\s*:\s*'([^']{8,})'/gi, replace: "'X-Api-Key': '" + REDACT_PLACEHOLDER + "'" },
  { regex: /"[Xx]-[Aa]pi-[Kk]ey"\s*:\s*"([^"]{8,})"/gi, replace: '"X-Api-Key": "' + REDACT_PLACEHOLDER + '"' },
  
  // xi-api-key header (ElevenLabs)
  { regex: /'xi-api-key'\s*:\s*'([^']{8,})'/gi, replace: "'xi-api-key': '" + REDACT_PLACEHOLDER + "'" },
  { regex: /"xi-api-key"\s*:\s*"([^"]{8,})"/gi, replace: '"xi-api-key": "' + REDACT_PLACEHOLDER + '"' },
  
  // ===== Token patterns =====
  
  // Generic long tokens in JSON (50+ chars, base64-ish)
  { regex: /"token"\s*:\s*"([a-zA-Z0-9+/=_-]{50,})"/gi, replace: '"token": "' + REDACT_PLACEHOLDER + '"' },
  { regex: /'token'\s*:\s*'([a-zA-Z0-9+/=_-]{50,})'/gi, replace: "'token': '" + REDACT_PLACEHOLDER + "'" },
  
  // Deepgram-style hex keys in "key" field (32+ hex chars)
  { regex: /"key"\s*:\s*"([a-f0-9]{32,})"/gi, replace: '"key": "' + REDACT_PLACEHOLDER + '"' },
  
  // HeyGen/generic base64 keys in "api_key" field (30+ chars)
  { regex: /"api_key"\s*:\s*"([A-Za-z0-9+/=]{30,})"/gi, replace: '"api_key": "' + REDACT_PLACEHOLDER + '"' },
  
  // AWS secret access keys (40 char base64-like)
  { regex: /"(secret_access_key|aws_secret_access_key|secretAccessKey)"\s*:\s*"([A-Za-z0-9+/]{40})"/gi, replace: '"$1": "' + REDACT_PLACEHOLDER + '"' },
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
