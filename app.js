    (function () {
      const LEVEL_MAP = { I: 'Info', D: 'Debug', W: 'Warn', E: 'Error' };
      // Standard log line timestamp (RFC3339 / ISO-ish) e.g. "2026-03-02T09:38:18.087...+00:00 140(172) I ...".
      // Some logs emit "M" which we treat as Info later.
      const RFC_LINE = /^(\d{4}-\d{2}-\d{2}T[\d.:+TZ-]+)\s+(\d+)\((\d+)\)\s+([IDWEM])\s+(.*)$/;
      // Alternate timestamp (seen in some STT logs): "03-12 16:48:50.216 82569(82659) D ...".
      const ALT_RFC_LINE = /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(\d+)\((\d+)\)\s+([IDWEM])\s+(.*)$/;
      // Time part allows HH:MM:SS(.fraction) or legacy HH.MM(.fraction) forms.
      const APP_VERSION_LINE = /^(\d{4}\/\d{2}\/\d{2}\s+[\d:.]+)\s+app_version:\s*([^,]+),\s*commit:\s*([^,\s]+),\s*build_time:\s*(.+)$/;
      const TAB_LINE = /^(\d{4}-\d{2}-\d{2}T[^\t]+)\t(\w+)\t(.+)$/;
      const EXTENSION_TAG = /\[([^\]]+)\]/g;

      /** GitHub Pages (*.github.io): keep UI file-only; CSTool fetch lives on Vercel/other hosts. */
      function isGitHubPagesHost() {
        try {
          const h = (window.location && window.location.hostname) || '';
          return /\.github\.io$/i.test(h);
        } catch (e) {
          return false;
        }
      }

      function trackUsageEvent(eventName, meta) {
        try {
          if (!window.location || window.location.protocol === 'file:') return;
          const payload = {
            event: eventName || 'page_view',
            client: {
              path: window.location.pathname + window.location.search,
              pageTitle: document.title || '',
              referrer: document.referrer || '',
              language: navigator.language || '',
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
              screen: window.screen ? [window.screen.width, window.screen.height].join('x') : '',
              visibility: document.visibilityState || ''
            },
            meta: meta || {}
          };
          const body = JSON.stringify(payload);
          const url = '/api/skyline-notes';
          if (navigator.sendBeacon) {
            const blob = new Blob([body], { type: 'application/json' });
            if (navigator.sendBeacon(url, blob)) return;
          }
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body,
            credentials: 'same-origin',
            keepalive: true
          }).catch(function () {});
        } catch (e) {}
      }

      setTimeout(function () {
        trackUsageEvent('page_view');
      }, 0);

      try {
        if (isGitHubPagesHost() && document.body) {
          document.body.classList.add('tenlr-host-github-pages');
        }
      } catch (e) {}

      function extractExtension(msg) {
        const m = msg.match(/\[([^\]]+)\]/);
        if (!m) return null;
        const ext = (m[1] || '').trim();
        // Guard against bracketed JSON/blob payloads accidentally becoming "extensions".
        if (!ext || ext.length > 64) return null;
        if (/[{}"\\]/.test(ext)) return null;
        if (!/^[A-Za-z0-9_:.@/\-]+$/.test(ext)) return null;
        return ext;
      }

      /** Parse log timestamp to ms (for comparison). Handles RFC3339 with nanos and YYYY/MM/DD H:mm:ss.xxx */
      function parseLogTs(ts) {
        if (!ts || typeof ts !== 'string') return NaN;
        const s = ts.trim();
        if (!s) return NaN;
        if (s.match(/^\d{4}-\d{2}-\d{2}T[\d:.]+/)) {
          const tz = s.indexOf('+') >= 0 ? s.slice(s.indexOf('+')) : 'Z';
          const iso = s.slice(0, 19) + (s.charAt(19) === '.' ? s.slice(19, 23) : '') + tz;
          return new Date(iso).getTime();
        }
        if (s.match(/^\d{4}\/\d{2}\/\d{2}\s+\d/)) {
          const repl = s.replace(/^(\d{4})\/(\d{2})\/(\d{2})\s+([\d.:]+)/, '$1-$2-$3T$4');
          return new Date(repl).getTime();
        }
        if (s.match(/^\d{4}-\d{2}-\d{2}\s+\d/)) {
          const repl = s.replace(/^(\d{4}-\d{2}-\d{2})\s+([\d.:]+)/, '$1T$2');
          return new Date(repl).getTime();
        }
        return new Date(s).getTime();
      }

      /** Find log entry index whose ts is closest to the given timestamp string. Returns -1 if no entries or ts invalid. */
      function findLogIndexByTs(ts) {
        if (!state.entries || !state.entries.length) return -1;
        const t = parseLogTs(ts);
        if (isNaN(t)) return -1;
        let bestIdx = 0;
        let bestDiff = Math.abs(parseLogTs(state.entries[0].ts) - t);
        for (let i = 1; i < state.entries.length; i++) {
          const diff = Math.abs(parseLogTs(state.entries[i].ts) - t);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = i;
          }
        }
        return bestIdx;
      }

      function entryMatchesInsightSource(entry, source) {
        const src = source != null ? String(source).trim().toLowerCase() : '';
        if (!src) return true;
        const ext = entry && entry.ext != null ? String(entry.ext).trim().toLowerCase() : '';
        const msg = entry && entry.msg != null ? String(entry.msg).toLowerCase() : '';
        if (src === 'llm') return ext === 'llm' || msg.indexOf('[llm]') !== -1;
        if (src === 'asr') return ext === 'asr' || ext === 'agora_stream_asr' || msg.indexOf('[asr]') !== -1;
        if (src === 'tts') return ext === 'tts' || msg.indexOf('[tts]') !== -1;
        if (src === 'mllm') return ext === 'v2v' || msg.indexOf('[v2v]') !== -1 || msg.indexOf('"source":"mllm"') !== -1 || msg.indexOf("'source': 'mllm'") !== -1;
        if (src === 'command') return msg.indexOf('[command]') !== -1;
        if (src === 'greeting') return msg.indexOf('greeting') !== -1;
        return ext === src || msg.indexOf('[' + src + ']') !== -1;
      }

      function findLogIndexByTsAndSource(ts, source) {
        if (!state.entries || !state.entries.length) return -1;
        const t = parseLogTs(ts);
        if (isNaN(t)) return -1;
        let bestIdx = -1;
        let bestDiff = Infinity;
        for (let i = 0; i < state.entries.length; i++) {
          const entry = state.entries[i];
          if (!entryMatchesInsightSource(entry, source)) continue;
          const diff = Math.abs(parseLogTs(entry.ts) - t);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = i;
          }
        }
        if (bestIdx >= 0) return bestIdx;
        return findLogIndexByTs(ts);
      }

      /** Parse user date/time input (e.g. "1/1/1 9:01:01" or "2026-03-06 16:08:34") to ms */
      function parseUserDateTime(str) {
        if (!str || typeof str !== 'string') return NaN;
        const s = str.trim();
        if (!s) return NaN;
        const d = new Date(s);
        return isNaN(d.getTime()) ? NaN : d.getTime();
      }

      function formatEpochMsAsLogTs(ms) {
        const n = typeof ms === 'number' ? ms : Number(ms);
        if (!isFinite(n)) return '';
        return new Date(n).toISOString().replace('Z', '+00:00');
      }

      function median(arr) {
        const nums = arr.filter(function (x) { return x != null && !isNaN(x); }).sort(function (a, b) { return a - b; });
        if (!nums.length) return null;
        const m = (nums.length - 1) / 2;
        return (nums[Math.floor(m)] + nums[Math.ceil(m)]) / 2;
      }

      function tryParseJSON(str) {
        if (!str || typeof str !== 'string') return null;
        // Try every `{` and `[` as a candidate JSON start. Log messages often
        // embed prefix brackets like `[preload_extension_go]` before the real
        // JSON payload, so picking the first bracket blindly misparses them.
        // We attempt the earliest candidate first and fall through to later
        // ones if it doesn't yield valid JSON. This also handles messages like
        // `event start {'taskInfo': {...}}` that mix Python dict + JSON.
        const candidates = [];
        for (let i = 0; i < str.length; i++) {
          const c = str[i];
          if (c === '{' || c === '[') candidates.push(i);
        }
        for (const start of candidates) {
          const open = str[start];
          const close = open === '[' ? ']' : '}';
          let depth = 0, end = -1, inStr = false, esc = false;
          for (let i = start; i < str.length; i++) {
            const ch = str[i];
            if (inStr) {
              if (esc) esc = false;
              else if (ch === '\\') esc = true;
              else if (ch === '"') inStr = false;
              continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === open) depth++;
            else if (ch === close) { depth--; if (depth === 0) { end = i + 1; break; } }
          }
          if (end === -1) continue;
          try { return JSON.parse(str.slice(start, end)); } catch (_) { /* try next candidate */ }
        }
        return null;
      }

      /** Parse Python dict literal (e.g. "event start {'taskInfo': {...}}") into a JS object. */
      function tryParsePythonDict(str) {
        if (!str || typeof str !== 'string') return null;
        const start = str.indexOf('{');
        if (start === -1) return null;
        let depth = 0;
        let end = -1;
        for (let i = start; i < str.length; i++) {
          if (str[i] === '{') depth++;
          else if (str[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        if (end === -1) return null;
        let s = str.slice(start, end);
        s = s.replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
        s = s.replace(/\\'/g, '\u0001').replace(/'/g, '"').replace(/\u0001/g, '\\"');
        try {
          return JSON.parse(s);
        } catch (_) {
          return null;
        }
      }

      function parseIpcSlaveStartPayload(msg) {
        if (!msg || typeof msg !== 'string' || !msg.includes('ipc_slave_start')) return null;
        const out = { header: null, payload: null, eventPayload: null };
        const headerIdx = msg.indexOf('header:');
        const payloadIdx = msg.indexOf(', payload:');
        if (headerIdx !== -1 && payloadIdx !== -1 && payloadIdx > headerIdx) {
          const headerText = msg.slice(headerIdx + 'header:'.length, payloadIdx).trim();
          const payloadText = msg.slice(payloadIdx + ', payload:'.length).trim();
          out.header = tryParseJSON(headerText);
          out.payload = tryParseJSON(payloadText);
        } else {
          // Fallback when formatting changes.
          const maybe = tryParseJSON(msg);
          if (maybe && typeof maybe === 'object') {
            out.payload = maybe.payload || null;
            out.header = maybe.header || null;
          }
        }
        const payloadObj = out.payload && typeof out.payload === 'object' ? out.payload : null;
        const payloadStr = payloadObj && typeof payloadObj.slaveServiceEventPayload === 'string'
          ? payloadObj.slaveServiceEventPayload
          : null;
        if (payloadStr) {
          try { out.eventPayload = JSON.parse(payloadStr); } catch (_) {}
        }
        return out;
      }

      function parseVendorPresets(raw) {
        if (!raw) return [];
        let arr = null;
        if (Array.isArray(raw)) arr = raw;
        else if (typeof raw === 'string') {
          try { arr = JSON.parse(raw); } catch (_) { arr = null; }
        }
        if (!Array.isArray(arr)) return [];
        const out = [];
        for (const item of arr) {
          if (!item || typeof item !== 'object') continue;
          const key = Object.keys(item)[0];
          if (!key) continue;
          const cfg = item[key] && typeof item[key] === 'object' ? item[key] : {};
          out.push({
            preset: String(key),
            applyMode: cfg.apply_mode != null ? String(cfg.apply_mode) : null,
            enabled: cfg.enable === true
          });
        }
        return out;
      }

      function inferProviderSourceBySignals(infoObj, kind, providerObj, presets) {
        const info = infoObj && typeof infoObj === 'object' ? infoObj : {};
        const p = providerObj && typeof providerObj === 'object' ? providerObj : {};
        const upper = String(kind || '').toUpperCase();
        const src = p.credential_source || p.key_source || p.source || info[upper + '_KEY_SOURCE'] || info[upper + '_SOURCE'] || null;
        if (src != null && String(src).trim() !== '') return String(src);

        const vendor = (p.vendor || p.vendor_name || info[upper + '_VENDOR'] || '').toString().toLowerCase();
        if (vendor && Array.isArray(presets) && presets.some(function (x) {
          const name = (x && x.preset ? String(x.preset) : '').toLowerCase();
          return name.indexOf(vendor) !== -1;
        })) {
          return 'agora_managed';
        }
        return null;
      }

      function inferConvoAiJoinSchemaFromBody(body) {
        const p = body && body.properties && typeof body.properties === 'object' ? body.properties : {};
        const td = p.turn_detection && typeof p.turn_detection === 'object' ? p.turn_detection : null;
        if (!td) return null;
        const hasCurrent = td.config != null || td.mode != null;
        const hasLegacy = ['interrupt_mode', 'interrupt_keywords', 'interrupt_duration_ms', 'prefix_padding_ms', 'silence_duration_ms', 'threshold']
          .some(function (key) { return td[key] != null; });
        if (hasCurrent && hasLegacy) return 'mixed turn_detection schema';
        if (hasCurrent) return 'current nested turn_detection schema';
        if (hasLegacy) return 'legacy flat turn_detection schema';
        return null;
      }

      function inferConvoAiJoinSchemaFromGraph(graph) {
        if (!graph || !Array.isArray(graph.nodes)) return null;
        function node(name) {
          return graph.nodes.find(function (n) { return n && n.name === name && n.property; }) || null;
        }
        const context = node('context');
        const vad = node('vad');
        const contextp = context ? context.property : {};
        const vadp = vad ? vad.property : {};
        const hasLegacyRuntimeSignals = contextp.interrupt_mode != null
          || vadp.speech_threshold != null
          || (vadp.end_of_speech && typeof vadp.end_of_speech === 'object')
          || (vadp.start_of_speech && typeof vadp.start_of_speech === 'object');
        return hasLegacyRuntimeSignals ? 'legacy flat turn_detection schema inferred from graph' : null;
      }

      function synthesizeConvoAiRequestBodyFromGraph(graph) {
        if (!graph || !Array.isArray(graph.nodes)) return null;
        function node(name) {
          return graph.nodes.find(function (n) { return n && n.name === name && n.property; }) || null;
        }
        function clone(v) {
          if (v == null) return v;
          try { return JSON.parse(JSON.stringify(v)); } catch (_) { return v; }
        }
        function vendorFromAddon(addon) {
          const s = String(addon || '').toLowerCase();
          if (s.indexOf('deepgram') !== -1) return 'deepgram';
          if (s.indexOf('minimax') !== -1) return 'minimax';
          if (s.indexOf('eleven') !== -1) return 'elevenlabs';
          if (s.indexOf('openai') !== -1) return 'openai';
          if (s.indexOf('cartesia') !== -1) return 'cartesia';
          if (s.indexOf('soniox') !== -1) return 'soniox';
          if (s.indexOf('agora') !== -1) return 'agora';
          return addon || null;
        }
        function pickObjectFields(src, keys) {
          const out = {};
          if (!src || typeof src !== 'object') return out;
          keys.forEach(function (key) {
            if (src[key] != null && src[key] !== '') out[key] = clone(src[key]);
          });
          return out;
        }

        const rtc = node('rtc');
        const rtm = node('rtm');
        const llm = node('llm');
        const tts = node('tts');
        const asr = node('asr');
        const context = node('context');
        const ifttt = node('ifttt');
        const vad = node('vad');
        const aivad = node('agora_aivadmd');
        const main = node('main');
        const collector = node('message_collector');

        const rtcp = rtc ? rtc.property : {};
        const rtmp = rtm ? rtm.property : {};
        const llmp = llm ? llm.property : {};
        const ttsp = tts ? tts.property : {};
        const asrp = asr ? asr.property : {};
        const contextp = context ? context.property : {};
        const iftttp = ifttt ? ifttt.property : {};
        const vadp = vad ? vad.property : {};
        const aivadp = aivad ? aivad.property : {};
        const mainp = main ? main.property : {};
        const collectorp = collector ? collector.property : {};

        if (!llm && !tts && !asr) return null;

        const eos = vadp.end_of_speech || {};
        const sos = vadp.start_of_speech || {};
        const eosAcoustic = eos.acoustic_cfg || {};
        const eosSemantic = eos.semantic_cfg || {};
        const sosVad = sos.vad_cfg || {};
        const sosSemantic = sos.semantic_cfg || {};
        const orchestrator = mainp.llm_orchestrator || {};
        const filler = orchestrator.filler_words || {};

        const props = {
          channel: rtcp.channel || rtmp.channel || contextp.channel || '',
          token: rtcp.token || rtmp.token || '',
          agent_rtc_uid: rtmp.user_id != null && rtmp.user_id !== '' ? String(rtmp.user_id) : (rtcp.user_id != null ? String(rtcp.user_id) : ''),
          remote_rtc_uids: Array.isArray(rtcp.subscribe_remote_user_ids) && rtcp.subscribe_remote_user_ids.length ? clone(rtcp.subscribe_remote_user_ids) : ['*'],
          enable_string_uid: rtcp.enable_string_uid === true,
          idle_timeout: iftttp.idle_duration != null ? iftttp.idle_duration : null,
          parameters: {
            enable_dump: contextp.enable_dump === true
          },
          turn_detection: {
            type: 'agora_vad',
            interrupt_mode: contextp.interrupt_mode || null,
            silence_duration_ms: eosAcoustic.silence_duration_ms != null ? eosAcoustic.silence_duration_ms : (eosSemantic.silence_duration_ms != null ? eosSemantic.silence_duration_ms : null),
            interrupt_duration_ms: sosVad.interrupt_duration_ms != null ? sosVad.interrupt_duration_ms : (sosSemantic.interrupt_duration_ms != null ? sosSemantic.interrupt_duration_ms : null),
            threshold: vadp.speech_threshold != null ? vadp.speech_threshold : null,
            prefix_padding_ms: sosVad.prefix_padding_ms != null ? sosVad.prefix_padding_ms : (sosSemantic.prefix_padding_ms != null ? sosSemantic.prefix_padding_ms : null)
          },
          advanced_features: {
            enable_aivad: aivadp.enable === true,
            enable_rtm: rtmp.rtm_enabled === true
          },
          llm: {
            url: llmp.url || '',
            api_key: llmp.api_key || '',
            system_messages: Array.isArray(llmp.system_messages) ? clone(llmp.system_messages) : [],
            greeting_message: iftttp.greeting_message || '',
            failure_message: iftttp.failure_message || '',
            max_history: contextp.max_history != null ? contextp.max_history : null,
            params: llmp.params ? clone(llmp.params) : {}
          },
          asr: {
            vendor: vendorFromAddon(asr && asr.addon),
            params: pickObjectFields(asrp.params, ['url', 'model', 'language', 'key', 'api_key'])
          },
          tts: {
            vendor: vendorFromAddon(tts && tts.addon),
            params: pickObjectFields(ttsp.params, ['base_url', 'url', 'model', 'sample_rate', 'voice_id', 'key', 'api_key'])
          },
          filler_words: {
            enable: filler.enable === true
          }
        };

        Object.keys(props.turn_detection).forEach(function (k) {
          if (props.turn_detection[k] == null) delete props.turn_detection[k];
        });
        if (props.idle_timeout == null) delete props.idle_timeout;
        return {
          name: collectorp.agent_name || contextp.agent_name || llmp.agent_name || '',
          properties: props
        };
      }

      function parseLines(text) {
        const lines = text.split(/\r?\n/);
        const entries = [];
        let i = 0;
        let inferredYear = null;

        const convertAltTsToIso = function (altTs) {
          // altTs: "MM-DD HH:MM:SS(.fraction)"
          const year = inferredYear != null ? inferredYear : new Date().getFullYear();
          const parts = String(altTs || '').trim().split(' ');
          if (parts.length < 2) return altTs;
          const md = parts[0];
          const time = parts.slice(1).join(' ');
          const mdParts = md.split('-');
          if (mdParts.length !== 2) return altTs;
          const mm = mdParts[0];
          const dd = mdParts[1];
          return year + '-' + mm + '-' + dd + 'T' + time;
        };

        while (i < lines.length) {
          const line = lines[i];
          if (!line.trim()) { i++; continue; }

          let match = line.match(APP_VERSION_LINE);
          if (match) {
            // Example match[1]: "2026/03/12 16.48"
            const y = String(match[1] || '').split('/')[0];
            const yNum = parseInt(y, 10);
            inferredYear = isNaN(yNum) ? inferredYear : yNum;
            const appMsg = redactInlineSecrets(`app_version: ${match[2].trim()}, commit: ${match[3]}, build_time: ${match[4].trim()}`);
            entries.push({
              ts: match[1],
              level: 'I',
              pid: '',
              tid: '',
              ext: 'app',
              msg: appMsg,
              raw: redactInlineSecrets(line),
              json: null
            });
            i++;
            continue;
          }

          match = line.match(TAB_LINE);
          if (match) {
            const level = match[2] === 'ERROR' ? 'E' : match[2] === 'WARN' ? 'W' : match[2] === 'DEBUG' ? 'D' : 'I';
            const tabMsg = redactInlineSecrets(match[3]);
            entries.push({
              ts: match[1],
              level,
              pid: '',
              tid: '',
              ext: extractExtension(match[3]) || 'go',
              msg: tabMsg,
              raw: redactInlineSecrets(line),
              json: null
            });
            i++;
            continue;
          }

          let rfcMatch = line.match(RFC_LINE);
          let altMatch = !rfcMatch ? line.match(ALT_RFC_LINE) : null;
          if (rfcMatch || altMatch) {
            const matchUsed = rfcMatch || altMatch;
            let ts = matchUsed[1];
            if (altMatch) ts = convertAltTsToIso(ts);
            const pid = matchUsed[2];
            const tid = matchUsed[3];
            let level = matchUsed[4];
            if (level === 'M') level = 'I'; // "M" is treated as info in the UI.
            let msg = matchUsed[5];
            const ext = extractExtension(msg);
            let json = tryParseJSON(msg);
            if (json == null) json = tryParsePythonDict(msg);

            i++;
            const continuation = [];
            while (
              i < lines.length &&
              !lines[i].match(RFC_LINE) &&
              !lines[i].match(ALT_RFC_LINE) &&
              !lines[i].match(APP_VERSION_LINE) &&
              !lines[i].match(TAB_LINE) &&
              !lines[i].startsWith('SESS_CTRL:')
            ) {
              continuation.push(lines[i]);
              let more = tryParseJSON(lines[i]);
              if (more == null) more = tryParsePythonDict(lines[i]);
              if (more !== null) json = more;
              i++;
            }

            if (continuation.length) {
              msg = msg + '\n' + continuation.join('\n');
              if (json == null || (typeof json === 'object' && !Array.isArray(json))) {
                let fromMsg = tryParseJSON(msg);
                if (fromMsg == null) fromMsg = tryParsePythonDict(msg);
                if (fromMsg != null) json = fromMsg;
              }
            }
            entries.push({
              ts,
              level,
              pid,
              tid,
              ext: ext || 'runtime',
              msg: redactInlineSecrets(msg),
              raw: redactInlineSecrets(line),
              json: json != null ? redactSecrets(json) : null
            });
            continue;
          }

          if (line.startsWith('SESS_CTRL:')) {
            entries.push({
              ts: entries.length ? entries[entries.length - 1].ts : '',
              level: 'I',
              pid: '',
              tid: '',
              ext: 'agora_sess_ctrl',
              msg: redactInlineSecrets(line),
              raw: redactInlineSecrets(line),
              json: null
            });
            i++;
            continue;
          }

          entries.push({
            ts: entries.length ? entries[entries.length - 1].ts : '',
            level: 'D',
            pid: '',
            tid: '',
            ext: 'raw',
            msg: redactInlineSecrets(line),
            raw: redactInlineSecrets(line),
            json: null
          });
          i++;
        }

        return entries;
      }

      function extractSummary(entries) {
        const summary = {
          appVersion: null,
          appVersionTimestamp: null,
          commit: null,
          buildTime: null,
          agentId: null,
          channel: null,
          startTs: null,
          graphId: null,
          rtcSid: null,
          stopTs: null,
          stopStatus: null,
          stopMessage: null,
          llmModule: null, llmUrl: null,
          llmModel: null, llmSystemPrompt: null, llmSystemPromptEntryIndex: null, llmSystemPromptEmpty: false,
          mllmVendor: null, mllmModel: null, mllmUrl: null,
          ttsModule: null,
          sttModule: null,
          avatarVendor: null,
          avatarId: null,
          eventStartInfo: null,
          createRequestBody: null,
          createRequestBodySource: null,
          createRequestBodySchema: null,
          sipLabels: null,
          sessCtrlVersion: null,
          rtm: null,
          tools: null,
          providerSource: { llm: null, tts: null, asr: null, presets: [] },
          geoLocation: null,
          errors: 0,
          warnings: 0,
          turns: []
        };
        const seenTurnKeys = new Set();

        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          // Fallback hints from plain-text extension creation lines (works even if graph JSON parse fails).
          // Record the *addon* name, not a guessed vendor — e.g. [glue_python_async] is used with Groq / xAI / vLLM / etc.
          // Authoritative sources (graph JSON `addon`, taskInfo ASR/TTS/AVATAR_VENDOR, etc.) overwrite these below.
          if (!summary.sttModule && e.msg && e.msg.includes('[deepgram_asr_python]')) summary.sttModule = 'deepgram_asr_python';
          if (!summary.ttsModule && e.msg && e.msg.includes('[minimax_tts_websocket]')) summary.ttsModule = 'minimax_tts_websocket';
          if (!summary.llmModule && e.msg && e.msg.includes('[glue_python_async]')) summary.llmModule = 'glue_python_async';
          if (!summary.avatarVendor && e.msg && e.msg.includes('[heygen_avatar_python]')) summary.avatarVendor = 'heygen_avatar_python';

          if (!summary.sessCtrlVersion && e.ext === 'agora_sess_ctrl' && e.msg && e.msg.includes('SESS_CTRL: version:')) {
            const m = e.msg.match(/SESS_CTRL:\s*version:\s*([^\s]+)/);
            if (m) summary.sessCtrlVersion = m[1];
          }
          if (e.level === 'E') summary.errors++;
          if (e.level === 'W') summary.warnings++;
          if (e.msg && e.msg.includes('app_version:')) {
            summary.appVersionTimestamp = e.ts || null;
            const m = e.msg.match(/app_version:\s*([^,]+)/);
            if (m) summary.appVersion = m[1].trim();
            const c = e.msg.match(/commit:\s*([^,\s]+)/);
            if (c) summary.commit = c[1];
            const b = e.msg.match(/build_time:\s*(.+)$/);
            if (b) summary.buildTime = b[1].trim();
          }
          if (e.msg && e.msg.includes('sid(') && /sid\([A-F0-9]{32}\)/.test(e.msg)) {
            const sidM = e.msg.match(/sid\(([A-F0-9]{32})\)/);
            if (sidM) summary.rtcSid = sidM[1];
          }
          if (e.json && typeof e.json === 'object' && typeof e.json.stop_ts !== 'undefined') {
            summary.stopTs = e.json.stop_ts;
            summary.stopStatus = e.json.status || null;
            summary.stopMessage = e.json.message || null;
          }
          if (!summary.stopTs && e.msg && e.msg.includes('"stop_ts"')) {
            const j = tryParseJSON(e.msg) || e.json;
            if (j && typeof j.stop_ts !== 'undefined') {
              summary.stopTs = j.stop_ts;
              summary.stopStatus = j.status || null;
              summary.stopMessage = j.message || null;
            }
          }
          if (e.msg && e.msg.includes('agent_id') && e.msg.includes('channel') && e.msg.includes('start_ts')) {
            const a = e.msg.match(/"agent_id"\s*:\s*"([^"]+)"/) || e.msg.match(/'agent_id':\s*'([^']*)'/);
            const c = e.msg.match(/"channel"\s*:\s*"([^"]+)"/) || e.msg.match(/'channel':\s*'([^']*)'/);
            const s = e.msg.match(/"start_ts"\s*:\s*(\d+)/) || e.msg.match(/'start_ts':\s*(\d+)/);
            if (a && c && s) {
              summary.agentId = a[1];
              summary.channel = c[1];
              summary.startTs = parseInt(s[1], 10);
            }
          }
          if (e.json && typeof e.json === 'object') {
            const j = e.json;
            if (j.detail && j.detail.agent_id && j.detail.channel) {
              summary.agentId = summary.agentId || j.detail.agent_id;
              summary.channel = summary.channel || j.detail.channel;
              if (j.detail.start_ts != null) summary.startTs = summary.startTs != null ? summary.startTs : j.detail.start_ts;
            }
            if (j.nodes && Array.isArray(j.nodes)) {
              if (!summary.createRequestBody) {
                const synthesized = synthesizeConvoAiRequestBodyFromGraph(j);
                if (synthesized) {
                  summary.createRequestBody = synthesized;
                  summary.createRequestBodySource = 'parsed from start_graph runtime config';
                  summary.createRequestBodySchema = inferConvoAiJoinSchemaFromGraph(j) || inferConvoAiJoinSchemaFromBody(synthesized);
                }
              }
              if (!summary.channel) {
                const rtc = j.nodes.find(n => n.name === 'agora_rtc' && n.property);
                if (rtc && rtc.property && rtc.property.channel) summary.channel = rtc.property.channel;
              }
              const llmNode = j.nodes.find(n => n.name === 'llm');
              const v2vNode = j.nodes.find(function (n) {
                if (!n || !n.name) return false;
                if (n.name === 'v2v') return true;
                const addon = (n.addon || '').toLowerCase();
                return addon.includes('v2v');
              });
              const ttsNode = j.nodes.find(n => n.name === 'tts');
              const asrNode = j.nodes.find(n => n.name === 'asr');
              const avatarNode = j.nodes.find(n => n.name === 'avatar');
              if (llmNode) {
                const llmAddon = llmNode.addon || llmNode.name || null;
                if (llmAddon) summary.llmModule = llmAddon;
                if (llmNode.property && llmNode.property.url) summary.llmUrl = llmNode.property.url;
                if (!summary.llmModel && llmNode.property && llmNode.property.params && llmNode.property.params.model) {
                  summary.llmModel = llmNode.property.params.model;
                }
                if (!summary.llmSystemPrompt && llmNode.property && Array.isArray(llmNode.property.system_messages) && llmNode.property.system_messages.length) {
                  const first = llmNode.property.system_messages[0];
                  if (first && first.content != null) {
                    const content = String(first.content);
                    if (content) {
                      summary.llmSystemPrompt = content;
                      summary.llmSystemPromptEntryIndex = i;
                      summary.llmSystemPromptEmpty = false;
                    } else {
                      summary.llmSystemPromptEmpty = true;
                    }
                  }
                }
              }
              if (v2vNode && v2vNode.property) {
                const p = v2vNode.property;
                if (!summary.mllmVendor && p.vendor) summary.mllmVendor = p.vendor;
                if (!summary.mllmUrl && p.url) summary.mllmUrl = p.url;
                if (!summary.mllmModel && p.params && p.params.model) summary.mllmModel = p.params.model;
                if (p.url) summary.llmUrl = p.url;
                // Prefer the specific addon name (e.g. `openai_v2v_python`) over the generic vendor
                // so MLLM flows show the same level of detail as LLM flows. Graph JSON is
                // authoritative, so overwrite any earlier hint ("truth-wins").
                const v2vModule = v2vNode.addon || v2vNode.name || p.vendor || null;
                if (v2vModule) summary.llmModule = v2vModule;
              }
              if (ttsNode) {
                const ttsAddon = ttsNode.addon || ttsNode.name || null;
                if (ttsAddon) summary.ttsModule = ttsAddon;
              }
              if (asrNode) {
                const asrAddon = asrNode.addon || asrNode.name || null;
                if (asrAddon) summary.sttModule = asrAddon;
              }
              if (avatarNode) {
                // Some graphs wire a placeholder addon like `null_tts` into the `avatar` node
                // when no avatar is configured. Treat any `null_*` / `noop_*` addon as
                // "avatar disabled" rather than surfacing the placeholder name as the vendor.
                const vendorFromGraph = avatarNode.addon || avatarNode.name || null;
                const isPlaceholder = vendorFromGraph && /^(null|noop|dummy)_/i.test(vendorFromGraph);
                if (vendorFromGraph && !isPlaceholder) summary.avatarVendor = vendorFromGraph;
                else if (isPlaceholder) summary.avatarVendor = null;
                const p = avatarNode.property && avatarNode.property.params ? avatarNode.property.params : null;
                if (p && !summary.avatarId && p.avatar_id) summary.avatarId = p.avatar_id;
              }
            }
            if (j.graph_id) summary.graphId = j.graph_id;
            if (j.app_base_dir !== undefined && j.graph_id) summary.graphId = j.graph_id;
          }
          if (e.msg && /graph_id|graph resources/.test(e.msg)) {
            const g = tryParseJSON(e.msg);
            if (g && g.graph_id && !summary.graphId) summary.graphId = g.graph_id;
          }
          if (e.msg && e.msg.includes('"nodes"') && (e.msg.includes('start_graph') || e.msg.includes('"name":"llm"'))) {
            const g = e.json || tryParseJSON(e.msg);
            if (g && g.nodes && Array.isArray(g.nodes)) {
              if (!summary.createRequestBody) {
                const synthesized = synthesizeConvoAiRequestBodyFromGraph(g);
                if (synthesized) {
                  summary.createRequestBody = synthesized;
                  summary.createRequestBodySource = 'parsed from start_graph runtime config';
                  summary.createRequestBodySchema = inferConvoAiJoinSchemaFromGraph(g) || inferConvoAiJoinSchemaFromBody(synthesized);
                }
              }
              const n = g.nodes.find(nn => nn.name === 'llm');
              if (n) {
                const addon = n.addon || n.name || null;
                if (addon) summary.llmModule = addon;
                if (!summary.llmUrl && n.property && n.property.url) summary.llmUrl = n.property.url;
                if (!summary.llmModel && n.property && n.property.params && n.property.params.model) summary.llmModel = n.property.params.model;
                if (!summary.llmSystemPrompt && n.property && Array.isArray(n.property.system_messages) && n.property.system_messages.length) {
                  const first = n.property.system_messages[0];
                  if (first && first.content != null) {
                    const content = String(first.content);
                    if (content) {
                      summary.llmSystemPrompt = content;
                      summary.llmSystemPromptEntryIndex = i;
                      summary.llmSystemPromptEmpty = false;
                    } else {
                      summary.llmSystemPromptEmpty = true;
                    }
                  }
                }
              }
              { const n2 = g.nodes.find(nn => nn.name === 'tts'); if (n2) { const a = n2.addon || n2.name; if (a) summary.ttsModule = a; } }
              { const n2 = g.nodes.find(nn => nn.name === 'asr'); if (n2) { const a = n2.addon || n2.name; if (a) summary.sttModule = a; } }
            }
          }
          if (e.json && Array.isArray(e.json)) {
            for (const item of e.json) {
              if (item && (item.role === 'user' || item.role === 'assistant') && item.content != null) {
                const content = typeof item.content === 'string' ? item.content : String(item.content);
                const source = item.metadata && item.metadata.source != null ? String(item.metadata.source) : '';
                const key = item.role + '|' + (item.turn_id != null ? String(item.turn_id) : '') + '|' + content + '|' + source;
                if (seenTurnKeys.has(key)) continue;
                seenTurnKeys.add(key);
                summary.turns.push({
                  role: item.role,
                  content,
                  turn_id: item.turn_id,
                  source: source || undefined
                });
              }
            }
          }
          // MLLM often emits single transcription objects instead of a {role, content} array.
          // Example shape:
          // { object: "assistant.transcription", text: "...", turn_id: 1, metadata: { source: "mllm" } }
          if (
            e.json &&
            typeof e.json === 'object' &&
            typeof e.json.object === 'string' &&
            e.json.text != null &&
            (e.json.object === 'assistant.transcription' || e.json.object === 'user.transcription')
          ) {
            const role = e.json.object === 'assistant.transcription' ? 'assistant' : 'user';
            const sourceRaw = e.json.metadata && e.json.metadata.source != null ? e.json.metadata.source : null;
            const source = sourceRaw != null ? String(sourceRaw) : (e.msg && e.msg.includes('"source":"mllm"') ? 'mllm' : null);
            if (source && source.toLowerCase() !== 'mllm') {
              // Only treat MLLM transcriptions as "conversation turns" for the summary.
              // (Other sources like tts/asr have their own extractors and can stay separate.)
            } else {
              const content = typeof e.json.text === 'string' ? e.json.text : String(e.json.text);
              const turnId = e.json.turn_id != null ? e.json.turn_id : null;
              const key = role + '|' + (turnId != null ? String(turnId) : '') + '|' + content + '|' + (source || '');
              if (!seenTurnKeys.has(key)) {
                seenTurnKeys.add(key);
                summary.turns.push({
                  role,
                  content,
                  turn_id: turnId,
                  source: source || undefined
                });
              }
            }
          }
          if (!summary.turns.length && e.msg && /"role"\s*:\s*"(user|assistant)"/.test(e.msg)) {
            const arr = tryParseJSON(e.msg);
            if (Array.isArray(arr)) {
              for (const item of arr) {
                if (item && (item.role === 'user' || item.role === 'assistant') && item.content != null) {
                  const content = typeof item.content === 'string' ? item.content : String(item.content);
                  const source = item.metadata && item.metadata.source != null ? String(item.metadata.source) : '';
                  const key = item.role + '|' + (item.turn_id != null ? String(item.turn_id) : '') + '|' + content + '|' + source;
                  if (seenTurnKeys.has(key)) continue;
                  seenTurnKeys.add(key);
                  summary.turns.push({
                    role: item.role,
                    content,
                    turn_id: item.turn_id,
                    source: source || undefined
                  });
                }
              }
            }
          }
          if (!summary.eventStartInfo && (e.json || e.msg)) {
            let j = e.json || tryParseJSON(e.msg);
            if (!j && e.msg && (e.msg.includes('event start') || e.msg.includes("'taskInfo'")) && e.msg.includes('taskInfo')) {
              j = tryParsePythonDict(e.msg);
            }
            if (!j && e.msg && e.msg.includes('ipc_slave_start') && e.msg.includes('slaveServiceEventPayload')) {
              const ipc = parseIpcSlaveStartPayload(e.msg);
              if (ipc && ipc.eventPayload) j = ipc.eventPayload;
            }
            if (j && typeof j === 'object' && j.taskInfo && typeof j.taskInfo === 'object' && (j.taskInfo.appId != null || j.taskInfo.taskId != null)) {
              summary.eventStartInfo = j;
              const info = j.taskInfo.info || j.taskInfo;
              if (!summary.geoLocation && j.taskInfo.geoLocation && typeof j.taskInfo.geoLocation === 'object') {
                summary.geoLocation = j.taskInfo.geoLocation;
              }
              summary.providerSource.presets = parseVendorPresets(info && info['X-VENDOR-PRESETS']);
              if (info.ASR_VENDOR || info.asr_vendor) summary.sttModule = info.ASR_VENDOR || info.asr_vendor;
              if (info.TTS_VENDOR || info.tts_vendor) summary.ttsModule = info.TTS_VENDOR || info.tts_vendor;
              if (!summary.llmModel && (info.LLM_MODEL || info.MODEL)) summary.llmModel = info.LLM_MODEL || info.MODEL;
              if (!summary.sipLabels && info && info.LABELS && typeof info.LABELS === 'object') summary.sipLabels = info.LABELS;
              const avTaskInfo = info.AVATAR_VENDOR || info.avatar_vendor;
              if (avTaskInfo) {
                summary.avatarVendor = /^(null|noop|dummy)_/i.test(avTaskInfo) ? null : avTaskInfo;
              }
              if (!summary.avatarId && (info.AVATAR_ID || info.avatar_id)) summary.avatarId = info.AVATAR_ID || info.avatar_id;
            }
          }
          // Fallback parse for taskInfo lines that may not be valid JSON/Python dict due nested quoting.
          if ((!summary.providerSource || !summary.providerSource.presets.length) && e.msg && e.msg.includes('X-VENDOR-PRESETS')) {
            const m = e.msg.match(/X-VENDOR-PRESETS['"]?\s*:\s*['"](\[[\s\S]*?\])['"]/);
            if (m && m[1]) {
              const parsed = parseVendorPresets(m[1]);
              if (parsed.length) summary.providerSource.presets = parsed;
            }
          }
          if (e.msg && /ASR_VENDOR['"]?\s*:\s*['"]([^'"]+)['"]/.test(e.msg)) {
            const m = e.msg.match(/ASR_VENDOR['"]?\s*:\s*['"]([^'"]+)['"]/);
            if (m && m[1]) summary.sttModule = m[1];
          }
          if (e.msg && /TTS_VENDOR['"]?\s*:\s*['"]([^'"]+)['"]/.test(e.msg)) {
            const m = e.msg.match(/TTS_VENDOR['"]?\s*:\s*['"]([^'"]+)['"]/);
            if (m && m[1]) summary.ttsModule = m[1];
          }
          if (e.msg && /AVATAR_VENDOR['"]?\s*:\s*['"]([^'"]+)['"]/.test(e.msg)) {
            const m = e.msg.match(/AVATAR_VENDOR['"]?\s*:\s*['"]([^'"]+)['"]/);
            if (m && m[1]) summary.avatarVendor = m[1];
          }
          if (!summary.avatarId && e.msg && /AVATAR_ID['"]?\s*:\s*['"]([^'"]+)['"]/.test(e.msg)) {
            const m = e.msg.match(/AVATAR_ID['"]?\s*:\s*['"]([^'"]+)['"]/);
            if (m && m[1]) summary.avatarId = m[1];
          }
          // Fallback extraction for geoLocation in plain task_info lines.
          if (!summary.geoLocation && e.msg && e.msg.includes('geoLocation')) {
            const city = (e.msg.match(/geoLocation[^}]*['"]city['"]\s*:\s*['"]([^'"]+)['"]/) || [])[1] || null;
            const country = (e.msg.match(/geoLocation[^}]*['"]country['"]\s*:\s*['"]([^'"]+)['"]/) || [])[1] || null;
            const region = (e.msg.match(/geoLocation[^}]*['"]region['"]\s*:\s*['"]([^'"]+)['"]/) || [])[1] || null;
            const continent = (e.msg.match(/geoLocation[^}]*['"]continent['"]\s*:\s*['"]([^'"]+)['"]/) || [])[1] || null;
            if (city || country || region || continent) {
              summary.geoLocation = { city, country, region, continent };
            }
          }
          if (!summary.createRequestBody && (e.json || e.msg)) {
            let j = e.json || tryParseJSON(e.msg);
            if (!j && e.msg && e.msg.includes("'properties'") && e.msg.includes('llm') && e.msg.includes('tts')) {
              j = tryParsePythonDict(e.msg);
            }
            if (j && typeof j === 'object' && j.properties && typeof j.properties === 'object' && j.properties.llm && j.properties.tts && j.properties.asr) {
              summary.createRequestBody = j;
              summary.createRequestBodySource = 'logged request body';
              summary.createRequestBodySchema = inferConvoAiJoinSchemaFromBody(j);
              const p = j.properties;
              if (!summary.llmModule && p.llm) {
                if (typeof p.llm === 'string') summary.llmModule = p.llm;
                else if (p.llm.url) { summary.llmModule = p.llm.url.replace(/^https?:\/\//, '').split('/')[0]; summary.llmUrl = p.llm.url; }
                else if (p.llm.vendor) summary.llmModule = p.llm.vendor;
              }
              if (!summary.ttsModule && p.tts && (p.tts.vendor || p.tts.vendor_name)) summary.ttsModule = p.tts.vendor || p.tts.vendor_name;
              if (!summary.sttModule && p.asr && (p.asr.vendor || p.asr.vendor_name)) summary.sttModule = p.asr.vendor || p.asr.vendor_name;
              if (!summary.channel && p.channel) summary.channel = p.channel;
            }
          }

          // RTM init info (avoid tokens)
          if (!summary.rtm && e.msg && (e.msg.includes('Rtm client created successfully') || e.msg.includes('rtm_enabled'))) {
            const j = e.json || tryParseJSON(e.msg);
            if (j && typeof j === 'object' && (j.rtm_enabled === true || j.rtm_presence_enabled === true || j.rtm_metadata_enabled === true)) {
              summary.rtm = {
                enabled: j.rtm_enabled === true,
                presence_enabled: j.rtm_presence_enabled === true,
                metadata_enabled: j.rtm_metadata_enabled === true,
                lock_enabled: j.rtm_lock_enabled === true,
                is_stream: j.rtm_is_stream === true,
                user_id: j.user_id != null ? String(j.user_id) : null,
                channel: j.channel || null,
                addon: e.ext || null
              };
            }
          }
          if (!summary.rtm && e.msg && e.msg.includes('Subscribe channel') && e.msg.includes('presence')) {
            const m = e.msg.match(/Subscribe channel\s+([^\s]+)\s+with request id:\s*(\d+)\s+presence:\s*(\d+)\s+metadata\s*(\d+)\s+lock\s*(\d+)/i);
            if (m) {
              summary.rtm = {
                enabled: true,
                presence_enabled: m[3] === '1',
                metadata_enabled: m[4] === '1',
                lock_enabled: m[5] === '1',
                is_stream: null,
                user_id: null,
                channel: m[1],
                addon: e.ext || null
              };
            }
          }

          // Tools / MCP summary + observed tool calls
          if (!summary.tools) summary.tools = { is_tool_call_available: null, servers: [], total_tools: null, mcp_errors: [], tool_calls: {} };
          if (e.msg && e.msg.includes('MCP [key_point] config loaded:')) {
            const mAvail = e.msg.match(/is_tool_call_available=([A-Za-z]+)/);
            if (mAvail) summary.tools.is_tool_call_available = (mAvail[1] === 'True' || mAvail[1] === 'true');
          }
          if (e.msg && e.msg.includes('connecting to server:')) {
            const m = e.msg.match(/connecting to server:\s*([^(]+)\s*\(([^)]+)\)/i);
            if (m) {
              const name = (m[1] || '').trim();
              const transport = (m[2] || '').trim();
              if (name && !summary.tools.servers.some(s => s.name === name)) summary.tools.servers.push({ name, transport, url: null });
            }
          }
          // URL clues (from MCP init errors / httpx request lines)
          if (summary.tools && summary.tools.servers && summary.tools.servers.length) {
            const urlMatch = e.msg && e.msg.match(/https?:\/\/[^\s"']+/);
            if (urlMatch && /\/mcp\//i.test(urlMatch[0])) {
              const last = summary.tools.servers[summary.tools.servers.length - 1];
              if (last && !last.url) last.url = urlMatch[0];
            }
          }
          if (e.msg && e.msg.includes('initialization completed: total_tools=')) {
            const m = e.msg.match(/total_tools=(\d+)/);
            if (m) summary.tools.total_tools = parseInt(m[1], 10);
          }
          if (e.level === 'E' && e.ext === 'mcp_client' && e.msg && e.msg.includes('MCP') && e.msg.includes('failed')) {
            summary.tools.mcp_errors.push({ ts: e.ts || '', msg: e.msg.slice(0, 220) });
          }
          // Count each tool invocation exactly once by anchoring on the canonical `ifttt`
          // dispatch line (`tool_call_with_retry ... tool_call NAME with args ...`). Other log
          // lines ("Routing built-in tool", "[on_cmd:tool_call]") reference the *same*
          // invocation and would cause double/triple counting.
          //
          // The `[ \t]` (not `\s`) is intentional: `\s` greedily matches newlines, which made
          // lines ending in `tool_call\n` swallow the next log line's timestamp as the tool
          // name (`2026-03-19T04`). See audit: that accounted for >50% of captured "names".
          if (e.msg && e.msg.includes('tool_call_with_retry') && e.msg.includes(' with args')) {
            const m = e.msg.match(/tool_call[ \t]+([A-Za-z_][A-Za-z0-9_\-]*)[ \t]+with args/);
            if (m) {
              const name = m[1];
              summary.tools.tool_calls[name] = (summary.tools.tool_calls[name] || 0) + 1;
            }
          }
          if ((!summary.llmUrl || !summary.llmModule) && e.msg && e.msg.includes('[llm]') && e.msg.includes('GlueConfig') && e.msg.includes('url=')) {
            const urlMatch = e.msg.match(/url='([^']+)'/);
            if (urlMatch) {
              summary.llmUrl = summary.llmUrl || urlMatch[1];
              if (!summary.llmModule) summary.llmModule = urlMatch[1].replace(/^https?:\/\//, '').split('/')[0];
            }
          }
          // Raw-log fallback for the LLM system prompt.
          //
          // Graph JSON carries `system_messages` as a real JSON array, but
          // many sessions only emit the `[llm] ... GlueConfig(... system_messages=[{'content': '...', 'role': 'system'}] ...)`
          // Python-dict dump. When Graph JSON never lands (or doesn't contain
          // a system message) we grab the content from that line so the
          // Insights summary still shows the prompt.
          //
          // We only look when we haven't already captured a prompt, and we
          // skip empty `system_messages=[]` to avoid clobbering a real value
          // from a later line.
          if (!summary.llmSystemPrompt && e.msg && e.msg.includes('system_messages=[') && !e.msg.includes('system_messages=[]')) {
            // Match the first `{'content': '...', 'role': 'system'}` dict inside
            // `system_messages=[...]`. Uses a non-greedy content capture that
            // permits escaped quotes (`\'`) inside the string, and deliberately
            // doesn't require the dict to be the array's only element — some
            // agents ship multiple system messages (primary prompt + greeting,
            // for example) and we still want to surface the first one.
            const m = e.msg.match(/system_messages=\[\s*\{\s*'content'\s*:\s*'((?:[^'\\]|\\.)*)'\s*,\s*'role'\s*:\s*'system'\s*\}/)
              || e.msg.match(/system_messages=\[\s*\{\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"role"\s*:\s*"system"\s*\}/);
            if (m) {
              if (m[1]) {
                // Python-escaped literal: turn \n, \t, \', \\ into their real chars so
                // the prompt renders naturally instead of showing escape sequences.
                const decoded = m[1]
                  .replace(/\\n/g, '\n')
                  .replace(/\\r/g, '\r')
                  .replace(/\\t/g, '\t')
                  .replace(/\\'/g, "'")
                  .replace(/\\"/g, '"')
                  .replace(/\\\\/g, '\\');
                summary.llmSystemPrompt = decoded;
                summary.llmSystemPromptEntryIndex = i;
                summary.llmSystemPromptEmpty = false;
              } else {
                // Matched the structure but the content string is empty. Common for
                // workflow-style LLMs (Dify, n8n, etc.) where the prompt lives on
                // the upstream service, not in the TEN graph.
                summary.llmSystemPromptEmpty = true;
              }
            }
          }
        }

        if (summary.tools) {
          const hasServers = summary.tools.servers && summary.tools.servers.length;
          const hasCalls = summary.tools.tool_calls && Object.keys(summary.tools.tool_calls).length;
          const hasMcp = summary.tools.is_tool_call_available != null || summary.tools.total_tools != null || hasServers || (summary.tools.mcp_errors && summary.tools.mcp_errors.length);
          if (!hasMcp && !hasCalls) summary.tools = null;
        }

        // Fill provider source hints for both legacy and updated workflows.
        const info = summary.eventStartInfo && summary.eventStartInfo.taskInfo
          ? (summary.eventStartInfo.taskInfo.info || summary.eventStartInfo.taskInfo)
          : {};
        const props = summary.createRequestBody && summary.createRequestBody.properties
          ? summary.createRequestBody.properties
          : {};
        const presets = summary.providerSource && Array.isArray(summary.providerSource.presets)
          ? summary.providerSource.presets
          : [];
        summary.providerSource.llm = inferProviderSourceBySignals(info, 'llm', props.llm, presets);
        summary.providerSource.tts = inferProviderSourceBySignals(info, 'tts', props.tts, presets);
        summary.providerSource.asr = inferProviderSourceBySignals(info, 'asr', props.asr, presets);

        return summary;
      }

      function collectExtensions(entries) {
        const set = new Set();
        for (const e of entries) if (e.ext) set.add(e.ext);
        return [...set].sort();
      }

      function extractStateTransitions(entries) {
        const out = [];
        const reNewOld = /new state:\s*(\w+),\s*old state:\s*(\w+),\s*reason:\s*([^,]+)(?:,\s*turn_id:\s*(\d+))?/i;
        const reCurState = /'cur_state':\s*'(\w+)'.*?'old_state':\s*'(\w+)'.*?'reason':\s*'([^']*)'(?:.*?'turn_id':\s*(\d+))?/;
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg) continue;
          const m = e.msg.match(reNewOld) || e.msg.match(reCurState);
          if (m) {
            const cur = m[1], old = m[2], reason = String(m[3]).trim(), turnId = m[4] != null ? parseInt(m[4], 10) : null;
            out.push({ ts: e.ts, cur_state: cur, old_state: old, reason, turn_id: turnId, isFailure: /llm failure|error/i.test(reason), entryIndex: i });
          }
        }
        return out;
      }

      function extractStateReports(entries) {
        const out = [];
        const stateNames = { 0: 'unknown', 1: 'created', 2: 'Started', 3: 'Running', 4: 'Stopped' };
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg) continue;
          const isStateReport = e.msg.includes('StateReporter') || (e.msg.includes('reporting state') && e.msg.includes('state'));
          if (!isStateReport) continue;
          let j = e.json || tryParseJSON(e.msg);
          if (!j && e.msg.includes('{')) {
            const start = e.msg.indexOf('{');
            const slice = e.msg.slice(start);
            j = tryParseJSON(slice);
          }
          if (j && typeof j === 'object' && (typeof j.state !== 'undefined' || (j.reason != null && (j.lts != null || j.taskId != null)))) {
            const stateVal = j.state != null ? j.state : (j.reason != null ? 2 : 0);
            const stateNum = typeof stateVal === 'number' ? stateVal : parseInt(stateVal, 10);
            out.push({
              ts: e.ts,
              state: stateNum,
              stateName: stateNames[stateNum] || j.reason || String(stateVal),
              reason: j.reason != null ? String(j.reason) : '',
              duration: j.duration != null ? j.duration : (j.lts != null ? String(j.lts) : null),
              oldState: j.oldState,
              entryIndex: i
            });
          }
        }
        return out;
      }

      function extractTts(entries) {
        const out = [];
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg) continue;
          if (e.msg.includes('send tts_text_result:') || e.msg.includes('tts_text_result:')) {
            const j = tryParseJSON(e.msg) || (e.json && e.json.text ? e.json : null);
            if (!j) {
              const m = e.msg.match(/"text"\s*:\s*"([^"]*)"[^}]*"duration_ms"\s*:\s*(\d+)/);
              if (m) out.push({ ts: e.ts, text: m[1].replace(/\\"/g, '"'), duration_ms: parseInt(m[2], 10), start_ms: null, turn_id: null, final: null, language: null, entryIndex: i });
            } else if (j.text != null) {
              const turnId = j.metadata && j.metadata.turn_id != null ? j.metadata.turn_id : (j.turn_id != null ? j.turn_id : null);
              out.push({
                ts: e.ts,
                text: j.text,
                duration_ms: j.duration_ms || j.duration || 0,
                start_ms: j.start_ms != null ? j.start_ms : null,
                turn_id: turnId,
                final: null,
                language: (j.metadata && j.metadata.language) || j.language || null,
                entryIndex: i
              });
            }
          }
          if (e.msg.includes('assistant.transcription') && e.msg.includes('"source":"tts"')) {
            const j = tryParseJSON(e.msg);
            if (j && j.text != null) {
              // assistant.transcription payloads don't carry an `is_final` flag
              // — only `turn_status` (0 = streaming, 1 = stream complete). Those
              // are different concepts from transcript finality, so we leave
              // `final: null` and surface `turn_status` separately. If the log
              // ever adds an explicit is_final/final field we honor it verbatim.
              let finalFlag = null;
              if (typeof j.is_final === 'boolean') finalFlag = j.is_final;
              else if (typeof j.final === 'boolean') finalFlag = j.final;
              out.push({ ts: e.ts, text: j.text, duration_ms: j.duration_ms || 0, start_ms: j.start_ms || null, turn_id: j.turn_id != null ? j.turn_id : null, final: finalFlag, turn_status: typeof j.turn_status === 'number' ? j.turn_status : null, language: j.language || null, entryIndex: i });
            }
          }
          // tts2_http.py shape: "[tts] Requesting TTS for text: <text>, text_input_end: ..., request ID: <id>"
          if (e.msg.includes('Requesting TTS for text:')) {
            const m = e.msg.match(/Requesting TTS for text:\s*([\s\S]*?),\s*text_input_end:\s*(True|False)\s*request ID:\s*(\d+)/);
            if (m) {
              out.push({
                ts: e.ts,
                text: m[1].trim(),
                duration_ms: 0,
                start_ms: null,
                turn_id: null,
                request_id: Number(m[3]),
                // Keep `final: null` for TTS fragments; `text_input_end` is a streaming flag,
                // not a transcript-finality signal. Using it here makes the turns-table
                // "Final" column misreport agent output as interim.
                final: null,
                text_input_end: m[2] === 'True',
                language: null,
                entryIndex: i,
              });
            }
          }
          // message_collector agent transcript shape:
          // "[message_collector] on_data text: <text> turn_id: N is_final: <True|False> turn_status: <0|1>"
          // Report `final` verbatim from the `is_final` field — the log is the
          // source of truth. `turn_status` is retained separately so callers
          // can tell whether the *stream* finished (status 1) even when the
          // final flag on the carried text is still False.
          if (e.msg.includes('[message_collector]') && e.msg.includes('on_data text:') && e.msg.includes('turn_status:')) {
            const mc = e.msg.match(/on_data text:\s*([\s\S]*?)\s+turn_id:\s*(\d+)\s+is_final:\s*(True|False)\s+turn_status:\s*(\d+)/);
            if (mc) {
              const txt = mc[1].trim();
              if (txt.length > 0) {
                const ts = Number(mc[4]);
                out.push({
                  ts: e.ts,
                  text: txt,
                  duration_ms: 0,
                  start_ms: null,
                  turn_id: Number(mc[2]),
                  final: mc[3] === 'True',
                  turn_status: ts,
                  language: null,
                  entryIndex: i,
                });
              }
            }
          }
          // ElevenLabs / v2 extension shape: "[tts] request_tts: request_id='1' text='...' text_input_end=False metadata={'turn_id': 1, ...}"
          // Only record non-empty text so we don't count the trailing text_input_end flush.
          if (e.msg.includes('[tts]') && e.msg.includes(' request_tts: request_id=')) {
            const textMatch = e.msg.match(/text=(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/);
            const rid = e.msg.match(/request_id='([^']+)'/);
            const tidM = e.msg.match(/'turn_id'\s*:\s*(\d+)/);
            const end = e.msg.match(/text_input_end=(True|False)/);
            const txt = textMatch ? (textMatch[1] != null ? textMatch[1] : textMatch[2]) : null;
            if (txt && txt.length > 0) {
              out.push({
                ts: e.ts,
                text: txt,
                duration_ms: 0,
                start_ms: null,
                turn_id: tidM ? Number(tidM[1]) : null,
                request_id: rid ? rid[1] : null,
                // Same reasoning: TTS streaming chunks are not "interim" transcripts.
                final: null,
                text_input_end: end ? end[1] === 'True' : null,
                language: null,
                entryIndex: i,
              });
            }
          }
        }
        return out;
      }

      /** TTS failures: WebSocket auth (401), empty api_key in config, runtime tts base_dir warnings. */
      function extractTtsIssues(entries) {
        const items = [];
        const seenEmptyKey = { v: false };
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg) continue;
          const msg = e.msg;
          // E/I key_point lines: tts_error: ... {"module":"tts",...} (ElevenLabs, etc.)
          if (/\[tts\]/i.test(msg) && (msg.includes('tts_error:') || msg.includes('send_tts_error'))) {
            const brace = msg.indexOf('{');
            if (brace >= 0) {
              const j = tryParseJSON(msg.slice(brace));
              if (j && typeof j === 'object' && (j.module === 'tts' || msg.includes('receive pcm error'))) {
                const vi = j.vendor_info && typeof j.vendor_info === 'object' ? j.vendor_info : null;
                const detailParts = [];
                if (j.message) detailParts.push(String(j.message));
                if (vi && vi.vendor) detailParts.push('vendor=' + vi.vendor);
                if (vi && vi.message && vi.message !== j.message) detailParts.push('vendor_msg=' + vi.message);
                items.push({
                  ts: e.ts,
                  kind: e.level === 'E' ? 'error' : 'warning',
                  issue: 'tts_vendor_error',
                  code: j.code != null ? String(j.code) : null,
                  detail: detailParts.join(' · ').slice(0, 220) || msg.replace(/\s+/g, ' ').trim().slice(0, 220),
                  entryIndex: i
                });
                continue;
              }
            }
          }
          if (/\[tts\]/i.test(msg) && /Websocket internal error|server rejected WebSocket|HTTP\s+\d{3}/i.test(msg)) {
            const httpM = msg.match(/HTTP\s+(\d{3})/);
            items.push({
              ts: e.ts,
              kind: 'error',
              issue: 'websocket',
              code: httpM ? httpM[1] : null,
              detail: msg.replace(/\s+/g, ' ').trim().slice(0, 220),
              entryIndex: i
            });
            continue;
          }
          if (/base_dir of 'tts' is missing|Skip the loading of (manifest|property).*'tts'/i.test(msg)) {
            items.push({
              ts: e.ts,
              kind: 'warning',
              issue: 'tts_base_dir',
              code: null,
              detail: msg.replace(/\s+/g, ' ').trim().slice(0, 200),
              entryIndex: i
            });
            continue;
          }
          if (/\[tts\]\s*config:/i.test(msg) && /api_key=(''|"")/.test(msg) && !seenEmptyKey.v) {
            seenEmptyKey.v = true;
            items.push({
              ts: e.ts,
              kind: 'warning',
              issue: 'empty_api_key',
              code: null,
              detail: 'TTS init config has empty api_key (often causes WebSocket HTTP 401 to ByteDance/openspeech).',
              entryIndex: i
            });
          }
          if (/KEYPOINT ignore flush in non-interruptable state/i.test(msg)) {
            items.push({
              ts: e.ts,
              kind: 'info',
              issue: 'flush_ignored',
              code: null,
              detail: msg.replace(/\s+/g, ' ').trim().slice(0, 160),
              entryIndex: i
            });
          }
        }
        return items;
      }

      function extractStt(entries) {
        // Vendor-side ASR view (raw transcripts the vendor returned, vendor metrics,
        // vendor/timeline errors). User-facing transcripts (`user.transcription`,
        // `send_asr_result`) are intentionally NOT duplicated here — they are
        // surfaced by `extractUserAsrTranscripts` and rendered in the Turns tab.
        const transcripts = [];
        const metrics = [];
        const errors = [];
        // Rolling cache of recent `input_audio_duration=Nms` billing records so
        // we can fold them into the matching `actual_send` asr_metrics row
        // instead of emitting a stand-alone row with no context.
        const billingQueue = [];
        // Helper: parse the body of a Python-dict expression like
        //   {'actual_send': 6770, 'actual_send_delta': 4940}
        // into a plain JS object. Values supported: int, float, True/False, None,
        // single-quoted strings. Non-matching keys are ignored rather than
        // throwing so we don't drop an otherwise-good row for one weird value.
        function parsePyDict(body) {
          const out = {};
          if (typeof body !== 'string') return out;
          const re = /'([A-Za-z0-9_]+)'\s*:\s*(-?\d+\.?\d*|True|False|None|'[^']*')/g;
          let m;
          while ((m = re.exec(body)) !== null) {
            const key = m[1];
            const raw = m[2];
            if (raw === 'True') out[key] = true;
            else if (raw === 'False') out[key] = false;
            else if (raw === 'None') out[key] = null;
            else if (raw.startsWith("'")) out[key] = raw.slice(1, -1);
            else if (raw.indexOf('.') >= 0) out[key] = parseFloat(raw);
            else out[key] = parseInt(raw, 10);
          }
          return out;
        }
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg) continue;

          // --- Vendor result (full JSON, e.g. Deepgram `on_recognized`) ---
          // Handle this BEFORE the Soniox/short-form branches because the
          // Deepgram log contains both `vendor_result:` and JSON with a
          // `transcript` field, which would otherwise match the short-form
          // regex and produce garbage.
          if (e.msg.includes('vendor_result:') && e.msg.includes('on_recognized:')) {
            const jsonStart = e.msg.indexOf('{');
            if (jsonStart >= 0) {
              const vj = tryParseJSON(e.msg.slice(jsonStart));
              if (vj && vj.channel && Array.isArray(vj.channel.alternatives) && vj.channel.alternatives.length) {
                const alt = vj.channel.alternatives[0];
                const txt = typeof alt.transcript === 'string' ? alt.transcript : '';
                if (txt.trim().length > 0) {
                  const modelName = vj.metadata && vj.metadata.model_info && vj.metadata.model_info.name ? String(vj.metadata.model_info.name) : null;
                  transcripts.push({
                    ts: e.ts,
                    text: txt,
                    final_audio_proc_ms: null,
                    total_audio_proc_ms: null,
                    vendor: modelName ? ('deepgram:' + modelName) : 'deepgram',
                    confidence: typeof alt.confidence === 'number' && isFinite(alt.confidence) ? alt.confidence : null,
                    is_final: vj.is_final === true,
                    entryIndex: i,
                  });
                }
              }
            }
            continue;
          }

          // --- Vendor result (Soniox token stream): `vendor_result: transcript: [SonioxTranscriptToken(text=..., is_final=..., confidence=...), ...], final_audio_proc_ms: N, total_audio_proc_ms: N` ---
          // Collapse all tokens in the list into a single row: text = joined
          // token texts, is_final = true only when every token is final,
          // confidence = average across tokens (the Soniox aggregator in the
          // main path uses min; here we want a row-level view).
          if (e.msg.includes('vendor_result:') && e.msg.includes('SonioxTranscriptToken(text=')) {
            const tokens = [];
            const tokenRe = /SonioxTranscriptToken\(\s*text='((?:[^'\\]|\\.)*)'\s*,\s*start_ms=(-?\d+)\s*,\s*end_ms=(-?\d+)\s*,\s*is_final=(True|False)\s*,\s*confidence=([0-9.]+)/g;
            let tm;
            while ((tm = tokenRe.exec(e.msg)) !== null) {
              tokens.push({ text: tm[1], isFinal: tm[4] === 'True', confidence: parseFloat(tm[5]) });
            }
            const procM = e.msg.match(/final_audio_proc_ms:\s*(\d+),\s*total_audio_proc_ms:\s*(\d+)/);
            if (tokens.length) {
              const textJoined = tokens.map(t => t.text).join('');
              if (textJoined.trim().length > 0) {
                const allFinal = tokens.every(t => t.isFinal);
                const anyInterim = tokens.some(t => !t.isFinal);
                const confs = tokens.map(t => t.confidence).filter(v => isFinite(v));
                const avgConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
                transcripts.push({
                  ts: e.ts,
                  text: textJoined,
                  final_audio_proc_ms: procM ? parseInt(procM[1], 10) : null,
                  total_audio_proc_ms: procM ? parseInt(procM[2], 10) : null,
                  vendor: 'soniox',
                  confidence: avgConf,
                  is_final: allFinal ? true : (anyInterim ? false : null),
                  entryIndex: i,
                });
              }
            }
            continue;
          }

          // --- Vendor result (short-form plain list, non-Soniox): `vendor_result: transcript: ["a","b"], final_audio_proc_ms: N, total_audio_proc_ms: N` ---
          const vr = e.msg.match(/vendor_result:\s*transcript:\s*(\[[^\]]*\]|"[^"]*"),\s*final_audio_proc_ms:\s*(\d+),\s*total_audio_proc_ms:\s*(\d+)/);
          if (vr) {
            let text = vr[1];
            let isEmpty = false;
            if (text === '[]') { text = ''; isEmpty = true; }
            else if (text.match(/^\[/)) try { text = JSON.parse(text).join(' '); } catch (_) {}
            else if (text.match(/^"/)) try { text = JSON.parse(text); } catch (_) {}
            if (!isEmpty && String(text).trim().length > 0) {
              transcripts.push({
                ts: e.ts,
                text,
                final_audio_proc_ms: parseInt(vr[2], 10),
                total_audio_proc_ms: parseInt(vr[3], 10),
                vendor: null,
                confidence: null,
                is_final: null,
                entryIndex: i,
              });
            }
            continue;
          }

          // --- Billing: `[billing] asr_metrics_recorded: input_audio_duration=Nms` ---
          // Folded into the next matching asr_metrics row (same value / near ts).
          const billShort = e.msg.match(/asr_metrics_recorded:\s*input_audio_duration=(\d+)ms/);
          if (billShort) {
            billingQueue.push({
              ts: e.ts,
              entryIndex: i,
              input_audio_duration: parseInt(billShort[1], 10),
              vendor: null,
            });
            continue;
          }

          // --- Billing: full `[billing] metrics_received: metrics_data=... module='asr' vendor='X' metrics={...}` ---
          if (/\[billing\]\s*metrics_received:/.test(e.msg) && /module='asr'/.test(e.msg)) {
            const vMatch = e.msg.match(/vendor='([^']+)'/);
            const mBody = e.msg.match(/metrics=\{([^}]*)\}/);
            if (mBody) {
              const parsed = parsePyDict(mBody[1]);
              if (parsed.input_audio_duration != null) {
                billingQueue.push({
                  ts: e.ts,
                  entryIndex: i,
                  input_audio_duration: parsed.input_audio_duration,
                  total_input_audio_duration: parsed.total_input_audio_duration != null ? parsed.total_input_audio_duration : null,
                  vendor: vMatch ? vMatch[1] : null,
                });
              }
            }
            continue;
          }

          // --- ASR metrics: `[asr|agora_stream_asr] send asr_metrics: id='...' module='asr' vendor='X' metrics={...}` ---
          if (/asr_metrics:/.test(e.msg) && /metrics=\{/.test(e.msg)) {
            const vMatch = e.msg.match(/vendor='([^']*)'/);
            const idMatch = e.msg.match(/\bid='([^']*)'/);
            const mBody = e.msg.match(/metrics=\{([^}]*)\}/);
            if (mBody) {
              const parsed = parsePyDict(mBody[1]);
              const row = {
                ts: e.ts,
                module: e.ext || null,
                vendor: vMatch ? vMatch[1] : null,
                metrics_id: idMatch && idMatch[1] ? idMatch[1] : null,
                connect_delay: parsed.connect_delay != null ? parsed.connect_delay : null,
                actual_send: parsed.actual_send != null ? parsed.actual_send : null,
                actual_send_delta: parsed.actual_send_delta != null ? parsed.actual_send_delta : null,
                ttfw: parsed.ttfw != null ? parsed.ttfw : null,
                ttlw: parsed.ttlw != null ? parsed.ttlw : null,
                input_audio_duration_ms: null,
                extras: {},
                entryIndex: i,
              };
              // Stash any unknown metric keys so we can still show them without
              // silently dropping future fields the SDK might add.
              for (const k of Object.keys(parsed)) {
                if (['connect_delay','actual_send','actual_send_delta','ttfw','ttlw'].indexOf(k) < 0) {
                  row.extras[k] = parsed[k];
                }
              }
              // Fold the most recent unmatched billing row for the same
              // vendor into this metrics row. Billing emits
              // `[billing] metrics_received: ... module='asr' vendor='soniox'
              // metrics={'input_audio_duration': N, ...}` immediately before
              // the corresponding `[asr] send asr_metrics: ... 'actual_send'`
              // line, so we match by vendor + temporal order (pop the oldest
              // billing row for this vendor). The values are not necessarily
              // equal — billing counts per delta/segment while asr_metrics
              // reports cumulative — so we intentionally do NOT require
              // numeric equality.
              if (row.actual_send != null && row.vendor) {
                for (let b = 0; b < billingQueue.length; b++) {
                  const bill = billingQueue[b];
                  const vendorOk = bill.vendor == null || bill.vendor === row.vendor;
                  if (vendorOk) {
                    row.input_audio_duration_ms = bill.input_audio_duration;
                    billingQueue.splice(b, 1);
                    break;
                  }
                }
              }
              metrics.push(row);
            }
            continue;
          }

          // --- ASR timeline failures (I-line: "Requested time Nms exceeds timeline duration Nms") ---
          const timelineErr = e.msg.match(/Requested time\s*(\d+)ms\s+exceeds timeline duration\s*(\d+)ms/);
          if (timelineErr) {
            errors.push({
              kind: 'timeline',
              ts: e.ts,
              requested_time_ms: parseInt(timelineErr[1], 10),
              timeline_duration_ms: parseInt(timelineErr[2], 10),
              detail: e.msg,
              entryIndex: i
            });
          }
          // --- E-level ASR line: `vendor_error: code: 400, message: ...` ---
          const ve = e.msg.match(/vendor_error:\s*code:\s*(\d+),\s*message:\s*(.+)$/i);
          if (ve && (e.ext === 'asr' || /\[asr\]/i.test(e.msg))) {
            errors.push({
              kind: 'asr_error',
              source: 'vendor_error',
              ts: e.ts,
              level: e.level || null,
              code: parseInt(ve[1], 10),
              message: String(ve[2] || '').trim().replace(/\.\s*$/, ''),
              vendor: null,
              vendor_code: null,
              vendor_message: null,
              detail: redactInlineSecrets(e.msg).slice(0, 500),
              entryIndex: i
            });
          }
          // --- Vendor/protocol ASR errors (I-line): `send asr_error: {...}` ---
          const asrErrTag = 'send asr_error:';
          const asrErrIdx = e.msg.indexOf(asrErrTag);
          if (asrErrIdx >= 0) {
            const jsonStr = e.msg.slice(asrErrIdx + asrErrTag.length).trim();
            const j = tryParseJSON(jsonStr);
            if (j && typeof j === 'object') {
              const vi = j.vendor_info && typeof j.vendor_info === 'object' ? j.vendor_info : null;
              errors.push({
                kind: 'asr_error',
                source: 'send_asr_error',
                ts: e.ts,
                level: e.level || null,
                code: j.code != null ? j.code : null,
                message: j.message != null ? String(j.message) : null,
                vendor: vi && vi.vendor != null ? String(vi.vendor) : null,
                vendor_code: vi && vi.code != null ? String(vi.code) : null,
                vendor_message: vi && vi.message != null ? String(vi.message) : null,
                detail: redactInlineSecrets(e.msg).slice(0, 500),
                entryIndex: i
              });
            }
          }
        }
        // Any billing rows left over: emit them as standalone rows so we don't
        // silently drop data. This is expected when the log lacks the matching
        // asr_metrics line (e.g. early termination).
        for (const bill of billingQueue) {
          metrics.push({
            ts: bill.ts,
            module: 'billing',
            vendor: bill.vendor,
            metrics_id: null,
            connect_delay: null,
            actual_send: null,
            actual_send_delta: null,
            ttfw: null,
            ttlw: null,
            input_audio_duration_ms: bill.input_audio_duration,
            extras: {},
            entryIndex: bill.entryIndex,
          });
        }
        return { transcripts, metrics, errors };
      }

      function extractLlm(entries) {
        const requests = [];
        let lastRequest = null;
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg) continue;
          // Newer logs may not include a `chat/completions` substring or `on_request_end`.
          // We still want to stitch together: on_request_start -> Request failed / finish_reason payload.
          if (e.msg.includes('on_request_start') && e.msg.includes('[llm]')) {
            const urlMatch =
              e.msg.match(/url=URL\('([^']*)'\)/) ||
              e.msg.match(/url=URL\("([^"]*)"\)/) ||
              e.msg.match(/url='([^']*)'/) ||
              e.msg.match(/url="([^"]*)"/);
            lastRequest = {
              ts: e.ts,
              url: urlMatch ? urlMatch[1] : null,
              status: null,
              error: null,
              model: null,
              finish_reason: null,
              duration_ms: null,
              err_message: null,
              err_code: null,
              entryIndex: i
            };
          }
          if (e.msg.includes('on_request_end') && lastRequest) {
            const statusMatch = e.msg.match(/ClientResponse\([^)]+\)\s*\[(\d+)/) || e.msg.match(/\[(\d+)\s+[\w\s]+\]/);
            if (statusMatch) lastRequest.status = statusMatch[1];
            lastRequest.entryIndex = i;
            const start = new Date(lastRequest.ts.replace('T', ' ').replace('+00:00', 'Z')).getTime();
            const end = new Date(e.ts.replace('T', ' ').replace('+00:00', 'Z')).getTime();
            if (!isNaN(start) && !isNaN(end)) lastRequest.duration_ms = end - start;
            requests.push(lastRequest);
            lastRequest = null;
          }
          if (e.msg.includes('on_request_exception') && e.msg.includes('[llm]')) {
            // Observed shapes across logs:
            // - exception=<InvalidUrlClientError >
            // - exception=CancelledError()
            const exMatch =
              e.msg.match(/exception=<\s*([^>]+?)\s*>/) ||
              e.msg.match(/exception=([A-Za-z0-9_]+(?:\(\))?)/);
            if (!exMatch) continue;

            const ex = String(exMatch[1]).trim();
            const req = lastRequest || {
              ts: e.ts,
              url: null,
              status: null,
              error: null,
              model: null,
              finish_reason: null,
              duration_ms: null,
              err_message: null,
              err_code: null,
              entryIndex: i
            };

            req.error = req.error || ex;
            req.err_message = req.err_message || ex;
            req.finish_reason = req.finish_reason || 'error';
            req.entryIndex = i;

            // Push immediately so we don't miss exceptions when the next on_request_start appears.
            // If a finish_reason payload arrives right after, it will merge into this row.
            if (!requests.includes(req)) requests.push(req);
            lastRequest = null;
          }

          if (e.msg.includes('Request failed:') && (e.level === 'E' || e.level === 'W')) {
            // Common shapes:
            // 1) Request failed: 500, message='...'
            // 2) Request failed: InvalidUrlClientError
            const m = e.msg.match(/Request failed:\s*(\d+),\s*message='([^']*)'/);
            if (m) {
              if (lastRequest) {
                lastRequest.status = m[1];
                lastRequest.error = m[2];
                lastRequest.err_message = lastRequest.err_message || m[2];
                lastRequest.finish_reason = lastRequest.finish_reason || 'error';
                lastRequest.entryIndex = i;
                requests.push(lastRequest);
                lastRequest = null;
              } else {
                requests.push({ ts: e.ts, url: null, status: m[1], error: m[2], model: null, finish_reason: 'error', err_message: m[2], err_code: null, duration_ms: null, entryIndex: i });
              }
            } else {
              const exMatch = e.msg.match(/Request failed:\s*([A-Za-z0-9_]+(?:Error|Exception|ClientError)?)/);
              if (exMatch) {
                const ex = String(exMatch[1]).trim();
                if (lastRequest) {
                  lastRequest.error = lastRequest.error || ex;
                  lastRequest.err_message = lastRequest.err_message || ex;
                  lastRequest.finish_reason = lastRequest.finish_reason || 'error';
                  lastRequest.entryIndex = i;
                  requests.push(lastRequest);
                  lastRequest = null;
                } else {
                  requests.push({ ts: e.ts, url: null, status: null, error: ex, model: null, finish_reason: 'error', err_message: ex, err_code: null, duration_ms: null, entryIndex: i });
                }
              }
            }
          }

          if (e.msg.includes('finish_reason') && (e.msg.includes('err_message') || e.msg.includes('err_code'))) {
            const j = tryParseJSON(e.msg);
            const fallbackFinish = {
              finish_reason: null,
              err_message: null,
              err_code: null,
              model: null
            };
            if (!j) {
              const finishM = e.msg.match(/"finish_reason"\s*:\s*"([^"]+)"/);
              const errMessageM = e.msg.match(/"err_message"\s*:\s*"([^"]*)"/);
              const errCodeM = e.msg.match(/"err_code"\s*:\s*(\d+)/);
              const modelM = e.msg.match(/"model"\s*:\s*(null|"([^"]+)")/);
              fallbackFinish.finish_reason = finishM ? finishM[1] : null;
              fallbackFinish.err_message = errMessageM ? errMessageM[1] : null;
              fallbackFinish.err_code = errCodeM ? errCodeM[1] : null;
              fallbackFinish.model = modelM ? (modelM[2] || null) : null;
            }

            const choice0 = j && j.choices && j.choices[0] ? j.choices[0] : null;
            if (choice0 || fallbackFinish.err_message || fallbackFinish.finish_reason || fallbackFinish.err_code) {
              // If we already pushed a request from "Request failed:", merge into the most recent entry.
              // This avoids duplicates when the finish_reason payload arrives right after.
              let req = lastRequest;
              if (!req) {
                const prev = requests.length ? requests[requests.length - 1] : null;
                if (prev && prev.entryIndex != null && Math.abs(prev.entryIndex - i) <= 2) req = prev;
              }
              if (!req) {
                req = {
                  ts: e.ts,
                  url: null,
                  status: null,
                  error: null,
                  model: null,
                  finish_reason: null,
                  duration_ms: null,
                  err_message: null,
                  err_code: null,
                  entryIndex: i
                };
              }

              if (choice0) {
                req.finish_reason = choice0.finish_reason;
                req.err_message = choice0.err_message;
                req.err_code = choice0.err_code;
                if (req.model == null && j.model != null) req.model = j.model;
              } else {
                req.finish_reason = req.finish_reason || fallbackFinish.finish_reason;
                req.err_message = req.err_message || fallbackFinish.err_message;
                req.err_code = req.err_code || fallbackFinish.err_code;
                req.model = req.model || fallbackFinish.model;
              }

              // Mark errors consistently so the UI can highlight the row.
              req.error = req.error || req.err_message || null;
              if (req.status == null && req.err_code != null) req.status = String(req.err_code);
              req.entryIndex = i;
              if (!requests.includes(req)) requests.push(req);
              lastRequest = null;
            }
          }
          if (e.msg.includes('ChatCompletion(') && e.msg.includes('model=')) {
            const modelMatch = e.msg.match(/model='([^']+)'/);
            if (modelMatch && requests.length) requests[requests.length - 1].model = modelMatch[1];
          }
        }
        if (lastRequest) requests.push(lastRequest);
        return requests;
      }

      function extractKeypointEvents(entries) {
        const out = [];
        const re = /KEYPOINT\s*\[event_type:(\w+)\]/;
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg) continue;
          const m = e.msg.match(re);
          if (m) out.push({ ts: e.ts, event_type: m[1], ext: e.ext, entryIndex: i });
        }
        return out;
      }

      /**
       * RTC / Agora: graph routing failures, cert/token manager, and SDK connection errors.
       * Skips routine I/D traffic; W-level SDK lines only when they look like real issues.
       */
      function extractRtcInsights(entries) {
        const items = [];
        const seen = new Set();
        function push(e, i, kind, category) {
          if (seen.has(i)) return;
          seen.add(i);
          const msg = e.msg;
          const modMatch = msg.match(/\[([^\]]+)\]/);
          const module = modMatch ? modMatch[1] : (e.ext || null);
          items.push({
            ts: e.ts,
            kind,
            category,
            module,
            detail: msg,
            entryIndex: i
          });
        }

        const rtcStack =
          /\[agora_rtc_extension\]|\[agora_sess_ctrl_extension\]|rtc_extension\.cc|connection_observer\.cc|rtc_connection\.cc|rtc_service\.cc/i;
        const sdkSeriousW =
          /\bonError\b|onConnectionLost|onReconnecting|INVALID_TOKEN|invalid\s+token|token\s+expired|Token\s+expired|onClientRoleChangeFailed|ConnectionFailed|connection\s+failed|join.*failed|publish.*failed|subscribe.*failed|ERR_[A-Z0-9_]+/i;

        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e || !e.msg) continue;
          const msg = e.msg;

          if (/No app certificate provided|TokenManager not initialized/i.test(msg)) {
            push(e, i, 'warning', 'cert');
            continue;
          }
          if (/Failed to send message:/i.test(msg)) {
            push(e, i, e.level === 'E' ? 'error' : 'warning', 'routing');
            continue;
          }
          if (/Failed to find destination/i.test(msg)) {
            push(e, i, 'warning', 'routing');
            continue;
          }

          if (!rtcStack.test(msg)) continue;
          if (e.level === 'E') {
            push(e, i, 'error', 'sdk');
            continue;
          }
          if (e.level === 'W' && sdkSeriousW.test(msg)) {
            push(e, i, 'warning', 'sdk');
          }
        }
        return { items };
      }

      /**
       * NCS insights (agent joined/left/errors + memory history).
       * Observed patterns in the same log:
       * - "ncs on_agent_joined { ... }"
       * - "ncs on_agent_left { ... }"
       * - "KEYPOINT ncs on_agent_memory { ... contents:[{content, role, turn_id, timestamp, metadata}] }"
       */
      function extractNcsInsights(entries) {
        const events = [];
        const memoryItems = [];
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg) continue;
          if (!e.msg.includes('ncs')) continue;

          // Example: "ncs on_agent_left", "KEYPOINT ncs on_agent_memory"
          let eventType = null;
          const mType = e.msg.match(/\bncs\s+((?:on_)?[A-Za-z0-9_]+)\b/);
          if (mType) eventType = mType[1];
          if (!eventType) continue;

          // Parse payload: usually Python-dict-ish (single quotes), not strict JSON.
          let payload = tryParsePythonDict(e.msg);
          if (!payload) payload = tryParseJSON(e.msg);
          const agentId = payload && typeof payload === 'object' ? (payload.agent_id || null) : null;

          // Memory: eventType contains "memory" and payload includes "contents" list.
          if (eventType && /memory/i.test(eventType)) {
            // tryParsePythonDict can fail when the memory content contains apostrophes (e.g. "I'm ..."),
            // because it replaces all `'` with `"` indiscriminately. For memory, convert only python *keys* and
            // single-quoted *values* (not the double-quoted content string).
            function tryParseNcsMemoryDict(msg) {
              const start = msg.indexOf('{');
              if (start < 0) return null;
              let depth = 0;
              let end = -1;
              let inSingle = false;
              let inDouble = false;
              let escaped = false;
              for (let j = start; j < msg.length; j++) {
                const ch = msg[j];
                if (escaped) { escaped = false; continue; }
                if (ch === '\\') { escaped = true; continue; }
                if (!inDouble && ch === '\'') { inSingle = !inSingle; continue; }
                if (!inSingle && ch === '"') { inDouble = !inDouble; continue; }
                if (inSingle || inDouble) continue;
                if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
              }
              if (end < 0) return null;
              const dictStr = msg.slice(start, end);
              // 1) keys: 'foo':  -> "foo":
              let converted = dictStr.replace(/'([A-Za-z0-9_]+)'\s*:/g, '"$1":');
              // 2) simple string values: : 'bar' -> : "bar"
              converted = converted.replace(/:\s*'([^']*)'/g, ': "$1"');
              // 3) Python literals:
              converted = converted.replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
              try { return JSON.parse(converted); } catch (_) { return null; }
            }

            if (!(payload && typeof payload === 'object' && Array.isArray(payload.contents))) {
              const payload2 = tryParseNcsMemoryDict(e.msg);
              if (payload2) payload = payload2;
            }

            if (payload && typeof payload === 'object' && Array.isArray(payload.contents)) {
              for (const item of payload.contents) {
                if (!item) continue;
                const md = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
                const confidence = (md.asr_info && md.asr_info.confidence != null) ? md.asr_info.confidence : null;
                const interruptMode = md.interrupt_mode != null ? md.interrupt_mode : null;
                const interrupted = (md.interrupted === true) || String(md.interrupted || '').toLowerCase() === 'true';
                const interruptTimestampMs = md.interrupt_timestamp != null ? md.interrupt_timestamp : null;
                memoryItems.push({
                  ts: e.ts,
                  agent_id: agentId,
                  start_ts: payload.start_ts != null ? payload.start_ts : null,
                  stop_ts: payload.stop_ts != null ? payload.stop_ts : null,
                  timestamp_ms: item.timestamp != null ? item.timestamp : null,
                  role: item.role != null ? item.role : null,
                  turn_id: item.turn_id != null ? item.turn_id : null,
                  source: item.metadata && item.metadata.source != null ? item.metadata.source : null,
                  interrupted: interrupted,
                  confidence: confidence,
                  interrupt_mode: interruptMode,
                  interrupt_timestamp_ms: interruptTimestampMs,
                  text: item.content != null ? item.content : null,
                  entryIndex: i
                });
              }
            } else {
              // Still show something for the event.
              memoryItems.push({
                ts: e.ts,
                agent_id: agentId,
                start_ts: null,
                stop_ts: null,
                timestamp_ms: null,
                role: null,
                turn_id: null,
                source: null,
                interrupted: false,
                confidence: null,
                interrupt_mode: null,
                interrupt_timestamp_ms: null,
                text: e.msg,
                entryIndex: i
              });
            }
            continue;
          }

          // Non-memory events: joined/left/etc.
          const status = payload && typeof payload === 'object' ? (payload.status != null ? payload.status : null) : null;
          const message = payload && typeof payload === 'object' ? (payload.message != null ? payload.message : null) : null;
          const channel = payload && typeof payload === 'object' ? (payload.channel != null ? payload.channel : null) : null;
          const startTs = payload && typeof payload === 'object' ? (payload.start_ts != null ? payload.start_ts : null) : null;
          const stopTs = payload && typeof payload === 'object' ? (payload.stop_ts != null ? payload.stop_ts : null) : null;
          events.push({
            ts: e.ts,
            event_type: eventType,
            agent_id: agentId,
            start_ts: startTs,
            stop_ts: stopTs,
            status,
            message,
            channel,
            entryIndex: i
          });
        }
        return { events, memoryItems };
      }

      function extractRtmTab(entries) {
        const out = { events: [], stats: { presence_events: 0, message_events: 0, presence_sets: 0 } };
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg) continue;
          if (e.msg.includes('rtm_presence_event')) out.stats.presence_events++;
          if (e.msg.includes('rtm_message_event')) out.stats.message_events++;
          if (e.msg.includes('set_presence_state')) out.stats.presence_sets++;
          if (/\[agora_rtm\]|\brtm\.cc\b|rtm_(presence|message)_event|set_presence_state|Subscribe channel|Login@rtm\.cc|Rtm client/i.test(e.msg)) {
            out.events.push({
              ts: e.ts,
              ext: e.ext || '',
              level: e.level || '',
              msg: redactInlineSecrets(e.msg).slice(0, 260),
              entryIndex: i
            });
          }
        }
        return out;
      }

      function extractToolsTab(entries) {
        const out = { events: [], toolCalls: {}, mcpErrors: [], servers: [], totalTools: null, isToolCallAvailable: null };
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg) continue;
          if (e.msg.includes('MCP [key_point] config loaded:')) {
            const mAvail = e.msg.match(/is_tool_call_available=([A-Za-z]+)/);
            if (mAvail) out.isToolCallAvailable = (mAvail[1] === 'True' || mAvail[1] === 'true');
          }
          if (e.msg.includes('connecting to server:')) {
            const m = e.msg.match(/connecting to server:\s*([^(]+)\s*\(([^)]+)\)/i);
            if (m) {
              const name = (m[1] || '').trim();
              const transport = (m[2] || '').trim();
              if (name && !out.servers.some(s => s.name === name)) out.servers.push({ name, transport, url: null });
            }
          }
          if (e.msg.includes('initialization completed: total_tools=')) {
            const m = e.msg.match(/total_tools=(\d+)/);
            if (m) out.totalTools = parseInt(m[1], 10);
          }
          const urlMatch = e.msg.match(/https?:\/\/[^\s"']+/);
          if (urlMatch && /\/mcp\//i.test(urlMatch[0]) && out.servers.length) {
            const last = out.servers[out.servers.length - 1];
            if (last && !last.url) last.url = urlMatch[0];
          }
          if (e.level === 'E' && e.ext === 'mcp_client' && e.msg.includes('MCP') && e.msg.includes('failed')) {
            out.mcpErrors.push({ ts: e.ts || '', msg: redactInlineSecrets(e.msg).slice(0, 220), entryIndex: i });
          }
          // Mirror the summary.tools.tool_calls logic: only count the canonical dispatch
          // line (`tool_call_with_retry ... tool_call NAME with args`). Keeps MCP, built-in
          // (`_speak`, `_interrupt`, `_leave`), and future user-defined tools intact while
          // avoiding triple counts and the newline/timestamp false-positive that `\s` caused.
          if (e.msg.includes('tool_call_with_retry') && e.msg.includes(' with args')) {
            const m = e.msg.match(/tool_call[ \t]+([A-Za-z_][A-Za-z0-9_\-]*)[ \t]+with args/);
            if (m) {
              const name = m[1];
              out.toolCalls[name] = (out.toolCalls[name] || 0) + 1;
            }
          }
          if (/\[mcp_client\]|\bMCP \[key_point\]|\btool_call\b|\btool_result\b/i.test(e.msg)) {
            out.events.push({ ts: e.ts, ext: e.ext || '', level: e.level || '', msg: redactInlineSecrets(e.msg).slice(0, 260), entryIndex: i });
          }
        }
        return out;
      }

      function extractSipTab(entries, summary) {
        const out = {
          enabled: null,
          applyMode: null,
          sipDefaultEnabled: null,
          fromNumber: null,
          toNumber: null,
          campaignId: null,
          callId: null,
          managerJobs: [],
          events: [],
          stats: { manager_events: 0, call_events: 0 }
        };
        const info = summary && summary.eventStartInfo && summary.eventStartInfo.taskInfo && summary.eventStartInfo.taskInfo.info
          ? summary.eventStartInfo.taskInfo.info
          : null;
        if (info && Object.prototype.hasOwnProperty.call(info, 'ENABLE_SIP')) out.enabled = info.ENABLE_SIP;
        const labels = info && info.LABELS && typeof info.LABELS === 'object' ? info.LABELS : (summary && summary.sipLabels ? summary.sipLabels : null);
        if (labels) {
          out.fromNumber = labels._from_number || null;
          out.toNumber = labels._to_number || null;
          out.campaignId = labels._campaign_id || null;
          out.callId = labels._call_id || labels._sip_call_id || null;
        }
        const managerJobSeen = new Set();
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e || !e.msg) continue;
          const msg = e.msg;
          if ((!out.fromNumber || !out.toNumber || !out.campaignId || !out.callId) && msg.includes('ipc_slave_start') && msg.includes('slaveServiceEventPayload')) {
            const ipc = parseIpcSlaveStartPayload(msg);
            const labels2 = ipc && ipc.eventPayload && ipc.eventPayload.taskInfo && ipc.eventPayload.taskInfo.info && ipc.eventPayload.taskInfo.info.LABELS
              ? ipc.eventPayload.taskInfo.info.LABELS
              : null;
            if (labels2) {
              if (!out.fromNumber) out.fromNumber = labels2._from_number || null;
              if (!out.toNumber) out.toNumber = labels2._to_number || null;
              if (!out.campaignId) out.campaignId = labels2._campaign_id || null;
              if (!out.callId) out.callId = labels2._call_id || labels2._sip_call_id || null;
            }
          }
          const sipDefaultMatch = msg.match(/\\?"sip_default\\?"\s*:\s*\{[^}]*?\\?"apply_mode\\?"\s*:\s*\\?"([^"\\]+)\\?"[^}]*?\\?"enable\\?"\s*:\s*(true|false)/i)
            || msg.match(/['"]sip_default['"]\s*:\s*\{[^}]*?['"]apply_mode['"]\s*:\s*['"]([^'"]+)['"][^}]*?['"]enable['"]\s*:\s*(true|false)/i);
          if (sipDefaultMatch) {
            if (!out.applyMode) out.applyMode = sipDefaultMatch[1];
            if (out.sipDefaultEnabled == null) out.sipDefaultEnabled = String(sipDefaultMatch[2]).toLowerCase() === 'true';
          }
          const managerMatch = msg.match(/\btool["']?\s*:\s*["']([^"']*sip[^"']*)["']/i) || msg.match(/\btool[:=]\s*([A-Za-z0-9_\-]*sip[A-Za-z0-9_\-]*)/i);
          const reasonMatch = msg.match(/\breason["']?\s*:\s*["']([^"']+)["']/i);
          const durationMatch = msg.match(/\bduration_ms["']?\s*:\s*(\d+)/i);
          if (/mcp_servers\/sip-manager|sip-silence-hangup|silence_hangup/i.test(msg)) {
            out.stats.manager_events++;
            const tool = managerMatch ? managerMatch[1] : (/sip-silence-hangup/i.test(msg) ? 'sip-silence-hangup' : null);
            const reason = reasonMatch ? reasonMatch[1] : (/silence_hangup/i.test(msg) ? 'silence_hangup' : null);
            const durationMs = durationMatch ? parseInt(durationMatch[1], 10) : null;
            const key = (tool || '') + '|' + (reason || '') + '|' + (durationMs != null ? durationMs : '');
            if (tool && !managerJobSeen.has(key)) {
              managerJobSeen.add(key);
              out.managerJobs.push({ tool, reason, durationMs });
            }
          }
          if (/\b(sip_default|sip-manager|sip[-_ ]|invite|ring(?:ing)?|hangup|bye|dtmf)\b/i.test(msg)) {
            out.stats.call_events++;
            out.events.push({
              ts: e.ts,
              ext: e.ext || '',
              level: e.level || '',
              msg: redactInlineSecrets(msg).slice(0, 300),
              entryIndex: i
            });
          }
        }
        return out;
      }

      function extractV2vTab(entries, enabled) {
        if (!enabled) return { events: [], stats: { assistant_transcriptions: 0, user_transcriptions: 0, mllm_source: 0, chat_completion_data: 0 } };
        const out = { events: [], stats: { assistant_transcriptions: 0, user_transcriptions: 0, mllm_source: 0, chat_completion_data: 0 } };
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg) continue;
          const msg = e.msg;
          const isV2v =
            e.ext === 'v2v' ||
            /\[v2v\]/i.test(msg) ||
            /assistant\.transcription|user\.transcription/.test(msg) ||
            /"source":"mllm"|'source':\s*'mllm'/.test(msg) ||
            /\bon_data name chat_completion\b/.test(msg);
          if (!isV2v) continue;

          if (/assistant\.transcription/.test(msg)) out.stats.assistant_transcriptions++;
          if (/user\.transcription/.test(msg)) out.stats.user_transcriptions++;
          if (/"source":"mllm"|'source':\s*'mllm'|\bsource=mllm\b/.test(msg)) out.stats.mllm_source++;
          if (/\bon_data name chat_completion\b/.test(msg)) out.stats.chat_completion_data++;

          out.events.push({
            ts: e.ts,
            ext: e.ext || '',
            level: e.level || '',
            msg: redactInlineSecrets(msg).slice(0, 300),
            entryIndex: i
          });
        }
        return out;
      }

      function extractV2vTranscriptions(entries, enabled) {
        if (!enabled) return [];
        const out = [];
        const seen = new Set();
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e || !e.msg) continue;
          let j = e.json;
          if (!j && e.msg.includes('transcription') && e.msg.includes('"object"')) j = tryParseJSON(e.msg);
          if (!j || typeof j !== 'object') continue;
          if (j.object !== 'assistant.transcription' && j.object !== 'user.transcription') continue;
          if (j.text == null || String(j.text).trim() === '') continue;
          const source = j.metadata && j.metadata.source != null ? String(j.metadata.source) : '';
          if (source && source.toLowerCase() !== 'mllm') continue;
          const speaker = j.object === 'assistant.transcription' ? 'agent' : 'user';
          const row = {
            speaker,
            source: source || 'mllm',
            ts: e.ts,
            text: typeof j.text === 'string' ? j.text : String(j.text),
            final: j.final === true ? true : (j.final === false ? false : null),
            turn_id: j.turn_id != null ? j.turn_id : null,
            start_ms: j.start_ms != null ? j.start_ms : null,
            duration_ms: j.duration_ms != null ? j.duration_ms : null,
            language: j.language || null,
            entryIndex: i
          };
          const key = row.speaker + '|' + (row.turn_id != null ? row.turn_id : '') + '|' + row.text + '|' + (row.start_ms != null ? row.start_ms : '');
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(row);
        }
        return out;
      }

      function extractAvatarTab(entries) {
        const out = { events: [], hasAvatarExt: false, vendors: new Set(), avatarIds: new Set(), channel: null, uid: null, quality: null, video_encoding: null, api_url: null };
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg) continue;
          if (e.ext === 'avatar' || /\[avatar\]/.test(e.msg) || /heygen_avatar_python/i.test(e.msg)) out.hasAvatarExt = true;
          if (e.msg.includes('AVATAR_VENDOR')) {
            const m = e.msg.match(/AVATAR_VENDOR['"]?\s*[:=]\s*['"]([^'"]+)['"]/);
            if (m) out.vendors.add(m[1]);
          }
          if (e.msg.includes('AVATAR_ID')) {
            const m = e.msg.match(/AVATAR_ID['"]?\s*[:=]\s*['"]([^'"]+)['"]/);
            if (m) out.avatarIds.add(m[1]);
          }
          if (!out.channel && /\[avatar\]/.test(e.msg) && /agora_settings/i.test(e.msg) && /\bchannel\b/i.test(e.msg) && /\buid\b/i.test(e.msg)) {
            const mCh = e.msg.match(/['"]channel['"]\s*:\s*['"]([^'"]+)['"]/i);
            const mUid = e.msg.match(/['"]uid['"]\s*:\s*['"]?(\d+)['"]?/i);
            if (mCh) out.channel = mCh[1];
            if (mUid) out.uid = mUid[1];
            const mQ = e.msg.match(/['"]quality['"]\s*:\s*['"]([^'"]+)['"]/i);
            if (mQ) out.quality = mQ[1];
            const mEnc = e.msg.match(/['"]video_encoding['"]\s*:\s*['"]([^'"]+)['"]/i);
            if (mEnc) out.video_encoding = mEnc[1];
            const mUrl = e.msg.match(/to\s+(https?:\/\/[^\s]+)\s+with payload:/i);
            if (mUrl) out.api_url = mUrl[1];
          }
          if (e.ext === 'avatar' || /\[avatar\]/.test(e.msg) || /avatar/i.test(e.ext || '') || /heygen_avatar_python/i.test(e.msg)) {
            out.events.push({ ts: e.ts, ext: e.ext || '', level: e.level || '', msg: redactInlineSecrets(e.msg).slice(0, 260), entryIndex: i });
          }
        }
        out.vendors = Array.from(out.vendors);
        out.avatarIds = Array.from(out.avatarIds);
        return out;
      }

      /** Performance metrics per turn. Aligns with report_controller + llm key_point lines (glue ttfb, connect times, _log_and_report_latency).
       *  Policy: every field is "first-wins" unless the source is explicitly more authoritative:
       *    - report_controller JSON is the *reported* E2E, so it overwrites vad/bhvs_delay and sets end_to_end_reported_ms.
       *    - All other sources (metric_message, per-event regex) fill missing values but never overwrite.
       *  No synthetic defaults are ever inserted — if a value is not logged, it stays null (→ rendered as N/A). */
      function extractPerformanceMetrics(entries) {
        const byTurn = {};
        /* `connect times:` is logged on the llm extension thread without a turn_id; we pair it with the *next* glue ttfb
         * line on the same thread.  We also track when the pending value was captured so a stale one (e.g. after an aborted
         * request that never produced a glue line) is discarded instead of being mis-attributed to the next turn. */
        let pendingLlmConnect = null;
        const CONNECT_PAIR_WINDOW_SEC = 5;
        function ensure(turnId) {
          if (!byTurn[turnId]) byTurn[turnId] = { turn_id: turnId };
          return byTurn[turnId];
        }
        for (const e of entries) {
          if (!e.msg) continue;
          const tsSec = e.ts != null ? parseLogTs(e.ts) / 1000 : null;
          function setTs(turnId) {
            if (tsSec != null && byTurn[turnId]) byTurn[turnId].ts = Math.max(byTurn[turnId].ts || 0, tsSec);
          }
          const connectM = e.msg.match(/\[llm\]\s*connect times:\s*([\d.]+)\s/);
          if (connectM) {
            const sec = parseFloat(connectM[1]);
            if (!isNaN(sec)) pendingLlmConnect = { ms: Math.round(sec * 1000), tsSec: tsSec };
          }
          const glueTtfb = e.msg.match(/\[llm\]\s*glue\s*\[turn_id:(\d+)\]\s*\[ttfb:(\d+)ms\]/);
          if (glueTtfb) {
            const turnId = parseInt(glueTtfb[1], 10);
            const row = ensure(turnId);
            if (row.llm_ttfb == null) row.llm_ttfb = parseInt(glueTtfb[2], 10);
            if (pendingLlmConnect != null && row.llm_connect == null) {
              const dt = (tsSec != null && pendingLlmConnect.tsSec != null) ? (tsSec - pendingLlmConnect.tsSec) : 0;
              if (dt >= 0 && dt <= CONNECT_PAIR_WINDOW_SEC) row.llm_connect = pendingLlmConnect.ms;
            }
            pendingLlmConnect = null;
            setTs(turnId);
          }
          const ttfsM = e.msg.match(/\[turn_id:(\d+)\]\s*\[ttfs:(\d+)ms\]/);
          if (ttfsM && e.msg.includes('_track_first_sentence')) {
            const turnId = parseInt(ttfsM[1], 10);
            const row = ensure(turnId);
            if (row.llm_ttfs == null) row.llm_ttfs = parseInt(ttfsM[2], 10);
            setTs(turnId);
          }
          const llmLat = e.msg.match(/Sending llm_latency metric:\s*turn_id=(\d+),\s*ttfb=(\d+)ms,\s*ttfs=(\d+)ms/);
          if (llmLat) {
            const turnId = parseInt(llmLat[1], 10);
            const row = ensure(turnId);
            if (row.llm_ttfb == null) row.llm_ttfb = parseInt(llmLat[2], 10);
            if (row.llm_ttfs == null) row.llm_ttfs = parseInt(llmLat[3], 10);
            setTs(turnId);
          }
          if (e.msg.indexOf('[report_controller]') >= 0 && e.msg.indexOf('end_to_end_latency_ms') >= 0) {
            const start = e.msg.indexOf('{', e.msg.indexOf('[report_controller]'));
            if (start >= 0) {
              let d = 0, end = start;
              for (; end < e.msg.length; end++) {
                if (e.msg.charAt(end) === '{') d++;
                else if (e.msg.charAt(end) === '}') { d--; if (d === 0) { end++; break; } }
              }
              const j = tryParseJSON(e.msg.slice(start, end));
              if (j && j.turn_id != null && j.end_to_end_latency_ms != null) {
                const turnId = parseInt(j.turn_id, 10);
                const row = ensure(turnId);
                if (j.bhvs_duration_ms != null) row.bhvs_delay = parseInt(j.bhvs_duration_ms, 10);
                /* VAD only when log gives it: silence_duration_ms (EOS) + fixed padding — same as upstream report */
                if (j.silence_duration_ms != null) row.vad = parseInt(j.silence_duration_ms, 10) + 160;
                row.end_to_end_reported_ms = parseInt(j.end_to_end_latency_ms, 10);
                setTs(turnId);
              }
            }
          }
          /* [metric_message:{...}] — use balanced-brace scan so array/object values in the JSON don't break parsing. */
          const mmIdx = e.msg.indexOf('[metric_message:');
          if (mmIdx >= 0) {
            const mmStart = e.msg.indexOf('{', mmIdx);
            if (mmStart >= 0) {
              let d = 0, mmEnd = mmStart;
              for (; mmEnd < e.msg.length; mmEnd++) {
                const ch = e.msg.charAt(mmEnd);
                if (ch === '{') d++;
                else if (ch === '}') { d--; if (d === 0) { mmEnd++; break; } }
              }
              const j = tryParseJSON(e.msg.slice(mmStart, mmEnd));
              if (j && j.turn_id != null) {
                const turnId = parseInt(j.turn_id, 10);
                const row = ensure(turnId);
                if (j.metric_name === 'aivad_delay' && j.latency_ms != null && row.aivad_delay == null) row.aivad_delay = parseInt(j.latency_ms, 10);
                if (j.metric_name === 'ttlw' && j.module === 'asr' && j.latency_ms != null && row.asr_ttlw == null) row.asr_ttlw = parseInt(j.latency_ms, 10);
                if (j.metric_name === 'vad' && j.latency_ms != null && row.vad == null) row.vad = parseInt(j.latency_ms, 10);
                if (j.module === 'llm' && j.latency_ms != null) {
                  if ((j.metric_name === 'connect_delay' || j.metric_name === 'connect') && row.llm_connect == null) row.llm_connect = parseInt(j.latency_ms, 10);
                  else if (j.metric_name === 'ttfb' && row.llm_ttfb == null) row.llm_ttfb = parseInt(j.latency_ms, 10);
                  else if (j.metric_name === 'ttfs' && row.llm_ttfs == null) row.llm_ttfs = parseInt(j.latency_ms, 10);
                }
                setTs(turnId);
              }
            }
          }
          const ttlw = e.msg.match(/Turn TTLW recorded:\s*turn_id=(\d+),\s*ttlw=(\d+)ms/);
          if (ttlw) {
            const turnId = parseInt(ttlw[1], 10);
            const row = ensure(turnId);
            if (row.asr_ttlw == null) row.asr_ttlw = parseInt(ttlw[2], 10);
            setTs(turnId);
          }
          const ttsTtfb = e.msg.match(/tts_ttfb:\s*(\d+)\s+of request_id:\s*(\d+)/);
          if (ttsTtfb) {
            const turnId = parseInt(ttsTtfb[2], 10);
            const row = ensure(turnId);
            if (row.tts_ttfb == null) row.tts_ttfb = parseInt(ttsTtfb[1], 10);
            setTs(turnId);
          }
          /* Python-dict style TTS report line, e.g. `...report_controller... 'turn_id': 5, ..., 'ttfb': 421, ...`
           * Require 'ttfb' to follow 'turn_id' so we only pair fields from the same dict object. */
          if (e.msg.includes('report_controller') && e.msg.includes("'ttfb'") && e.msg.includes("'turn_id'")) {
            const pair = e.msg.match(/'turn_id':\s*(\d+)[\s\S]*?'ttfb':\s*(\d+)/);
            if (pair) {
              const turnId = parseInt(pair[1], 10);
              const row = ensure(turnId);
              if (row.tts_ttfb == null) row.tts_ttfb = parseInt(pair[2], 10);
              setTs(turnId);
            }
          }
          const aivadEnd = e.msg.match(/aivad_eval eval_id:\s*turn_(\d+)_[^\s]+\s+end in (\d+)ms/);
          if (aivadEnd) {
            const turnId = parseInt(aivadEnd[1], 10);
            const row = ensure(turnId);
            if (row.aivad_delay == null) row.aivad_delay = parseInt(aivadEnd[2], 10);
            setTs(turnId);
          }
          if (e.msg.includes('bhvs_delay')) {
            const latM = e.msg.match(/latency_ms["']?\s*:\s*(\d+)/);
            const turnM = e.msg.match(/"turn_id"\s*:\s*(\d+)/);
            if (latM && turnM) {
              const turnId = parseInt(turnM[1], 10);
              const row = ensure(turnId);
              if (row.bhvs_delay == null) row.bhvs_delay = parseInt(latM[1], 10);
              setTs(turnId);
            }
          }
        }
        return Object.values(byTurn).sort((a, b) => a.turn_id - b.turn_id);
      }

      /** User speech from ASR: send_asr_result, vendor_result, and ten:runtime Publish Message content user.transcription (has final) */
      function extractUserAsrTranscripts(entries) {
        const out = [];
        // Rolling cache of the most recent `vendor_result: on_recognized: {...}`
        // alternative. Some vendors (e.g., Deepgram) only emit per-utterance
        // confidence on the raw recognizer line and never propagate it to the
        // downstream `send_asr_result` / `user.transcription`. We capture it
        // here and attach it to the next matching transcript (same text, or
        // the immediate next frame if text is empty) so the Turns/STT views
        // still get an authoritative number. Keyed by (text, final).
        let lastVendorConf = null; // { confidence, transcript, final, entryIndex }
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg) continue;
          // Capture raw vendor_result confidence when present. JSON shape:
          //   vendor_result: on_recognized: {"channel":{"alternatives":[{"transcript":"...","confidence":0.93,"words":[...]}]},"is_final":true,...}
          // We only keep frames with a non-empty transcript — Deepgram emits
          // dozens of empty filler frames with `confidence: 0.0` that would
          // otherwise swamp the averages and match against the next empty
          // downstream frame.
          if (e.msg.includes('vendor_result:') && e.msg.includes('on_recognized:') && e.msg.includes('"confidence"')) {
            const jsonStart = e.msg.indexOf('{');
            if (jsonStart >= 0) {
              const vj = tryParseJSON(e.msg.slice(jsonStart));
              if (vj && vj.channel && Array.isArray(vj.channel.alternatives) && vj.channel.alternatives.length) {
                const alt = vj.channel.alternatives[0];
                const transcript = typeof alt.transcript === 'string' ? alt.transcript : '';
                if (alt && typeof alt.confidence === 'number' && isFinite(alt.confidence) && transcript.trim().length > 0) {
                  lastVendorConf = {
                    confidence: alt.confidence,
                    transcript: transcript,
                    final: vj.is_final === true,
                    entryIndex: i,
                  };
                }
              }
            }
          }
          if (e.msg.includes('Message content:') && e.msg.includes('user.transcription')) {
            let j = e.json;
            if (!j || j.object !== 'user.transcription') {
              const idx = e.msg.indexOf('Message content:');
              if (idx >= 0) {
                const jsonStr = e.msg.slice(e.msg.indexOf('{', idx));
                j = tryParseJSON(jsonStr);
              }
            }
            if (j && j.object === 'user.transcription' && j.text != null) {
              // Many ASR vendors attach an overall-utterance confidence at
              // `metadata.asr_info.confidence` (0..1). Some logs surface it
              // at the top level too — honor both. If the downstream payload
              // doesn't carry a confidence but we just saw a vendor_result
              // line with a matching transcript, reuse that score (Deepgram
              // drops it between the raw recognizer and the user.transcription
              // conversion).
              let conf = null;
              if (j.metadata && j.metadata.asr_info && typeof j.metadata.asr_info.confidence === 'number') {
                conf = j.metadata.asr_info.confidence;
              } else if (typeof j.confidence === 'number') {
                conf = j.confidence;
              } else if (lastVendorConf && typeof j.text === 'string' && j.text.trim().length > 0 && lastVendorConf.transcript === j.text) {
                conf = lastVendorConf.confidence;
              }
              out.push({
                ts: e.ts,
                text: typeof j.text === 'string' ? j.text : '',
                final: typeof j.final === 'boolean' ? j.final : null,
                start_ms: j.start_ms != null ? j.start_ms : null,
                duration_ms: j.duration_ms != null ? j.duration_ms : null,
                language: (j.language != null && j.language !== '') ? j.language : null,
                turn_id: j.turn_id != null ? j.turn_id : null,
                confidence: conf,
                entryIndex: i
              });
            }
          }
          if (e.msg.includes('send_asr_result:')) {
            const textMatch = e.msg.match(/'text':\s*'((?:[^'\\]|\\.)*)'/);
            const finalMatch = e.msg.match(/'final':\s*(True|False)/);
            const startMatch = e.msg.match(/'start_ms':\s*(\d+)/);
            const durMatch = e.msg.match(/'duration_ms':\s*(\d+)/);
            const langMatch = e.msg.match(/'language':\s*'([^']*)'/);
            const turnMatch = e.msg.match(/'turn_id':\s*(\d+)/);
            // Typical shape: `'metadata': {'asr_info': {'confidence': 0.91}, ...}`.
            // Use a non-greedy match scoped to the asr_info dict so we don't
            // accidentally grab a numeric field from another part of the log.
            const confMatch = e.msg.match(/'asr_info'\s*:\s*\{[^}]*?'confidence'\s*:\s*([0-9.eE+-]+)/);
            if (textMatch) {
              const text = textMatch[1].replace(/\\'/g, "'");
              let conf = confMatch ? parseFloat(confMatch[1]) : null;
              // Deepgram-via-SIP drops confidence on send_asr_result but the
              // previous vendor_result line carries it. Match by transcript
              // (ignoring empty strings so bogus 0.0 scores aren't attached).
              if (conf == null && text.trim().length > 0 && lastVendorConf && lastVendorConf.transcript === text) {
                conf = lastVendorConf.confidence;
              }
              out.push({
                ts: e.ts,
                text: text,
                final: finalMatch ? finalMatch[1] === 'True' : null,
                start_ms: startMatch ? parseInt(startMatch[1], 10) : null,
                duration_ms: durMatch ? parseInt(durMatch[1], 10) : null,
                language: langMatch ? langMatch[1] : null,
                turn_id: turnMatch ? parseInt(turnMatch[1], 10) : null,
                confidence: conf,
                entryIndex: i
              });
            }
          }
          // message_collector user transcript shape (authoritative user finality):
          // "[message_collector] on_data text: <text> turn_id: N is_final: <True|False> stream_id: N"
          // stream_id identifies the user stream; turn_status is only on agent lines.
          if (e.msg.includes('[message_collector]') && e.msg.includes('on_data text:') && e.msg.includes('stream_id:') && !e.msg.includes('turn_status:')) {
            const mc = e.msg.match(/on_data text:\s*([\s\S]*?)\s+turn_id:\s*(\d+)\s+is_final:\s*(True|False)\s+stream_id:\s*(\d+)/);
            if (mc) {
              const txt = mc[1].trim();
              if (txt.length > 0) {
                out.push({
                  ts: e.ts,
                  text: txt,
                  final: mc[3] === 'True',
                  start_ms: null,
                  duration_ms: null,
                  language: null,
                  turn_id: Number(mc[2]),
                  stream_id: Number(mc[4]),
                  entryIndex: i
                });
              }
            }
          }
          if (e.msg.includes('vendor_result:') && e.msg.includes('SonioxTranscriptToken(text=')) {
            const tokens = [];
            const re = /SonioxTranscriptToken\(text='((?:[^'\\]|\\.)*)'/g;
            let m;
            while ((m = re.exec(e.msg)) !== null) tokens.push(m[1].replace(/\\'/g, "'"));
            if (tokens.length) {
              const text = tokens.join('').replace(/\s+/g, ' ').trim();
              const finalMatch = e.msg.match(/final_audio_proc_ms:\s*(\d+)/);
              const totalMatch = e.msg.match(/total_audio_proc_ms:\s*(\d+)/);
              out.push({
                ts: e.ts,
                text: text,
                final: null,
                start_ms: null,
                duration_ms: totalMatch ? parseInt(totalMatch[1], 10) : null,
                language: null,
                turn_id: null,
                from_vendor: true,
                final_audio_proc_ms: finalMatch ? parseInt(finalMatch[1], 10) : null,
                entryIndex: i
              });
            }
          }
        }
        return out;
      }

      /** User/agent turns from eval_id + messages JSON (e.g. aivad_eval payload, cmd_json raw) */
      function extractEvalIdMessages(entries) {
        const out = [];
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          let j = e.json;
          if (!j && e.msg && (e.msg.includes('eval_id') && e.msg.includes('messages'))) {
            j = tryParseJSON(e.msg);
            if (!j) {
              const pyPayload = e.msg.match(/payload:\s*\{'eval_id':\s*'([^']+)',\s*'messages':\s*\[(.*?)\]\s*\}/s);
              if (pyPayload) {
                const evalId = pyPayload[1];
                const turnM = evalId.match(/turn_(\d+)_/);
                const turnId = turnM ? parseInt(turnM[1], 10) : null;
                const contentRe = /'content':\s*'((?:[^'\\]|\\.)*)'/g;
                let m;
                while ((m = contentRe.exec(pyPayload[2])) !== null) {
                  out.push({ speaker: 'user', turn: turnId, ts: e.ts, text: m[1].replace(/\\'/g, "'"), final: null, start_ms: null, duration_ms: null, language: null, entryIndex: i });
                }
              }
            }
          }
          if (j && typeof j.eval_id === 'string' && Array.isArray(j.messages)) {
            const turnM = j.eval_id.match(/turn_(\d+)_/);
            const turnId = turnM ? parseInt(turnM[1], 10) : null;
            for (const msg of j.messages) {
              if (msg && (msg.role === 'user' || msg.role === 'assistant') && msg.content != null) {
                const speaker = msg.role === 'user' ? 'user' : 'agent';
                out.push({
                  speaker,
                  turn: msg.turn_id != null ? msg.turn_id : turnId,
                  ts: e.ts,
                  text: typeof msg.content === 'string' ? msg.content : (msg.content && msg.content.text) || '',
                  final: null,
                  start_ms: msg.start_ms != null ? msg.start_ms : null,
                  duration_ms: msg.duration_ms != null ? msg.duration_ms : null,
                  language: msg.language || null,
                  entryIndex: i
                });
              }
            }
          }
        }
        return out;
      }

      /** User + agent turns from LLM glue payload: "glue [turn_id:N]: {messages:[...]}". Emit all user/assistant messages; buildTurnsList dedupes by (turn, speaker). */
      function extractLlmGlueMessages(entries) {
        const out = [];
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg || !e.msg.includes('glue [turn_id:') || !e.msg.includes('"messages"')) continue;
          let j = e.json;
          if (!j || !Array.isArray(j.messages)) {
            const colonIdx = e.msg.indexOf(']: ', e.msg.indexOf('glue [turn_id:'));
            const jsonStr = colonIdx >= 0 ? e.msg.slice(colonIdx + 3) : e.msg;
            j = tryParseJSON(jsonStr);
          }
          if (!j || !Array.isArray(j.messages)) continue;
          for (const msg of j.messages) {
            if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
            const content = typeof msg.content === 'string' ? msg.content : (msg.content && msg.content.text) || '';
            if (!content) continue;
            const turnId = msg.turn_id != null ? msg.turn_id : null;
            const speaker = msg.role === 'user' ? 'user' : 'agent';
            out.push({ speaker, turn: turnId, ts: e.ts, text: content, final: null, start_ms: msg.start_ms != null ? msg.start_ms : null, duration_ms: msg.duration_ms != null ? msg.duration_ms : null, language: msg.language || null, entryIndex: i });
          }
        }
        return out;
      }

      function extractTurnInterruptions(entries) {
        const out = [];
        const seen = new Set();
        function add(turnId, ts, reason, entryIndex) {
          if (turnId == null || isNaN(turnId)) return;
          const key = String(turnId) + '|' + String(reason || '') + '|' + String(entryIndex);
          if (seen.has(key)) return;
          seen.add(key);
          out.push({ turn_id: turnId, ts: ts || '', reason: reason || null, entryIndex });
        }

        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const msg = e.msg || '';
          if (!msg || msg.indexOf('interrupted') === -1) continue;

          // Agent tracer view shape: one log line can contain many Python-repr
          // spans. For each `name: turn` span, look for its explicit turn_id and
          // an interrupted end status inside that span.
          let searchFrom = 0;
          while (searchFrom < msg.length) {
            let idx = msg.indexOf("'name': 'turn'", searchFrom);
            let jsonStyle = false;
            const idxJson = msg.indexOf('"name":"turn"', searchFrom);
            if (idx === -1 || (idxJson !== -1 && idxJson < idx)) {
              idx = idxJson;
              jsonStyle = idxJson !== -1;
            }
            if (idx === -1) break;
            const nextPy = msg.indexOf("}, {'traceId'", idx + 1);
            const nextJson = msg.indexOf('},{"traceId"', idx + 1);
            const ends = [nextPy, nextJson].filter(v => v !== -1);
            const end = ends.length ? Math.min.apply(null, ends) : Math.min(msg.length, idx + 2400);
            const span = msg.slice(idx, end);
            if (span.indexOf('interrupted') !== -1) {
              const turnM = jsonStyle
                ? span.match(/"key"\s*:\s*"turn_id"[\s\S]{0,180}?"intValue"\s*:\s*"?(\d+)/)
                : span.match(/'key':\s*'turn_id'[\s\S]{0,180}?'intValue':\s*'?(\d+)/);
              const reasonM = span.match(/caused_by["']?\s*:\s*["']([^"'}]+)["']/);
              if (turnM) add(parseInt(turnM[1], 10), e.ts, reasonM ? reasonM[1] : null, i);
            }
            searchFrom = end > idx ? end : idx + 1;
          }

          // Turn trace summary shape:
          // {"turn_id": 5, ..., "end": {"type": "interrupted", ...}}
          const j = e.json || tryParseJSON(msg);
          if (j && typeof j === 'object') {
            const endType = j.end && j.end.type != null ? String(j.end.type) : '';
            const turnId = j.turn_id != null ? Number(j.turn_id) : null;
            const reason = j.end && j.end.metadata && j.end.metadata.caused_by != null
              ? String(j.end.metadata.caused_by)
              : null;
            if (turnId != null && /interrupted/i.test(endType)) add(turnId, e.ts, reason, i);
          }
        }
        return out;
      }

      /** All individual text messages (user ASR + agent TTS + STT transcripts), no deduplication, for filtering */
      function buildAllMessagesList(insights) {
        const list = [];
        (insights.userAsr || []).forEach(o => {
          list.push({ ts: o.ts, source: 'user', text: o.text, final: o.final, turn_id: o.turn_id, start_ms: o.start_ms, duration_ms: o.duration_ms != null ? o.duration_ms : o.final_audio_proc_ms, language: o.language, entryIndex: o.entryIndex });
        });
        (insights.tts || []).forEach(o => {
          list.push({ ts: o.ts, source: 'agent', text: o.text, final: (typeof o.final === 'boolean') ? o.final : null, turn_id: o.turn_id, start_ms: o.start_ms, duration_ms: o.duration_ms, language: o.language, entryIndex: o.entryIndex });
        });
        const stt = insights.stt;
        if (stt && stt.transcripts) {
          stt.transcripts.forEach(o => {
            list.push({ ts: o.ts, source: o.user ? 'user' : 'asr', text: typeof o.text === 'string' ? o.text : (o.text || '').toString(), final: o.final, turn_id: o.turn_id, start_ms: null, duration_ms: o.total_audio_proc_ms != null ? o.total_audio_proc_ms : o.final_audio_proc_ms, language: null, entryIndex: o.entryIndex });
          });
        }
        (insights.v2vTranscriptions || []).forEach(o => {
          list.push({
            ts: o.ts,
            source: o.speaker === 'agent' ? 'v2v-agent' : 'v2v-user',
            text: o.text,
            final: o.final,
            turn_id: o.turn_id,
            start_ms: o.start_ms,
            duration_ms: o.duration_ms,
            language: o.language,
            entryIndex: o.entryIndex
          });
        });
        list.sort((a, b) => {
          const ta = parseLogTs(a.ts);
          const tb = parseLogTs(b.ts);
          return (isNaN(ta) ? 0 : ta) - (isNaN(tb) ? 0 : tb);
        });
        return list;
      }

      /** Combined turns: user (ASR + eval_id + glue) + agent (TTS + glue), same shape, sorted by turn then time */
      // Render an STT-confidence pill (e.g., "92%") colored by tier:
      //   >= 0.85 → green, >= 0.70 → amber, < 0.70 → red.
      // Only the authoritative source (final-frame) produces a solid pill; if
      // we only have an interim frame's confidence we render a dashed outline
      // and label the source in the tooltip. Returns '' for rows with no conf.
      function renderConfidencePill(row) {
        if (typeof row.confidence !== 'number' || !isFinite(row.confidence)) return '';
        const pct = Math.max(0, Math.min(1, row.confidence));
        const display = Math.round(pct * 100) + '%';
        let tier = 'low';
        if (pct >= 0.85) tier = 'high';
        else if (pct >= 0.70) tier = 'mid';
        const sourceLabel = row.confidenceSource === 'final' ? 'final frame' : 'interim frame';
        const stats = row.confidenceStats;
        const tipParts = ['ASR confidence · ' + sourceLabel];
        if (stats && stats.count > 1) {
          tipParts.push('across ' + stats.count + ' frames');
          tipParts.push('min ' + Math.round(stats.min * 100) + '% · max ' + Math.round(stats.max * 100) + '% · avg ' + Math.round(stats.avg * 100) + '%');
        }
        const tip = tipParts.join('\n');
        const sourceClass = row.confidenceSource === 'final' ? 'conf-final' : 'conf-interim';
        return '<span class="stt-conf-pill conf-' + tier + ' ' + sourceClass + '" title="' + escapeHtml(tip) + '">' + display + '</span>';
      }

      function buildTurnRowHtml(row) {
        const textCell = insightLongTextCell(row.text || '');
        const finalStr = row.final === true ? 'yes' : row.final === false ? 'no' : '—';
        const interruptedStr = row.interrupted ? 'yes' : '—';
        const interruptedTitle = row.interruptReason ? ' title="' + escapeHtml('Interrupted: ' + row.interruptReason) + '"' : '';
        const tsAttr = escapeHtml(row.ts || '');
        const idxAttr = row.entryIndex != null ? ' data-index="' + row.entryIndex + '"' : '';
        const confCell = row.speaker === 'user' ? (renderConfidencePill(row) || '—') : '—';
        const classes = ['turn-row', 'turn-' + row.speaker, row.interrupted ? 'turn-interrupted' : ''].filter(Boolean).join(' ');
        return `<tr class="${classes}" data-ts="${tsAttr}"${idxAttr}><td>${row.turn != null ? row.turn : '—'}</td><td>${escapeHtml(row.speaker)}</td><td>${escapeHtml(row.ts)}</td><td>${escapeHtml(row.source || '—')}</td><td${interruptedTitle}>${interruptedStr}</td><td>${textCell}</td><td>${finalStr}</td><td class="stt-conf-cell">${confCell}</td><td>${row.start_ms != null ? row.start_ms : '—'}</td><td>${row.duration_ms != null ? row.duration_ms : '—'}</td><td>${escapeHtml(row.language || '—')}</td></tr>`;
      }

      function buildTurnsList(insights) {
        const agentFromTts = (insights.tts || []).map(o => ({
          speaker: 'agent',
          turn: o.turn_id,
          ts: o.ts,
          text: o.text,
          source: 'tts',
          final: o.final,
          start_ms: o.start_ms,
          duration_ms: o.duration_ms,
          language: o.language,
          entryIndex: o.entryIndex
        }));
        const turnInterruptById = {};
        (insights.turnInterruptions || []).forEach(o => {
          if (!o || o.turn_id == null) return;
          turnInterruptById[String(o.turn_id)] = o;
        });
        const ncsTurnItems = [];
        ((insights.ncs && insights.ncs.memoryItems) || []).forEach(m => {
          if (!m) return;
          const role = String(m.role || '').toLowerCase();
          const speaker = role === 'assistant' ? 'agent' : (role === 'user' ? 'user' : role);
          if (speaker !== 'agent' && speaker !== 'user') return;
          ncsTurnItems.push({
            speaker,
            turn: m.turn_id != null ? m.turn_id : null,
            text: m.text != null ? String(m.text).trim() : '',
            source: m.source != null ? String(m.source) : null,
            ts: m.timestamp_ms != null ? formatEpochMsAsLogTs(m.timestamp_ms) : '',
            interrupted: !!m.interrupted,
            reason: m.interrupt_mode || null,
            entryIndex: m.entryIndex
          });
        });
        function applyTurnInterruption(row) {
          if (!row) return row;
          let matched = null;
          const rowText = String(row.text || '').trim();
          for (const item of ncsTurnItems) {
            if (item.speaker !== row.speaker) continue;
            if (item.turn != null && row.turn != null && String(item.turn) !== String(row.turn)) continue;
            if (item.text && rowText && item.text !== rowText) continue;
            matched = item;
            break;
          }
          if (matched) {
            if (matched.source) row.source = matched.source;
            if (matched.ts) row.ts = matched.ts;
            if (matched.interrupted) {
              row.interrupted = true;
              row.interruptReason = matched.reason || row.interruptReason || null;
            }
          }
          if (!row.interrupted && row.speaker === 'agent' && row.turn != null && turnInterruptById[String(row.turn)]) {
            const intr = turnInterruptById[String(row.turn)];
            row.interrupted = true;
            row.interruptReason = intr.reason || row.interruptReason || null;
          } else {
            row.interrupted = !!row.interrupted;
          }
          return row;
        }
        // Group user ASR frames by turn so we can pick the "right" confidence
        // per turn: the confidence from the final frame (final: True) if one
        // exists, otherwise the confidence on the last interim frame. We also
        // keep min/max/avg across frames for the STT tab tooltip.
        const userAsrByTurn = {};
        (insights.userAsr || []).forEach(o => {
          const key = o.turn_id != null ? o.turn_id : '__null__';
          if (!userAsrByTurn[key]) userAsrByTurn[key] = [];
          userAsrByTurn[key].push(o);
        });
        function pickUserTurnConfidence(frames) {
          const vals = frames.map(f => (typeof f.confidence === 'number' && isFinite(f.confidence) ? f.confidence : null)).filter(v => v != null);
          if (!vals.length) return { value: null, source: null, count: 0, min: null, max: null, avg: null };
          const finalFrame = frames.slice().reverse().find(f => f.final === true && typeof f.confidence === 'number');
          const lastWithConf = frames.slice().reverse().find(f => typeof f.confidence === 'number');
          const chosen = finalFrame || lastWithConf;
          const sum = vals.reduce((a, b) => a + b, 0);
          return {
            value: chosen ? chosen.confidence : null,
            source: finalFrame ? 'final' : 'interim',
            count: vals.length,
            min: Math.min.apply(null, vals),
            max: Math.max.apply(null, vals),
            avg: sum / vals.length,
          };
        }
        const userFromAsr = (insights.userAsr || []).map(o => {
          const frames = userAsrByTurn[o.turn_id != null ? o.turn_id : '__null__'] || [];
          const confInfo = pickUserTurnConfidence(frames);
          return {
            speaker: 'user',
            turn: o.turn_id,
            ts: o.ts,
            text: o.text,
            source: 'asr',
            final: o.final,
            start_ms: o.start_ms,
            duration_ms: o.duration_ms != null ? o.duration_ms : o.final_audio_proc_ms,
            language: o.language,
            confidence: confInfo.value,
            confidenceSource: confInfo.source,
            confidenceStats: confInfo,
            entryIndex: o.entryIndex
          };
        });
        const evalTurns = (insights.evalIdTurns || []).map(o => Object.assign({ source: 'command' }, o));
        const glueTurns = (insights.llmGlueTurns || []).map(o => Object.assign({ source: 'llm' }, o));
        const v2vTurns = (insights.v2vTranscriptions || []).map(o => ({
          speaker: o.speaker,
          turn: o.turn_id,
          ts: o.ts,
          text: o.text,
          source: 'mllm',
          final: o.final,
          start_ms: o.start_ms,
          duration_ms: o.duration_ms,
          language: o.language,
          entryIndex: o.entryIndex
        }));
        // Merge rows with the same (turn, speaker) coming from different sources.
        // Rules:
        //  - Keep the row with the longest trimmed text (most complete utterance)
        //    as the carrier row (its ts / entryIndex).
        //  - But treat `final` separately: take the strongest finality signal any
        //    source emitted for that (turn, speaker). Authoritative finality signals
        //    come from the source that actually saw them (ASR's `is_final`,
        //    assistant.transcription's `turn_status`, vendor `is_final`), and we do
        //    not want the order of merging to silently downgrade that to `null`.
        //  - final === true  beats final === false beats final === null / undefined.
        const byKey = {};
        function strongerFinal(a, b) {
          if (a === true || b === true) return true;
          if (a === false || b === false) return false;
          return null;
        }
        function chooseTurnSource(speaker, a, b) {
          const av = a != null && String(a).trim() ? String(a) : null;
          const bv = b != null && String(b).trim() ? String(b) : null;
          if (!av) return bv;
          if (!bv) return av;
          const userOrder = ['asr', 'mllm', 'llm', 'command', 'tts', 'greeting'];
          const agentOrder = ['llm', 'command', 'greeting', 'mllm', 'tts', 'asr'];
          const order = speaker === 'user' ? userOrder : agentOrder;
          const ar = order.indexOf(av.toLowerCase());
          const br = order.indexOf(bv.toLowerCase());
          if (ar === -1 && br === -1) return av;
          if (ar === -1) return bv;
          if (br === -1) return av;
          return ar <= br ? av : bv;
        }
        function turnSourceRank(speaker, source) {
          const v = source != null ? String(source).trim().toLowerCase() : '';
          if (!v) return 999;
          const userOrder = ['asr', 'mllm', 'llm', 'command', 'tts', 'greeting'];
          const agentOrder = ['llm', 'command', 'greeting', 'mllm', 'tts', 'asr'];
          const order = speaker === 'user' ? userOrder : agentOrder;
          const idx = order.indexOf(v);
          return idx === -1 ? 999 : idx;
        }
        function chooseCarrierRow(existing, row, preferredSource) {
          const speaker = row.speaker || existing.speaker;
          const pref = preferredSource != null ? String(preferredSource).trim().toLowerCase() : '';
          const exSource = existing.source != null ? String(existing.source).trim().toLowerCase() : '';
          const rowSource = row.source != null ? String(row.source).trim().toLowerCase() : '';
          const exMatches = pref && exSource === pref;
          const rowMatches = pref && rowSource === pref;
          if (exMatches !== rowMatches) return exMatches ? existing : row;
          const exRank = turnSourceRank(speaker, existing.source);
          const rowRank = turnSourceRank(speaker, row.source);
          if (exRank !== rowRank) return exRank < rowRank ? existing : row;
          const oldText = String(existing.text || '').trim();
          const newText = String(row.text || '').trim();
          if (oldText.length !== newText.length) return newText.length > oldText.length ? row : existing;
          const exTs = parseLogTs(existing.ts);
          const rowTs = parseLogTs(row.ts);
          if (!isNaN(exTs) && !isNaN(rowTs)) return exTs <= rowTs ? existing : row;
          if (!isNaN(exTs)) return existing;
          if (!isNaN(rowTs)) return row;
          return existing;
        }
        function addOne(row) {
          const k = (row.turn != null ? row.turn : '') + '|' + row.speaker;
          const existing = byKey[k];
          if (!existing) { byKey[k] = Object.assign({}, row); return; }
          const newText = (row.text || '').trim();
          const oldText = (existing.text || '').trim();
          const preferredSource = chooseTurnSource(row.speaker, existing.source, row.source);
          const carrier = chooseCarrierRow(existing, row, preferredSource);
          const merged = Object.assign({}, carrier);
          if (newText.length > oldText.length) merged.text = row.text;
          else if (!merged.text && oldText) merged.text = existing.text;
          merged.final = strongerFinal(existing.final, row.final);
          merged.interrupted = !!(existing.interrupted || row.interrupted);
          merged.interruptReason = existing.interruptReason || row.interruptReason || null;
          merged.source = preferredSource || merged.source || null;
          if (merged.start_ms == null && row.start_ms != null) merged.start_ms = row.start_ms;
          if (merged.duration_ms == null && row.duration_ms != null) merged.duration_ms = row.duration_ms;
          if (!merged.language && row.language) merged.language = row.language;
          // Confidence: prefer whichever source actually carries a number.
          // Never overwrite a real confidence with null.
          if (typeof merged.confidence !== 'number') {
            if (typeof row.confidence === 'number') {
              merged.confidence = row.confidence;
              merged.confidenceSource = row.confidenceSource || merged.confidenceSource || null;
              merged.confidenceStats = row.confidenceStats || merged.confidenceStats || null;
            } else if (typeof existing.confidence === 'number') {
              merged.confidence = existing.confidence;
              merged.confidenceSource = existing.confidenceSource || merged.confidenceSource || null;
              merged.confidenceStats = existing.confidenceStats || merged.confidenceStats || null;
            }
          }
          byKey[k] = merged;
        }
        evalTurns.forEach(addOne);
        glueTurns.forEach(addOne);
        v2vTurns.forEach(addOne);
        userFromAsr.forEach(addOne);
        agentFromTts.forEach(addOne);
        const list = Object.values(byKey).map(applyTurnInterruption);
        const rowsWithTurnId = list.filter(function (row) { return row.turn != null; });
        const finalList = rowsWithTurnId.length ? rowsWithTurnId : list;
        finalList.forEach(function (row) {
          row.entryIndex = findLogIndexByTsAndSource(row.ts, row.source);
        });
        finalList.sort((a, b) => {
          const ta = a.turn != null ? a.turn : 999999;
          const tb = b.turn != null ? b.turn : 999999;
          if (ta !== tb) return ta - tb;
          const tsa = parseLogTs(a.ts);
          const tsb = parseLogTs(b.ts);
          return (isNaN(tsa) ? 0 : tsa) - (isNaN(tsb) ? 0 : tsb);
        });
        return finalList;
      }

      function renderEntry(entry, index, isSelected, searchRaw) {
        const isRelevant = entry.msg && (
          /llm failure|Something went wrong|Request failed|on_request_exception|ncs on_agent_left|Failed too many times|No app certificate provided|TokenManager not initialized|Requested time .* exceeds timeline duration|vendor_error:|send asr_error:|tts_error:|send_tts_error|Websocket internal error|server rejected WebSocket|HTTP 401|base_dir of 'tts' is missing|500 Internal Server Error|Failed to send message/i.test(entry.msg)
        );
        const levelClass = entry.level ? `level-${entry.level}` : '';
        const hasPerLineOverride =
          state.lineExpanded && Object.prototype.hasOwnProperty.call(state.lineExpanded, index);
        const perLineExpanded = hasPerLineOverride ? !!state.lineExpanded[index] : false;
        const globalLineExpanded = state.lineAllExpanded != null ? !!state.lineAllExpanded : false;
        const expanded = hasPerLineOverride ? perLineExpanded : globalLineExpanded;

        let jsonHtml = ''; // Log-line expansion is independent of JSON parsing.

        const classes = ['log-entry', 'clickable', isRelevant ? 'relevant-error' : '', isSelected ? 'selected' : ''].filter(Boolean).join(' ');
        return `
          <div class="${classes}" data-level="${entry.level || ''}" data-index="${index}" ${isRelevant ? 'data-relevant="true"' : ''}>
            <div class="log-line">
              <div class="meta">
                <button type="button" class="copy-entry-btn" data-copy-index="${index}" title="Copy full log line" aria-label="Copy full log line">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <rect x="2.5" y="2.5" width="13" height="13" rx="2" ry="2" opacity="0.45"></rect>
                  </svg>
                </button>
                <span class="ts">${escapeHtml(entry.ts)}</span>
                <span class="level ${levelClass}">${entry.level || '-'}</span>
                ${entry.pid ? `<span>${entry.pid}(${entry.tid})</span>` : ''}
                ${entry.ext ? `<span class="ext">[${escapeHtml(entry.ext)}]</span>` : ''}
              </div>
              <div class="msg ${expanded ? 'line-expanded' : 'line-collapsed'}">${highlightText(entry.msg, searchRaw)}</div>
            </div>
            ${jsonHtml}
          </div>
        `;
      }

      function escapeHtml(s) {
        if (s == null) return '';
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
      }

      /** Long text in insight tables: short strings inline; longer wrapped in details/summary so full text is readable without jumping to the log. */
      const INSIGHT_TEXT_PREVIEW_MAX = 200;

      function insightLongTextCell(raw, previewMax) {
        const max = previewMax != null ? previewMax : INSIGHT_TEXT_PREVIEW_MAX;
        const s = raw == null ? '' : String(raw);
        if (s.length <= max) {
          return '<span class="insight-text-cell insight-text-inline">' + escapeHtml(s) + '</span>';
        }
        const preview = s.slice(0, max) + '…';
        return (
          '<details class="insight-text-expand">' +
          '<summary class="insight-text-summary"><span class="insight-text-preview">' +
          escapeHtml(preview) +
          '</span> <span class="insight-text-hint">Show full</span></summary>' +
          '<div class="insight-text-full">' +
          escapeHtml(s) +
          '</div></details>'
        );
      }

      function escapeRegExp(str) {
        return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }

      let highlightCacheTerm = null;
      let highlightCacheRe = null;

      function highlightText(text, termRaw) {
        const t = termRaw == null ? '' : String(termRaw);
        const term = t.trim();
        if (!term) return escapeHtml(text);

        const raw = text == null ? '' : String(text);
        if (term !== highlightCacheTerm) {
          highlightCacheTerm = term;
          highlightCacheRe = null;
          try {
            highlightCacheRe = new RegExp(escapeRegExp(term), 'ig');
          } catch (_) {
            highlightCacheRe = null;
          }
        }
        if (!highlightCacheRe) return escapeHtml(raw);

        let out = '';
        let lastIdx = 0;
        let m;
        highlightCacheRe.lastIndex = 0;
        while ((m = highlightCacheRe.exec(raw)) !== null) {
          const start = m.index;
          const end = start + m[0].length;
          out += escapeHtml(raw.slice(lastIdx, start));
          out += '<span class="log-highlight">' + escapeHtml(m[0]) + '</span>';
          lastIdx = end;
          if (m[0].length === 0) break; // safety
        }
        out += escapeHtml(raw.slice(lastIdx));
        return out;
      }

      function jsonSyntaxHighlight(jsonStr) {
        try {
          const raw = typeof jsonStr === 'string' ? jsonStr : JSON.stringify(jsonStr, null, 2);
          const re = /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g;
          let out = '';
          let last = 0;
          let m;
          while ((m = re.exec(raw)) !== null) {
            out += escapeHtml(raw.slice(last, m.index));
            const tok = m[0];
            let cls = 'p';
            if (tok.charAt(0) === '"') cls = tok.endsWith(':') ? 'k' : 's';
            else if (tok === 'true' || tok === 'false') cls = 'b';
            else if (tok === 'null') cls = 'z';
            else cls = 'n';
            out += '<span class="' + cls + '">' + escapeHtml(tok) + '</span>';
            last = m.index + tok.length;
          }
          out += escapeHtml(raw.slice(last));
          return out;
        } catch (_) {
          return escapeHtml(String(jsonStr));
        }
      }

      let jsonModalCurrentText = '';
      function redactSecrets(value) {
        const seen = new WeakSet();
        function walk(v, k) {
          if (v == null) return v;
          const key = (k || '').toString();
          if (key && /(api[_-]?key|token|authorization|access[_-]?key|secret|password|bearer)/i.test(key)) {
            return '***';
          }
          if (typeof v !== 'object') return v;
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
          if (Array.isArray(v)) return v.map(function (x) { return walk(x, ''); });
          const out = {};
          for (const kk in v) out[kk] = walk(v[kk], kk);
          return out;
        }
        return walk(value, '');
      }

      function redactInlineSecrets(msg) {
        if (!msg || typeof msg !== 'string') return '';
        let s = msg;
        s = s.replace(/(['"]?(?:api[_-]?key|access[_-]?key|secret|password|authorization|bearer|token)['"]?\s*[:=]\s*)['"][^'"]*['"]/gi, '$1"***"');
        s = s.replace(/(\btoken\b\s*[:=]\s*)[^\s,}]+/gi, '$1***');
        return s;
      }
      function redactLogText(text) {
        if (!text || typeof text !== 'string') return '';
        return text.split(/\r?\n/).map(function (line) {
          return redactInlineSecrets(line);
        }).join('\n');
      }
      function openJsonModal(title, subtitle, obj, options) {
        const overlay = document.getElementById('jsonModal');
        const pre = document.getElementById('jsonModalPre');
        const t = document.getElementById('jsonModalTitle');
        const st = document.getElementById('jsonModalSubtitle');
        const safeObj = (typeof obj === 'string') ? obj : redactSecrets(obj);
        const text = typeof safeObj === 'string' ? safeObj : JSON.stringify(safeObj, null, 2);
        jsonModalCurrentText = text || '';
        t.textContent = title || 'JSON';
        st.textContent = subtitle || '';
        st.className = 'modal-subtitle' + (options && options.warning ? ' modal-subtitle-warning' : '');
        pre.innerHTML = jsonSyntaxHighlight(text || '');
        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');
        syncModalOpenClass();
      }
      function closeJsonModal() {
        const overlay = document.getElementById('jsonModal');
        overlay.classList.remove('visible');
        overlay.setAttribute('aria-hidden', 'true');
        syncModalOpenClass();
        jsonModalCurrentText = '';
      }

      function copyText(text) {
        const s = text == null ? '' : String(text);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(s).catch(function () {
            const ta = document.createElement('textarea');
            ta.value = s;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            try { document.execCommand('copy'); } catch (_) {}
            document.body.removeChild(ta);
          });
        }
        try {
          const ta = document.createElement('textarea');
          ta.value = s;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (_) {}
        return Promise.resolve();
      }
      function insightHeaderRow(labels) {
        return labels.map((l, i) => '<th class="insight-th-filter" data-col-index="' + i + '">' + escapeHtml(l) + '</th>').join('');
      }

      // --- Collapsible section primitive -----------------------------------
      // Any insight tab that stacks multiple tables uses this so the user can
      // collapse noisy sections and keep their layout sticky. Open/closed
      // state is keyed by `id` (stable per section) and persisted under a
      // single JSON blob in localStorage so it survives re-renders and page
      // reloads. Missing storage → default to `defaultOpen` (true unless the
      // caller says otherwise).
      const INSIGHT_SECTION_STORE = 'ten-log-insight-sections';
      function insightSectionStateLoad() {
        try {
          const raw = localStorage.getItem(INSIGHT_SECTION_STORE);
          if (!raw) return {};
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) { return {}; }
      }
      function insightSectionStateSave(state) {
        try { localStorage.setItem(INSIGHT_SECTION_STORE, JSON.stringify(state)); } catch (e) {}
      }
      function insightSectionIsOpen(id, defaultOpen) {
        const state = insightSectionStateLoad();
        if (Object.prototype.hasOwnProperty.call(state, id)) return state[id] !== false;
        return defaultOpen !== false;
      }
      // Render a collapsible section. `hintHtml` is optional and rendered
      // next to the title inside the <summary>. `bodyHtml` is the contents
      // revealed when the section is expanded.
      function insightSection(id, title, hintHtml, bodyHtml, opts) {
        opts = opts || {};
        const open = insightSectionIsOpen(id, opts.defaultOpen !== false);
        const safeTitle = escapeHtml(title || '');
        const hint = hintHtml ? ' <span class="summary-json-hint insight-section-hint">' + hintHtml + '</span>' : '';
        return '<details class="insight-section" data-section-id="' + escapeHtml(id) + '"' + (open ? ' open' : '') + '>' +
          '<summary class="insight-section-summary"><span class="insight-section-caret" aria-hidden="true"></span><span class="insight-section-title">' + safeTitle + '</span>' + hint + '</summary>' +
          '<div class="insight-section-body">' + (bodyHtml || '') + '</div>' +
          '</details>';
      }
      // Summary panel variant: same state machine, but keeps the
      // `.summary-card` / `.summary-json-card` styling so existing cards just
      // become collapsible in place.
      function summaryCardSection(id, title, bodyHtml, opts) {
        opts = opts || {};
        const open = insightSectionIsOpen(id, opts.defaultOpen !== false);
        const safeTitle = escapeHtml(title || '');
        return '<details class="summary-card summary-json-card insight-section summary-card-section" data-section-id="' + escapeHtml(id) + '"' + (open ? ' open' : '') + '>' +
          '<summary class="insight-section-summary summary-card-summary"><span class="insight-section-caret" aria-hidden="true"></span><h3 class="summary-card-title">' + safeTitle + '</h3></summary>' +
          '<div class="insight-section-body summary-card-body">' + (bodyHtml || '') + '</div>' +
          '</details>';
      }
      /** Performance table only: custom CSS tooltip (instant, no help cursor). */
      function insightPerfHeaderRow(cols) {
        return cols.map(function (c, i) {
          const label = typeof c === 'string' ? c : c.label;
          const tip = typeof c === 'string' ? '' : (c.title || '');
          const tipEsc = tip.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
          const dataTip = tip ? ' data-tooltip="' + tipEsc + '"' : '';
          return '<th class="insight-th-filter perf-th-tip" data-col-index="' + i + '"' + dataTip + '>' + escapeHtml(label) + '</th>';
        }).join('');
      }

      function renderPrettySummaryPanel(insights) {
        const summary = insights && insights.summary ? insights.summary : null;
        if (!summary) return '<p class="insight-empty">No summary available.</p>';

        const ev = summary.eventStartInfo && summary.eventStartInfo.taskInfo ? summary.eventStartInfo : null;
        const ti = ev ? ev.taskInfo : null;
        const info = ti && ti.info && typeof ti.info === 'object' ? ti.info : {};
        const geo = (ti && ti.geoLocation && typeof ti.geoLocation === 'object' ? ti.geoLocation : null) || summary.geoLocation || null;
        const createReq = summary.createRequestBody && summary.createRequestBody.properties ? summary.createRequestBody : null;
        const props = createReq ? createReq.properties : null;

        const versions = (function () {
          const out = {};
          if (summary.appVersion) out['App'] = summary.appVersion;
          if (ti && ti.apiVersion) out['API'] = ti.apiVersion;
          if (summary.sessCtrlVersion) out['Sess ctrl'] = summary.sessCtrlVersion;
          return out;
        })();

        function ynBadge(v) {
          if (v === true) return '<span class="badge badge--ok">Enabled</span>';
          if (v === false) return '<span class="badge badge--off">Disabled</span>';
          if (v == null) return '<span class="badge badge--off">—</span>';
          return '<span class="badge badge--info">' + escapeHtml(String(v)) + '</span>';
        }

        function kvCard(label, valueHtml) {
          return '<div class="summary-pretty-card"><div class="summary-pretty-k">' + escapeHtml(label) + '</div><div class="summary-pretty-v">' + valueHtml + '</div></div>';
        }

        function mono(v) {
          const s = v == null || v === '' ? '—' : String(v);
          return '<code>' + escapeHtml(s) + '</code>';
        }

        const asrVendor = info.ASR_VENDOR || (props && props.asr && (props.asr.vendor || props.asr.vendor_name)) || summary.sttModule || '—';
        const asrLang = info.ASR_LANGUAGE || (props && props.asr && props.asr.language) || '—';
        const ttsVendor = info.TTS_VENDOR || (props && props.tts && (props.tts.vendor || props.tts.vendor_name)) || summary.ttsModule || '—';
        const llmStr = (props && props.llm && (props.llm.url || props.llm.vendor || (typeof props.llm === 'string' ? props.llm : null))) || summary.llmUrl || summary.llmModule || '—';
        const llmModel = summary.llmModel || (props && props.llm && props.llm.params && props.llm.params.model) || '—';
        const src = summary.providerSource || {};
        const mllmEnabled = info.ENABLE_MLLM === true;
        const mllmVendor = summary.mllmVendor || '—';
        const mllmModel = summary.mllmModel || '—';
        const mllmUrl = summary.mllmUrl || '—';
        const geoStr = geo ? [geo.city, geo.country, geo.region].filter(Boolean).join(' / ') : '—';
        const avatarVendor = info.AVATAR_VENDOR || summary.avatarVendor || '—';
        const avatarId = info.AVATAR_ID || summary.avatarId || '—';
        const bvcUrl = info.BVC_URL || '—';

        const flagKeys = Object.keys(info || {}).filter(function (k) { return /^ENABLE_/.test(k); }).sort();
        function labelForFlagKey(k) {
          return k
            .replace(/^ENABLE_/, '')
            .toLowerCase()
            .split('_')
            .map(function (s) { return s ? (s.charAt(0).toUpperCase() + s.slice(1)) : s; })
            .join(' ');
        }

        let html = '<div class="summary-pretty-wrap">';
        html += '<div class="summary-pretty-grid">';
        html += kvCard('ASR', '<span>' + mono(asrVendor) + '</span><span>' + mono(src.asr || asrLang) + '</span>');
        html += kvCard('LLM', '<span>' + mono(llmStr) + '</span><span>' + mono(src.llm || llmModel) + '</span>');
        if (mllmEnabled || summary.mllmVendor || summary.mllmModel || summary.mllmUrl) {
          html += kvCard(
            'MLLM / V2V',
            '<span>' + mono(mllmVendor !== '—' ? mllmVendor : mllmModel) + '</span><span class="badge badge--info">' + escapeHtml(mllmEnabled ? 'enabled' : (mllmUrl !== '—' ? 'url' : '—')) + '</span>'
          );
          if (mllmUrl && mllmUrl !== '—') {
            html += kvCard('MLLM URL', '<span>' + mono(mllmUrl) + '</span><span>' + mono('') + '</span>');
          }
        }
        html += kvCard('TTS', '<span>' + mono(ttsVendor) + '</span><span>' + mono(src.tts || '') + '</span>');
        html += kvCard('Service', '<span>' + mono(ti && ti.service) + '</span><span>' + mono(ti && ti.apiVersion) + '</span>');
        html += kvCard('GeoLocation', '<span>' + mono(geoStr) + '</span><span>' + mono(geo && geo.continent) + '</span>');
        html += kvCard('Channel', '<span>' + mono((ti && ti.taskLabels && ti.taskLabels.channel) || summary.channel) + '</span><span>' + mono('') + '</span>');
        html += kvCard('Avatar', '<span>' + mono(avatarVendor) + '</span><span>' + mono(avatarId) + '</span>');
        if (info.BVC_URL) {
          html += kvCard('BVC', '<span>' + mono(bvcUrl) + '</span><span>' + mono('') + '</span>');
        }
        html += '</div>';

        {
          let optsBody = '';
          if (!flagKeys.length && (info.SAL_MODE == null || String(info.SAL_MODE).trim() === '')) {
            optsBody += '<p class="summary-json-hint">No ENABLE_* flags found in event-start info.</p>';
          } else {
            optsBody += '<table class="summary-flag-table"><tbody>';
            const hasSalMode = (info.SAL_MODE != null && String(info.SAL_MODE).trim() !== '');
            // Keep ordering dynamic: SAL mode is displayed inline with ENABLE_SAL (if present), and not duplicated.
            if (!flagKeys.includes('ENABLE_SAL') && hasSalMode) {
              optsBody += '<tr><td class="summary-flag-k">SAL mode <code>SAL_MODE</code></td><td class="summary-flag-v"><code>' + escapeHtml(String(info.SAL_MODE)) + '</code></td></tr>';
            }
            for (const k of flagKeys) {
              if (k === 'ENABLE_SAL') {
                optsBody += '<tr><td class="summary-flag-k">SAL <code>ENABLE_SAL</code>' + (hasSalMode ? ' / <code>SAL_MODE</code>' : '') + '</td><td class="summary-flag-v">' + ynBadge(info[k]) + (hasSalMode ? ' <code style="margin-left:8px;">' + escapeHtml(String(info.SAL_MODE)) + '</code>' : '') + '</td></tr>';
                continue;
              }
              optsBody += '<tr><td class="summary-flag-k">' + escapeHtml(labelForFlagKey(k)) + ' <code>' + escapeHtml(k) + '</code></td><td class="summary-flag-v">' + ynBadge(info[k]) + '</td></tr>';
            }
            optsBody += '</tbody></table>';
          }
          html += summaryCardSection('summary:options', 'Options', optsBody);
        }

        {
          let vBody = '';
          const vKeys = Object.keys(versions);
          if (vKeys.length) {
            vBody += '<dl>' + vKeys.map(k => '<dt>' + escapeHtml(k) + '</dt><dd>' + escapeHtml(String(versions[k])) + '</dd>').join('') + '</dl>';
          } else {
            vBody += '<p class="summary-json-hint">No version snapshot found in this log.</p>';
          }
          html += summaryCardSection('summary:versions', 'Task versions', vBody);
        }

        if (summary.rtm) {
          const r = summary.rtm;
          let rBody = '<dl>';
          rBody += '<dt>Enabled</dt><dd>' + (r.enabled ? 'yes' : 'no') + '</dd>';
          rBody += '<dt>Presence</dt><dd>' + (r.presence_enabled ? 'yes' : 'no') + '</dd>';
          rBody += '<dt>Metadata</dt><dd>' + (r.metadata_enabled ? 'yes' : 'no') + '</dd>';
          rBody += '<dt>Lock</dt><dd>' + (r.lock_enabled ? 'yes' : 'no') + '</dd>';
          if (r.channel) rBody += '<dt>Channel</dt><dd>' + escapeHtml(String(r.channel)) + '</dd>';
          if (r.user_id) rBody += '<dt>UID</dt><dd>' + escapeHtml(String(r.user_id)) + '</dd>';
          rBody += '</dl>';
          html += summaryCardSection('summary:rtm', 'RTM', rBody);
        }

        if (summary.tools) {
          const t = summary.tools;
          let tBody = '<dl>';
          if (t.is_tool_call_available != null) tBody += '<dt>Tool calling available</dt><dd>' + (t.is_tool_call_available ? 'yes' : 'no') + '</dd>';
          if (t.total_tools != null) tBody += '<dt>Total tools</dt><dd>' + escapeHtml(String(t.total_tools)) + '</dd>';
          if (t.servers && t.servers.length) tBody += '<dt>MCP servers</dt><dd>' + escapeHtml(t.servers.map(function (s) { return s.name + (s.transport ? ' (' + s.transport + ')' : '') + (s.url ? ' — ' + s.url : ''); }).join('\n')) + '</dd>';
          tBody += '</dl>';
          if (t.mcp_errors && t.mcp_errors.length) {
            tBody += '<p class="summary-json-hint">MCP errors: ' + escapeHtml(String(t.mcp_errors.length)) + ' (see Insights → Tools for details)</p>';
          }
          html += summaryCardSection('summary:tools', 'Tools', tBody);
        }

        if (src && Array.isArray(src.presets) && src.presets.length) {
          let pBody = '<table class="summary-flag-table"><tbody>';
          for (const p of src.presets) {
            pBody += '<tr><td class="summary-flag-k"><code>' + escapeHtml(String(p.preset || '')) + '</code></td><td class="summary-flag-v">' + ynBadge(!!p.enabled) + (p.applyMode ? ' <code style="margin-left:8px;">' + escapeHtml(p.applyMode) + '</code>' : '') + '</td></tr>';
          }
          pBody += '</tbody></table>';
          html += summaryCardSection('summary:presets', 'Vendor presets', pBody);
        }

        {
          let rjBody = '<p class="summary-json-hint">Open a syntax-colored JSON viewer with copy.</p>';
          rjBody += '<div class="summary-json-actions">';
          if (summary.eventStartInfo) rjBody += '<button type="button" class="summary-json-toggle open-json-modal" data-json-kind="eventStart">View event start JSON</button>';
          if (summary.createRequestBody) rjBody += '<button type="button" class="summary-json-toggle open-json-modal" data-json-kind="createReq">View create request JSON</button>';
          rjBody += '</div>';
          html += summaryCardSection('summary:raw-json', 'Raw JSON', rjBody);
        }
        html += '</div>';
        return html;
      }

      function renderInsights(insights) {
        const root = document.getElementById('insightsContent');
        if (!insights) { root.innerHTML = '<p class="insight-empty">Load a log file to see extracted insights.</p>'; return; }
        insightColumnFilter = {};

        const tabs = [
          { id: 'summaryPretty', label: 'Summary' },
          { id: 'ncs', label: 'Keypoints' },
          { id: 'messages', label: 'Text messages' },
          { id: 'turns', label: 'Turns (user & agent)' },
          { id: 'states', label: 'States' },
          { id: 'reports', label: 'State reports' },
          { id: 'performance', label: 'Performance' },
          { id: 'rtc', label: 'RTC / Agora' },
          { id: 'stt', label: 'STT / ASR metrics' },
          { id: 'llm', label: 'LLM' },
          { id: 'v2vTab', label: 'MLLM / V2V' },
          { id: 'ttsTab', label: 'TTS' },
          { id: 'avatarTab', label: 'Avatar' },
          { id: 'sipTab', label: 'SIP' },
          { id: 'rtmTab', label: 'RTM' },
          { id: 'toolsTab', label: 'Tools' },
          { id: 'events', label: 'Events' }
        ];

        let html = '<div class="insight-tabs"><div class="insight-tabs-filter-wrap"><label for="insightFilterInput">Filter table</label><input type="text" class="insight-tabs-filter" id="insightFilterInput" placeholder="Search rows..." /></div><div class="insight-tabs-scroll">';
        tabs.forEach((t, i) => {
          html += '<button type="button" class="insight-tab' + (i === 0 ? ' active' : '') + '" data-tab="' + t.id + '">' + escapeHtml(t.label) + '</button>';
        });
        html += '</div></div>';

        html += '<div id="insightPanels">';

        html += '<div class="insight-tab-panel active" data-panel="summaryPretty">';
        html += renderPrettySummaryPanel(insights);
        html += '</div>';

        const allMessages = buildAllMessagesList(insights);
        html += '<div class="insight-tab-panel" data-panel="messages">';
        if (allMessages.length) {
          html += '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Source','Text','Final','Turn','Start (ms)','Duration (ms)']) + '</tr></thead><tbody>';
          for (const row of allMessages) {
            const textCell = insightLongTextCell(row.text || '', 300);
            const finalStr = row.final === true ? 'yes' : row.final === false ? 'no' : '—';
            const tsAttr = escapeHtml(row.ts || '');
            const idxAttr = row.entryIndex != null ? ' data-index="' + row.entryIndex + '"' : '';
            html += `<tr class="msg-row source-${row.source}" data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(row.ts)}</td><td>${escapeHtml(row.source)}</td><td>${textCell}</td><td>${finalStr}</td><td>${row.turn_id != null ? row.turn_id : '—'}</td><td>${row.start_ms != null ? row.start_ms : '—'}</td><td>${row.duration_ms != null ? row.duration_ms : '—'}</td></tr>`;
          }
          html += '</tbody></table>';
        } else html += '<p class="insight-empty">No text messages found.</p>';
        html += '</div>';

        const turnsList = buildTurnsList(insights);
        html += '<div class="insight-tab-panel" data-panel="turns">';
        if (turnsList.length) {
          html += '<div class="turns-toolbar"><label title="Hides user rows marked non-final (interim ASR). Agent and other turns stay listed."><input type="checkbox" id="turnsFinalOnly" /> Hide interim user ASR</label></div>';
          html += '<table id="turnsTable" class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Turn','Speaker','Time','Source','Interrupted','Text','Final','STT conf','Start (ms)','Duration (ms)','Language']) + '</tr></thead><tbody>';
          for (const row of turnsList) {
            html += buildTurnRowHtml(row);
          }
          html += '</tbody></table>';
        } else html += '<p class="insight-empty">No turns (user or agent speech) found.</p>';
        html += '</div>';

        html += '<div class="insight-tab-panel" data-panel="states">';
        if (insights.stateTransitions && insights.stateTransitions.length) {
          html += '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','From','To','Reason','Turn']) + '</tr></thead><tbody>';
          for (const s of insights.stateTransitions) {
            const tsAttr = escapeHtml(s.ts || '');
            const idxAttr = s.entryIndex != null ? ' data-index="' + s.entryIndex + '"' : '';
            html += `<tr class="state-row ${s.isFailure ? 'failure' : ''}" data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(s.ts)}</td><td class="from">${escapeHtml(s.old_state)}</td><td class="to">${escapeHtml(s.cur_state)}</td><td class="reason">${escapeHtml(s.reason)}</td><td>${s.turn_id != null ? s.turn_id : '—'}</td></tr>`;
          }
          html += '</tbody></table>';
        } else html += '<p class="insight-empty">No state transitions found.</p>';
        html += '</div>';

        html += '<div class="insight-tab-panel" data-panel="reports">';
        if (insights.stateReports && insights.stateReports.length) {
          html += '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','State','Reason','Duration','Old state']) + '</tr></thead><tbody>';
          for (const r of insights.stateReports) {
            const tsAttr = escapeHtml(r.ts || '');
            const idxAttr = r.entryIndex != null ? ' data-index="' + r.entryIndex + '"' : '';
            html += `<tr data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(r.ts)}</td><td>${escapeHtml(r.stateName)}</td><td>${escapeHtml(r.reason)}</td><td>${r.duration != null ? r.duration + ' ms' : '—'}</td><td>${r.oldState != null ? r.oldState : '—'}</td></tr>`;
          }
          html += '</tbody></table>';
        } else html += '<p class="insight-empty">No state reports found.</p>';
        html += '</div>';

        html += '<div class="insight-tab-panel" data-panel="performance">';
        const perf = insights.performanceMetrics || [];
        if (perf.length) {
          html += '<p class="insight-formula">Module timings by turn; see <strong>Note</strong> under the table for TTeRTC and <strong>~</strong>/<strong>†</strong>.</p>';
          (function () {
            const series = [
              { key: 'vad', label: 'VAD (ms)', color: '#67e8f9', marker: 'circle' },
              { key: 'aivad_delay', label: 'AIVAD Delay (ms)', color: '#93c5fd', marker: 'circle' },
              { key: 'bhvs_delay', label: 'BHVS Delay (ms)', color: '#a5b4fc', marker: 'circle' },
              { key: 'asr_ttlw', label: 'ASR TTLW (ms)', color: '#fde047', marker: 'circle' },
              { key: 'llm_connect', label: 'LLM Connect (ms)', color: '#c4b5fd', marker: 'circle' },
              { key: 'llm_ttfb', label: 'LLM TTFB (ms)', color: '#86efac', marker: 'circle' },
              { key: 'llm_ttfs', label: 'LLM TTFS (ms)', color: '#fdba74', marker: 'circle' },
              { key: 'tts_ttfb', label: 'TTS TTFB (ms)', color: '#fca5a5', marker: 'circle' },
              { key: 'total', label: 'Total Time Exclude RTC', color: '#e9d5ff', marker: 'circle' }
            ];
            const n = perf.length;
            const maxTurnId = n ? Math.max.apply(null, perf.map(function (r) { return r.turn_id; })) : 1;
            const pointsBySeries = {};
            for (const s of series) {
              pointsBySeries[s.key] = [];
              if (s.key === 'total') {
                for (let i = 0; i < n; i++) {
                  const r = perf[i];
                  const v = r.end_to_end_reported_ms != null ? r.end_to_end_reported_ms
                    : (r.vad || 0) + (r.aivad_delay || 0) + (r.bhvs_delay || 0) + (r.asr_ttlw || 0) + (r.llm_ttfs || 0) + (r.tts_ttfb || 0);
                  if (v > 0) pointsBySeries.total.push({ i: i, v: v });
                }
              } else {
                for (let i = 0; i < n; i++) {
                  const v = perf[i][s.key];
                  if (v != null) pointsBySeries[s.key].push({ i: i, v: v });
                }
              }
            }
            let maxVal = 0;
            for (const key in pointsBySeries) {
              for (const p of pointsBySeries[key]) { if (p.v > maxVal) maxVal = p.v; }
            }
            if (maxVal === 0) maxVal = 1;
            const yStep = maxVal <= 50 ? 10 : maxVal <= 200 ? 50 : maxVal <= 1000 ? 200 : maxVal <= 3500 ? 500 : 1000;
            const yMax = Math.ceil(maxVal / yStep) * yStep || yStep;
            const scale = 3;
            const w = 320 * scale;
            const h = 240 * scale;
            const padL = 34 * scale, padR = 12 * scale, padT = 36 * scale, padB = 28 * scale;
            const plotW = w - padL - padR, plotH = h - padT - padB;
            function xPosForTurnId(tid) { return maxTurnId <= 0 ? padL + plotW / 2 : padL + (tid / maxTurnId) * plotW; }
            function xPos(i) { return xPosForTurnId(perf[i].turn_id); }
            function yPos(v) { return padT + plotH - (v / yMax) * plotH; }
            const strokeW = 0.75;
            const markerR = 2.8;
            const triH = 0.7;
            const triW = 0.7;
            const fontAxis = 22;
            const fontYLabel = 22;
            let svg = '<div class="perf-chart-wrap"><div class="perf-chart-title">Module Performance Metrics</div><div class="perf-chart-subtitle">Module Response Time Trends</div>';
            svg += '<div class="perf-chart-legend">';
            for (const s of series) {
              svg += '<span class="perf-legend-item" data-series="' + escapeHtml(s.key) + '" role="button" tabindex="0"><span class="swatch" style="background:' + s.color + '"></span>' + escapeHtml(s.label) + '</span>';
            }
            svg += '</div><div class="perf-chart-svg-wrap"><svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMinYMid meet" style="width:100%;height:auto;">';
            const plotLeft = padL, plotBottom = padT + plotH, plotRight = padL + plotW, plotTop = padT;
            svg += '<line x1="' + plotLeft + '" y1="' + plotTop + '" x2="' + plotLeft + '" y2="' + plotBottom + '" stroke="var(--text-muted)" stroke-width="0.6"/>';
            svg += '<line x1="' + plotLeft + '" y1="' + plotBottom + '" x2="' + plotRight + '" y2="' + plotBottom + '" stroke="var(--text-muted)" stroke-width="0.6"/>';
            svg += '<text x="14" y="' + (plotTop + plotH / 2) + '" text-anchor="middle" dominant-baseline="middle" fill="var(--text-muted)" font-size="' + fontYLabel + '" transform="rotate(-90 14 ' + (plotTop + plotH / 2) + ')">Response Time (ms)</text>';
            for (let v = 0; v <= yMax; v += yStep) {
              const y = yPos(v);
              if (y < plotTop - 1) continue;
              svg += '<line x1="' + plotLeft + '" y1="' + y + '" x2="' + plotRight + '" y2="' + y + '" stroke="var(--border)" stroke-dasharray="2" stroke-width="0.25"/>';
              svg += '<text x="' + (plotLeft - 8) + '" y="' + (y + 1) + '" text-anchor="end" fill="var(--text-muted)" font-size="' + fontAxis + '">' + v + '</text>';
            }
            const xLabelY = plotBottom + 6;
            svg += '<text x="' + plotLeft + '" y="' + xLabelY + '" text-anchor="middle" dominant-baseline="hanging" fill="var(--text-muted)" font-size="' + fontAxis + '">0</text>';
            const xLabelStep = maxTurnId <= 12 ? 1 : maxTurnId <= 30 ? 2 : maxTurnId <= 80 ? 5 : Math.max(1, Math.floor(maxTurnId / 15));
            for (let t = xLabelStep; t <= maxTurnId; t += xLabelStep) {
              const tx = xPosForTurnId(t);
              svg += '<text x="' + tx + '" y="' + xLabelY + '" text-anchor="middle" dominant-baseline="hanging" fill="var(--text-muted)" font-size="' + fontAxis + '">' + t + '</text>';
            }
            if (maxTurnId > 0 && maxTurnId % xLabelStep !== 0) {
              svg += '<text x="' + plotRight + '" y="' + xLabelY + '" text-anchor="middle" dominant-baseline="hanging" fill="var(--text-muted)" font-size="' + fontAxis + '">' + maxTurnId + '</text>';
            }
            svg += '<text x="' + (plotLeft + plotW / 2) + '" y="' + (plotBottom + fontAxis + 22) + '" text-anchor="middle" fill="var(--text-muted)" font-size="' + fontYLabel + '">Turn</text>';
            const aivadPoints = pointsBySeries.aivad_delay;
            if (aivadPoints.length >= 2) {
              let areaPath = 'M' + xPos(aivadPoints[0].i) + ',' + yPos(aivadPoints[0].v);
              for (let k = 1; k < aivadPoints.length; k++) { areaPath += 'L' + xPos(aivadPoints[k].i) + ',' + yPos(aivadPoints[k].v); }
              areaPath += 'L' + xPos(aivadPoints[aivadPoints.length - 1].i) + ',' + (padT + plotH) + 'L' + xPos(aivadPoints[0].i) + ',' + (padT + plotH) + 'Z';
              svg += '<g data-series="aivad_delay"><path d="' + areaPath + '" fill="#93c5fd28" stroke="none"/></g>';
            }
            const hitR = 8;
            function pointTitle(s, p) {
              const turnId = perf[p.i].turn_id;
              return escapeHtml(s.label) + ': Turn ' + turnId + ', ' + Math.round(p.v) + ' ms';
            }
            function pointAttrs(s, p, cx, cy) {
              const turnId = perf[p.i].turn_id;
              const title = pointTitle(s, p);
              const pointId = escapeHtml(s.key + '-' + p.i);
              return {
                pointId: pointId,
                marker: ' class="perf-point-marker" data-point-id="' + pointId + '"',
                hit: ' class="perf-point-hit" data-point-id="' + pointId + '" data-series="' + escapeHtml(s.key) + '" data-label="' + escapeHtml(s.label) + '" data-turn="' + escapeHtml(String(turnId)) + '" data-value="' + escapeHtml(String(Math.round(p.v))) + '" data-cx="' + escapeHtml(String(cx)) + '" data-cy="' + escapeHtml(String(cy)) + '" aria-label="' + title + '" role="button" tabindex="0" focusable="true"'
              };
            }
            for (const s of series) {
              const pts = pointsBySeries[s.key];
              svg += '<g data-series="' + escapeHtml(s.key) + '">';
              if (pts.length < 2) {
                for (const p of pts) {
                  const cx = xPos(p.i), cy = yPos(p.v);
                  const attrs = pointAttrs(s, p, cx, cy);
                  if (s.marker === 'triangle') {
                    svg += '<polygon' + attrs.marker + ' points="' + cx + ',' + (cy - triH) + ' ' + (cx + triW) + ',' + (cy + triH) + ' ' + (cx - triW) + ',' + (cy + triH) + '" fill="' + s.color + '" stroke="none"/>';
                    svg += '<circle' + attrs.hit + ' cx="' + cx + '" cy="' + cy + '" r="' + hitR + '"></circle>';
                  } else {
                    svg += '<circle' + attrs.marker + ' cx="' + cx + '" cy="' + cy + '" r="' + markerR + '" fill="' + s.color + '" stroke="var(--bg)" stroke-width="0.3"/>';
                    svg += '<circle' + attrs.hit + ' cx="' + cx + '" cy="' + cy + '" r="' + hitR + '"></circle>';
                  }
                }
              } else {
                let path = 'M' + xPos(pts[0].i) + ',' + yPos(pts[0].v);
                for (let k = 1; k < pts.length; k++) { path += 'L' + xPos(pts[k].i) + ',' + yPos(pts[k].v); }
                svg += '<path d="' + path + '" fill="none" stroke="' + s.color + '" stroke-width="' + strokeW + '" stroke-linecap="round" stroke-linejoin="round"/>';
                for (const p of pts) {
                  const cx = xPos(p.i), cy = yPos(p.v);
                  const attrs = pointAttrs(s, p, cx, cy);
                  if (s.marker === 'triangle') {
                    svg += '<polygon' + attrs.marker + ' points="' + cx + ',' + (cy - triH) + ' ' + (cx + triW) + ',' + (cy + triH) + ' ' + (cx - triW) + ',' + (cy + triH) + '" fill="' + s.color + '" stroke="var(--bg)" stroke-width="0.3"/>';
                    svg += '<circle' + attrs.hit + ' cx="' + cx + '" cy="' + cy + '" r="' + hitR + '"></circle>';
                  } else {
                    svg += '<circle' + attrs.marker + ' cx="' + cx + '" cy="' + cy + '" r="' + markerR + '" fill="' + s.color + '" stroke="var(--bg)" stroke-width="0.3"/>';
                    svg += '<circle' + attrs.hit + ' cx="' + cx + '" cy="' + cy + '" r="' + hitR + '"></circle>';
                  }
                }
              }
              svg += '</g>';
            }
            svg += '</svg></div></div>';
            html += svg;
          })();
          html += '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightPerfHeaderRow([
            { label: 'Turn ID', title: 'Turn index for this user-speech segment (matches turn_detector / metrics in the log).' },
            { label: 'VAD (ms)', title: 'Voice Activity Detection window: silence duration after speech ends plus fixed padding (from EOS / E2E report when logged). Not shown if that line is missing for the turn.' },
            { label: 'AIVAD Delay (ms)', title: 'AIVAD (AI VAD) extra delay when that extension is enabled; N/A when disabled.' },
            { label: 'BHVS Delay (ms)', title: 'BHVS: behavioral hold / barge-in window (ms) before ASR finalize, from bhvs_duration_ms in the report_controller E2E line (or a bhvs_delay metric_message). N/A when the turn did not log either.' },
            { label: 'ASR TTLW (ms)', title: 'ASR Time To Last Word: from end-of-speech to last finalized transcript for the turn.' },
            { label: 'LLM Connect (ms)', title: 'Time until the LLM HTTP streaming connection returns headers (before first token).' },
            { label: 'LLM TTFB (ms)', title: 'LLM Time To First Byte: from request start to first assistant text token in the stream.' },
            { label: 'LLM TTFS (ms)', title: 'LLM Time To First Sentence: until the first chunk sent to TTS (first speakable sentence).' },
            { label: 'TTS TTFB (ms)', title: 'TTS Time To First Byte: from TTS request to first audio frame out of the synthesizer.' },
            { label: 'TTeRTC (ms)', title: 'Total time excluding RTC: backend end-to-end when logged; else sum of VAD + AIVAD + BHVS + ASR TTLW + LLM TTFS + TTS TTFB. ~…† = partial when VAD missing.' }
          ]) + '</tr></thead><tbody>';
          for (const row of perf) {
            const vad = row.vad != null ? row.vad + ' ms' : '—';
            const aivad = row.aivad_delay != null ? row.aivad_delay + ' ms' : 'N/A';
            const bhvs = row.bhvs_delay != null ? row.bhvs_delay + ' ms' : 'N/A';
            const asrTtlw = row.asr_ttlw != null ? row.asr_ttlw + ' ms' : 'N/A';
            const llmConn = row.llm_connect != null ? row.llm_connect + ' ms' : 'N/A';
            const llmTtfb = row.llm_ttfb != null ? row.llm_ttfb + ' ms' : 'N/A';
            const llmTtfs = row.llm_ttfs != null ? row.llm_ttfs + ' ms' : 'N/A';
            const ttsTtfb = row.tts_ttfb != null ? row.tts_ttfb + ' ms' : 'N/A';
            const sumParts = (row.vad || 0) + (row.aivad_delay || 0) + (row.bhvs_delay || 0) + (row.asr_ttlw || 0) + (row.llm_ttfs || 0) + (row.tts_ttfb || 0);
            const totalExclRtc = row.end_to_end_reported_ms != null ? row.end_to_end_reported_ms : sumParts;
            let totalStr = '—';
            if (row.end_to_end_reported_ms != null) totalStr = totalExclRtc + ' ms';
            else if (sumParts > 0) totalStr = (row.vad == null ? '~' : '') + sumParts + ' ms' + (row.vad == null ? ' †' : '');
            html += `<tr class="perf-table-row" data-turn-id="${row.turn_id}"><td>${row.turn_id}</td><td>${vad}</td><td>${aivad}</td><td>${bhvs}</td><td>${asrTtlw}</td><td>${llmConn}</td><td>${llmTtfb}</td><td>${llmTtfs}</td><td>${ttsTtfb}</td><td>${totalStr}</td></tr>`;
          }
          const medVad = median(perf.map(function (r) { return r.vad; }));
          const medAivad = median(perf.map(function (r) { return r.aivad_delay; }));
          const medBhvs = median(perf.map(function (r) { return r.bhvs_delay; }));
          const medAsr = median(perf.map(function (r) { return r.asr_ttlw; }));
          const medLlmConn = median(perf.map(function (r) { return r.llm_connect; }));
          const medLlmTtfb = median(perf.map(function (r) { return r.llm_ttfb; }));
          const medLlmTtfs = median(perf.map(function (r) { return r.llm_ttfs; }));
          const medTts = median(perf.map(function (r) { return r.tts_ttfb; }));
          const totalV = function (r) {
            if (r.end_to_end_reported_ms != null) return r.end_to_end_reported_ms;
            return (r.vad || 0) + (r.aivad_delay || 0) + (r.bhvs_delay || 0) + (r.asr_ttlw || 0) + (r.llm_ttfs || 0) + (r.tts_ttfb || 0);
          };
          const medTotal = median(perf.map(totalV));
          const fmt = function (v) { return v != null ? Math.round(v) + ' ms' : '—'; };
          html += '</tbody><tfoot><tr class="perf-median-row"><td>Median</td><td>' + fmt(medVad) + '</td><td>' + fmt(medAivad) + '</td><td>' + fmt(medBhvs) + '</td><td>' + fmt(medAsr) + '</td><td>' + fmt(medLlmConn) + '</td><td>' + fmt(medLlmTtfb) + '</td><td>' + fmt(medLlmTtfs) + '</td><td>' + fmt(medTts) + '</td><td>' + fmt(medTotal) + '</td></tr></tfoot></table>';
          html += '<p class="perf-table-footnote"><strong>Note:</strong> TTeRTC = backend E2E when logged; else sum(VAD+AIVAD+BHVS+ASR+LLM_TTFS+TTS). <strong>~</strong> + <strong>†</strong> = partial total when VAD (ms) is — for that turn—same as adding only the row’s numeric ms columns (not —/N/A). Not a negative time. <strong>†</strong> = incomplete vs full pipeline; <strong>~</strong> = same idea (can look like “−” in some fonts).</p>';
        } else html += '<p class="insight-empty">No performance metrics found.</p>';
        html += '</div>';

        html += '<div class="insight-tab-panel" data-panel="stt">';
        const stt = insights.stt;
        let sttConfidenceRendered = false;
        // Confidence summary: group final user ASR frames by turn so we report
        // one number per turn (vendors emit per-utterance confidence on the
        // final frame — that's the authoritative one). We still surface the
        // min/max across *all* frames in the tooltip so you can see whether
        // the score moved while streaming.
        (function () {
          const userAsr = insights.userAsr || [];
          if (!userAsr.length) return;
          const byTurn = {};
          userAsr.forEach(o => {
            const key = o.turn_id != null ? o.turn_id : '__null__';
            if (!byTurn[key]) byTurn[key] = [];
            byTurn[key].push(o);
          });
          const rows = [];
          const finalVals = [];
          let lowCount = 0;
          const LOW_THRESHOLD = 0.70;
          Object.keys(byTurn).forEach(k => {
            const frames = byTurn[k];
            const confs = frames.map(f => (typeof f.confidence === 'number' && isFinite(f.confidence)) ? f.confidence : null).filter(v => v != null);
            if (!confs.length) return;
            const finalFrame = frames.slice().reverse().find(f => f.final === true && typeof f.confidence === 'number');
            const chosen = finalFrame || frames.slice().reverse().find(f => typeof f.confidence === 'number');
            const v = chosen.confidence;
            if (finalFrame) finalVals.push(v);
            if (v < LOW_THRESHOLD) lowCount++;
            const sum = confs.reduce((a, b) => a + b, 0);
            rows.push({
              turn_id: frames[0].turn_id != null ? frames[0].turn_id : null,
              text: chosen.text || '',
              ts: chosen.ts,
              entryIndex: chosen.entryIndex,
              confidence: v,
              source: finalFrame ? 'final' : 'interim',
              frames: confs.length,
              min: Math.min.apply(null, confs),
              max: Math.max.apply(null, confs),
              avg: sum / confs.length,
            });
          });
          if (!rows.length) return;
          rows.sort((a, b) => (a.turn_id != null ? a.turn_id : 1e9) - (b.turn_id != null ? b.turn_id : 1e9));
          const statsPool = finalVals.length ? finalVals : rows.map(r => r.confidence);
          const statsSum = statsPool.reduce((a, b) => a + b, 0);
          const sessionAvg = statsSum / statsPool.length;
          const sessionMin = Math.min.apply(null, statsPool);
          const sessionMax = Math.max.apply(null, statsPool);
          const fmtPct = v => Math.round(v * 100) + '%';
          const tierOf = v => v >= 0.85 ? 'high' : (v >= 0.70 ? 'mid' : 'low');
          let confBody = '';
          confBody += '<div class="stt-conf-stats">';
          confBody += '<span class="stt-conf-stat"><em>Session avg</em> <span class="stt-conf-pill conf-final conf-' + tierOf(sessionAvg) + '">' + fmtPct(sessionAvg) + '</span></span>';
          confBody += '<span class="stt-conf-stat"><em>Min</em> <span class="stt-conf-pill conf-final conf-' + tierOf(sessionMin) + '">' + fmtPct(sessionMin) + '</span></span>';
          confBody += '<span class="stt-conf-stat"><em>Max</em> <span class="stt-conf-pill conf-final conf-' + tierOf(sessionMax) + '">' + fmtPct(sessionMax) + '</span></span>';
          confBody += '<span class="stt-conf-stat"><em>Turns</em> ' + rows.length + '</span>';
          if (finalVals.length && finalVals.length !== rows.length) {
            confBody += '<span class="stt-conf-stat"><em>Final frames</em> ' + finalVals.length + ' / ' + rows.length + '</span>';
          }
          confBody += '<span class="stt-conf-stat"><em>Below ' + Math.round(LOW_THRESHOLD * 100) + '%</em> ' + lowCount + '</span>';
          // Only show the "low only" chip when there is actually something to
          // filter down to — otherwise it's just dead UI.
          if (lowCount > 0) {
            confBody += '<label class="stt-conf-toggle"><input type="checkbox" class="stt-conf-lowonly" data-low-threshold="' + LOW_THRESHOLD + '"> <span>Show only &lt; ' + Math.round(LOW_THRESHOLD * 100) + '%</span></label>';
          }
          confBody += '</div>';
          confBody += '<table class="insight-table insight-filterable insight-rows-clickable stt-conf-table"><thead><tr>' + insightHeaderRow(['Turn','Time','Confidence','Source','Frames','Range (min / max / avg)','Text']) + '</tr></thead><tbody>';
          for (const r of rows) {
            const tsAttr = escapeHtml(r.ts || '');
            const idxAttr = r.entryIndex != null ? ' data-index="' + r.entryIndex + '"' : '';
            const pillRow = { confidence: r.confidence, confidenceSource: r.source, confidenceStats: { count: r.frames, min: r.min, max: r.max, avg: r.avg } };
            const pill = renderConfidencePill(pillRow);
            const range = fmtPct(r.min) + ' / ' + fmtPct(r.max) + ' / ' + fmtPct(r.avg);
            const lowAttr = r.confidence < LOW_THRESHOLD ? ' data-conf-low="1"' : '';
            confBody += '<tr class="stt-conf-row" data-ts="' + tsAttr + '"' + idxAttr + lowAttr + '><td>' + (r.turn_id != null ? r.turn_id : '—') + '</td><td>' + escapeHtml(r.ts || '') + '</td><td>' + pill + '</td><td>' + (r.source === 'final' ? 'final' : 'interim') + '</td><td>' + r.frames + '</td><td>' + range + '</td><td>' + insightLongTextCell(r.text || '', 100) + '</td></tr>';
          }
          confBody += '</tbody></table>';
          html += insightSection(
            'stt:confidence',
            'ASR confidence',
            'one score per turn; vendors report it on the final ASR frame (<code>metadata.asr_info.confidence</code>). Interim-frame scores shown dashed.',
            confBody
          );
          sttConfidenceRendered = true;
        })();
        if (stt && (stt.transcripts.length || stt.metrics.length || (stt.errors && stt.errors.length))) {
          if (stt.transcripts.length) {
            let tBody = '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Vendor','Final','Confidence','Text','Final audio (ms)','Total audio (ms)']) + '</tr></thead><tbody>';
            for (const t of stt.transcripts) {
              const textCell = insightLongTextCell(t.text || '', 120);
              const tsAttr = escapeHtml(t.ts || '');
              const idxAttr = t.entryIndex != null ? ' data-index="' + t.entryIndex + '"' : '';
              const vendorCell = t.vendor ? escapeHtml(t.vendor) : '—';
              const finalCell = t.is_final === true ? 'yes' : t.is_final === false ? 'no' : '—';
              // Reuse the same confidence pill we show in the Turns tab; each
              // vendor row here is a single frame so we treat it as a mini
              // "final" source when is_final is true, "interim" otherwise.
              const confPill = typeof t.confidence === 'number' && isFinite(t.confidence)
                ? renderConfidencePill({ confidence: t.confidence, confidenceSource: t.is_final ? 'final' : 'interim', speaker: 'user' })
                : '—';
              tBody += `<tr data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(t.ts)}</td><td>${vendorCell}</td><td>${finalCell}</td><td class="stt-conf-cell">${confPill}</td><td>${textCell}</td><td>${t.final_audio_proc_ms != null ? t.final_audio_proc_ms : '—'}</td><td>${t.total_audio_proc_ms != null ? t.total_audio_proc_ms : '—'}</td></tr>`;
            }
            tBody += '</tbody></table>';
            html += insightSection(
              'stt:transcripts',
              'Transcripts / vendor results',
              'raw ASR output from the vendor (empty heartbeat frames are hidden)',
              tBody
            );
          }
          if (stt.metrics.length) {
            // Any rows carry unknown metric keys? Surface them in a single
            // "Other metrics" column so we don't drop forward-compat fields.
            const hasExtras = stt.metrics.some(m => m.extras && Object.keys(m.extras).length);
            const metricsHeader = ['Time','Module','Vendor','Connect (ms)','Actual send (ms)','Delta (ms)','TTFW (ms)','TTLW (ms)','Input duration (ms)'];
            if (hasExtras) metricsHeader.push('Other');
            let mBody = '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(metricsHeader) + '</tr></thead><tbody>';
            for (const m of stt.metrics) {
              const tsAttr = escapeHtml(m.ts || '');
              const idxAttr = m.entryIndex != null ? ' data-index="' + m.entryIndex + '"' : '';
              const cell = v => v != null ? escapeHtml(String(v)) : '—';
              let extraStr = '';
              if (hasExtras) {
                const parts = [];
                if (m.extras) for (const k of Object.keys(m.extras)) parts.push(k + '=' + m.extras[k]);
                extraStr = '<td>' + (parts.length ? escapeHtml(parts.join(', ')) : '—') + '</td>';
              }
              mBody += `<tr data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(m.ts)}</td><td>${cell(m.module)}</td><td>${cell(m.vendor)}</td><td>${cell(m.connect_delay)}</td><td>${cell(m.actual_send)}</td><td>${cell(m.actual_send_delta)}</td><td>${cell(m.ttfw)}</td><td>${cell(m.ttlw)}</td><td>${cell(m.input_audio_duration_ms)}</td>${extraStr}</tr>`;
            }
            mBody += '</tbody></table>';
            html += insightSection(
              'stt:metrics',
              'ASR metrics',
              'per vendor, merged with billing input-duration when available',
              mBody
            );
          }

          if (stt.errors && stt.errors.length) {
            const timelineErrs = stt.errors.filter(function (err) { return !err.kind || err.kind === 'timeline'; });
            const vendorErrs = stt.errors.filter(function (err) { return err.kind === 'asr_error'; });
            if (timelineErrs.length) {
              let eBody = '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Requested time (ms)','Timeline duration (ms)','Message']) + '</tr></thead><tbody>';
              for (const err of timelineErrs) {
                const tsAttr = escapeHtml(err.ts || '');
                const idxAttr = err.entryIndex != null ? ' data-index="' + err.entryIndex + '"' : '';
                eBody += `<tr data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(err.ts)}</td><td>${err.requested_time_ms != null ? escapeHtml(String(err.requested_time_ms)) : '—'}</td><td>${err.timeline_duration_ms != null ? escapeHtml(String(err.timeline_duration_ms)) : '—'}</td><td>${escapeHtml((err.detail || '').slice(0, 90) || '—')}</td></tr>`;
              }
              eBody += '</tbody></table>';
              html += insightSection('stt:errors-timeline', 'ASR timeline errors', '', eBody);
            }
            if (vendorErrs.length) {
              let vBody = '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Source','Lvl','Code','Vendor','Message','Vendor detail']) + '</tr></thead><tbody>';
              for (const err of vendorErrs) {
                const tsAttr = escapeHtml(err.ts || '');
                const idxAttr = err.entryIndex != null ? ' data-index="' + err.entryIndex + '"' : '';
                const vm = err.vendor_message || err.message || '';
                const src = err.source === 'vendor_error' ? 'vendor_error' : (err.source === 'send_asr_error' ? 'send_asr_error' : '—');
                const lvl = err.level != null ? escapeHtml(String(err.level)) : '—';
                vBody += `<tr class="llm-row error" data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(err.ts)}</td><td>${escapeHtml(src)}</td><td>${lvl}</td><td>${err.code != null ? escapeHtml(String(err.code)) : '—'}</td><td>${err.vendor != null ? escapeHtml(String(err.vendor)) : '—'}</td><td>${escapeHtml((err.message || '').slice(0, 120) || '—')}</td><td>${escapeHtml(vm.slice(0, 120) || '—')}</td></tr>`;
              }
              vBody += '</tbody></table>';
              html += insightSection(
                'stt:errors-vendor',
                'ASR vendor / protocol errors',
                '(E-line <code>vendor_error:</code> and/or I-line <code>send asr_error:</code> JSON)',
                vBody
              );
            }
          }
        } else if (!sttConfidenceRendered) {
          html += '<p class="insight-empty">No STT/ASR data found.</p>';
        }
        html += '</div>';

        html += '<div class="insight-tab-panel" data-panel="rtc">';
        const rtc = insights.rtc || { items: [] };
        if (rtc.items && rtc.items.length) {
          html += '<p class="insight-formula"><strong>RTC / Agora</strong> — <code>routing</code> = graph cmd delivery; <code>cert</code> = token manager; <code>sdk</code> = extension / connection errors.</p>';
          html += '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Severity','Category','Module','Message']) + '</tr></thead><tbody>';
          for (const r of rtc.items) {
            const tsAttr = escapeHtml(r.ts || '');
            const idxAttr = r.entryIndex != null ? ' data-index="' + r.entryIndex + '"' : '';
            const sev = r.kind === 'error' ? '<span style="color:var(--error)">error</span>' : 'warning';
            const cat = escapeHtml(r.category || '—');
            const msg = (r.detail || '').slice(0, 120);
            html += `<tr class="${r.kind === 'error' ? 'llm-row error' : ''}" data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(r.ts)}</td><td>${sev}</td><td>${cat}</td><td>${escapeHtml(r.module || '—')}</td><td>${escapeHtml(msg || '—')}</td></tr>`;
          }
          html += '</tbody></table>';
        } else {
          html += '<p class="insight-empty">No RTC / Agora runtime warnings or errors found.</p>';
        }
        html += '</div>';

        html += '<div class="insight-tab-panel" data-panel="llm">';
        const sumForLlm = insights.summary || {};
        if (sumForLlm.llmModel || sumForLlm.llmSystemPrompt || sumForLlm.llmSystemPromptEmpty) {
          let mpBody = '<p class="summary-json-hint"><strong>Model</strong>: ' + escapeHtml(sumForLlm.llmModel || '—') + '</p>';
          if (!sumForLlm.llmSystemPrompt && sumForLlm.llmSystemPromptEmpty) {
            mpBody += '<p class="insight-empty" style="margin-top:4px;">No system prompt configured in the TEN graph (empty <code>system_messages</code>).</p>';
          }
          if (sumForLlm.llmSystemPrompt) {
            // Full prompt card — previously a 320-char preview. System prompts
            // can be several KB, so we clamp the rendered block with a scroll
            // container and expose copy + jump-to-log affordances.
            const promptStr = String(sumForLlm.llmSystemPrompt);
            const charCount = promptStr.length;
            const lineCount = promptStr.split('\n').length;
            const metaBits = [charCount + (charCount === 1 ? ' char' : ' chars')];
            if (lineCount > 1) metaBits.push(lineCount + ' lines');
            const jumpIdx = sumForLlm.llmSystemPromptEntryIndex;
            const hasJump = typeof jumpIdx === 'number' && jumpIdx >= 0;
            mpBody += '<div class="system-prompt-card">';
            mpBody += '<div class="system-prompt-title">System prompt</div>';
            mpBody += '<div class="system-prompt-meta">' + escapeHtml(metaBits.join(' · ')) + '</div>';
            mpBody += '<details class="system-prompt-details"><summary>Show prompt</summary>';
            mpBody += '<pre class="system-prompt-text">' + escapeHtml(promptStr) + '</pre>';
            mpBody += '<div class="system-prompt-actions">';
            mpBody += '<button type="button" class="summary-json-toggle system-prompt-copy">Copy prompt</button>';
            if (hasJump) {
              mpBody += '<button type="button" class="summary-json-toggle system-prompt-jump" data-entry-index="' + jumpIdx + '">Jump to log line</button>';
            }
            mpBody += '</div>';
            mpBody += '</details>';
            mpBody += '</div>';
          }
          html += insightSection('llm:model-prompt', 'Model & system prompt', '', mpBody);
        }
        if (insights.llm && insights.llm.length) {
          let reqBody = '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','URL / Status','Duration (ms)','Model','Finish / Error']) + '</tr></thead><tbody>';
          for (const r of insights.llm) {
            const status = r.status ? (r.status === '500' ? '<span style="color:var(--error)">500</span>' : r.status) : '—';
            const err = r.error || r.err_message || (r.finish_reason === 'error' ? 'error' : r.finish_reason || '');
            const tsAttr = escapeHtml(r.ts || '');
            const idxAttr = r.entryIndex != null ? ' data-index="' + r.entryIndex + '"' : '';
            const isErrorRow = (r.status === '500' || r.error || r.err_message || r.finish_reason === 'error');
            reqBody += `<tr class="llm-row ${isErrorRow ? 'error' : ''}" data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(r.ts)}</td><td><span class="url" title="${escapeHtml(r.url || '')}">${escapeHtml((r.url || '').replace(/^https?:\/\//, '').slice(0, 50))}</span> ${status}</td><td>${r.duration_ms != null ? r.duration_ms : '—'}</td><td>${escapeHtml(r.model || '—')}</td><td>${escapeHtml(String(err).slice(0, 80))}</td></tr>`;
          }
          reqBody += '</tbody></table>';
          html += insightSection('llm:requests', 'LLM requests', '', reqBody);
        } else html += '<p class="insight-empty">No LLM requests found.</p>';
        html += '</div>';

        html += '<div class="insight-tab-panel" data-panel="v2vTab">';
        const v2v = insights.v2vTab || { events: [], stats: {} };
        if (v2v.events && v2v.events.length) {
          html += '<p class="summary-json-hint">Assistant transcriptions: ' + (v2v.stats.assistant_transcriptions || 0) +
            ' · User transcriptions: ' + (v2v.stats.user_transcriptions || 0) +
            ' · MLLM source rows: ' + (v2v.stats.mllm_source || 0) +
            ' · chat_completion rows: ' + (v2v.stats.chat_completion_data || 0) + '</p>';
          html += '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Ext','Level','Message']) + '</tr></thead><tbody>';
          for (const row of v2v.events) {
            const idxAttr = row.entryIndex != null ? ' data-index="' + row.entryIndex + '"' : '';
            html += `<tr${idxAttr}><td>${escapeHtml(row.ts || '')}</td><td>${escapeHtml(row.ext || '')}</td><td>${escapeHtml(row.level || '')}</td><td>${escapeHtml(row.msg || '')}</td></tr>`;
          }
          html += '</tbody></table>';
        } else html += '<p class="insight-empty">No MLLM / V2V events found.</p>';
        html += '</div>';

        html += '<div class="insight-tab-panel" data-panel="avatarTab">';
        const avatar = insights.avatarTab || { events: [], vendors: [], avatarIds: [], hasAvatarExt: false, channel: null, uid: null, quality: null, video_encoding: null, api_url: null };
        if ((avatar.vendors && avatar.vendors.length) || (avatar.avatarIds && avatar.avatarIds.length) || (avatar.events && avatar.events.length)) {
          if (avatar.vendors && avatar.vendors.length) html += '<p class="summary-json-hint"><strong>Vendor</strong>: ' + escapeHtml(avatar.vendors.join(', ')) + '</p>';
          if (avatar.avatarIds && avatar.avatarIds.length) html += '<p class="summary-json-hint"><strong>Avatar ID</strong>: ' + escapeHtml(avatar.avatarIds.join(', ')) + '</p>';
          if (avatar.channel || avatar.uid || avatar.quality || avatar.video_encoding) {
            html += '<p class="summary-json-hint"><strong>Channel</strong>: ' + escapeHtml(avatar.channel || '—') +
              ' · <strong>UID</strong>: ' + escapeHtml(avatar.uid || '—') +
              (avatar.quality ? ' · <strong>Quality</strong>: ' + escapeHtml(avatar.quality) : '') +
              (avatar.video_encoding ? ' · <strong>Encoding</strong>: ' + escapeHtml(avatar.video_encoding) : '') +
              '</p>';
          }
          if (avatar.api_url) html += '<p class="summary-json-hint"><strong>API</strong>: ' + escapeHtml(avatar.api_url) + '</p>';
          if (avatar.events && avatar.events.length) {
            html += '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Ext','Level','Message']) + '</tr></thead><tbody>';
            for (const row of avatar.events) {
              const idxAttr = row.entryIndex != null ? ' data-index="' + row.entryIndex + '"' : '';
              html += `<tr${idxAttr}><td>${escapeHtml(row.ts || '')}</td><td>${escapeHtml(row.ext || '')}</td><td>${escapeHtml(row.level || '')}</td><td>${escapeHtml(row.msg || '')}</td></tr>`;
            }
            html += '</tbody></table>';
          } else {
            html += '<p class="insight-empty">No avatar log lines found.</p>';
          }
        } else html += '<p class="insight-empty">No avatar configuration found.</p>';
        html += '</div>';

        html += '<div class="insight-tab-panel" data-panel="sipTab">';
        const sip = insights.sipTab || { enabled: null, applyMode: null, sipDefaultEnabled: null, fromNumber: null, toNumber: null, campaignId: null, callId: null, managerJobs: [], events: [], stats: {} };
        html += '<p class="summary-json-hint"><strong>ENABLE_SIP</strong>: ' + escapeHtml(sip.enabled == null ? '—' : String(sip.enabled)) +
          (sip.applyMode ? ' · <strong>sip_default.apply_mode</strong>: ' + escapeHtml(String(sip.applyMode)) : '') +
          (sip.sipDefaultEnabled != null ? ' · <strong>sip_default.enable</strong>: ' + escapeHtml(String(sip.sipDefaultEnabled)) : '') +
          '</p>';
        if (sip.fromNumber || sip.toNumber || sip.campaignId || sip.callId) {
          html += '<table class="insight-table insight-filterable"><thead><tr>' + insightHeaderRow(['From', 'To', 'Campaign', 'Call ID']) + '</tr></thead><tbody>';
          html += `<tr><td>${escapeHtml(sip.fromNumber || '—')}</td><td>${escapeHtml(sip.toNumber || '—')}</td><td>${escapeHtml(sip.campaignId || '—')}</td><td>${escapeHtml(sip.callId || '—')}</td></tr>`;
          html += '</tbody></table>';
        }
        if (sip.managerJobs && sip.managerJobs.length) {
          html += '<table class="insight-table insight-filterable"><thead><tr>' + insightHeaderRow(['SIP manager tool', 'Reason', 'Duration (ms)']) + '</tr></thead><tbody>';
          for (const j of sip.managerJobs) {
            html += `<tr><td>${escapeHtml(j.tool || '—')}</td><td>${escapeHtml(j.reason || '—')}</td><td>${j.durationMs != null ? j.durationMs : '—'}</td></tr>`;
          }
          html += '</tbody></table>';
        }
        if (sip.events && sip.events.length) {
          html += '<p class="summary-json-hint">Manager events: ' + (sip.stats.manager_events || 0) + ' · SIP call events: ' + (sip.stats.call_events || 0) + '</p>';
          html += '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Ext','Level','Message']) + '</tr></thead><tbody>';
          for (const row of sip.events) {
            const idxAttr = row.entryIndex != null ? ' data-index="' + row.entryIndex + '"' : '';
            html += `<tr${idxAttr}><td>${escapeHtml(row.ts || '')}</td><td>${escapeHtml(row.ext || '')}</td><td>${escapeHtml(row.level || '')}</td><td>${escapeHtml(row.msg || '')}</td></tr>`;
          }
          html += '</tbody></table>';
        } else {
          html += '<p class="insight-empty">No SIP-specific events found.</p>';
        }
        html += '</div>';

        html += '<div class="insight-tab-panel" data-panel="rtmTab">';
        const rtm = insights.rtmTab || { events: [], stats: {} };
        if (rtm && rtm.events && rtm.events.length) {
          html += '<p class="summary-json-hint">Presence events: ' + (rtm.stats.presence_events || 0) + ' · Message events: ' + (rtm.stats.message_events || 0) + ' · Presence set: ' + (rtm.stats.presence_sets || 0) + '</p>';
          html += '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Ext','Level','Message']) + '</tr></thead><tbody>';
          for (const row of rtm.events) {
            const idxAttr = row.entryIndex != null ? ' data-index="' + row.entryIndex + '"' : '';
            html += `<tr${idxAttr}><td>${escapeHtml(row.ts || '')}</td><td>${escapeHtml(row.ext || '')}</td><td>${escapeHtml(row.level || '')}</td><td>${escapeHtml(row.msg || '')}</td></tr>`;
          }
          html += '</tbody></table>';
        } else html += '<p class="insight-empty">No RTM events found.</p>';
        html += '</div>';

        html += '<div class="insight-tab-panel" data-panel="toolsTab">';
        const tools = insights.toolsTab || null;
        if (tools) {
          const callNames = tools.toolCalls ? Object.keys(tools.toolCalls).sort(function (a, b) { return (tools.toolCalls[b] || 0) - (tools.toolCalls[a] || 0); }) : [];
          let mcpBody = '<dl>';
          if (tools.isToolCallAvailable != null) mcpBody += '<dt>Tool calling available</dt><dd>' + (tools.isToolCallAvailable ? 'yes' : 'no') + '</dd>';
          if (tools.totalTools != null) mcpBody += '<dt>Total tools</dt><dd>' + escapeHtml(String(tools.totalTools)) + '</dd>';
          if (tools.servers && tools.servers.length) mcpBody += '<dt>Servers</dt><dd>' + escapeHtml(tools.servers.map(function (s) { return s.name + (s.transport ? ' (' + s.transport + ')' : '') + (s.url ? ' — ' + s.url : ''); }).join('\n')) + '</dd>';
          if (tools.mcpErrors && tools.mcpErrors.length) mcpBody += '<dt>MCP errors</dt><dd>' + escapeHtml(String(tools.mcpErrors.length)) + '</dd>';
          mcpBody += '</dl>';
          html += summaryCardSection('tools:mcp', 'MCP', mcpBody);
          if (callNames.length) {
            let cBody = '<dl>';
            for (const n of callNames) cBody += '<dt>' + escapeHtml(n) + '</dt><dd>' + escapeHtml(String(tools.toolCalls[n])) + '</dd>';
            cBody += '</dl>';
            html += summaryCardSection('tools:observed', 'Observed tool calls', cBody);
          }
          if (tools.events && tools.events.length) {
            html += '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Ext','Level','Message']) + '</tr></thead><tbody>';
            for (const row of tools.events) {
              const idxAttr = row.entryIndex != null ? ' data-index="' + row.entryIndex + '"' : '';
              html += `<tr${idxAttr}><td>${escapeHtml(row.ts || '')}</td><td>${escapeHtml(row.ext || '')}</td><td>${escapeHtml(row.level || '')}</td><td>${escapeHtml(row.msg || '')}</td></tr>`;
            }
            html += '</tbody></table>';
          } else html += '<p class="insight-empty">No MCP / tool-call logs found.</p>';
        } else html += '<p class="insight-empty">No MCP / tool-call logs found.</p>';
        html += '</div>';

        html += '<div class="insight-tab-panel" data-panel="ttsTab">';
        const ttsIssues = insights.ttsIssues || [];
        if (ttsIssues.length) {
          let iBody = '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Severity','Issue','Code','Detail']) + '</tr></thead><tbody>';
          for (const r of ttsIssues) {
            const tsAttr = escapeHtml(r.ts || '');
            const idxAttr = r.entryIndex != null ? ' data-index="' + r.entryIndex + '"' : '';
            const sev = r.kind === 'error' ? '<span style="color:var(--error)">error</span>' : r.kind === 'warning' ? 'warning' : 'info';
            iBody += `<tr class="${r.kind === 'error' ? 'llm-row error' : ''}" data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(r.ts)}</td><td>${sev}</td><td>${escapeHtml(r.issue || '—')}</td><td>${escapeHtml(r.code || '—')}</td><td>${escapeHtml((r.detail || '').slice(0, 100))}</td></tr>`;
          }
          iBody += '</tbody></table>';
          html += insightSection('tts:issues', 'TTS issues & hints', '', iBody);
        } else {
          html += '<p class="insight-empty">No TTS errors or warnings detected.</p>';
        }
        const ttsOut = insights.tts || [];
        if (ttsOut.length) {
          let oBody = '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Turn','Text','Duration (ms)']) + '</tr></thead><tbody>';
          for (const t of ttsOut) {
            const tsAttr = escapeHtml(t.ts || '');
            const idxAttr = t.entryIndex != null ? ' data-index="' + t.entryIndex + '"' : '';
            const textCell = insightLongTextCell((t.text || '') || '—');
            oBody += `<tr data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(t.ts)}</td><td>${t.turn_id != null ? escapeHtml(String(t.turn_id)) : '—'}</td><td>${textCell}</td><td>${t.duration_ms != null ? t.duration_ms : '—'}</td></tr>`;
          }
          oBody += '</tbody></table>';
          html += insightSection('tts:output', 'TTS output (transcripts / text results)', '', oBody);
        }
        html += '</div>';

        html += '<div class="insight-tab-panel" data-panel="ncs">';
        const ncs = insights.ncs || { events: [], memoryItems: [] };
        if (ncs.events && ncs.events.length) {
          html += '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Event','Agent','Start','Stop','Status','Message','Channel']) + '</tr></thead><tbody>';
          for (const r of ncs.events) {
            const tsAttr = escapeHtml(r.ts || '');
            const idxAttr = r.entryIndex != null ? ' data-index="' + r.entryIndex + '"' : '';
            html += `<tr data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(r.ts)}</td><td>${escapeHtml(r.event_type || '')}</td><td>${escapeHtml(r.agent_id || '—')}</td><td>${r.start_ts != null ? escapeHtml(String(r.start_ts)) : '—'}</td><td>${r.stop_ts != null ? escapeHtml(String(r.stop_ts)) : '—'}</td><td>${escapeHtml(r.status || '—')}</td><td>${escapeHtml((r.message || '').slice(0, 80) || '—')}</td><td>${escapeHtml(r.channel || '—')}</td></tr>`;
          }
          html += '</tbody></table>';
        } else {
          html += '<p class="insight-empty">No NCS events found.</p>';
        }

        if (ncs.memoryItems && ncs.memoryItems.length) {
          let memBody = '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Agent','Start','Stop','Timestamp(ms)','Role','Turn','Source','Interrupted','Confidence','Text']) + '</tr></thead><tbody>';
          for (const m of ncs.memoryItems) {
            const tsAttr = escapeHtml(m.ts || '');
            const idxAttr = m.entryIndex != null ? ' data-index="' + m.entryIndex + '"' : '';
            const text = (m.text || '').slice(0, 240) + ((m.text || '').length > 240 ? '…' : '');
            const interruptedStr = m.interrupted ? 'yes' : '—';
            const confidenceStr = m.confidence != null ? escapeHtml(String(m.confidence)) : '—';
            memBody += `<tr data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(m.ts)}</td><td>${escapeHtml(m.agent_id || '—')}</td><td>${m.start_ts != null ? escapeHtml(String(m.start_ts)) : '—'}</td><td>${m.stop_ts != null ? escapeHtml(String(m.stop_ts)) : '—'}</td><td>${m.timestamp_ms != null ? escapeHtml(String(m.timestamp_ms)) : '—'}</td><td>${escapeHtml(m.role || '—')}</td><td>${m.turn_id != null ? escapeHtml(String(m.turn_id)) : '—'}</td><td>${escapeHtml(m.source || '—')}</td><td>${escapeHtml(interruptedStr)}</td><td>${confidenceStr}</td><td>${escapeHtml(text || '—')}</td></tr>`;
          }
          memBody += '</tbody></table>';
          html += insightSection('ncs:memory', 'Keypoints Memory history', '', memBody);

          const interruptedItems = (ncs.memoryItems || []).filter(m => m.interrupted);
          if (interruptedItems.length) {
            let intBody = '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Agent','Timestamp(ms)','Role','Turn','Source','Confidence','Interrupt ts','Text']) + '</tr></thead><tbody>';
            for (const m of interruptedItems) {
              const tsAttr = escapeHtml(m.ts || '');
              const idxAttr = m.entryIndex != null ? ' data-index="' + m.entryIndex + '"' : '';
              const text = (m.text || '').slice(0, 240) + ((m.text || '').length > 240 ? '…' : '');
              const confidenceStr = m.confidence != null ? escapeHtml(String(m.confidence)) : '—';
              intBody += `<tr data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(m.ts)}</td><td>${escapeHtml(m.agent_id || '—')}</td><td>${m.timestamp_ms != null ? escapeHtml(String(m.timestamp_ms)) : '—'}</td><td>${escapeHtml(m.role || '—')}</td><td>${m.turn_id != null ? escapeHtml(String(m.turn_id)) : '—'}</td><td>${escapeHtml(m.source || '—')}</td><td>${confidenceStr}</td><td>${m.interrupt_timestamp_ms != null ? escapeHtml(String(m.interrupt_timestamp_ms)) : '—'}</td><td>${escapeHtml(text || '—')}</td></tr>`;
            }
            intBody += '</tbody></table>';
            html += insightSection('ncs:interrupted', 'Interrupted items', '', intBody);
          }
        }

        html += '</div>';

        html += '<div class="insight-tab-panel" data-panel="events">';
        if (insights.keypointEvents && insights.keypointEvents.length) {
          html += '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Event type','Extension']) + '</tr></thead><tbody>';
          for (const k of insights.keypointEvents) {
            const tsAttr = escapeHtml(k.ts || '');
            const idxAttr = k.entryIndex != null ? ' data-index="' + k.entryIndex + '"' : '';
            html += `<tr data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(k.ts)}</td><td>${escapeHtml(k.event_type)}</td><td>${escapeHtml(k.ext || '')}</td></tr>`;
          }
          html += '</tbody></table>';
        } else html += '<p class="insight-empty">No KEYPOINT events found.</p>';
        html += '</div>';

        html += '</div>';
        root.innerHTML = html;

        // JSON modal buttons (Summary tab)
        root.querySelectorAll('.open-json-modal').forEach(function (btn) {
          btn.addEventListener('click', function (ev) {
            ev.preventDefault();
            const kind = btn.getAttribute('data-json-kind');
            const sum = insights && insights.summary ? insights.summary : null;
            if (!sum) return;
            if (kind === 'eventStart' && sum.eventStartInfo) {
              openJsonModal('Event start JSON', 'Parsed from log', sum.eventStartInfo);
            } else if (kind === 'createReq' && sum.createRequestBody) {
              const isLoggedBody = sum.createRequestBodySource === 'logged request body';
              const subtitle = isLoggedBody
                ? 'Parsed from logged request body'
                : 'Parsed from log runtime config, not the request that was sent';
              const schema = sum.createRequestBodySchema ? ' (' + sum.createRequestBodySchema + ')' : '';
              openJsonModal('Create request JSON', subtitle + schema, sum.createRequestBody, { warning: !isLoggedBody });
            }
          });
        });

        root.querySelectorAll('.perf-chart-wrap').forEach(function (wrap) {
          const chartSvg = wrap.querySelector('.perf-chart-svg-wrap svg');
          if (!chartSvg) return;
          const tooltip = document.createElement('div');
          tooltip.className = 'perf-chart-tooltip';
          tooltip.setAttribute('role', 'status');
          wrap.appendChild(tooltip);
          let pinnedPoint = null;
          function pointMarker(point) {
            const id = point.getAttribute('data-point-id');
            return id ? wrap.querySelector('.perf-point-marker[data-point-id="' + id + '"]') : null;
          }
          function nearestPointFromEvent(ev) {
            if (!ev || typeof chartSvg.createSVGPoint !== 'function') return null;
            const matrix = chartSvg.getScreenCTM();
            if (!matrix) return null;
            const svgPoint = chartSvg.createSVGPoint();
            svgPoint.x = ev.clientX;
            svgPoint.y = ev.clientY;
            const p = svgPoint.matrixTransform(matrix.inverse());
            let best = null;
            let bestDist = Infinity;
            wrap.querySelectorAll('.perf-point-hit').forEach(function (point) {
              const seriesKey = point.getAttribute('data-series');
              const group = seriesKey ? wrap.querySelector('g[data-series="' + seriesKey + '"]') : null;
              if (group && group.classList.contains('perf-series-off')) return;
              const cx = parseFloat(point.getAttribute('data-cx'));
              const cy = parseFloat(point.getAttribute('data-cy'));
              if (!isFinite(cx) || !isFinite(cy)) return;
              const dx = p.x - cx;
              const dy = p.y - cy;
              const dist = dx * dx + dy * dy;
              if (dist < bestDist) {
                bestDist = dist;
                best = point;
              }
            });
            return best;
          }
          function clearHover() {
            wrap.querySelectorAll('.perf-point-marker.hovered').forEach(function (m) { m.classList.remove('hovered'); });
          }
          function clearActive() {
            wrap.querySelectorAll('.perf-point-marker.active').forEach(function (m) { m.classList.remove('active'); });
            root.querySelectorAll('.perf-table-row.active').forEach(function (r) { r.classList.remove('active'); });
          }
          function placeTooltip(point, ev) {
            const wrapRect = wrap.getBoundingClientRect();
            const pointRect = point.getBoundingClientRect();
            const rawX = ev && ev.clientX ? ev.clientX - wrapRect.left : pointRect.left + pointRect.width / 2 - wrapRect.left;
            const rawY = ev && ev.clientY ? ev.clientY - wrapRect.top : pointRect.top - wrapRect.top;
            const maxX = Math.max(12, wrapRect.width - 220);
            const x = Math.max(12, Math.min(rawX + 12, maxX));
            const y = Math.max(12, rawY - 48);
            tooltip.style.left = x + 'px';
            tooltip.style.top = y + 'px';
          }
          function showPoint(point, ev, pin) {
            const marker = pointMarker(point);
            const turnId = point.getAttribute('data-turn') || '';
            const label = point.getAttribute('data-label') || '';
            const value = point.getAttribute('data-value') || '';
            tooltip.innerHTML = '<strong>' + escapeHtml(label) + '</strong><span>Turn ' + escapeHtml(turnId) + ' · ' + escapeHtml(value) + ' ms</span>' + (pin ? '<em>Selected</em>' : '');
            tooltip.classList.add('visible');
            placeTooltip(point, ev);
            clearHover();
            if (marker) marker.classList.add('hovered');
            if (pin) {
              pinnedPoint = point;
              clearActive();
              if (marker) marker.classList.add('active');
              const row = root.querySelector('.perf-table-row[data-turn-id="' + turnId + '"]');
              if (row) row.classList.add('active');
            }
          }
          function hidePoint(point) {
            if (pinnedPoint === point) return;
            clearHover();
            if (pinnedPoint) showPoint(pinnedPoint, null, true);
            else tooltip.classList.remove('visible');
          }
          wrap.querySelectorAll('.perf-point-hit').forEach(function (point) {
            point.addEventListener('mouseenter', function (ev) { showPoint(nearestPointFromEvent(ev) || point, ev, false); });
            point.addEventListener('mousemove', function (ev) {
              const nearest = nearestPointFromEvent(ev) || point;
              if (pinnedPoint !== nearest) showPoint(nearest, ev, false);
              else placeTooltip(nearest, ev);
            });
            point.addEventListener('mouseleave', function () { hidePoint(point); });
            point.addEventListener('focus', function () { showPoint(point, null, false); });
            point.addEventListener('blur', function () { hidePoint(point); });
            point.addEventListener('click', function (ev) {
              ev.stopPropagation();
              const nearest = (ev.clientX || ev.clientY) ? (nearestPointFromEvent(ev) || point) : point;
              if (pinnedPoint === nearest) {
                pinnedPoint = null;
                clearActive();
                tooltip.classList.remove('visible');
                clearHover();
              } else {
                showPoint(nearest, ev, true);
              }
            });
            point.addEventListener('keydown', function (ev) {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                point.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 0, clientY: 0 }));
              } else if (ev.key === 'Escape') {
                pinnedPoint = null;
                clearActive();
                clearHover();
                tooltip.classList.remove('visible');
                point.blur();
              }
            });
          });
          chartSvg.addEventListener('click', function () {
            if (!pinnedPoint) return;
            pinnedPoint = null;
            clearActive();
            clearHover();
            tooltip.classList.remove('visible');
          });
          wrap.querySelectorAll('.perf-legend-item').forEach(function (el) {
            el.addEventListener('click', function () {
              const key = el.getAttribute('data-series');
              if (!key) return;
              wrap.querySelectorAll('g[data-series="' + key + '"]').forEach(function (g) { g.classList.toggle('perf-series-off'); });
              el.classList.toggle('dimmed');
              if (pinnedPoint && pinnedPoint.getAttribute('data-series') === key) {
                pinnedPoint = null;
                clearActive();
                clearHover();
                tooltip.classList.remove('visible');
              }
            });
            el.addEventListener('keydown', function (e) {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                el.click();
              }
            });
          });
        });

        root.querySelectorAll('.insight-tab').forEach(btn => {
          btn.addEventListener('click', function () {
            const tab = this.getAttribute('data-tab');
            root.querySelectorAll('.insight-tab').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            root.querySelectorAll('.insight-tab-panel').forEach(p => {
              p.classList.toggle('active', p.getAttribute('data-panel') === tab);
            });
            applyInsightFilter();
          });
        });

        const filterInput = document.getElementById('insightFilterInput');
        if (filterInput) {
          filterInput.addEventListener('input', applyInsightFilter);
          filterInput.addEventListener('keyup', applyInsightFilter);
        }

        // Low-confidence-only toggle on the STT tab: hides any stt-conf-row
        // that isn't tagged `data-conf-low="1"` when checked. Re-applies the
        // search/column filter so the two compose cleanly.
        root.querySelectorAll('.stt-conf-lowonly').forEach(cb => {
          cb.addEventListener('change', function () {
            const show = !this.checked;
            root.querySelectorAll('.stt-conf-row').forEach(tr => {
              tr.classList.toggle('stt-conf-row-hidden', !show && tr.getAttribute('data-conf-low') !== '1');
            });
            applyInsightFilter();
          });
        });

        // Persist collapsed/expanded state for every <details.insight-section>
        // so user layout choices survive re-renders and page reloads.
        // `toggle` bubbles when the listener is `capture:true` (browsers
        // intentionally don't bubble it by default).
        root.addEventListener('toggle', function (ev) {
          const det = ev.target;
          if (!det || !det.classList || !det.classList.contains('insight-section')) return;
          const id = det.getAttribute('data-section-id');
          if (!id) return;
          const state = insightSectionStateLoad();
          state[id] = !!det.open;
          insightSectionStateSave(state);
        }, true);

        root.addEventListener('click', function (ev) {
          const th = ev.target.closest('.insight-th-filter');
          if (!th) return;
          ev.preventDefault();
          const table = th.closest('table');
          const panel = th.closest('.insight-tab-panel');
          if (!panel || !table) return;
          const panelId = panel.getAttribute('data-panel');
          const tables = panel.querySelectorAll('.insight-table');
          const tableIndex = Array.prototype.indexOf.call(tables, table);
          const colIndex = parseInt(th.getAttribute('data-col-index'), 10);
          if (isNaN(colIndex)) return;
          const key = panelId + '_' + tableIndex;
          const col = colIndex + 1;
          const values = new Set();
          table.querySelectorAll('tbody tr').forEach(tr => {
            const cell = tr.querySelector('td:nth-child(' + col + ')');
            if (cell) values.add((cell.textContent || '').trim());
          });
          const sortedValues = Array.from(values).filter(Boolean).sort();
          let dropdown = document.getElementById('insightColFilterDropdown');
          if (!dropdown) {
            dropdown = document.createElement('div');
            dropdown.id = 'insightColFilterDropdown';
            dropdown.className = 'insight-col-filter-dropdown';
            document.body.appendChild(dropdown);
            dropdown.addEventListener('click', function (e) {
              e.stopPropagation();
            });
            document.addEventListener('click', function (e) {
              if (!dropdown.classList.contains('visible')) return;
              if (dropdown.contains(e.target) || (e.target.closest && e.target.closest('.insight-th-filter'))) return;
              dropdown.classList.remove('visible');
            });
          }
          dropdown._currentTable = table;
          dropdown._currentKey = key;
          dropdown._currentValues = sortedValues;
          dropdown._currentColIndex = colIndex;
          const currentFilter = insightColumnFilter[key];
          const selectedSet = (currentFilter && Array.isArray(currentFilter.values)) ? new Set(currentFilter.values.map(String)) : new Set();
          dropdown.innerHTML = '<button type="button" class="all" data-value="__all__" data-filter-key="' + key + '">All</button>' +
            sortedValues.map((v, i) => {
              const checked = selectedSet.has(String(v)) ? ' checked' : '';
              return '<label><input type="checkbox" data-value-index="' + i + '" data-filter-key="' + key + '"' + checked + ' />' + escapeHtml(v) + '</label>';
            }).join('');
          dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', function () {
              const k = this.getAttribute('data-filter-key');
              const values = dropdown._currentValues;
              const idx = parseInt(this.getAttribute('data-value-index'), 10);
              const val = values && values[idx] != null ? values[idx] : this.value;
              let filter = insightColumnFilter[k];
              if (!filter) filter = { colIndex: colIndex, values: [] };
              if (!Array.isArray(filter.values)) filter.values = [];
              const set = new Set(filter.values.map(String));
              if (this.checked) set.add(String(val)); else set.delete(String(val));
              filter.values = Array.from(set);
              if (filter.values.length === 0) delete insightColumnFilter[k];
              else insightColumnFilter[k] = filter;
              table.querySelectorAll('th.insight-th-filter').forEach(h => h.classList.remove('filter-active'));
              if (filter.values && filter.values.length) {
                const thToMark = table.querySelector('th.insight-th-filter[data-col-index="' + colIndex + '"]');
                if (thToMark) thToMark.classList.add('filter-active');
              }
              applyInsightFilter();
            });
          });
          dropdown.querySelector('button.all').addEventListener('click', function () {
            delete insightColumnFilter[dropdown._currentKey];
            table.querySelectorAll('th.insight-th-filter').forEach(h => h.classList.remove('filter-active'));
            applyInsightFilter();
            dropdown.classList.remove('visible');
          });
          const rect = th.getBoundingClientRect();
          dropdown.style.left = rect.left + 'px';
          dropdown.style.top = (rect.bottom + 2) + 'px';
          dropdown.classList.add('visible');
        });

        applyInsightFilter();
      }

      function applyInsightFilter() {
        const q = (document.getElementById('insightFilterInput') && document.getElementById('insightFilterInput').value || '').trim().toLowerCase();
        const activePanel = document.querySelector('.insight-tab-panel.active');
        if (!activePanel) return;
        const panelId = activePanel.getAttribute('data-panel');
        activePanel.querySelectorAll('.insight-table').forEach((table, tableIndex) => {
          const key = panelId + '_' + tableIndex;
          const colFilter = insightColumnFilter[key];
          table.querySelectorAll('th.insight-th-filter').forEach(h => h.classList.remove('filter-active'));
          if (colFilter && colFilter.colIndex != null && colFilter.values && colFilter.values.length) {
            const th = table.querySelector('th.insight-th-filter[data-col-index="' + colFilter.colIndex + '"]');
            if (th) th.classList.add('filter-active');
          }
          table.querySelectorAll('tbody tr').forEach(tr => {
            const text = tr.textContent || '';
            const textOk = !q || text.toLowerCase().includes(q);
            let colOk = true;
            if (colFilter && colFilter.colIndex != null && Array.isArray(colFilter.values) && colFilter.values.length > 0) {
              const cell = tr.querySelector('td:nth-child(' + (colFilter.colIndex + 1) + ')');
              const cellText = (cell && cell.textContent || '').trim();
              colOk = colFilter.values.some(v => String(v).trim() === cellText);
            }
            // Respect the low-only toggle on the STT confidence table: a row
            // tagged `stt-conf-row-hidden` stays hidden regardless of the
            // search/column filter result.
            const hiddenByToggle = tr.classList.contains('stt-conf-row-hidden');
            tr.style.display = textOk && colOk && !hiddenByToggle ? '' : 'none';
          });
        });
      }

      let state = {
        entries: [],
        summary: {},
        extensions: [],
        insights: null,
        /** Original file text (for download); not modified by parsing. */
        rawLogText: '',
        sourceFileName: '',
        selectedIndex: null,
        contextRadius: null,
        pendingScrollToSelection: false,
        // Per-log-entry JSON expand/collapse state (keyed by global log index).
        jsonExpanded: {},
        // When set (true/false), acts as a default for all log lines unless overridden in jsonExpanded.
        jsonAllExpanded: null,
        // Per-log-entry line expand/collapse state (keyed by global log index).
        lineExpanded: {},
        // When set, acts as a default for all log lines unless overridden in lineExpanded.
        lineAllExpanded: null
      };
      let insightColumnFilter = {};

      /** So the jumped-to line is actually in the DOM (not hidden by errors-only, extension, search, time). */
      function resetLogFiltersForInsightsJump() {
        document.getElementById('filterI').checked = true;
        document.getElementById('filterD').checked = true;
        document.getElementById('filterW').checked = true;
        document.getElementById('filterE').checked = true;
        document.getElementById('extFilter').value = '';
        document.getElementById('searchInput').value = '';
        document.getElementById('timeFrom').value = '';
        document.getElementById('timeTo').value = '';
        document.getElementById('goToFirstMatch').style.display = 'none';
      }

      /** logContainer scrolls, not the window — center the selected row after layout. */
      function scrollSelectedIntoLogContainer() {
        const idx = state.selectedIndex;
        if (idx == null) return;
        const logContainer = document.getElementById('logContainer');
        const logEntries = document.getElementById('logEntries');
        if (!logContainer || !logEntries) return;
        const selEl = logEntries.querySelector('.log-entry[data-index="' + idx + '"]');
        if (!selEl) return;
        const lcRect = logContainer.getBoundingClientRect();
        const elRect = selEl.getBoundingClientRect();
        const delta = (elRect.top + elRect.height / 2) - (lcRect.top + lcRect.height / 2);
        logContainer.scrollTop += delta;
      }

      function clampLogScrollTop() {
        const logContainer = document.getElementById('logContainer');
        if (!logContainer) return;
        const max = Math.max(0, logContainer.scrollHeight - logContainer.clientHeight);
        if (logContainer.scrollTop > max) logContainer.scrollTop = max;
        if (logContainer.scrollTop < 0) logContainer.scrollTop = 0;
      }

      // ---------- Lazy JSON hydration for log entries ----------
      let jsonObserver = null;
      const observedJsonEntries = new WeakSet();
      let jsonHydrateQueue = [];
      let jsonHydrateRaf = null;

      function requestedExpandedForIndex(idx) {
        if (!state) return false;
        if (state.jsonExpanded && Object.prototype.hasOwnProperty.call(state.jsonExpanded, idx)) {
          return !!state.jsonExpanded[idx];
        }
        return state.jsonAllExpanded != null ? !!state.jsonAllExpanded : false;
      }

      function hydrateJsonBlockNow(block, idx) {
        if (!block) return;
        if (block.dataset && block.dataset.hydrated === '1') return;
        const entry = state && state.entries ? state.entries[idx] : null;
        if (!entry || !entry.json) {
          block.innerHTML = '';
          if (block.dataset) block.dataset.hydrated = '0';
          return;
        }
        const str = JSON.stringify(entry.json, null, 2);
        block.innerHTML = escapeHtml(str);
        if (block.dataset) block.dataset.hydrated = '1';
      }

      function processJsonHydrateQueue() {
        jsonHydrateRaf = null;
        const start = performance.now();
        while (jsonHydrateQueue.length) {
          const item = jsonHydrateQueue.shift();
          if (item && item.block && item.idx != null) {
            if (item.block.dataset) item.block.dataset.hydrationQueued = '0';
            hydrateJsonBlockNow(item.block, item.idx);
          }
          if (performance.now() - start > 10) break;
        }
        if (jsonHydrateQueue.length) {
          jsonHydrateRaf = requestAnimationFrame(processJsonHydrateQueue);
        }
      }

      function queueHydrateJsonBlock(block, idx) {
        if (!block) return;
        if (block.dataset && block.dataset.hydrated === '1') return;
        if (block.dataset && block.dataset.hydrationQueued === '1') return;
        if (block.dataset) block.dataset.hydrationQueued = '1';
        jsonHydrateQueue.push({ block, idx });
        if (!jsonHydrateRaf) jsonHydrateRaf = requestAnimationFrame(processJsonHydrateQueue);
      }

      function ensureJsonObserver() {
        if (jsonObserver) return;
        const root = document.getElementById('logContainer');
        if (!root) return;
        jsonObserver = new IntersectionObserver(function (obsEntries) {
          obsEntries.forEach(function (obs) {
            const logEntryEl = obs.target;
            const block = logEntryEl.querySelector && logEntryEl.querySelector('.json-block');
            if (!block) return;
            const toggle = logEntryEl.querySelector && logEntryEl.querySelector('.json-toggle');
            const idx = parseInt(block.dataset.jsonEntryIndex || block.getAttribute('data-json-entry-index') || '', 10);
            if (isNaN(idx)) return;
            const shouldExpand = requestedExpandedForIndex(idx);
            const hasPerOverride = state && state.jsonExpanded && Object.prototype.hasOwnProperty.call(state.jsonExpanded, idx);

            if (obs.isIntersecting) {
              if (shouldExpand) {
                if (block.style.display !== 'block') block.style.display = 'block';
                if (toggle) {
                  toggle.textContent = '▲ Hide JSON';
                  toggle.setAttribute('aria-expanded', 'true');
                }
                if (!block.innerHTML || (block.dataset && block.dataset.hydrated !== '1')) {
                  if (block.dataset && block.dataset.hydrated) block.dataset.hydrated = '0';
                  block.innerHTML = '<div class="json-loading">Loading…</div>';
                }
                // Global expand-all: show placeholders only. Per-entry toggle: hydrate.
                if (hasPerOverride) queueHydrateJsonBlock(block, idx);
              } else {
                if (block.style.display === 'block') block.style.display = 'none';
                if (toggle) {
                  toggle.textContent = '▼ Show JSON';
                  toggle.setAttribute('aria-expanded', 'false');
                }
              }
            } else {
              if (block.style.display === 'block') {
                block.style.display = 'none';
                // When global expand/collapse is active, keep memory usage in check.
                if (!hasPerOverride && state && state.jsonAllExpanded != null) {
                  block.innerHTML = '';
                  if (block.dataset) block.dataset.hydrated = '0';
                }
                if (toggle) {
                  toggle.textContent = shouldExpand ? '▲ Hide JSON' : '▼ Show JSON';
                  toggle.setAttribute('aria-expanded', shouldExpand ? 'true' : 'false');
                }
              }
            }
          });
        }, { root: root, threshold: 0.05 });
      }

      function syncJsonObserverTargets(containerEl) {
        ensureJsonObserver();
        if (!jsonObserver || !containerEl || !containerEl.querySelectorAll) return;
        containerEl.querySelectorAll('.log-entry').forEach(function (el) {
          if (observedJsonEntries.has(el)) return;
          observedJsonEntries.add(el);
          jsonObserver.observe(el);
        });
      }

      function doApplyFilters() {
        // Return a promise so the overlay spinner can stay visible
        // until chunked DOM rendering completes.
        let resolveFn = null;
        const donePromise = new Promise(function (resolve) {
          resolveFn = resolve;
        });
        const showI = document.getElementById('filterI').checked;
        const showD = document.getElementById('filterD').checked;
        const showW = document.getElementById('filterW').checked;
        const showE = document.getElementById('filterE').checked;
        const searchRaw = (document.getElementById('searchInput').value || '').trim();
        const search = searchRaw.toLowerCase();
        const ext = (document.getElementById('extFilter').value || '').trim();
        const timeFromStr = (document.getElementById('timeFrom').value || '').trim();
        const timeToStr = (document.getElementById('timeTo').value || '').trim();
        const timeFromVal = timeFromStr ? parseUserDateTime(timeFromStr) : NaN;
        const timeToVal = timeToStr ? parseUserDateTime(timeToStr) : NaN;
        const wantTimeFrom = !isNaN(timeFromVal);
        const wantTimeTo = !isNaN(timeToVal);
        const contextRadius = state.contextRadius;
        const selectedIndex = state.selectedIndex;

        let pool = state.entries;
        let baseGlobalIndex = 0;
        if (contextRadius != null && selectedIndex != null) {
          const low = Math.max(0, selectedIndex - contextRadius);
          const high = Math.min(state.entries.length - 1, selectedIndex + contextRadius);
          pool = state.entries.slice(low, high + 1);
          baseGlobalIndex = low;
        }

        // Build an array of { entry, globalIdx } to avoid O(n) indexOf lookups.
        const visible = [];
        for (let i = 0; i < pool.length; i++) {
          const e = pool[i];
          const globalIdx = baseGlobalIndex + i;
          if (e.level === 'I' && !showI) continue;
          if (e.level === 'D' && !showD) continue;
          if (e.level === 'W' && !showW) continue;
          if (e.level === 'E' && !showE) continue;
          if (ext && e.ext !== ext) continue;
          if (search && !(e.msg && e.msg.toLowerCase().includes(search))) continue;
          if (wantTimeFrom || wantTimeTo) {
            const et = parseLogTs(e.ts);
            if (wantTimeFrom && (isNaN(et) || et < timeFromVal)) continue;
            if (wantTimeTo && (isNaN(et) || et > timeToVal)) continue;
          }
          visible.push({ entry: e, globalIdx });
        }

        const foundCountEl = document.getElementById('foundCount');
        if (foundCountEl) {
          const n = visible.length;
          foundCountEl.textContent = 'Found ' + n + ' line' + (n === 1 ? '' : 's');
        }

        const container = document.getElementById('logEntries');
        container.style.display = 'block';
        container.innerHTML = '';

        const maxInlineHtml = 2000; // chunk rendering for large logs
        const doFinalize = function () {
          requestAnimationFrame(function () {
            clampLogScrollTop();

            if (selectedIndex != null && state.pendingScrollToSelection) {
              state.pendingScrollToSelection = false;
              requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                  scrollSelectedIntoLogContainer();
                  if (resolveFn) resolveFn();
                });
              });
            } else {
              if (resolveFn) resolveFn();
            }
          });
        };

        if (visible.length <= maxInlineHtml) {
          container.innerHTML = visible.map((v) => {
            return renderEntry(v.entry, v.globalIdx, v.globalIdx === selectedIndex, searchRaw);
          }).join('');
          doFinalize();
        } else {
          const chunkSize = 750;
          let cursor = 0;

          function renderNextChunk() {
            const end = Math.min(visible.length, cursor + chunkSize);
            const html = visible.slice(cursor, end).map((v) => {
              return renderEntry(v.entry, v.globalIdx, v.globalIdx === selectedIndex, searchRaw);
            }).join('');
            container.insertAdjacentHTML('beforeend', html);
            cursor = end;

            if (cursor < visible.length) {
              requestAnimationFrame(renderNextChunk);
            } else {
              doFinalize();
            }
          }

          renderNextChunk();
        }

        const ctxBar = document.getElementById('contextBar');
        ctxBar.classList.toggle('visible', selectedIndex != null);
        const ctxLbl = document.getElementById('ctxBarLabel');
        if (ctxLbl && selectedIndex != null) {
          ctxLbl.textContent =
            contextRadius != null
              ? 'Showing ±' + contextRadius + ' lines around the selected message (rest of file is hidden). Use Full log or Clear filters to see everything.'
              : 'Full log is visible; selected line is highlighted. Use Done to hide this bar.';
        }

        const searchWrap = (document.getElementById('searchInput').value || '').trim();
        document.getElementById('goToFirstMatch').style.display = searchWrap ? 'inline-block' : 'none';

        // JSON expand/collapse is disabled in log view (line expand/collapse only).

        return donePromise;
      }

      let applyFiltersSeq = 0;
      let applyFiltersDebounceTimer = null;
      let applyFiltersSpinnerTimer = null;
      function applyFilters() {
        // Debounce expensive DOM re-rendering and show a lightweight spinner only if it takes time.
        applyFiltersSeq++;
        const seq = applyFiltersSeq;

        if (applyFiltersDebounceTimer) clearTimeout(applyFiltersDebounceTimer);
        if (applyFiltersSpinnerTimer) clearTimeout(applyFiltersSpinnerTimer);

        // Delay the actual work so we don't re-render while the user is still typing.
        applyFiltersDebounceTimer = setTimeout(function () {
          // If a newer update request came in, do nothing.
          if (seq !== applyFiltersSeq) return;
          setParseOverlay(true, 'Updating view…');
          try {
            const p = doApplyFilters();
            if (p && typeof p.finally === 'function') {
              p.finally(function () {
                setParseOverlay(false);
              });
            } else {
              setParseOverlay(false);
            }
          } catch (_) {
            setParseOverlay(false);
          }
        }, 250);
      }

      function goToFirstMatch() {
        const search = (document.getElementById('searchInput').value || '').trim().toLowerCase();
        if (!search) return;
        const idx = state.entries.findIndex(e => e.msg && e.msg.toLowerCase().includes(search));
        if (idx < 0) return;
        document.querySelector('.view-tabs button[data-view="log"]').click();
        document.getElementById('filterI').checked = true;
        document.getElementById('filterD').checked = true;
        document.getElementById('filterW').checked = true;
        document.getElementById('filterE').checked = true;
        document.getElementById('extFilter').value = '';
        document.getElementById('timeFrom').value = '';
        document.getElementById('timeTo').value = '';
        state.selectedIndex = idx;
        state.contextRadius = 50;
        state.pendingScrollToSelection = true;
        applyFilters();
      }

      /** Argus needs fromTs/toTs so search is not limited to a default 3-day window. */
      function computeArgusTimeRangeSec(summary, entries) {
        let startSec = summary.startTs != null ? Number(summary.startTs) : null;
        let endSec = summary.stopTs != null ? Number(summary.stopTs) : null;
        if (startSec == null && entries.length) {
          const t = parseLogTs(entries[0].ts);
          if (!isNaN(t)) startSec = Math.floor(t / 1000);
        }
        if (endSec == null && entries.length) {
          const t = parseLogTs(entries[entries.length - 1].ts);
          if (!isNaN(t)) endSec = Math.ceil(t / 1000);
        }
        if (startSec == null && endSec != null) startSec = endSec - 7200;
        if (startSec == null) return null;
        if (endSec == null) endSec = startSec + 7200;
        const padBefore = 3600;
        const padAfter = 3600;
        let fromTs = Math.floor(startSec - padBefore);
        let toTs = Math.ceil(endSec + padAfter);
        if (toTs <= fromTs) toTs = fromTs + 3600;
        if (fromTs < 0) fromTs = 0;
        return { fromTs, toTs };
      }

      function argusFallbackRangeSec() {
        const now = Math.floor(Date.now() / 1000);
        return { fromTs: now - 86400 * 30, toTs: now };
      }

      function argusUrlBySid(rtcSid, fromTs, toTs) {
        return (
          'https://argus.agoralab.co/call/search?sids=' +
          encodeURIComponent(rtcSid) +
          '&fromTs=' +
          fromTs +
          '&toTs=' +
          toTs +
          '&page=1'
        );
      }

      function argusUrlByChannel(channelName, fromTs, toTs) {
        return (
          'https://argus.agoralab.co/call/search?sids=&channelName=' +
          encodeURIComponent(channelName) +
          '&fromTs=' +
          fromTs +
          '&toTs=' +
          toTs +
          '&page=1'
        );
      }

      /** CSTool: parse_ten_err → poll → OSS .tgz (same as rtsc-tools Log 快速分析). */
      const CSTOOL_ORIGIN = 'https://rtsc-tools.sh3.agoralab.co';
      const CSTOOL_POLL_MS = 3000;
      const CSTOOL_MAX_WAIT_MS = 12 * 60 * 1000;

      function cstoolDirectRoot() {
        try {
          const o = localStorage.getItem('tenLogReader_cstoolOrigin');
          if (o && /^https?:\/\/.+/i.test(o)) return o.replace(/\/$/, '');
        } catch (e) {}
        return CSTOOL_ORIGIN;
      }

      function cstoolProxyRoot() {
        try {
          const p = localStorage.getItem('tenLogReader_cstoolProxy');
          if (p && /^https?:\/\/.+/i.test(p)) return p.replace(/\/$/, '');
          if (window.__TEN_LOG_READER_BUILTIN_CSTOOL__) {
            return window.location.origin.replace(/\/$/, '');
          }
        } catch (e2) {}
        return '';
      }

      function cstoolFetchRoot() {
        return cstoolProxyRoot() || cstoolDirectRoot();
      }

      function cstoolDirectOriginMatchesReader() {
        try {
          return window.location.origin === new URL(cstoolDirectRoot()).origin;
        } catch (e) {
          return false;
        }
      }

      function cstoolFetchCanWork() {
        return !!cstoolProxyRoot() || cstoolDirectOriginMatchesReader() || !!window.__TEN_INVESTIGATOR_BASE__;
      }

      function investigatorAvailable() {
        return !!window.__TEN_INVESTIGATOR_BASE__;
      }

      function getInvestigatorBase() {
        return window.__TEN_INVESTIGATOR_BASE__ || '';
      }

      function cstoolFetchOriginMatchesReader() {
        try {
          return window.location.origin === new URL(cstoolFetchRoot()).origin;
        } catch (e) {
          return false;
        }
      }

      function cstoolFetchCredentials() {
        return cstoolFetchOriginMatchesReader() ? 'include' : 'omit';
      }

      /** True when this app is served from rtsc-tools and no separate proxy URL is set — browser sends cookies via credentials. */
      function cstoolUsesBrowserSessionOnly() {
        return cstoolDirectOriginMatchesReader() && !cstoolProxyRoot();
      }

      /** Heuristic: clipboard text plausibly from a Cookie request header (not a guarantee). */
      function looksLikeCookieHeader(text) {
        const s = String(text || '').trim();
        if (s.length < 24) return false;
        if (!/=/.test(s)) return false;
        if (/^https?:\/\//i.test(s)) return false;
        if (/^\s*\{/m.test(s)) return false;
        return /HCIAuthToken|accessToken|_streamlit|session|csrf|xsrf|_ga=/i.test(s);
      }

      /** Pasted cookie is sent to your proxy as X-CSTOOL-Cookie (browser cannot set Cookie on rtsc-tools cross-origin). */
      function cstoolClientHeaders() {
        try {
          if (!cstoolProxyRoot()) return null;
          const c = sessionStorage.getItem('tenLogReader_cstoolCookie');
          if (c && String(c).trim()) {
            return { 'X-CSTOOL-Cookie': String(c).trim() };
          }
        } catch (e) {}
        return null;
      }

      /**
       * DevTools sometimes copies Set-Cookie text with ;Domain=…;HttpOnly — strip attributes so the proxy can forward a valid Cookie header.
       */
      function normalizePastedCstoolCookie(s) {
        if (!s || typeof s !== 'string') return s;
        let t = s.trim();
        const cut = t.search(/;\s*(Domain|Path|Max-Age|Expires|HttpOnly|Secure|SameSite)\s*=/i);
        if (cut > 0) t = t.slice(0, cut).trim();
        return t;
      }

      function getStoredCstoolCookie() {
        try {
          const c = sessionStorage.getItem('tenLogReader_cstoolCookie');
          return c && String(c).trim() ? String(c).trim() : '';
        } catch (e) {
          return '';
        }
      }

      /** For one-click Fetch: read clipboard without opening the modal (no UI permission prompt in some browsers until gesture — still part of same click). */
      function trySilentClipboardCookieForCstool() {
        return new Promise(function (resolve) {
          if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
            resolve({ ok: false, reason: 'unavailable' });
            return;
          }
          navigator.clipboard
            .readText()
            .then(function (text) {
              const t = (text || '').trim();
              if (!t) {
                resolve({ ok: false, reason: 'empty' });
                return;
              }
              if (!looksLikeCookieHeader(t)) {
                resolve({ ok: false, reason: 'not_cookie' });
                return;
              }
              const norm = normalizePastedCstoolCookie(t);
              try {
                sessionStorage.setItem('tenLogReader_cstoolCookie', norm);
              } catch (e2) {}
              resolve({ ok: true });
            })
            .catch(function () {
              resolve({ ok: false, reason: 'denied' });
            });
        });
      }

      /** python -m http.server does not implement POST to /cstoolconvoai/ — returns 501 HTML. */
      function getCstoolProxySameAsReaderError() {
        try {
          if (window.__TEN_LOG_READER_BUILTIN_CSTOOL__) return null;
          const p = cstoolProxyRoot();
          if (!p || window.location.protocol === 'file:') return null;
          const readerOrigin = window.location.origin;
          const proxyOrigin = new URL(p).origin;
          if (readerOrigin === proxyOrigin) {
            return (
              'CSTool proxy URL must be a different origin than this page (e.g. http://127.0.0.1:8787 for local Node proxy), unless you deployed the built-in Vercel proxy (same site, no URL needed).'
            );
          }
        } catch (e) {}
        return null;
      }

      /** file:// has no normal origin — CORS with the proxy usually fails with "Failed to fetch". */
      function getCstoolFileProtocolError() {
        try {
          if (window.location.protocol === 'file:') {
            return (
              'This page was opened as a local file (file://…). Browsers do not give it a real web origin, so fetch to your CSTool proxy usually fails.\n\n' +
              'From the project folder run:\n  python3 -m http.server 8080\n' +
              'then open:\n  http://127.0.0.1:8080/index.html\n\n' +
              'On the proxy, set ALLOWED_ORIGIN=http://127.0.0.1:8080 (or use ALLOWED_ORIGIN=* only for local testing).'
            );
          }
        } catch (e) {}
        return null;
      }

      /** HTTPS reader pages cannot fetch http://127.0.0.1 (mixed content) — browser reports opaque "Failed to fetch". */
      function getCstoolMixedContentProxyError() {
        try {
          if (window.location.protocol !== 'https:') return null;
          const p = cstoolProxyRoot();
          if (!p) return null;
          const u = new URL(p);
          if (u.protocol === 'http:') {
            return (
              'This page is loaded over HTTPS, but your CSTool proxy URL is HTTP (' +
              p +
              '). The browser blocks that (mixed content), so you only see “Failed to fetch”. ' +
              'Fix: expose the proxy over HTTPS (e.g. cloudflared tunnel, ngrok) and paste that https:// URL, or deploy proxy/cf-worker.mjs and use the Worker URL.'
            );
          }
        } catch (e) {}
        return null;
      }

      function getCstoolTenLogPageUrl(agentId, environment) {
        const root = cstoolDirectRoot();
        const env = environment || 'prod';
        return (
          root +
          '/cstoolconvoai/ten_log?agent_id=' +
          encodeURIComponent(agentId) +
          '&environment=' +
          encodeURIComponent(env) +
          '&mode=auto'
        );
      }

      function maybeWarmCstoolCookieIframe() {
        if (cstoolDirectOriginMatchesReader()) return;
        const ifr = document.getElementById('cstoolSessionIframe');
        if (!ifr) return;
        try {
          ifr.src = cstoolDirectRoot() + '/cstoolconvoai/ten_log';
        } catch (e) {}
      }

      function isLikelyNetworkOrCorsFetchFailure(err) {
        if (!err) return false;
        const m = String(err.message != null ? err.message : err);
        if (err.name === 'TypeError' && /fetch|Failed|network|Load failed/i.test(m)) return true;
        if (/Failed to fetch|NetworkError|Load failed|networkerror/i.test(m)) return true;
        return false;
      }

      function shouldShowCorsFetchHelp(err) {
        if (!isLikelyNetworkOrCorsFetchFailure(err)) return false;
        if (cstoolProxyRoot()) return false;
        if (cstoolDirectOriginMatchesReader()) return false;
        return true;
      }

      function updateAgentFetchButtonState() {
        const fetchBtn = document.getElementById('agentFetchBtn');
        if (!fetchBtn) return;
        if (cstoolFetchCanWork()) {
          fetchBtn.disabled = false;
          fetchBtn.removeAttribute('title');
        } else {
          fetchBtn.disabled = true;
          fetchBtn.setAttribute(
            'title',
            'Set a CSTool proxy URL, use a Vercel deploy with the built-in /api proxy, or host on the CSTool site.'
          );
        }
      }

      /** Hide “CSTool proxy” when this deployment already provides a proxy or browser session is enough. */
      function updateCstoolProxyDetailsVisibility() {
        const details = document.getElementById('cstoolProxyDetails');
        const hint = document.getElementById('cstoolProxyOverrideHint');
        if (!details && !hint) return;
        let hide =
          !!(window.__TEN_LOG_READER_BUILTIN_CSTOOL__ || cstoolUsesBrowserSessionOnly());
        try {
          const saved = localStorage.getItem('tenLogReader_cstoolProxy');
          if (saved && String(saved).trim()) hide = false;
        } catch (e) {}
        if (details) details.style.display = hide ? 'none' : '';
        if (hint) hint.style.display = hide ? 'block' : 'none';
      }

      function syncModalOpenClass() {
        const any = document.querySelector('.modal-overlay.visible');
        document.body.classList.toggle('modal-open', !!any);
      }

      function setCstoolClipboardStatus(msg) {
        const st = document.getElementById('cstoolClipboardStatus');
        if (st) st.textContent = msg || '';
      }

      function refreshCstoolAuthModalMode() {
        const same = cstoolUsesBrowserSessionOnly();
        const banner = document.getElementById('cstoolSameOriginBanner');
        const section = document.getElementById('cstoolCookieSection');
        const hint = document.getElementById('cstoolAuthHint');
        const sub = document.getElementById('cstoolAuthSubtitle');
        const mAgent = document.getElementById('cstoolModalAgentId');
        const mEnv = document.getElementById('cstoolModalEnv');
        const link = document.getElementById('cstoolOpenForCookieLink');
        const pasteBtn = document.getElementById('cstoolPasteClipboardBtn');
        if (banner) banner.style.display = same ? 'block' : 'none';
        if (section) section.style.display = same ? 'none' : 'block';
        if (hint) hint.style.display = same ? 'none' : 'block';
        if (sub) sub.textContent = same ? 'Using your CSTool browser session' : 'Cookie for the proxy';
        if (pasteBtn) pasteBtn.style.display = same ? 'none' : '';
        if (link) {
          const raw = (mAgent && mAgent.value ? mAgent.value : '').trim();
          const env = (mEnv && mEnv.value) || 'prod';
          link.href = raw
            ? getCstoolTenLogPageUrl(raw, env)
            : cstoolDirectRoot() + '/cstoolconvoai/ten_log';
        }
      }

      function tryAutofillCstoolCookieFromClipboard() {
        setCstoolClipboardStatus('');
        if (cstoolUsesBrowserSessionOnly()) return;
        const ta = document.getElementById('cstoolCookieInput');
        if (!ta || (ta.value || '').trim()) return;
        if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
          setCstoolClipboardStatus('Clipboard API unavailable here — paste manually or click “Fill from clipboard” after copying.');
          return;
        }
        navigator.clipboard
          .readText()
          .then(function (text) {
            const t = (text || '').trim();
            if (!t || !looksLikeCookieHeader(t)) {
              setCstoolClipboardStatus(
                'Clipboard did not look like a Cookie header — copy from DevTools → Network → Request Headers → Cookie, then paste or use the button.'
              );
              return;
            }
            ta.value = normalizePastedCstoolCookie(t);
            try {
              sessionStorage.setItem('tenLogReader_cstoolCookie', ta.value);
            } catch (e) {}
            setCstoolClipboardStatus('Filled from clipboard.');
          })
          .catch(function () {
            setCstoolClipboardStatus(
              'Could not read clipboard automatically (browser permission). Copy Cookie in DevTools, then click “Fill from clipboard” or paste here.'
            );
          });
      }

      function fillCstoolCookieFromClipboardButton() {
        setCstoolClipboardStatus('');
        const ta = document.getElementById('cstoolCookieInput');
        if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
          alert('Clipboard read is not available. Paste the Cookie line into the box (Ctrl/Cmd+V).');
          if (ta) ta.focus();
          return;
        }
        navigator.clipboard
          .readText()
          .then(function (text) {
            const t = (text || '').trim();
            if (!t) {
              setCstoolClipboardStatus('Clipboard was empty. Copy the Cookie header in DevTools first.');
              if (ta) ta.focus();
              return;
            }
            if (!looksLikeCookieHeader(t)) {
              if (
                !confirm(
                  'Clipboard does not look like a Cookie header. Paste it into the box anyway?'
                )
              ) {
                if (ta) ta.focus();
                return;
              }
            }
            const norm = normalizePastedCstoolCookie(t);
            if (ta) ta.value = norm;
            try {
              sessionStorage.setItem('tenLogReader_cstoolCookie', norm);
            } catch (e) {}
            setCstoolClipboardStatus('Filled from clipboard.');
          })
          .catch(function () {
            alert('Could not read clipboard. Paste the Cookie line manually into the box.');
            if (ta) ta.focus();
          });
      }

      function openCstoolAuthModal(opts) {
        opts = opts || {};
        const overlay = document.getElementById('cstoolAuthModal');
        const retryBanner = document.getElementById('cstoolAuthRetryBanner');
        const agentInput = document.getElementById('agentIdInput');
        const envSelect = document.getElementById('agentEnvSelect');
        const mAgent = document.getElementById('cstoolModalAgentId');
        const mEnv = document.getElementById('cstoolModalEnv');
        const mCookie = document.getElementById('cstoolCookieInput');
        if (retryBanner) {
          const r = opts.retryReason;
          if (r === 'session_failed') {
            retryBanner.textContent =
              'Could not fetch with your browser session. Confirm you are signed in to CSTool on this site, then press Fetch again.';
            retryBanner.style.display = 'block';
          } else if (r === 'cookie_fetch_failed') {
            retryBanner.textContent =
              'Fetch failed with the saved cookie (it may be expired). Paste a fresh Cookie request header from DevTools → Network, then press Fetch again.';
            retryBanner.style.display = 'block';
          } else if (r === 'clipboard_failed') {
            retryBanner.textContent =
              'Could not use the clipboard as a Cookie automatically. Paste the Cookie request header below, then press Fetch.';
            retryBanner.style.display = 'block';
          } else {
            retryBanner.textContent = '';
            retryBanner.style.display = 'none';
          }
        }
        if (mAgent && agentInput) mAgent.value = agentInput.value || '';
        if (mEnv && envSelect) mEnv.value = envSelect.value || 'prod';
        try {
          if (mCookie) mCookie.value = sessionStorage.getItem('tenLogReader_cstoolCookie') || '';
        } catch (e) {}
        refreshCstoolAuthModalMode();
        if (opts.skipClipboardAutofill) {
          setCstoolClipboardStatus('');
        } else {
          tryAutofillCstoolCookieFromClipboard();
        }
        if (overlay) {
          overlay.classList.add('visible');
          overlay.setAttribute('aria-hidden', 'false');
          syncModalOpenClass();
          if (mAgent) mAgent.focus();
        }
      }

      function closeCstoolAuthModal() {
        setCstoolClipboardStatus('');
        const retryBanner = document.getElementById('cstoolAuthRetryBanner');
        if (retryBanner) {
          retryBanner.textContent = '';
          retryBanner.style.display = 'none';
        }
        const overlay = document.getElementById('cstoolAuthModal');
        if (overlay) {
          overlay.classList.remove('visible');
          overlay.setAttribute('aria-hidden', 'true');
        }
        syncModalOpenClass();
      }

      function openAgentFetchCorsDialog(agentId, environment) {
        const a = document.getElementById('agentFetchOpenCstoolLink');
        const sub = document.getElementById('agentFetchCorsSubtitle');
        if (a) a.href = getCstoolTenLogPageUrl(agentId, environment);
        if (sub) sub.textContent = window.location.origin || 'this origin';
        const overlay = document.getElementById('agentFetchCorsDialog');
        if (overlay) {
          overlay.classList.add('visible');
          overlay.setAttribute('aria-hidden', 'false');
          syncModalOpenClass();
        }
      }

      function closeAgentFetchCorsDialog() {
        const overlay = document.getElementById('agentFetchCorsDialog');
        if (overlay) {
          overlay.classList.remove('visible');
          overlay.setAttribute('aria-hidden', 'true');
        }
        syncModalOpenClass();
      }

      function readTarField(block, start, len) {
        let s = '';
        for (let i = 0; i < len; i++) {
          const c = block[start + i];
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        return s.trim();
      }

      function parseUstarTarEntries(tarBuf) {
        const arr = new Uint8Array(tarBuf);
        const len = arr.length;
        let offset = 0;
        const out = [];
        let pendingLongName = null;

        while (offset + 512 <= len) {
          const header = arr.subarray(offset, offset + 512);
          if (header.every((b) => b === 0)) break;

          const type = String.fromCharCode(header[156] || 0);
          const sizeStr = readTarField(header, 124, 12).replace(/\0/g, '');
          const size = parseInt(sizeStr, 8) || 0;
          let shortName = readTarField(header, 0, 100).replace(/\0/g, '').trim();
          if (shortName.indexOf('./') === 0) shortName = shortName.slice(2);

          offset += 512;

          if (type === 'L') {
            const nameBytes = arr.subarray(offset, offset + size);
            pendingLongName = new TextDecoder('utf-8', { fatal: false }).decode(nameBytes).replace(/\0+$/, '').trim();
            offset += size;
            offset = Math.ceil(offset / 512) * 512;
            continue;
          }
          if (type === 'K') {
            offset += Math.ceil(size / 512) * 512;
            continue;
          }
          if (type === '5') {
            offset += Math.ceil(size / 512) * 512;
            pendingLongName = null;
            continue;
          }

          const data = arr.subarray(offset, offset + size);
          offset += size;
          offset = Math.ceil(offset / 512) * 512;

          const reg = type === '0' || type === '\0' || type === '';
          if (!reg) {
            pendingLongName = null;
            continue;
          }

          let name = pendingLongName || shortName;
          pendingLongName = null;
          if (!name) continue;
          out.push({ name, data });
        }
        return out;
      }

      function pickErrEntry(entries) {
        if (!entries || !entries.length) return null;
        const nonEmpty = entries.filter((e) => e.data && e.data.length);
        if (!nonEmpty.length) return null;
        let candidates = nonEmpty.filter((e) => {
          const n = (e.name || '').toLowerCase();
          return /\.(err|err\.log)$/i.test(n) || n.indexOf('ten.err') !== -1;
        });
        if (!candidates.length) candidates = nonEmpty.slice();
        const ten = candidates.filter((e) => /(^|\/)ten\.err([^/]*)$/i.test(e.name));
        if (ten.length) {
          ten.sort((a, b) => b.data.length - a.data.length);
          return ten[0];
        }
        candidates.sort((a, b) => b.data.length - a.data.length);
        return candidates[0];
      }

      function gunzipArrayBuffer(buf) {
        if (typeof DecompressionStream === 'undefined') {
          return Promise.reject(new Error('This browser cannot decompress .tgz (no DecompressionStream). Try Chrome, Edge, or Safari 16.4+.'));
        }
        const ds = new DecompressionStream('gzip');
        const stream = new Blob([buf]).stream().pipeThrough(ds);
        return new Response(stream).arrayBuffer();
      }

      function extractErrTextFromTgz(tgzBytes) {
        return gunzipArrayBuffer(tgzBytes).then((tarBuf) => {
          const entries = parseUstarTarEntries(tarBuf);
          const picked = pickErrEntry(entries);
          if (!picked) {
            const names = entries.map((e) => e.name).slice(0, 20);
            throw new Error('No .err file found in archive. Entries (sample): ' + (names.length ? names.join(', ') : '(empty)'));
          }
          return new TextDecoder('utf-8', { fatal: false }).decode(picked.data);
        });
      }

      /**
       * Fetch log via TEN Investigator (token-based, no cookie needed).
       * Server-side: downloads, extracts, and redacts sensitive keys.
       * Returns { text, fileName } or throws.
       */
      function fetchTenErrViaInvestigator(agentId, environment, opts) {
        const onStatus = opts && opts.onStatus ? opts.onStatus : function () {};
        const base = getInvestigatorBase();
        if (!base) {
          return Promise.reject(new Error('TEN Investigator not available'));
        }

        onStatus('Fetching log from TEN Investigator…');
        return fetch(base + '/api/ten-investigator-fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: agentId, environment: environment || 'prod' }),
          credentials: 'omit',
          mode: 'cors'
        })
          .then(function (res) {
            return res.text().then(function (t) {
              if (!res.ok) {
                var errMsg = 'Investigator failed (' + res.status + ')';
                try {
                  var errData = JSON.parse(t);
                  if (errData.error) errMsg = errData.error;
                  else if (errData.message) errMsg = errData.message;
                } catch (e) {
                  errMsg += ': ' + (t || '').slice(0, 200);
                }
                throw new Error(errMsg);
              }
              var data;
              try {
                data = JSON.parse(t);
              } catch (e) {
                throw new Error('Invalid JSON from investigator');
              }
              return data;
            });
          })
          .then(function (data) {
            if (data.error) {
              throw new Error(data.error);
            }
            if (!data.text) {
              throw new Error('No log text returned');
            }
            onStatus('Log fetched and processed.');
            return { text: data.text, fileName: data.fileName || ((agentId.slice(0, 12) || 'ten') + '-fetched.err') };
          });
      }

      /**
       * Try to fetch audio dumps (PCM/WAV) for the given agent.
       *
       * The investigator returns a .tgz archive that actually holds several
       * audio files (mixed playback, raw capture, per-vendor ASR input, ...).
       * We hand that off to `/api/ten-investigator-audio`, which unpacks the
       * archive server-side and returns a list of the real inner files plus
       * per-file stream URLs. The UI picks the "mixed" stream as the default
       * playable one and exposes the rest as individual downloads.
       */
      function fetchAudioDumps(agentId, environment) {
        var audioCard = document.getElementById('audioCard');
        var audioStatus = document.getElementById('audioStatus');
        var audioPlayers = document.getElementById('audioPlayers');
        if (!audioCard || !audioStatus || !audioPlayers) return;

        var base = getInvestigatorBase();
        if (!base) {
          audioCard.style.display = 'none';
          return;
        }

        audioCard.style.display = '';
        audioStatus.className = 'audio-status audio-status--loading';
        audioStatus.textContent = 'Checking for audio dumps…';
        audioPlayers.innerHTML = '';

        var audioTypes = [
          { suffix: '.wav', label: 'WAV Audio' },
          { suffix: '.pcm', label: 'PCM Audio' }
        ];

        var foundAny = false;
        var pending = audioTypes.length;

        audioTypes.forEach(function (at) {
          fetch(base + '/api/ten-investigator-audio', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: agentId, environment: environment || 'prod', suffix: at.suffix }),
            credentials: 'omit',
            mode: 'cors'
          })
            .then(function (res) {
              return res.json().then(function (data) {
                if (!res.ok) {
                  // 404 ("no files") is expected for one suffix or the other.
                  if (res.status === 404) return null;
                  throw new Error((data && data.error) || ('audio fetch ' + res.status));
                }
                return data;
              });
            })
            .then(function (data) {
              if (data && data.files && data.files.length) {
                foundAny = true;
                renderAudioGroup(audioPlayers, at, data);
              }
            })
            .catch(function () {})
            .finally(function () {
              pending--;
              if (pending === 0) {
                if (foundAny) {
                  audioStatus.className = 'audio-status';
                  audioStatus.textContent = '';
                } else {
                  audioStatus.className = 'audio-status audio-status--none';
                  audioStatus.textContent = 'No audio dumps available for this session.';
                }
              }
            });
        });
      }

      /**
       * Render one suffix group (.wav or .pcm). Shows the primary playable
       * file first (inline <audio> for WAVs) and lists every other file from
       * the archive with its own Download button so debugging any of the
       * raw streams stays one click away.
       */
      function renderAudioGroup(container, audioType, data) {
        var suffix = audioType.suffix;
        var files = data.files || [];
        if (!files.length) return;

        var primaryName = data.primary || (files[0] && files[0].name);
        var primary = files.filter(function (f) { return f.name === primaryName; })[0] || files[0];
        var others = files.filter(function (f) { return f !== primary; });

        var group = document.createElement('div');
        group.className = 'audio-player-group';

        var header = document.createElement('div');
        header.className = 'audio-group-header';
        var label = document.createElement('label');
        label.textContent = audioType.label + ' (' + suffix + ')';
        header.appendChild(label);
        // Show the "Download all (.zip)" affordance at the group level when the
        // archive has more than one file. With a single file the per-row
        // Download button is already all you need, so we'd just be adding noise.
        if (files.length > 1 && data.allUrl) {
          var totalBytes = typeof data.totalSize === 'number' ? data.totalSize : 0;
          var dlAll = document.createElement('a');
          dlAll.className = 'audio-download-all';
          dlAll.href = data.allUrl;
          // Hinting the target filename helps browsers save directly instead
          // of navigating to the stream URL (the server sets Content-Disposition
          // too; this is belt-and-suspenders).
          dlAll.setAttribute('download', '');
          // Icon-only: the inline SVG is decorative, so screen readers get
          // the label via aria-label and sighted users get it via title tooltip.
          var sizeSuffix = totalBytes ? ' (' + formatBytes(totalBytes) + ')' : '';
          dlAll.title = 'Download all as .zip' + sizeSuffix;
          dlAll.setAttribute('aria-label', 'Download all files in this archive as a .zip' + sizeSuffix);
          dlAll.innerHTML = downloadIconSvg();
          header.appendChild(dlAll);
        }
        group.appendChild(header);

        group.appendChild(renderAudioRow(primary, suffix, true));
        if (others.length) {
          var details = document.createElement('details');
          details.className = 'audio-extra';
          var summary = document.createElement('summary');
          summary.textContent = 'Other files in archive (' + others.length + ')';
          details.appendChild(summary);
          others.forEach(function (f) { details.appendChild(renderAudioRow(f, suffix, false)); });
          group.appendChild(details);
        }

        container.appendChild(group);
      }

      function formatBytes(n) {
        if (!n || n < 0) return '0 B';
        var units = ['B', 'KB', 'MB', 'GB'];
        var i = 0;
        while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
        return (i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
      }

      function renderAudioRow(file, suffix, isPrimary) {
        var row = document.createElement('div');
        row.className = 'audio-player-item' + (isPrimary ? ' audio-player-item--primary' : '');

        var meta = document.createElement('div');
        meta.className = 'audio-meta';
        var kindLabel = document.createElement('span');
        kindLabel.className = 'audio-kind';
        kindLabel.textContent = file.label || file.name;
        meta.appendChild(kindLabel);
        var nameEl = document.createElement('span');
        nameEl.className = 'audio-filename';
        nameEl.textContent = file.name;
        meta.appendChild(nameEl);
        row.appendChild(meta);

        if (isPrimary && suffix === '.wav') {
          var audio = document.createElement('audio');
          audio.controls = true;
          audio.preload = 'none';
          audio.src = file.url;
          row.appendChild(audio);
        } else if (isPrimary && suffix === '.pcm') {
          var note = document.createElement('p');
          note.style.cssText = 'font-size:11px;color:var(--text-muted);margin:4px 0;';
          note.textContent = 'PCM is raw samples — download and play with: ffplay -f s16le -ar 16000 -ac 1 ' + file.name;
          row.appendChild(note);
        }

        var dl = document.createElement('a');
        dl.className = 'audio-download';
        dl.href = file.url;
        dl.download = file.name;
        // Icon-only: same pattern as the group-level "download all" button.
        dl.title = 'Download ' + file.name;
        dl.setAttribute('aria-label', 'Download ' + file.name);
        dl.innerHTML = downloadIconSvg();
        row.appendChild(dl);

        return row;
      }

      /**
       * Inline SVG for a "download" arrow (arrow pointing at a horizontal tray).
       * Rendered with `currentColor` so the button's CSS color drives both the
       * stroke and the resting/hover state.
       */
      function downloadIconSvg() {
        return (
          '<svg class="audio-download-icon" xmlns="http://www.w3.org/2000/svg"' +
          ' width="14" height="14" viewBox="0 0 24 24" fill="none"' +
          ' stroke="currentColor" stroke-width="2" stroke-linecap="round"' +
          ' stroke-linejoin="round" aria-hidden="true" focusable="false">' +
          '<path d="M12 3v12"/>' +
          '<path d="m7 10 5 5 5-5"/>' +
          '<path d="M5 21h14"/>' +
          '</svg>'
        );
      }

      function fetchTenErrViaCstool(agentId, environment, opts) {
        const onStatus = opts && opts.onStatus ? opts.onStatus : () => {};
        const cred = cstoolFetchCredentials();
        const root = cstoolFetchRoot();
        const viaProxy = !!cstoolProxyRoot();
        const fileErr = getCstoolFileProtocolError();
        if (fileErr) return Promise.reject(new Error(fileErr));
        const sameOriginErr = getCstoolProxySameAsReaderError();
        if (sameOriginErr) return Promise.reject(new Error(sameOriginErr));
        const mixed = getCstoolMixedContentProxyError();
        if (mixed) return Promise.reject(new Error(mixed));
        const parseUrl = root + '/cstoolconvoai/parse_ten_err';
        const fd = new FormData();
        fd.append('agent_id', agentId);
        fd.append('environment', environment || 'prod');

        const postInit = { method: 'POST', body: fd, credentials: cred, mode: 'cors' };
        const ph = cstoolClientHeaders();
        if (ph) postInit.headers = ph;

        return fetch(parseUrl, postInit)
          .then((res) => {
            if (!res.ok) {
              return res.text().then((t) => {
                throw new Error('Start job failed (' + res.status + '). ' + (t ? t.slice(0, 200) : ''));
              });
            }
            return res.json();
          })
          .then((data) => {
            if (!data || !data.success) {
              throw new Error((data && data.error) || (data && data.message) || 'Could not start log job.');
            }
            const jobId = data.job_id;
            if (!jobId) throw new Error('No job_id in response.');
            const rootNorm = root.replace(/\/$/, '');
            const su = data && typeof data.status_url === 'string' ? data.status_url.trim() : '';
            let statusRel;
            if (su && su.indexOf('/api/ten_err_status') !== -1) {
              statusRel = su.indexOf('/') === 0 ? su : '/' + su;
            } else if (viaProxy) {
              statusRel = '/cstoolconvoai/ten_err_status/' + encodeURIComponent(jobId);
            } else {
              statusRel = '/cstoolconvoai/api/ten_err_status/' + encodeURIComponent(jobId);
            }
            const statusPath = rootNorm + statusRel;
            const deadline = Date.now() + CSTOOL_MAX_WAIT_MS;

            function pollOnce() {
              const pollInit = { credentials: cred, mode: 'cors' };
              const h2 = cstoolClientHeaders();
              if (h2) pollInit.headers = h2;
              return fetch(statusPath, pollInit).then((res) => {
                if (!res.ok) {
                  return res.text().then((t) => {
                    throw new Error('Status check failed (' + res.status + '). ' + (t ? t.slice(0, 200) : ''));
                  });
                }
                return res.json();
              }).then((st) => {
                if (!st) throw new Error('Empty status response.');
                const status = st.status != null ? String(st.status).toLowerCase() : '';
                if (status === 'failed') {
                  throw new Error(st.error || st.message || 'Server failed to prepare log.');
                }
                if (status === 'done' && st.download_url) {
                  return st;
                }
                if (status === 'done' && !st.download_url) {
                  throw new Error('Job finished but no download_url was returned.');
                }
                if (Date.now() > deadline) {
                  throw new Error('Timed out waiting for log (>' + Math.floor(CSTOOL_MAX_WAIT_MS / 60000) + ' min).');
                }
                onStatus('Processing on server… (' + (status || '…') + ')');
                return new Promise((resolve) => {
                  setTimeout(() => resolve(pollOnce()), CSTOOL_POLL_MS);
                });
              });
            }

            onStatus('Job started; waiting for log package…');
            return pollOnce();
          })
          .then((st) => {
            let url = st.download_url;
            if (!url) throw new Error('No download URL.');
            if (viaProxy) {
              url = root + '/_oss_tunnel?u=' + encodeURIComponent(st.download_url);
            }
            onStatus('Downloading log archive…');
            return fetch(url, { credentials: 'omit', mode: 'cors' }).then((res) => {
              if (!res.ok) {
                throw new Error('Download failed (' + res.status + '). If this is a browser CORS block, open the URL in a tab, or download manually: ' + url);
              }
              return res.arrayBuffer();
            }).then((ab) => {
              onStatus('Extracting ten.err…');
              return extractErrTextFromTgz(ab);
            }).then((text) => {
              const base = (agentId.slice(0, 12) || 'ten') + '-fetched.err';
              return { text, fileName: base };
            });
          });
      }

      function setParseOverlay(show, message) {
        var ov = document.getElementById('parseOverlay');
        var msg = document.getElementById('parseOverlayMsg');
        if (message) msg.textContent = message;
        ov.setAttribute('aria-hidden', show ? 'false' : 'true');
        ov.style.display = show ? 'flex' : 'none';
        document.body.classList.toggle('parse-busy', !!show);
      }

      function sanitizeLogDownloadFileName(name) {
        const base = String(name || 'ten.err').replace(/^.*[\\/]/, '').trim() || 'ten.err';
        return base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
      }

      function updateRawLogDownloadButton() {
        const btn = document.getElementById('downloadRawLogBtn');
        if (!btn) return;
        const ok = state && typeof state.rawLogText === 'string' && state.rawLogText.length > 0;
        btn.disabled = !ok;
      }

      function downloadRawLogFile() {
        if (!state || typeof state.rawLogText !== 'string' || !state.rawLogText.length) return;
        const name = sanitizeLogDownloadFileName(state.sourceFileName || 'ten.err');
        const blob = new Blob([state.rawLogText], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      function onFileLoad(text, fileName) {
        document.getElementById('parseOverlayMsg').textContent = 'Parsing log…';
        document.getElementById('fileName').textContent = fileName || 'ten.err.log';
        document.getElementById('loading').style.display = 'block';
        document.getElementById('emptyState').style.display = 'none';
        document.getElementById('logEntries').style.display = 'none';
        // Reset audio card when loading new file
        var audioCard = document.getElementById('audioCard');
        if (audioCard) audioCard.style.display = 'none';
        var audioPlayers = document.getElementById('audioPlayers');
        if (audioPlayers) audioPlayers.innerHTML = '';

        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            try {
          const entries = parseLines(text);
          const summary = extractSummary(entries);
          const extensions = collectExtensions(entries);
          trackUsageEvent('log_loaded', {
            fileName: fileName || 'ten.err.log',
            fileSize: text && text.length != null ? text.length : '',
            entryCount: entries.length,
            errorCount: entries.filter(function (entry) { return entry.level === 'E'; }).length,
            warningCount: entries.filter(function (entry) { return entry.level === 'W'; }).length
          });
          state = {
            entries,
            summary,
            extensions,
            insights: null,
            rawLogText: redactLogText(text),
            sourceFileName: fileName || 'ten.err.log',
            selectedIndex: null,
            contextRadius: null,
            pendingScrollToSelection: false,
            lineExpanded: {},
            lineAllExpanded: null,
            jsonExpanded: {},
            jsonAllExpanded: null
          };

          document.getElementById('summaryPlaceholder').style.display = 'none';
          document.getElementById('summaryContent').style.display = 'block';
          document.getElementById('sumVersion').textContent = summary.appVersion || '—';
          document.getElementById('sumAppTs').textContent = summary.appVersionTimestamp || '—';
          document.getElementById('sumCommit').textContent = summary.commit || '—';
          document.getElementById('sumBuild').textContent = summary.buildTime || '—';
          document.getElementById('sumAgentId').textContent = summary.agentId || '—';
          const convoreplay = document.getElementById('linkConvoReplay');
          if (summary.agentId) {
            convoreplay.href = 'https://rtsc-tools.sh3.agoralab.co/convoreplay/?agentId=' + encodeURIComponent(summary.agentId);
            convoreplay.style.display = '';
          } else convoreplay.style.display = 'none';
          document.getElementById('sumChannel').textContent = summary.channel || '—';
          const argusCh = document.getElementById('linkArgusChannel');
          const startTsEl = document.getElementById('sumStartTs');
          if (summary.startTs != null) {
            const ts = summary.startTs;
            const utcStr = new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
            startTsEl.textContent = ts + ' (' + utcStr + ')';
          } else startTsEl.textContent = '—';
          let argusRange = computeArgusTimeRangeSec(summary, entries);
          if (!argusRange && (summary.rtcSid || summary.channel)) argusRange = argusFallbackRangeSec();
          const argusLink = document.getElementById('linkArgus');
          if (summary.rtcSid && argusRange) {
            argusLink.textContent = summary.rtcSid;
            argusLink.href = argusUrlBySid(summary.rtcSid, argusRange.fromTs, argusRange.toTs);
            argusLink.title = '';
          } else {
            argusLink.textContent = '—';
            argusLink.href = '#';
            argusLink.title = '';
          }
          if (summary.channel && argusRange) {
            argusCh.href = argusUrlByChannel(summary.channel, argusRange.fromTs, argusRange.toTs);
            argusCh.style.display = '';
          } else {
            argusCh.href = '#';
            argusCh.style.display = 'none';
          }
          document.getElementById('sumGraphId').textContent = summary.graphId || '—';
          const src = summary.providerSource || {};
          document.getElementById('sumLlm').textContent = (summary.llmUrl || summary.llmModule || '—') + (src.llm ? ' (' + src.llm + ')' : '');
          document.getElementById('sumTts').textContent = (summary.ttsModule || '—') + (src.tts ? ' (' + src.tts + ')' : '');
          document.getElementById('sumStt').textContent = (summary.sttModule || '—') + (src.asr ? ' (' + src.asr + ')' : '');
          document.getElementById('sumAvatar').textContent = [summary.avatarVendor || '—', summary.avatarId ? ('id=' + summary.avatarId) : ''].filter(Boolean).join(' ');
          const stopCard = document.getElementById('summaryStopCard');
          if (summary.stopTs != null || summary.stopStatus || summary.stopMessage) {
            stopCard.style.display = 'block';
            const stopTsEl = document.getElementById('sumStopTs');
            const durEl = document.getElementById('sumStopDuration');
            if (summary.stopTs != null) {
              const st = Number(summary.stopTs);
              if (!isNaN(st)) {
                const utcStr = new Date(st * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
                stopTsEl.textContent = st + ' (' + utcStr + ')';
              } else {
                stopTsEl.textContent = String(summary.stopTs);
              }
            } else stopTsEl.textContent = '—';
            if (summary.startTs != null && summary.stopTs != null) {
              const a = Number(summary.startTs);
              const b = Number(summary.stopTs);
              if (!isNaN(a) && !isNaN(b)) {
                const diff = Math.round(b - a);
                let durText = diff + ' s';
                if (diff < 0) {
                  durText += ' (stop before start — check timestamps)';
                } else if (diff >= 60) {
                  const h = Math.floor(diff / 3600);
                  const m = Math.floor((diff % 3600) / 60);
                  const s = diff % 60;
                  if (h > 0) durText += ' (' + h + 'h ' + m + 'm ' + s + 's)';
                  else durText += ' (' + m + 'm ' + s + 's)';
                }
                durEl.textContent = durText;
              } else durEl.textContent = '—';
            } else durEl.textContent = '—';
            document.getElementById('sumStopStatus').textContent = summary.stopStatus || '—';
            document.getElementById('sumStopMessage').textContent = summary.stopMessage || '—';
          } else stopCard.style.display = 'none';

          const eventStartCard = document.getElementById('summaryEventStartCard');
          if (summary.eventStartInfo && summary.eventStartInfo.taskInfo) {
            eventStartCard.style.display = 'block';
            const ti = summary.eventStartInfo.taskInfo;
            const info = ti.info || {};
            const geo =
              (ti && ti.geoLocation && typeof ti.geoLocation === 'object' ? ti.geoLocation : null) ||
              summary.geoLocation ||
              null;
            const fields = [];
            if (ti.taskId != null) fields.push(['Task ID', ti.taskId]);
            if (ti.appId != null) fields.push(['App ID', ti.appId]);
            if (ti.taskName != null) fields.push(['Task name', ti.taskName]);
            if (ti.agentName != null) fields.push(['Agent name', ti.agentName]);
            if (ti.graphName != null) fields.push(['Graph', ti.graphName]);
            if (ti.template != null) fields.push(['Template', ti.template]);
            if (info.ASR_VENDOR != null) fields.push(['ASR (STT)', info.ASR_VENDOR]);
            if (info.TTS_VENDOR != null) fields.push(['TTS', info.TTS_VENDOR]);
            if (summary.providerSource && summary.providerSource.asr) fields.push(['ASR source', summary.providerSource.asr]);
            if (summary.providerSource && summary.providerSource.tts) fields.push(['TTS source', summary.providerSource.tts]);
            if (summary.providerSource && summary.providerSource.llm) fields.push(['LLM source', summary.providerSource.llm]);
            if (summary.providerSource && Array.isArray(summary.providerSource.presets) && summary.providerSource.presets.length) {
              fields.push(['X-VENDOR-PRESETS', summary.providerSource.presets.map(function (p) {
                const name = p && p.preset ? p.preset : '';
                const mode = p && p.applyMode ? p.applyMode : '';
                return name + (mode ? ' (' + mode + ')' : '');
              }).join(', ')]);
            } else if (info['X-VENDOR-PRESETS']) {
              fields.push(['X-VENDOR-PRESETS', String(info['X-VENDOR-PRESETS'])]);
            }
            if (info.ASR_LANGUAGE != null) fields.push(['ASR language', info.ASR_LANGUAGE]);
            if (ti.createTs != null) fields.push(['Create TS', String(ti.createTs)]);
            if (ti.service != null) fields.push(['Service', ti.service]);
            if (geo && (geo.city || geo.country || geo.region || geo.continent)) {
              fields.push(['Geo', [geo.city, geo.country, geo.region, geo.continent].filter(Boolean).join(' / ')]);
            }
            document.getElementById('sumEventStartFields').innerHTML = '<dl>' + fields.map(([k, v]) => '<dt>' + escapeHtml(k) + '</dt><dd>' + escapeHtml(String(v)) + '</dd>').join('') + '</dl>';
            document.getElementById('sumEventStartJson').textContent = JSON.stringify(redactSecrets(summary.eventStartInfo), null, 2);
          } else eventStartCard.style.display = 'none';

          const createReqCard = document.getElementById('summaryCreateReqCard');
          if (summary.createRequestBody && summary.createRequestBody.properties) {
            createReqCard.style.display = 'block';
            const p = summary.createRequestBody.properties;
            const fields = [];
            if (summary.createRequestBodySource) fields.push(['Source', summary.createRequestBodySource]);
            if (summary.createRequestBodySchema) fields.push(['Schema', summary.createRequestBodySchema]);
            if (summary.createRequestBodySource && summary.createRequestBodySource !== 'logged request body') {
              fields.push(['Certainty', 'Runtime config parsed from the log, not the captured HTTP body']);
            }
            if (summary.createRequestBody.name != null) fields.push(['Name', summary.createRequestBody.name]);
            if (p.channel != null) fields.push(['Channel', p.channel]);
            if (p.llm) {
              const url = p.llm.url || (typeof p.llm === 'string' ? p.llm : null);
              fields.push(['LLM', url ? url.replace(/^https?:\/\//, '').slice(0, 60) + (url.length > 60 ? '…' : '') : (p.llm.vendor || '—')]);
            }
            if (p.tts && (p.tts.vendor || p.tts.vendor_name)) fields.push(['TTS', p.tts.vendor || p.tts.vendor_name]);
            if (p.asr && (p.asr.vendor || p.asr.vendor_name)) fields.push(['ASR (STT)', p.asr.vendor || p.asr.vendor_name]);
            if (p.asr && (p.asr.language || (p.asr.params && p.asr.params.language))) fields.push(['ASR language', p.asr.language || p.asr.params.language]);
            if (p.idle_timeout != null) fields.push(['Idle timeout', p.idle_timeout + 's']);
            if (p.turn_detection) {
              const td = p.turn_detection;
              const turnBits = [];
              if (td.type) turnBits.push(td.type);
              if (td.interrupt_mode) turnBits.push('mode ' + td.interrupt_mode);
              if (td.silence_duration_ms != null) turnBits.push('silence ' + td.silence_duration_ms + 'ms');
              if (td.interrupt_duration_ms != null) turnBits.push('interrupt ' + td.interrupt_duration_ms + 'ms');
              if (td.threshold != null) turnBits.push('threshold ' + td.threshold);
              if (td.prefix_padding_ms != null) turnBits.push('prefix ' + td.prefix_padding_ms + 'ms');
              if (turnBits.length) fields.push(['Turn detection', turnBits.join(' · ')]);
            }
            if (p.advanced_features) {
              const af = p.advanced_features;
              const advancedBits = [];
              if (af.enable_aivad != null) advancedBits.push('AIVAD ' + (af.enable_aivad ? 'on' : 'off'));
              if (af.enable_rtm != null) advancedBits.push('RTM ' + (af.enable_rtm ? 'on' : 'off'));
              if (advancedBits.length) fields.push(['Advanced', advancedBits.join(' · ')]);
            }
            if (p.filler_words && p.filler_words.enable != null) {
              fields.push(['Filler words', p.filler_words.enable ? 'on' : 'off']);
            }
            document.getElementById('sumCreateReqFields').innerHTML = '<dl>' + fields.map(([k, v]) => '<dt>' + escapeHtml(k) + '</dt><dd>' + escapeHtml(String(v)) + '</dd>').join('') + '</dl>';
            document.getElementById('sumCreateReqJson').textContent = JSON.stringify(redactSecrets(summary.createRequestBody), null, 2);
          } else createReqCard.style.display = 'none';

          document.getElementById('badgeErrors').textContent = summary.errors + ' errors';
          document.getElementById('badgeWarnings').textContent = summary.warnings + ' warnings';
          document.getElementById('badgeEntries').textContent = entries.length + ' entries';

          const extSelect = document.getElementById('extFilter');
          extSelect.innerHTML = '<option value="">All extensions</option>' +
            extensions.map(ex => `<option value="${escapeHtml(ex)}">${escapeHtml(ex)}</option>`).join('');

          state.selectedIndex = null;
          state.contextRadius = null;
          const infoObj = summary && summary.eventStartInfo && summary.eventStartInfo.taskInfo && summary.eventStartInfo.taskInfo.info
            ? summary.eventStartInfo.taskInfo.info
            : {};
          const hasExplicitMllmFlag = Object.prototype.hasOwnProperty.call(infoObj, 'ENABLE_MLLM');
          const flagVal = hasExplicitMllmFlag ? infoObj.ENABLE_MLLM : null;
          const flagTrue = flagVal === true || String(flagVal).toLowerCase() === 'true' || String(flagVal) === '1';
          const hasV2vSignal = entries.some(function (e) {
            const msg = e && e.msg ? e.msg : '';
            return e.ext === 'v2v' || /\[v2v\]/i.test(msg) || /"source":"mllm"|'source':\s*'mllm'/.test(msg);
          });
          // Strict behavior requested: when ENABLE_MLLM is present and false, keep MLLM tab empty.
          // If the flag is absent, allow fallback to observed v2v/mllm signals.
          const mllmEnabled = hasExplicitMllmFlag ? flagTrue : hasV2vSignal;
          state.insights = {
            summary: summary,
            stateTransitions: extractStateTransitions(entries),
            stateReports: extractStateReports(entries),
            tts: extractTts(entries),
            ttsIssues: extractTtsIssues(entries),
            userAsr: extractUserAsrTranscripts(entries),
            evalIdTurns: extractEvalIdMessages(entries),
            llmGlueTurns: extractLlmGlueMessages(entries),
            turnInterruptions: extractTurnInterruptions(entries),
            stt: extractStt(entries),
            rtc: extractRtcInsights(entries),
            rtmTab: extractRtmTab(entries),
            toolsTab: extractToolsTab(entries),
            sipTab: extractSipTab(entries, summary),
            v2vTab: extractV2vTab(entries, mllmEnabled),
            v2vTranscriptions: extractV2vTranscriptions(entries, mllmEnabled),
            avatarTab: extractAvatarTab(entries),
            llm: extractLlm(entries),
            ncs: extractNcsInsights(entries),
            keypointEvents: extractKeypointEvents(entries),
            performanceMetrics: extractPerformanceMetrics(entries),
            callStartTs: summary.startTs != null ? summary.startTs : (entries.length ? parseLogTs(entries[0].ts) / 1000 : null),
            callEndTs: summary.stopTs != null ? summary.stopTs : (entries.length ? parseLogTs(entries[entries.length - 1].ts) / 1000 : null)
          };
          renderInsights(state.insights);

          document.getElementById('loading').style.display = 'none';
          updateRawLogDownloadButton();
          applyFilters();
            } catch (err) {
              console.error(err);
              alert('Failed to parse log: ' + (err && err.message ? err.message : String(err)));
            } finally {
              setParseOverlay(false);
            }
          });
        });
      }

      document.querySelectorAll('.view-tabs button').forEach(btn => {
        btn.addEventListener('click', function () {
          const view = this.getAttribute('data-view');
          document.querySelectorAll('.view-tabs button').forEach(b => b.classList.toggle('active', b === this));
          document.getElementById('logView').classList.toggle('active', view === 'log');
          document.getElementById('insightsView').classList.toggle('active', view === 'insights');
        });
      });

      function loadLogFile(file) {
        if (!file || !(file instanceof File)) return;
        setParseOverlay(true, 'Reading file…');
        requestAnimationFrame(function () {
          var reader = new FileReader();
          reader.onerror = function () {
            setParseOverlay(false);
            alert('Could not read the file.');
          };
          reader.onload = function () {
            onFileLoad(reader.result, file.name);
          };
          reader.readAsText(file, 'UTF-8');
        });
      }

      document.getElementById('fileInput').addEventListener('change', function () {
        const file = this.files && this.files[0];
        if (file) loadLogFile(file);
      });

      const downloadRawLogBtn = document.getElementById('downloadRawLogBtn');
      if (downloadRawLogBtn) {
        downloadRawLogBtn.addEventListener('click', function () {
          downloadRawLogFile();
        });
      }

      (function initAgentFetch() {
        if (isGitHubPagesHost()) return;
        const agentInput = document.getElementById('agentIdInput');
        const envSelect = document.getElementById('agentEnvSelect');
        const fetchBtn = document.getElementById('agentFetchBtn');
        const openCstoolBtn = document.getElementById('agentOpenCstoolBtn');
        const authModal = document.getElementById('cstoolAuthModal');
        const cstoolAuthCloseBtn = document.getElementById('cstoolAuthCloseBtn');
        const cstoolAuthCancelBtn = document.getElementById('cstoolAuthCancelBtn');
        const cstoolAuthRunBtn = document.getElementById('cstoolAuthRunBtn');
        const corsDialog = document.getElementById('agentFetchCorsDialog');
        const corsCloseBtn = document.getElementById('agentFetchCorsCloseBtn');
        const proxyInput = document.getElementById('cstoolProxyInput');
        if (!agentInput || !envSelect || !fetchBtn) return;

        function probeBackend(baseUrl) {
          var url = baseUrl ? baseUrl.replace(/\/$/, '') + '/api/cstool-proxy-status' : '/api/cstool-proxy-status';
          // Same-origin probe: send credentials so Vercel preview deployments
          // behind "Deployment Protection" (SSO cookie) can reach our own
          // API routes. Cross-origin probes still omit credentials to avoid
          // unintentionally forwarding session cookies to an unrelated host.
          var sameOrigin = !baseUrl;
          return fetch(url, {
            method: 'GET',
            credentials: sameOrigin ? 'include' : 'omit',
            mode: sameOrigin ? 'same-origin' : 'cors'
          })
            .then(function (r) {
              if (!r.ok) return null;
              var ctype = r.headers.get('content-type') || '';
              // Vercel's SSO gate replies 200 text/html with the login page.
              // Anything that isn't clearly JSON is therefore not our probe.
              if (!/json/i.test(ctype)) return null;
              return r.json().catch(function () { return null; });
            })
            .catch(function () { return null; });
        }

        // Probe same-origin backend first, then proxy if set
        probeBackend(null).then(function (data) {
          if (data && data.cstoolProxy) {
            window.__TEN_LOG_READER_BUILTIN_CSTOOL__ = true;
            if (data.investigator) {
              window.__TEN_INVESTIGATOR_BASE__ = window.location.origin;
            }
            updateAgentFetchButtonState();
            updateCstoolProxyDetailsVisibility();
            return;
          }
          // Same-origin probe failed — try the proxy URL if set
          var proxyUrl = (proxyInput && proxyInput.value || '').trim();
          if (!proxyUrl) {
            try {
              proxyUrl = localStorage.getItem('tenLogReader_cstoolProxy') || '';
            } catch (e) {}
          }
          if (proxyUrl) {
            probeBackend(proxyUrl).then(function (pd) {
              if (pd && pd.investigator) {
                window.__TEN_INVESTIGATOR_BASE__ = proxyUrl.replace(/\/$/, '');
              }
              updateAgentFetchButtonState();
              updateCstoolProxyDetailsVisibility();
            });
          } else {
            updateAgentFetchButtonState();
            updateCstoolProxyDetailsVisibility();
          }
        });

        try {
          const savedId = localStorage.getItem('tenLogReader_lastAgentId');
          if (savedId) agentInput.value = savedId;
          const savedEnv = localStorage.getItem('tenLogReader_lastAgentEnv');
          if (savedEnv && (savedEnv === 'prod' || savedEnv === 'staging')) envSelect.value = savedEnv;
          const savedProxy = localStorage.getItem('tenLogReader_cstoolProxy');
          if (savedProxy && proxyInput) proxyInput.value = savedProxy;
        } catch (err) {}

        function persistProxyFromInput() {
          if (!proxyInput) return;
          const v = (proxyInput.value || '').trim();
          try {
            if (v) localStorage.setItem('tenLogReader_cstoolProxy', v.replace(/\/$/, ''));
            else localStorage.removeItem('tenLogReader_cstoolProxy');
          } catch (e3) {}
          updateAgentFetchButtonState();
          updateCstoolProxyDetailsVisibility();
        }

        if (proxyInput) {
          proxyInput.addEventListener('change', persistProxyFromInput);
          proxyInput.addEventListener('blur', persistProxyFromInput);
        }

        const cstoolProxyOverrideBtn = document.getElementById('cstoolProxyOverrideBtn');
        if (cstoolProxyOverrideBtn) {
          cstoolProxyOverrideBtn.addEventListener('click', function () {
            const d = document.getElementById('cstoolProxyDetails');
            const h = document.getElementById('cstoolProxyOverrideHint');
            if (d) {
              d.style.display = '';
              d.open = true;
            }
            if (h) h.style.display = 'none';
            if (proxyInput) proxyInput.focus();
          });
        }

        updateAgentFetchButtonState();
        updateCstoolProxyDetailsVisibility();

        function openCstoolInNewTab() {
          const raw = (agentInput.value || '').trim();
          if (!raw) {
            alert('Enter an Agent ID.');
            agentInput.focus();
            return;
          }
          window.open(getCstoolTenLogPageUrl(raw, envSelect.value || 'prod'), '_blank', 'noopener,noreferrer');
        }

        if (openCstoolBtn) {
          openCstoolBtn.addEventListener('click', openCstoolInNewTab);
        }

        function handleCstoolFetchError(err, raw, environment, pipelineOpts) {
          console.error(err);
          setParseOverlay(false);
          if (isLikelyNetworkOrCorsFetchFailure(err) && cstoolProxyRoot()) {
            alert(
              (err && err.message ? err.message : 'Failed to fetch') +
                '\n\nCheck: (1) Proxy running: node proxy/local-server.mjs on port 8787\n' +
                '(2) ALLOWED_ORIGIN matches this page exactly: ' +
                (window.location.origin || '(unknown)') +
                '\n   For local dev you can use: ALLOWED_ORIGIN=*\n' +
                '(3) Restart the proxy after updating it (Chrome may need a preflight header).\n\n' +
                'Paste the Cookie request header, not Set-Cookie (no ;Domain= / HttpOnly).'
            );
            return;
          }
          if (shouldShowCorsFetchHelp(err)) {
            openAgentFetchCorsDialog(raw, environment);
            return;
          }
          if (pipelineOpts && pipelineOpts.openAuthModalOnFailure) {
            const clipMiss = !!pipelineOpts.clipboardAttemptFailed;
            openCstoolAuthModal({
              retryReason: clipMiss ? 'clipboard_failed' : pipelineOpts.retryReason || 'cookie_fetch_failed',
              skipClipboardAutofill: clipMiss
            });
            if (clipMiss) {
              setCstoolClipboardStatus(
                'Paste the Cookie request header from DevTools → Network (after signing in to CSTool), then press Fetch.'
              );
            }
            return;
          }
          alert(err && err.message ? err.message : String(err));
        }

        function runCstoolFetchPipeline(raw, environment, pipelineOpts) {
          maybeWarmCstoolCookieIframe();
          fetchBtn.disabled = true;
          trackUsageEvent('fetch_log_requested', {
            agentId: raw,
            environment: environment,
            source: 'cstool'
          });
          setParseOverlay(true, 'Connecting to log service…');
          fetchTenErrViaCstool(raw, environment, {
            onStatus: function (msg) {
              setParseOverlay(true, msg);
            }
          })
            .then(function (result) {
              try {
                localStorage.setItem('tenLogReader_lastAgentId', raw);
                localStorage.setItem('tenLogReader_lastAgentEnv', environment);
              } catch (e2) {}
              trackUsageEvent('fetch_log_succeeded', {
                agentId: raw,
                environment: environment,
                source: 'cstool',
                fileName: result.fileName || ''
              });
              onFileLoad(result.text, result.fileName);
            })
            .catch(function (err) {
              trackUsageEvent('fetch_log_failed', {
                agentId: raw,
                environment: environment,
                source: 'cstool'
              });
              handleCstoolFetchError(err, raw, environment, pipelineOpts);
            })
            .finally(function () {
              updateAgentFetchButtonState();
            });
        }

        function runCstoolFetchFromUi() {
          const mAgent = document.getElementById('cstoolModalAgentId');
          const mEnv = document.getElementById('cstoolModalEnv');
          const mCookie = document.getElementById('cstoolCookieInput');
          const raw = (mAgent && mAgent.value ? mAgent.value : agentInput.value || '').trim();
          if (!raw) {
            alert('Enter an Agent ID.');
            if (mAgent) mAgent.focus();
            return;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(raw) || raw.length < 16) {
            if (!confirm('Agent ID looks unusual. Continue anyway?')) return;
          }
          const environment = (mEnv && mEnv.value) || envSelect.value || 'prod';
          try {
            if (cstoolUsesBrowserSessionOnly()) {
              sessionStorage.removeItem('tenLogReader_cstoolCookie');
            } else {
              const rawCk = mCookie && mCookie.value ? String(mCookie.value).trim() : '';
              const ck = rawCk ? normalizePastedCstoolCookie(rawCk) : '';
              if (ck) sessionStorage.setItem('tenLogReader_cstoolCookie', ck);
              else sessionStorage.removeItem('tenLogReader_cstoolCookie');
            }
          } catch (e) {}
          agentInput.value = raw;
          envSelect.value = environment;
          closeCstoolAuthModal();
          runCstoolFetchPipeline(raw, environment, { openAuthModalOnFailure: false });
        }

        if (cstoolAuthCloseBtn) cstoolAuthCloseBtn.addEventListener('click', closeCstoolAuthModal);
        if (cstoolAuthCancelBtn) cstoolAuthCancelBtn.addEventListener('click', closeCstoolAuthModal);
        if (cstoolAuthRunBtn) cstoolAuthRunBtn.addEventListener('click', runCstoolFetchFromUi);
        const cstoolPasteClipboardBtn = document.getElementById('cstoolPasteClipboardBtn');
        if (cstoolPasteClipboardBtn) {
          cstoolPasteClipboardBtn.addEventListener('click', fillCstoolCookieFromClipboardButton);
        }
        const cstoolModalAgentIdEl = document.getElementById('cstoolModalAgentId');
        const cstoolModalEnvEl = document.getElementById('cstoolModalEnv');
        function onCstoolModalFieldChange() {
          const ov = document.getElementById('cstoolAuthModal');
          if (ov && ov.classList.contains('visible')) refreshCstoolAuthModalMode();
        }
        if (cstoolModalAgentIdEl) cstoolModalAgentIdEl.addEventListener('input', onCstoolModalFieldChange);
        if (cstoolModalEnvEl) cstoolModalEnvEl.addEventListener('change', onCstoolModalFieldChange);

        if (authModal) {
          authModal.addEventListener('click', function (e) {
            if (e.target === authModal) closeCstoolAuthModal();
          });
        }

        if (corsDialog && corsCloseBtn) {
          corsCloseBtn.addEventListener('click', closeAgentFetchCorsDialog);
          corsDialog.addEventListener('click', function (e) {
            if (e.target === corsDialog) closeAgentFetchCorsDialog();
          });
        }

        function runInvestigatorPipeline(raw, environment) {
          fetchBtn.disabled = true;
          trackUsageEvent('fetch_log_requested', {
            agentId: raw,
            environment: environment,
            source: 'investigator'
          });
          setParseOverlay(true, 'Connecting to TEN Investigator…');
          fetchTenErrViaInvestigator(raw, environment, {
            onStatus: function (msg) { setParseOverlay(true, msg); }
          })
            .then(function (result) {
              try {
                localStorage.setItem('tenLogReader_lastAgentId', raw);
                localStorage.setItem('tenLogReader_lastAgentEnv', environment);
              } catch (e2) {}
              trackUsageEvent('fetch_log_succeeded', {
                agentId: raw,
                environment: environment,
                source: 'investigator',
                fileName: result.fileName || ''
              });
              onFileLoad(result.text, result.fileName);
              // After log loads, try to fetch audio dumps in background
              fetchAudioDumps(raw, environment);
            })
            .catch(function (invErr) {
              trackUsageEvent('fetch_log_failed', {
                agentId: raw,
                environment: environment,
                source: 'investigator'
              });
              setParseOverlay(false);
              console.error('Investigator failed:', invErr);
              alert('Failed to fetch log:\n' + (invErr.message || invErr));
            })
            .finally(function () { updateAgentFetchButtonState(); });
        }

        fetchBtn.addEventListener('click', function () {
          const raw = (agentInput.value || '').trim();
          if (!raw) {
            alert('Enter an Agent ID.');
            agentInput.focus();
            return;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(raw) || raw.length < 16) {
            if (!confirm('Agent ID looks unusual. Continue anyway?')) return;
          }
          const environment = envSelect.value || 'prod';

          // Persist proxy input and probe it for investigator support
          var currentProxyVal = (proxyInput && proxyInput.value || '').trim();
          if (currentProxyVal) {
            try { localStorage.setItem('tenLogReader_cstoolProxy', currentProxyVal.replace(/\/$/, '')); } catch(e){}
            // Probe the proxy and then fetch
            fetchBtn.disabled = true;
            setParseOverlay(true, 'Checking proxy…');
            probeBackend(currentProxyVal).then(function (pd) {
              if (pd && pd.investigator) {
                window.__TEN_INVESTIGATOR_BASE__ = currentProxyVal.replace(/\/$/, '');
              }
              setParseOverlay(false);
              doFetch(raw, environment);
            }).catch(function () {
              setParseOverlay(false);
              doFetch(raw, environment);
            });
            return;
          }

          doFetch(raw, environment);
        });

        function doFetch(raw, environment) {
          // TEN Investigator first (no cookie needed)
          if (investigatorAvailable()) {
            runInvestigatorPipeline(raw, environment);
            return;
          }

          // No investigator — must have proxy or same-origin CSTool
          if (!cstoolFetchCanWork()) {
            alert('Set a CSTool proxy URL under "CSTool proxy" (or host this app on the CSTool site), then try again.');
            if (proxyInput) proxyInput.focus();
            return;
          }

          if (cstoolUsesBrowserSessionOnly()) {
            runCstoolFetchPipeline(raw, environment, { openAuthModalOnFailure: true, retryReason: 'session_failed' });
            return;
          }

          if (cstoolProxyRoot()) {
            const ck = getStoredCstoolCookie();
            if (ck) {
              runCstoolFetchPipeline(raw, environment, { openAuthModalOnFailure: true, retryReason: 'cookie_fetch_failed' });
              return;
            }
            trySilentClipboardCookieForCstool().then(function (clip) {
              runCstoolFetchPipeline(raw, environment, { openAuthModalOnFailure: true, retryReason: 'cookie_fetch_failed', clipboardAttemptFailed: !clip.ok });
            });
            return;
          }

          runCstoolFetchPipeline(raw, environment, { openAuthModalOnFailure: true, retryReason: 'session_failed' });
        }

        const agentCstoolOptionsBtn = document.getElementById('agentCstoolOptionsBtn');
        if (agentCstoolOptionsBtn) {
          agentCstoolOptionsBtn.addEventListener('click', function () {
            if (!cstoolFetchCanWork()) {
              alert('Set a CSTool proxy URL under “CSTool proxy” (or host this app on the CSTool site), then try again.');
              if (proxyInput) proxyInput.focus();
              return;
            }
            openCstoolAuthModal({});
          });
        }
      })();

      const appEl = document.getElementById('app');
      /** DOMStringList (Safari) has .contains; arrays have .includes — avoid throws on GitHub Pages / Safari */
      function isFileDrag(e) {
        try {
          const types = e.dataTransfer && e.dataTransfer.types;
          if (!types || !types.length) return false;
          if (typeof types.contains === 'function') return types.contains('Files');
          if (typeof types.includes === 'function') return types.includes('Files');
          for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
          return false;
        } catch (err) { return false; }
      }
      window.addEventListener('dragenter', function (e) {
        if (!isFileDrag(e)) return;
        appEl.classList.add('drag-over');
      }, true);
      document.addEventListener('dragleave', function (e) {
        if (!isFileDrag(e)) return;
        const rel = e.relatedTarget;
        if (!rel || !document.documentElement.contains(rel))
          appEl.classList.remove('drag-over');
      }, true);
      /* Capture phase + window: whole tab is a drop target (fixes GH Pages / Firefox navigating away on drop) */
      window.addEventListener('dragover', function (e) {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
      }, true);
      window.addEventListener('drop', function (e) {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        appEl.classList.remove('drag-over');
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) loadLogFile(file);
      }, true);

      // ---------- Log view controls: JSON expand/collapse, copy, extra filters ----------
      const CUSTOM_FILTERS_KEY = 'tenLogReaderCustomFilters_v1';
      function loadCustomFilters() {
        try {
          const raw = localStorage.getItem(CUSTOM_FILTERS_KEY);
          const parsed = raw ? JSON.parse(raw) : [];
          if (!Array.isArray(parsed)) return [];
          return parsed.map(v => String(v)).filter(Boolean);
        } catch (_) {
          return [];
        }
      }
      function saveCustomFilters(list) {
        try {
          localStorage.setItem(CUSTOM_FILTERS_KEY, JSON.stringify(list));
        } catch (_) {}
      }
      function escapeAttr(s) {
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      let customFilters = loadCustomFilters();

      function renderCustomFilters() {
        const wrap = document.getElementById('customFiltersList');
        if (!wrap) return;
        if (!customFilters || !customFilters.length) {
          wrap.innerHTML = '';
          return;
        }
        wrap.innerHTML = customFilters.map((term, idx) => (
          '<span class="custom-filter-pill" data-custom-filter-idx="' + idx + '">' +
            '<button type="button" class="filter-event-btn" data-search="' + escapeAttr(term) + '" title="Custom filter">' + escapeHtml(term) + '</button>' +
            '<button type="button" class="custom-filter-remove-btn" data-remove-idx="' + idx + '" aria-label="Remove custom filter" title="Remove">×</button>' +
          '</span>'
        )).join('');
      }

      const moreFiltersBtn = document.getElementById('toggleMoreFilters');
      const moreFiltersEl = document.getElementById('moreFilters');
      if (moreFiltersBtn && moreFiltersEl) {
        moreFiltersBtn.addEventListener('click', function () {
          const open = moreFiltersEl.style.display !== 'none';
          moreFiltersEl.style.display = open ? 'none' : 'flex';
          moreFiltersBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
        });
      }

      if (customFilters && document.getElementById('customFiltersList')) {
        document.getElementById('customFiltersList').addEventListener('click', function (ev) {
          const rmBtn = ev.target.closest('.custom-filter-remove-btn');
          if (!rmBtn) return;
          ev.stopPropagation();
          const idx = parseInt(rmBtn.getAttribute('data-remove-idx'), 10);
          if (isNaN(idx)) return;
          if (!customFilters || !customFilters.length) return;
          customFilters.splice(idx, 1);
          saveCustomFilters(customFilters);
          renderCustomFilters();
        });
      }

      const expandAllJsonBtn = document.getElementById('expandAllJsonBtn');
      const collapseAllJsonBtn = document.getElementById('collapseAllJsonBtn');
      if (expandAllJsonBtn) {
        expandAllJsonBtn.addEventListener('click', function () {
          if (!state || !Array.isArray(state.entries) || !state.entries.length) return;
          state.lineAllExpanded = true;
          state.lineExpanded = {};
          ensureLineAllScrollListener();
          refreshLineExpansionInViewport();
          requestAnimationFrame(clampLogScrollTop);

          const logEl = document.getElementById('logEntries');
          if (logEl) {
            const logContainer = document.getElementById('logContainer');
            if (!logContainer) return;
            const rootRect = logContainer.getBoundingClientRect();
            let shown = 0;
            const maxShow = 500; // cap updates to keep UI responsive
            const entriesEls = logEl.querySelectorAll('.log-entry');
            for (let i = 0; i < entriesEls.length; i++) {
              const el = entriesEls[i];
              const elRect = el.getBoundingClientRect();
              const overlaps = elRect.bottom >= rootRect.top && elRect.top <= rootRect.bottom;
              if (!overlaps) continue;
              if (shown >= maxShow) break;
              const msgEl = el.querySelector && el.querySelector('.msg');
              if (msgEl) {
                msgEl.classList.toggle('line-expanded', true);
                msgEl.classList.toggle('line-collapsed', false);
              }
              shown++;
            }
            requestAnimationFrame(clampLogScrollTop);
          }
        });
      }
      if (collapseAllJsonBtn) {
        collapseAllJsonBtn.addEventListener('click', function () {
          if (!state || !Array.isArray(state.entries) || !state.entries.length) return;
          state.lineAllExpanded = false;
          state.lineExpanded = {};
          ensureLineAllScrollListener();
          refreshLineExpansionInViewport();
          requestAnimationFrame(clampLogScrollTop);

          const logEl = document.getElementById('logEntries');
          if (logEl) {
            // Collapse only currently visible blocks first.
            const logContainer = document.getElementById('logContainer');
            if (!logContainer) return;
            const rootRect = logContainer.getBoundingClientRect();
            let collapsed = 0;
            const entriesEls = logEl.querySelectorAll('.log-entry');
            for (let i = 0; i < entriesEls.length; i++) {
              const el = entriesEls[i];
              const elRect = el.getBoundingClientRect();
              const overlaps = elRect.bottom >= rootRect.top && elRect.top <= rootRect.bottom;
              if (!overlaps) continue;
              if (collapsed >= 800) break;
              const msgEl = el.querySelector && el.querySelector('.msg');
              if (msgEl) {
                msgEl.classList.toggle('line-expanded', false);
                msgEl.classList.toggle('line-collapsed', true);
              }
              collapsed++;
            }
            requestAnimationFrame(clampLogScrollTop);
          }
        });
      }

      const addCustomFiltersBtn = document.getElementById('addCustomFilterBtn');
      const clearCustomFiltersBtn = document.getElementById('clearCustomFiltersBtn');
      const customFilterInput = document.getElementById('customFilterInput');
      if (customFilterInput && addCustomFiltersBtn) {
        customFilterInput.addEventListener('keydown', function (ev) {
          if (ev.key !== 'Enter') return;
          ev.preventDefault();
          addCustomFiltersBtn.click();
        });
        addCustomFiltersBtn.addEventListener('click', function () {
          if (!customFilterInput) return;
          const term = (customFilterInput.value || '').trim();
          if (!term) return;
          const lower = term.toLowerCase();
          const exists = customFilters.some(t => String(t).toLowerCase() === lower);
          if (!exists) {
            customFilters.push(term);
            saveCustomFilters(customFilters);
          }
          customFilterInput.value = '';
          renderCustomFilters();
        });
      }
      if (clearCustomFiltersBtn) {
        clearCustomFiltersBtn.addEventListener('click', function () {
          customFilters = [];
          saveCustomFilters(customFilters);
          renderCustomFilters();
        });
      }
      renderCustomFilters();

      // Double-click a log line to expand/collapse the log message itself.
      let logClickTimer = null;
      let ignoreNextLogClickUntil = 0;
      const logEntriesEl = document.getElementById('logEntries');

      // When global line expand-all is enabled, keep messages in view expanded as the user scrolls.
      let lineAllScrollRaf = null;
      let lineAllScrollListenerBound = false;
      function refreshLineExpansionInViewport() {
        if (!state || state.lineAllExpanded == null) return;
        const logContainer = document.getElementById('logContainer');
        const logEl = document.getElementById('logEntries');
        if (!logContainer || !logEl) return;

        const rootTop = logContainer.scrollTop;
        const rootBottom = rootTop + logContainer.clientHeight;

        const entries = logEl.querySelectorAll('.log-entry');
        for (let i = 0; i < entries.length; i++) {
          const el = entries[i];
          const top = el.offsetTop;
          const bottom = top + el.offsetHeight;
          if (top > rootBottom) break;
          if (bottom < rootTop) continue;

          const idx = parseInt(el.getAttribute('data-index'), 10);
          if (isNaN(idx)) continue;

          const hasOverride = state.lineExpanded && Object.prototype.hasOwnProperty.call(state.lineExpanded, idx);
          const effectiveExpanded = hasOverride ? !!state.lineExpanded[idx] : !!state.lineAllExpanded;

          const msgEl = el.querySelector('.msg');
          if (msgEl) {
            msgEl.classList.toggle('line-expanded', effectiveExpanded);
            msgEl.classList.toggle('line-collapsed', !effectiveExpanded);
          }
          // no arrows
        }
      }

      function ensureLineAllScrollListener() {
        if (lineAllScrollListenerBound) return;
        const logContainer = document.getElementById('logContainer');
        if (!logContainer) return;
        logContainer.addEventListener('scroll', function () {
          if (!state || state.lineAllExpanded == null) return;
          if (lineAllScrollRaf) return;
          lineAllScrollRaf = requestAnimationFrame(function () {
            lineAllScrollRaf = null;
            refreshLineExpansionInViewport();
          });
        });
        lineAllScrollListenerBound = true;
      }

      if (logEntriesEl) {
        logEntriesEl.addEventListener('dblclick', function (ev) {
          if (logClickTimer) clearTimeout(logClickTimer);
          logClickTimer = null;
          ignoreNextLogClickUntil = Date.now() + 600;
          ev.preventDefault();
          ev.stopPropagation();
          const entryEl = ev.target.closest('.log-entry');
          if (!entryEl) return;
          const idx = parseInt(entryEl.getAttribute('data-index'), 10);
          if (isNaN(idx)) return;

          const hasOverride = state.lineExpanded && Object.prototype.hasOwnProperty.call(state.lineExpanded, idx);
          const effectiveExpanded = hasOverride ? !!state.lineExpanded[idx] : !!state.lineAllExpanded;
          const nextExpanded = !effectiveExpanded;
          if (!state.lineExpanded) state.lineExpanded = {};
          state.lineExpanded[idx] = nextExpanded;

          const msgEl = entryEl.querySelector('.msg');
          if (msgEl) {
            msgEl.classList.toggle('line-expanded', nextExpanded);
            msgEl.classList.toggle('line-collapsed', !nextExpanded);
          }
        });
      }

      document.getElementById('filterI').addEventListener('change', applyFilters);
      document.getElementById('filterD').addEventListener('change', applyFilters);
      document.getElementById('filterW').addEventListener('change', applyFilters);
      document.getElementById('filterE').addEventListener('change', applyFilters);
      document.getElementById('searchInput').addEventListener('input', applyFilters);
      document.getElementById('extFilter').addEventListener('change', applyFilters);
      document.getElementById('timeFrom').addEventListener('input', applyFilters);
      document.getElementById('timeTo').addEventListener('input', applyFilters);

      document.querySelector('.filters').addEventListener('click', function (ev) {
        const btn = ev.target.closest('.filter-event-btn');
        if (!btn) return;
        const ignoreIds = new Set([
          'toggleMoreFilters',
          'expandAllJsonBtn',
          'collapseAllJsonBtn',
          'addCustomFilterBtn',
          'clearCustomFiltersBtn'
        ]);
        if (btn.id && ignoreIds.has(btn.id)) return;
        const searchEl = document.getElementById('searchInput');
        if (btn.getAttribute('data-clear') === 'true') {
          searchEl.value = '';
          state.selectedIndex = null;
          state.contextRadius = null;
        } else searchEl.value = btn.getAttribute('data-search') || '';
        applyFilters();
      });

      document.getElementById('logEntries').addEventListener('click', function (ev) {
        const copyBtn = ev.target.closest('.copy-entry-btn');
        if (copyBtn) {
          if (logClickTimer) clearTimeout(logClickTimer);
          ev.stopPropagation();
          const idx = parseInt(copyBtn.getAttribute('data-copy-index'), 10);
          if (!isNaN(idx) && state && Array.isArray(state.entries)) {
            const entry = state.entries[idx];
            if (entry) copyText(entry.raw != null ? entry.raw : (entry.msg != null ? entry.msg : ''));
          }
          return;
        }
        if (Date.now() < ignoreNextLogClickUntil) return;

        // (no per-line arrows)

        const jsonToggle = ev.target.closest('.json-toggle');
        if (jsonToggle) return; // don't change selection when clicking JSON toggle

        const entry = ev.target.closest('.log-entry');
        if (!entry) return;
        const idx = parseInt(entry.getAttribute('data-index'), 10);
        if (isNaN(idx)) return;

        // If we're in full-log mode (no context window), just update selection highlight + scroll.
        // This avoids expensive re-render on big logs.
        if (state && state.contextRadius == null) {
          const container = document.getElementById('logEntries');
          const prevSel = container && container.querySelector('.log-entry.selected');
          const nextSel = container && container.querySelector('.log-entry[data-index="' + idx + '"]');
          if (prevSel) prevSel.classList.remove('selected');
          if (nextSel) nextSel.classList.add('selected');
          state.selectedIndex = idx;
          state.pendingScrollToSelection = false;
          return;
        }

        // Context window mode: re-render is needed to shift ±N lines.
        if (logClickTimer) clearTimeout(logClickTimer);
        logClickTimer = setTimeout(function () {
          logClickTimer = null;
          state.selectedIndex = idx;
          state.pendingScrollToSelection = false;
          applyFilters();
        }, 180);
      });

      document.getElementById('goToFirstMatch').addEventListener('click', goToFirstMatch);

      document.getElementById('insightsContent').addEventListener('change', function (ev) {
        if (ev.target.id === 'turnsFinalOnly') {
          const insights = state && state.insights;
          const turnsTable = document.getElementById('turnsTable');
          if (!insights || !turnsTable) return;
          let list = buildTurnsList(insights);
          /* Drop only explicit interim user ASR (final === false). Agent TTS / LLM glue / eval use final: null — they must stay visible. */
          if (ev.target.checked) list = list.filter(function (r) { return r.final !== false; });
          const tbody = turnsTable.querySelector('tbody');
          if (tbody) tbody.innerHTML = list.map(buildTurnRowHtml).join('');
          return;
        }
      });

      document.getElementById('insightsContent').addEventListener('click', function (ev) {
        // Copy / jump controls inside the System prompt card. Intercept first
        // so the generic table-row jump handler below doesn't also fire.
        const copyBtn = ev.target.closest && ev.target.closest('.system-prompt-copy');
        if (copyBtn) {
          ev.stopPropagation();
          const prompt = state && state.insights && state.insights.summary ? state.insights.summary.llmSystemPrompt : null;
          if (prompt) {
            copyText(String(prompt));
            const orig = copyBtn.textContent;
            copyBtn.textContent = 'Copied!';
            setTimeout(function () { copyBtn.textContent = orig; }, 1200);
          }
          return;
        }
        const jumpBtn = ev.target.closest && ev.target.closest('.system-prompt-jump');
        if (jumpBtn) {
          ev.stopPropagation();
          const idxRaw = jumpBtn.getAttribute('data-entry-index');
          const idx = idxRaw != null ? parseInt(idxRaw, 10) : NaN;
          if (!isNaN(idx) && state && Array.isArray(state.entries) && state.entries[idx]) {
            document.querySelector('.view-tabs button[data-view="log"]').click();
            resetLogFiltersForInsightsJump();
            state.selectedIndex = idx;
            state.contextRadius = 50;
            state.pendingScrollToSelection = true;
            applyFilters();
          }
          return;
        }
        if (window.getSelection().toString().trim()) return;
        if (ev.target.closest && ev.target.closest('details.insight-text-expand')) return;
        if (ev.target.closest && ev.target.closest('.system-prompt-card')) return;
        const row = ev.target.closest('tr[data-ts], tr[data-index]');
        if (!row) return;
        let idx = -1;
        const dataIndex = row.getAttribute('data-index');
        if (dataIndex != null && dataIndex !== '') {
          idx = parseInt(dataIndex, 10);
        }
        if (idx < 0) {
          const ts = row.getAttribute('data-ts');
          if (!ts) return;
          idx = findLogIndexByTs(ts);
        }
        if (idx < 0) return;
        document.querySelector('.view-tabs button[data-view="log"]').click();
        resetLogFiltersForInsightsJump();
        state.selectedIndex = idx;
        state.contextRadius = 50;
        state.pendingScrollToSelection = true;
        applyFilters();
      });

      document.getElementById('ctxShow50').addEventListener('click', function () {
        state.contextRadius = 50;
        state.pendingScrollToSelection = true;
        applyFilters();
      });
      document.getElementById('ctxShow100').addEventListener('click', function () {
        state.contextRadius = 100;
        state.pendingScrollToSelection = true;
        applyFilters();
      });
      document.getElementById('ctxShowAll').addEventListener('click', function () {
        state.contextRadius = null;
        state.pendingScrollToSelection = true;
        applyFilters();
      });
      function exitInsightsJump() {
        state.selectedIndex = null;
        state.contextRadius = null;
        document.getElementById('searchInput').value = '';
        applyFilters();
      }

      document.getElementById('ctxClearFilters').addEventListener('click', function () {
        state.contextRadius = null;
        state.pendingScrollToSelection = true;
        document.getElementById('searchInput').value = '';
        document.getElementById('extFilter').value = '';
        document.getElementById('filterI').checked = true;
        document.getElementById('filterD').checked = true;
        document.getElementById('filterW').checked = true;
        document.getElementById('filterE').checked = true;
        document.getElementById('timeFrom').value = '';
        document.getElementById('timeTo').value = '';
        document.getElementById('goToFirstMatch').style.display = 'none';
        applyFilters();
      });

      document.getElementById('ctxExitJump').addEventListener('click', function () {
        exitInsightsJump();
        document.getElementById('extFilter').value = '';
        document.getElementById('filterI').checked = true;
        document.getElementById('filterD').checked = true;
        document.getElementById('filterW').checked = true;
        document.getElementById('filterE').checked = true;
        document.getElementById('timeFrom').value = '';
        document.getElementById('timeTo').value = '';
        document.getElementById('goToFirstMatch').style.display = 'none';
        applyFilters();
      });

      document.getElementById('toggleEventStartJson').addEventListener('click', function () {
        const pre = document.getElementById('sumEventStartJson');
        const show = pre.style.display === 'none';
        pre.style.display = show ? 'block' : 'none';
        this.textContent = show ? 'Hide JSON' : 'Show JSON';
        this.setAttribute('aria-expanded', show);
      });
      document.getElementById('toggleCreateReqJson').addEventListener('click', function () {
        const pre = document.getElementById('sumCreateReqJson');
        const show = pre.style.display === 'none';
        pre.style.display = show ? 'block' : 'none';
        this.textContent = show ? 'Hide JSON' : 'Show JSON';
        this.setAttribute('aria-expanded', show);
      });

      // JSON modal controls (used by Insights → Summary)
      document.getElementById('jsonModalCloseBtn').addEventListener('click', function () {
        closeJsonModal();
      });
      document.getElementById('jsonModalCopyBtn').addEventListener('click', function () {
        copyText(jsonModalCurrentText);
      });
      document.getElementById('jsonModal').addEventListener('click', function (e) {
        if (e.target && e.target.id === 'jsonModal') closeJsonModal();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        const auth = document.getElementById('cstoolAuthModal');
        if (auth && auth.classList.contains('visible')) {
          closeCstoolAuthModal();
          return;
        }
        const cors = document.getElementById('agentFetchCorsDialog');
        if (cors && cors.classList.contains('visible')) {
          closeAgentFetchCorsDialog();
          return;
        }
        closeJsonModal();
      });

      document.getElementById('badgeErrors').addEventListener('click', function () {
        document.querySelector('.view-tabs button[data-view="log"]').click();
        document.getElementById('filterI').checked = false;
        document.getElementById('filterD').checked = false;
        document.getElementById('filterW').checked = false;
        document.getElementById('filterE').checked = true;
        applyFilters();
        document.getElementById('logContainer').scrollTop = 0;
      });
      document.getElementById('badgeWarnings').addEventListener('click', function () {
        document.querySelector('.view-tabs button[data-view="log"]').click();
        document.getElementById('filterI').checked = false;
        document.getElementById('filterD').checked = false;
        document.getElementById('filterW').checked = true;
        document.getElementById('filterE').checked = false;
        applyFilters();
        document.getElementById('logContainer').scrollTop = 0;
      });
      document.getElementById('badgeEntries').addEventListener('click', function () {
        document.querySelector('.view-tabs button[data-view="log"]').click();
        document.getElementById('filterI').checked = true;
        document.getElementById('filterD').checked = true;
        document.getElementById('filterW').checked = true;
        document.getElementById('filterE').checked = true;
        applyFilters();
        document.getElementById('logContainer').scrollTop = 0;
      });
    })();
  
