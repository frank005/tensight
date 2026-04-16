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

/**
 * Minimal tar (USTAR/POSIX) parser — enough for the investigator archives,
 * which only contain regular files with short names and no PAX extensions.
 */
function parseTar(buffer) {
  const entries = [];
  const buf = Buffer.from(buffer);
  let offset = 0;

  while (offset < buf.length - 512) {
    const header = buf.slice(offset, offset + 512);
    if (header[0] === 0) break;

    const name = header.slice(0, 100).toString('utf8').replace(/\0+$/, '');
    const sizeOctal = header.slice(124, 136).toString('utf8').replace(/\0+$/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeFlag = String.fromCharCode(header[156] || 0x30);

    offset += 512;

    // typeFlag '0' or '\0' = regular file; we only care about those.
    if (size > 0 && name && (typeFlag === '0' || typeFlag === '\0')) {
      entries.push({ name, data: buf.slice(offset, offset + size) });
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return entries;
}

function pickErrEntry(entries) {
  if (!entries || !entries.length) return null;
  const candidates = entries.filter((e) => {
    const n = (e.name || '').toLowerCase();
    return /\.err$/i.test(n) || n.includes('ten.err');
  });
  if (candidates.length) {
    candidates.sort((a, b) => b.data.length - a.data.length);
    return candidates[0];
  }
  const sorted = entries.slice().sort((a, b) => b.data.length - a.data.length);
  return sorted[0] || null;
}

/**
 * Classify an audio-file basename from a ten.audio dump archive.
 *
 * Observed names in current archives:
 *   audio_dump_playback_before_mixed_0_YYYY_MM_DD_HHMMSS_1.wav  ← final mixed call audio
 *   audio_dump_pro_send_proe_0.wav                              ← raw pre-processed capture
 *   audio_rtc_1.pcm                                              ← raw RTC downstream PCM
 *   audio_tts.pcm                                                ← TTS-only output
 *   audio_vad.pcm                                                ← VAD-processed input
 *   agora_asr_in.pcm / deepgram_asr_in.pcm                       ← per-vendor ASR input
 *   audio_agora_audio3a_downstream.pcm                           ← audio3a processed
 *   se_denoise_4ch.pcm                                           ← 4-channel denoise debug
 *
 * We tag each with a `kind` so the UI can:
 *   - default to the "mixed" stream for the single playable download
 *   - still expose every other file for debugging.
 */
function classifyAudioName(name) {
  const base = name.replace(/^.*\//, '');
  const lower = base.toLowerCase();
  if (!/\.(wav|pcm)$/i.test(lower)) return null;

  // WAVs
  if (lower.includes('playback_before_mixed')) {
    return { kind: 'mixed', label: 'Mixed call audio (playback)', priority: 1 };
  }
  if (lower.includes('pro_send_proe') || lower.includes('pro_send_proc')) {
    return { kind: 'capture', label: 'Pre-send capture', priority: 2 };
  }

  // PCMs
  if (/^audio_rtc(_\d+)?\.pcm$/i.test(base)) {
    return { kind: 'rtc', label: 'RTC downstream PCM', priority: 1 };
  }
  if (/^audio_tts\.pcm$/i.test(base)) {
    return { kind: 'tts', label: 'TTS output PCM', priority: 2 };
  }
  if (/^audio_vad\.pcm$/i.test(base)) {
    return { kind: 'vad', label: 'VAD input PCM', priority: 3 };
  }
  if (/_asr_in\.pcm$/i.test(base)) {
    return { kind: 'asr', label: 'ASR input PCM', priority: 3 };
  }
  if (/audio3a/i.test(base)) {
    return { kind: 'audio3a', label: 'Audio3A processed PCM', priority: 4 };
  }
  if (/se_denoise/i.test(base)) {
    return { kind: 'denoise', label: 'Denoise debug PCM', priority: 5 };
  }
  return { kind: 'other', label: base, priority: 9 };
}

function listAudioEntries(entries) {
  if (!entries || !entries.length) return [];
  const out = [];
  for (const e of entries) {
    const info = classifyAudioName(e.name);
    if (!info) continue;
    out.push({
      name: e.name,
      base: e.name.replace(/^.*\//, ''),
      size: e.data.length,
      kind: info.kind,
      label: info.label,
      priority: info.priority,
    });
  }
  out.sort((a, b) => a.priority - b.priority || a.base.localeCompare(b.base));
  return out;
}

/**
 * Pick the "best" audio entry to play inline for a given suffix.
 * WAV → mixed playback; PCM → RTC downstream.
 */
function pickPrimaryAudioEntry(entries, suffix) {
  const list = listAudioEntries(entries);
  if (!list.length) return null;
  const want = (suffix || '').toLowerCase().replace(/^\./, '');
  const filtered = want ? list.filter((e) => e.base.toLowerCase().endsWith('.' + want)) : list;
  if (!filtered.length) return list[0];
  return filtered[0];
}

/**
 * Build a ZIP archive from `[{ name, data }]` using STORE (no compression).
 *
 * Audio PCM/WAV buffers don't compress meaningfully, so skipping DEFLATE keeps
 * us dependency-free and still produces a standard ZIP that every OS / tool
 * can open. Format reference: APPNOTE 4.5 (PKZIP).
 *
 * We emit one local file header + data + central directory entry per file,
 * then the end-of-central-directory record. Only ASCII filenames are used
 * (tar entry basenames from the investigator archive); no ZIP64 support.
 */
function buildStoreZip(files) {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(String(f.name || 'file'), 'utf8');
    const data = f.data instanceof Buffer ? f.data : Buffer.from(f.data || []);
    const crc = crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);          // local file header signature
    local.writeUInt16LE(20, 4);                  // version needed to extract (2.0)
    local.writeUInt16LE(0, 6);                   // general purpose bit flag
    local.writeUInt16LE(0, 8);                   // compression method = store
    local.writeUInt16LE(0, 10);                  // last mod file time
    local.writeUInt16LE(0x21, 12);               // last mod file date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);               // compressed size
    local.writeUInt32LE(size, 22);               // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);                  // extra field length
    nameBuf.copy(local, 30);

    parts.push(local, data);

    const centralEntry = Buffer.alloc(46 + nameBuf.length);
    centralEntry.writeUInt32LE(0x02014b50, 0);   // central dir signature
    centralEntry.writeUInt16LE(0x031e, 4);       // version made by (3.0, unix)
    centralEntry.writeUInt16LE(20, 6);           // version needed to extract
    centralEntry.writeUInt16LE(0, 8);            // flags
    centralEntry.writeUInt16LE(0, 10);           // method
    centralEntry.writeUInt16LE(0, 12);           // mtime
    centralEntry.writeUInt16LE(0x21, 14);        // mdate
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(size, 20);
    centralEntry.writeUInt32LE(size, 24);
    centralEntry.writeUInt16LE(nameBuf.length, 28);
    centralEntry.writeUInt16LE(0, 30);           // extra len
    centralEntry.writeUInt16LE(0, 32);           // comment len
    centralEntry.writeUInt16LE(0, 34);           // disk number
    centralEntry.writeUInt16LE(0, 36);           // internal attrs
    centralEntry.writeUInt32LE(0, 38);           // external attrs
    centralEntry.writeUInt32LE(offset, 42);      // local header offset
    nameBuf.copy(centralEntry, 46);
    central.push(centralEntry);

    offset += local.length + size;
  }

  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const centralOffset = offset;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);              // end of central dir signature
  end.writeUInt16LE(0, 4);                       // disk number
  end.writeUInt16LE(0, 6);                       // disk with central
  end.writeUInt16LE(files.length, 8);            // entries on this disk
  end.writeUInt16LE(files.length, 10);           // total entries
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);                      // comment length

  return Buffer.concat([...parts, ...central, end]);
}

function findTarEntryByName(entries, wantedName) {
  if (!entries || !entries.length || !wantedName) return null;
  const target = String(wantedName).replace(/^.*\//, '').toLowerCase();
  for (const e of entries) {
    const base = (e.name || '').replace(/^.*\//, '').toLowerCase();
    if (base === target) return e;
  }
  // fallback: match full path
  for (const e of entries) {
    if ((e.name || '').toLowerCase() === String(wantedName).toLowerCase()) return e;
  }
  return null;
}

module.exports = {
  INVESTIGATOR_HOSTS,
  DEFAULT_LOG_PREFIX,
  getInvestigatorHost,
  buildExtractPayload,
  isAllowedDownloadHost,
  parseTar,
  pickErrEntry,
  classifyAudioName,
  listAudioEntries,
  pickPrimaryAudioEntry,
  findTarEntryByName,
  buildStoreZip,
};
