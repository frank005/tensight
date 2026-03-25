    (function () {
      const LEVEL_MAP = { I: 'Info', D: 'Debug', W: 'Warn', E: 'Error' };
      // Standard log line timestamp (RFC3339 / ISO-ish) e.g. "2026-03-02T09:38:18.087...+00:00 140(172) I ...".
      // Some logs emit "M" which we treat as Info later.
      const RFC_LINE = /^(\d{4}-\d{2}-\d{2}T[\d.:+TZ-]+)\s+(\d+)\((\d+)\)\s+([IDWEM])\s+(.*)$/;
      // Alternate timestamp (seen in some STT logs): "03-12 16:48:50.216 82569(82659) D ...".
      const ALT_RFC_LINE = /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(\d+)\((\d+)\)\s+([IDWEM])\s+(.*)$/;
      const APP_VERSION_LINE = /^(\d{4}\/\d{2}\/\d{2}\s+[\d.]+)\s+app_version:\s*([^,]+),\s*commit:\s*(\S+),\s*build_time:\s*(.+)$/;
      const TAB_LINE = /^(\d{4}-\d{2}-\d{2}T[^\t]+)\t(\w+)\t(.+)$/;
      const EXTENSION_TAG = /\[([^\]]+)\]/g;

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

      /** Parse user date/time input (e.g. "1/1/1 9:01:01" or "2026-03-06 16:08:34") to ms */
      function parseUserDateTime(str) {
        if (!str || typeof str !== 'string') return NaN;
        const s = str.trim();
        if (!s) return NaN;
        const d = new Date(s);
        return isNaN(d.getTime()) ? NaN : d.getTime();
      }

      function median(arr) {
        const nums = arr.filter(function (x) { return x != null && !isNaN(x); }).sort(function (a, b) { return a - b; });
        if (!nums.length) return null;
        const m = (nums.length - 1) / 2;
        return (nums[Math.floor(m)] + nums[Math.ceil(m)]) / 2;
      }

      function tryParseJSON(str) {
        if (!str || typeof str !== 'string') return null;
        const startObj = str.indexOf('{');
        const startArr = str.indexOf('[');
        const start = startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr);
        if (start === -1) return null;
        const open = str[start];
        const close = open === '[' ? ']' : '}';
        let depth = 0;
        let end = -1;
        for (let i = start; i < str.length; i++) {
          if (str[i] === open) depth++;
          else if (str[i] === close) { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        if (end === -1) return null;
        try {
          return JSON.parse(str.slice(start, end));
        } catch (_) {
          return null;
        }
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
            entries.push({
              ts: match[1],
              level: 'I',
              pid: '',
              tid: '',
              ext: 'app',
              msg: `app_version: ${match[2].trim()}, commit: ${match[3]}, build_time: ${match[4].trim()}`,
              raw: line,
              json: null
            });
            i++;
            continue;
          }

          match = line.match(TAB_LINE);
          if (match) {
            const level = match[2] === 'ERROR' ? 'E' : match[2] === 'WARN' ? 'W' : match[2] === 'DEBUG' ? 'D' : 'I';
            entries.push({
              ts: match[1],
              level,
              pid: '',
              tid: '',
              ext: extractExtension(match[3]) || 'go',
              msg: match[3],
              raw: line,
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
            entries.push({ ts, level, pid, tid, ext: ext || 'runtime', msg, raw: line, json });
            continue;
          }

          if (line.startsWith('SESS_CTRL:')) {
            entries.push({
              ts: entries.length ? entries[entries.length - 1].ts : '',
              level: 'I',
              pid: '',
              tid: '',
              ext: 'agora_sess_ctrl',
              msg: line,
              raw: line,
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
            msg: line,
            raw: line,
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
          llmModel: null, llmSystemPrompt: null,
          mllmVendor: null, mllmModel: null, mllmUrl: null,
          ttsModule: null,
          sttModule: null,
          eventStartInfo: null,
          createRequestBody: null,
          sipLabels: null,
          sessCtrlVersion: null,
          rtm: null,
          tools: null,
          errors: 0,
          warnings: 0,
          turns: []
        };
        const seenTurnKeys = new Set();

        for (const e of entries) {
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
            const c = e.msg.match(/commit:\s*(\S+)/);
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
              if (llmNode) {
                summary.llmModule = llmNode.addon || llmNode.name || null;
                if (llmNode.property && llmNode.property.url) summary.llmUrl = llmNode.property.url;
                if (!summary.llmModel && llmNode.property && llmNode.property.params && llmNode.property.params.model) {
                  summary.llmModel = llmNode.property.params.model;
                }
                if (!summary.llmSystemPrompt && llmNode.property && Array.isArray(llmNode.property.system_messages) && llmNode.property.system_messages.length) {
                  const first = llmNode.property.system_messages[0];
                  if (first && first.content != null) summary.llmSystemPrompt = String(first.content);
                }
              }
              if (v2vNode && v2vNode.property) {
                const p = v2vNode.property;
                if (!summary.mllmVendor && p.vendor) summary.mllmVendor = p.vendor;
                if (!summary.mllmUrl && p.url) summary.mllmUrl = p.url;
                if (!summary.mllmModel && p.params && p.params.model) summary.mllmModel = p.params.model;
                if (!summary.llmUrl && p.url) summary.llmUrl = p.url;
                if (!summary.llmModule && (p.vendor || v2vNode.addon || v2vNode.name)) summary.llmModule = p.vendor || v2vNode.addon || v2vNode.name;
              }
              if (ttsNode) summary.ttsModule = ttsNode.addon || ttsNode.name || null;
              if (asrNode) summary.sttModule = asrNode.addon || asrNode.name || null;
            }
            if (j.graph_id) summary.graphId = j.graph_id;
            if (j.app_base_dir !== undefined && j.graph_id) summary.graphId = j.graph_id;
          }
          if (e.msg && /graph_id|graph resources/.test(e.msg)) {
            const g = tryParseJSON(e.msg);
            if (g && g.graph_id && !summary.graphId) summary.graphId = g.graph_id;
          }
          if ((!summary.llmModule || !summary.ttsModule || !summary.sttModule) && e.msg && e.msg.includes('"nodes"') && (e.msg.includes('start_graph') || e.msg.includes('"name":"llm"'))) {
            const g = e.json || tryParseJSON(e.msg);
            if (g && g.nodes && Array.isArray(g.nodes)) {
              if (!summary.llmModule || !summary.llmModel || !summary.llmSystemPrompt || !summary.llmUrl) {
                const n = g.nodes.find(nn => nn.name === 'llm');
                if (n) {
                  if (!summary.llmModule) summary.llmModule = n.addon || n.name;
                  if (!summary.llmUrl && n.property && n.property.url) summary.llmUrl = n.property.url;
                  if (!summary.llmModel && n.property && n.property.params && n.property.params.model) summary.llmModel = n.property.params.model;
                  if (!summary.llmSystemPrompt && n.property && Array.isArray(n.property.system_messages) && n.property.system_messages.length) {
                    const first = n.property.system_messages[0];
                    if (first && first.content != null) summary.llmSystemPrompt = String(first.content);
                  }
                }
              }
              if (!summary.ttsModule) { const n = g.nodes.find(nn => nn.name === 'tts'); if (n) summary.ttsModule = n.addon || n.name; }
              if (!summary.sttModule) { const n = g.nodes.find(nn => nn.name === 'asr'); if (n) summary.sttModule = n.addon || n.name; }
            }
          }
          if (e.json && Array.isArray(e.json)) {
            for (const item of e.json) {
              if (item && (item.role === 'user' || item.role === 'assistant') && item.content != null) {
                summary.turns.push({
                  role: item.role,
                  content: typeof item.content === 'string' ? item.content : String(item.content),
                  turn_id: item.turn_id,
                  source: item.metadata && item.metadata.source
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
                  summary.turns.push({
                    role: item.role,
                    content: typeof item.content === 'string' ? item.content : String(item.content),
                    turn_id: item.turn_id,
                    source: item.metadata && item.metadata.source
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
              if (!summary.sttModule && (info.ASR_VENDOR || info.asr_vendor)) summary.sttModule = info.ASR_VENDOR || info.asr_vendor;
              if (!summary.ttsModule && (info.TTS_VENDOR || info.tts_vendor)) summary.ttsModule = info.TTS_VENDOR || info.tts_vendor;
              if (!summary.llmModel && (info.LLM_MODEL || info.MODEL)) summary.llmModel = info.LLM_MODEL || info.MODEL;
              if (!summary.sipLabels && info && info.LABELS && typeof info.LABELS === 'object') summary.sipLabels = info.LABELS;
            }
          }
          if (!summary.createRequestBody && (e.json || e.msg)) {
            let j = e.json || tryParseJSON(e.msg);
            if (!j && e.msg && e.msg.includes("'properties'") && e.msg.includes('llm') && e.msg.includes('tts')) {
              j = tryParsePythonDict(e.msg);
            }
            if (j && typeof j === 'object' && j.properties && typeof j.properties === 'object' && j.properties.llm && j.properties.tts && j.properties.asr) {
              summary.createRequestBody = j;
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
          if (e.msg && e.msg.includes('tool_call') && (e.msg.includes('tool_call ') || e.msg.includes('tool_call:'))) {
            const m = e.msg.match(/tool_call[:\s]+([A-Za-z0-9_]+)\b/);
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
        }

        if (summary.tools) {
          const hasServers = summary.tools.servers && summary.tools.servers.length;
          const hasCalls = summary.tools.tool_calls && Object.keys(summary.tools.tool_calls).length;
          const hasMcp = summary.tools.is_tool_call_available != null || summary.tools.total_tools != null || hasServers || (summary.tools.mcp_errors && summary.tools.mcp_errors.length);
          if (!hasMcp && !hasCalls) summary.tools = null;
        }

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
            if (j && j.text != null)
              out.push({ ts: e.ts, text: j.text, duration_ms: j.duration_ms || 0, start_ms: j.start_ms || null, turn_id: j.turn_id != null ? j.turn_id : null, final: null, language: j.language || null, entryIndex: i });
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
        const transcripts = [];
        const metrics = [];
        const errors = [];
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg) continue;
          const vr = e.msg.match(/vendor_result:\s*transcript:\s*(\[[^\]]*\]|[^,]+),\s*final_audio_proc_ms:\s*(\d+),\s*total_audio_proc_ms:\s*(\d+)/);
          if (vr) {
            let text = vr[1];
            if (text === '[]') text = '(empty)';
            else if (text.match(/^\[/)) try { text = JSON.parse(text).join(' '); } catch (_) {}
            transcripts.push({ ts: e.ts, text, final_audio_proc_ms: parseInt(vr[2], 10), total_audio_proc_ms: parseInt(vr[3], 10), entryIndex: i });
          }
          if (e.msg.includes('send asr_metrics:') || e.msg.includes('asr_metrics:')) {
            const m = e.msg.match(/metrics=\{[^}]*'actual_send':\s*(\d+)[^}]*'actual_send_delta':\s*(\d+)/) || e.msg.match(/actual_send["']?\s*:\s*(\d+).*?actual_send_delta["']?\s*:\s*(\d+)/);
            if (m) metrics.push({ ts: e.ts, actual_send: parseInt(m[1], 10), actual_send_delta: parseInt(m[2], 10), entryIndex: i });
          }
          if (e.msg.includes('input_audio_duration=')) {
            const d = e.msg.match(/input_audio_duration=(\d+)ms/);
            if (d) metrics.push({ ts: e.ts, input_audio_duration_ms: parseInt(d[1], 10), entryIndex: i });
          }
          // ASR timeline failures (seen asr.py: Requested time ... exceeds timeline duration ...)
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
          // Vendor/protocol ASR errors (logged as key_point I-lines): "send asr_error: {...}"
          const asrErrTag = 'send asr_error:';
          const asrErrIdx = e.msg.indexOf(asrErrTag);
          if (asrErrIdx >= 0) {
            const jsonStr = e.msg.slice(asrErrIdx + asrErrTag.length).trim();
            const j = tryParseJSON(jsonStr);
            if (j && typeof j === 'object') {
              const vi = j.vendor_info && typeof j.vendor_info === 'object' ? j.vendor_info : null;
              errors.push({
                kind: 'asr_error',
                ts: e.ts,
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
          if (e.msg.includes('user.transcription') && e.msg.includes('"text"')) {
            const j = tryParseJSON(e.msg);
            if (j && j.text) transcripts.push({ ts: e.ts, text: j.text, user: true, final: j.final, turn_id: j.turn_id, entryIndex: i });
          }
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
        if (requests.length === 0) {
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (!e.msg || !e.msg.includes('[llm]') || !e.msg.includes('GlueConfig') || !e.msg.includes('chat/completions')) continue;
            const urlMatch = e.msg.match(/url='([^']+)'/);
            const modelMatch = e.msg.match(/params=\{[^}]*'model':\s*'([^']+)'/) || e.msg.match(/params=\{[^}]*"model":\s*"([^"]+)"/);
            requests.push({ ts: e.ts, url: urlMatch ? urlMatch[1] : null, status: null, error: null, model: modelMatch ? modelMatch[1] : null, finish_reason: null, duration_ms: null, entryIndex: i });
            break;
          }
        }
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
                const interrupted = (md.interrupted === true) || (interruptMode != null && /interrupt/i.test(String(interruptMode)));
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
          if (e.msg.includes('tool_call')) {
            const m = e.msg.match(/tool_call[:\s]+([A-Za-z0-9_]+)\b/);
            if (m) out.toolCalls[m[1]] = (out.toolCalls[m[1]] || 0) + 1;
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

      /** Performance metrics per turn. Aligns with report_controller + llm key_point lines (glue ttfb, connect times, _log_and_report_latency). */
      function extractPerformanceMetrics(entries) {
        const byTurn = {};
        let pendingLlmConnectMs = null;
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
          /* HTTP time to response headers (s) — next glue [turn_id:N] [ttfb:…] pairs with this turn */
          const connectM = e.msg.match(/\[llm\]\s*connect times:\s*([\d.]+)\s/);
          if (connectM) {
            const sec = parseFloat(connectM[1]);
            if (!isNaN(sec)) pendingLlmConnectMs = Math.round(sec * 1000);
          }
          const glueTtfb = e.msg.match(/\[llm\]\s*glue\s*\[turn_id:(\d+)\]\s*\[ttfb:(\d+)ms\]/);
          if (glueTtfb) {
            const turnId = parseInt(glueTtfb[1], 10);
            const row = ensure(turnId);
            row.llm_ttfb = parseInt(glueTtfb[2], 10);
            if (pendingLlmConnectMs != null) {
              row.llm_connect = pendingLlmConnectMs;
              pendingLlmConnectMs = null;
            }
            setTs(turnId);
          }
          const ttfsM = e.msg.match(/\[turn_id:(\d+)\]\s*\[ttfs:(\d+)ms\]/);
          if (ttfsM && e.msg.includes('_track_first_sentence')) {
            const turnId = parseInt(ttfsM[1], 10);
            ensure(turnId).llm_ttfs = parseInt(ttfsM[2], 10);
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
          const metricMsg = e.msg.match(/\[metric_message:\s*(\{[^]]+\})\]/);
          if (metricMsg) {
            const j = tryParseJSON(metricMsg[1]);
            if (j && j.turn_id != null) {
              const turnId = parseInt(j.turn_id, 10);
              const row = ensure(turnId);
              if (j.metric_name === 'aivad_delay' && j.latency_ms != null) row.aivad_delay = parseInt(j.latency_ms, 10);
              if (j.metric_name === 'ttlw' && j.module === 'asr' && j.latency_ms != null) row.asr_ttlw = parseInt(j.latency_ms, 10);
              if (j.metric_name === 'vad' && j.latency_ms != null) row.vad = parseInt(j.latency_ms, 10);
              if (j.module === 'llm' && j.latency_ms != null) {
                if (j.metric_name === 'connect_delay' || j.metric_name === 'connect') row.llm_connect = parseInt(j.latency_ms, 10);
                else if (j.metric_name === 'ttfb' && row.llm_ttfb == null) row.llm_ttfb = parseInt(j.latency_ms, 10);
                else if (j.metric_name === 'ttfs' && row.llm_ttfs == null) row.llm_ttfs = parseInt(j.latency_ms, 10);
              }
              setTs(turnId);
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
            ensure(turnId).tts_ttfb = parseInt(ttsTtfb[1], 10);
            setTs(turnId);
          }
          if ((e.msg.includes('tts') && e.msg.includes('ttfb')) && e.msg.includes('report_controller') && e.msg.includes("'turn_id'")) {
            const turnM = e.msg.match(/'turn_id':\s*(\d+)/);
            const ttfbM = e.msg.match(/'ttfb':\s*(\d+)/);
            if (turnM && ttfbM) {
              const turnId = parseInt(turnM[1], 10);
              const row = ensure(turnId);
              if (row.tts_ttfb == null) row.tts_ttfb = parseInt(ttfbM[1], 10);
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
          if (e.msg.includes('bhvs_delay') && e.msg.match(/latency_ms["']?\s*:\s*(\d+)/)) {
            const m = e.msg.match(/"turn_id"\s*:\s*(\d+)/);
            if (m) ensure(parseInt(m[1], 10)).bhvs_delay = parseInt(e.msg.match(/latency_ms["']?\s*:\s*(\d+)/)[1], 10);
          }
        }
        const list = Object.values(byTurn).sort((a, b) => a.turn_id - b.turn_id);
        for (const row of list) {
          if (row.bhvs_delay == null && row.asr_ttlw != null) row.bhvs_delay = 120;
        }
        return list;
      }

      /** User speech from ASR: send_asr_result, vendor_result, and ten:runtime Publish Message content user.transcription (has final) */
      function extractUserAsrTranscripts(entries) {
        const out = [];
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (!e.msg) continue;
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
              out.push({
                ts: e.ts,
                text: typeof j.text === 'string' ? j.text : '',
                final: j.final === true,
                start_ms: j.start_ms != null ? j.start_ms : null,
                duration_ms: j.duration_ms != null ? j.duration_ms : null,
                language: (j.language != null && j.language !== '') ? j.language : null,
                turn_id: j.turn_id != null ? j.turn_id : null,
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
            if (textMatch) {
              out.push({
                ts: e.ts,
                text: textMatch[1].replace(/\\'/g, "'"),
                final: finalMatch ? finalMatch[1] === 'True' : null,
                start_ms: startMatch ? parseInt(startMatch[1], 10) : null,
                duration_ms: durMatch ? parseInt(durMatch[1], 10) : null,
                language: langMatch ? langMatch[1] : null,
                turn_id: turnMatch ? parseInt(turnMatch[1], 10) : null,
                entryIndex: i
              });
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

      /** All individual text messages (user ASR + agent TTS + STT transcripts), no deduplication, for filtering */
      function buildAllMessagesList(insights) {
        const list = [];
        (insights.userAsr || []).forEach(o => {
          list.push({ ts: o.ts, source: 'user', text: o.text, final: o.final, turn_id: o.turn_id, start_ms: o.start_ms, duration_ms: o.duration_ms != null ? o.duration_ms : o.final_audio_proc_ms, language: o.language, entryIndex: o.entryIndex });
        });
        (insights.tts || []).forEach(o => {
          list.push({ ts: o.ts, source: 'agent', text: o.text, final: null, turn_id: o.turn_id, start_ms: o.start_ms, duration_ms: o.duration_ms, language: o.language, entryIndex: o.entryIndex });
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
      function buildTurnRowHtml(row) {
        const text = (row.text || '').slice(0, 200) + (row.text && row.text.length > 200 ? '…' : '');
        const finalStr = row.final === true ? 'yes' : row.final === false ? 'no' : '—';
        const tsAttr = escapeHtml(row.ts || '');
        const idxAttr = row.entryIndex != null ? ' data-index="' + row.entryIndex + '"' : '';
        return `<tr class="turn-row turn-${row.speaker}" data-ts="${tsAttr}"${idxAttr}><td>${row.turn != null ? row.turn : '—'}</td><td>${escapeHtml(row.speaker)}</td><td>${escapeHtml(row.ts)}</td><td>${escapeHtml(text)}</td><td>${finalStr}</td><td>${row.start_ms != null ? row.start_ms : '—'}</td><td>${row.duration_ms != null ? row.duration_ms : '—'}</td><td>${escapeHtml(row.language || '—')}</td></tr>`;
      }

      function buildTurnsList(insights) {
        const agentFromTts = (insights.tts || []).map(o => ({
          speaker: 'agent',
          turn: o.turn_id,
          ts: o.ts,
          text: o.text,
          final: o.final,
          start_ms: o.start_ms,
          duration_ms: o.duration_ms,
          language: o.language,
          entryIndex: o.entryIndex
        }));
        const userFromAsr = (insights.userAsr || []).map(o => ({
          speaker: 'user',
          turn: o.turn_id,
          ts: o.ts,
          text: o.text,
          final: o.final,
          start_ms: o.start_ms,
          duration_ms: o.duration_ms != null ? o.duration_ms : o.final_audio_proc_ms,
          language: o.language,
          entryIndex: o.entryIndex
        }));
        const evalTurns = (insights.evalIdTurns || []);
        const glueTurns = (insights.llmGlueTurns || []);
        const v2vTurns = (insights.v2vTranscriptions || []).map(o => ({
          speaker: o.speaker,
          turn: o.turn_id,
          ts: o.ts,
          text: o.text,
          final: o.final,
          start_ms: o.start_ms,
          duration_ms: o.duration_ms,
          language: o.language,
          entryIndex: o.entryIndex
        }));
        const byKey = {};
        function addOne(row) {
          const k = (row.turn != null ? row.turn : '') + '|' + row.speaker;
          const existing = byKey[k];
          if (!existing) { byKey[k] = row; return; }
          if (row.final === true && existing.final !== true) { byKey[k] = row; return; }
          if (row.final !== true && existing.final === true) return;
          if ((row.text || '').trim().length > (existing.text || '').trim().length) byKey[k] = row;
        }
        evalTurns.forEach(addOne);
        glueTurns.forEach(addOne);
        v2vTurns.forEach(addOne);
        userFromAsr.forEach(addOne);
        agentFromTts.forEach(addOne);
        const list = Object.values(byKey);
        list.sort((a, b) => {
          const ta = a.turn != null ? a.turn : 999999;
          const tb = b.turn != null ? b.turn : 999999;
          if (ta !== tb) return ta - tb;
          const tsa = parseLogTs(a.ts);
          const tsb = parseLogTs(b.ts);
          return (isNaN(tsa) ? 0 : tsa) - (isNaN(tsb) ? 0 : tsb);
        });
        return list;
      }

      function renderEntry(entry, index, isSelected, searchRaw) {
        const isRelevant = entry.msg && (
          /llm failure|Something went wrong|Request failed|on_request_exception|ncs on_agent_left|Failed too many times|No app certificate provided|TokenManager not initialized|Requested time .* exceeds timeline duration|send asr_error:|Websocket internal error|server rejected WebSocket|HTTP 401|base_dir of 'tts' is missing|500 Internal Server Error|Failed to send message/i.test(entry.msg)
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
      function openJsonModal(title, subtitle, obj) {
        const overlay = document.getElementById('jsonModal');
        const pre = document.getElementById('jsonModalPre');
        const t = document.getElementById('jsonModalTitle');
        const st = document.getElementById('jsonModalSubtitle');
        const safeObj = (typeof obj === 'string') ? obj : redactSecrets(obj);
        const text = typeof safeObj === 'string' ? safeObj : JSON.stringify(safeObj, null, 2);
        jsonModalCurrentText = text || '';
        t.textContent = title || 'JSON';
        st.textContent = subtitle || '';
        pre.innerHTML = jsonSyntaxHighlight(text || '');
        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('modal-open');
      }
      function closeJsonModal() {
        const overlay = document.getElementById('jsonModal');
        overlay.classList.remove('visible');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('modal-open');
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
        const geo = ti && ti.geoLocation && typeof ti.geoLocation === 'object' ? ti.geoLocation : null;
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
        const mllmEnabled = info.ENABLE_MLLM === true;
        const mllmVendor = summary.mllmVendor || '—';
        const mllmModel = summary.mllmModel || '—';
        const mllmUrl = summary.mllmUrl || '—';
        const geoStr = geo ? [geo.city, geo.country, geo.region].filter(Boolean).join(' / ') : '—';
        const avatarVendor = info.AVATAR_VENDOR || '—';
        const avatarId = info.AVATAR_ID || '—';
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
        html += kvCard('ASR', '<span>' + mono(asrVendor) + '</span><span>' + mono(asrLang) + '</span>');
        html += kvCard('LLM', '<span>' + mono(llmStr) + '</span><span>' + mono(llmModel) + '</span>');
        if (mllmEnabled || summary.mllmVendor || summary.mllmModel || summary.mllmUrl) {
          html += kvCard(
            'MLLM / V2V',
            '<span>' + mono(mllmVendor !== '—' ? mllmVendor : mllmModel) + '</span><span class="badge badge--info">' + escapeHtml(mllmEnabled ? 'enabled' : (mllmUrl !== '—' ? 'url' : '—')) + '</span>'
          );
          if (mllmUrl && mllmUrl !== '—') {
            html += kvCard('MLLM URL', '<span>' + mono(mllmUrl) + '</span><span>' + mono('') + '</span>');
          }
        }
        html += kvCard('TTS', '<span>' + mono(ttsVendor) + '</span><span>' + mono('') + '</span>');
        html += kvCard('Service', '<span>' + mono(ti && ti.service) + '</span><span>' + mono(ti && ti.apiVersion) + '</span>');
        html += kvCard('GeoLocation', '<span>' + mono(geoStr) + '</span><span>' + mono(geo && geo.continent) + '</span>');
        html += kvCard('Channel', '<span>' + mono((ti && ti.taskLabels && ti.taskLabels.channel) || summary.channel) + '</span><span>' + mono('') + '</span>');
        if (info.AVATAR_VENDOR || info.AVATAR_ID) {
          html += kvCard('Avatar', '<span>' + mono(avatarVendor) + '</span><span>' + mono(avatarId) + '</span>');
        }
        if (info.BVC_URL) {
          html += kvCard('BVC', '<span>' + mono(bvcUrl) + '</span><span>' + mono('') + '</span>');
        }
        html += '</div>';

        html += '<div class="summary-card summary-json-card"><h3 class="summary-card-title">Options</h3>';
        if (!flagKeys.length && (info.SAL_MODE == null || String(info.SAL_MODE).trim() === '')) {
          html += '<p class="summary-json-hint">No ENABLE_* flags found in event-start info.</p>';
        } else {
          html += '<table class="summary-flag-table"><tbody>';
          const hasSalMode = (info.SAL_MODE != null && String(info.SAL_MODE).trim() !== '');
          // Keep ordering dynamic: SAL mode is displayed inline with ENABLE_SAL (if present), and not duplicated.
          if (!flagKeys.includes('ENABLE_SAL') && hasSalMode) {
            html += '<tr><td class="summary-flag-k">SAL mode <code>SAL_MODE</code></td><td class="summary-flag-v"><code>' + escapeHtml(String(info.SAL_MODE)) + '</code></td></tr>';
          }
          for (const k of flagKeys) {
            if (k === 'ENABLE_SAL') {
              html += '<tr><td class="summary-flag-k">SAL <code>ENABLE_SAL</code>' + (hasSalMode ? ' / <code>SAL_MODE</code>' : '') + '</td><td class="summary-flag-v">' + ynBadge(info[k]) + (hasSalMode ? ' <code style="margin-left:8px;">' + escapeHtml(String(info.SAL_MODE)) + '</code>' : '') + '</td></tr>';
              continue;
            }
            html += '<tr><td class="summary-flag-k">' + escapeHtml(labelForFlagKey(k)) + ' <code>' + escapeHtml(k) + '</code></td><td class="summary-flag-v">' + ynBadge(info[k]) + '</td></tr>';
          }
          html += '</tbody></table>';
        }
        html += '</div>';

        html += '<div class="summary-card summary-json-card"><h3 class="summary-card-title">Task versions</h3>';
        const vKeys = Object.keys(versions);
        if (vKeys.length) {
          html += '<dl>' + vKeys.map(k => '<dt>' + escapeHtml(k) + '</dt><dd>' + escapeHtml(String(versions[k])) + '</dd>').join('') + '</dl>';
        } else {
          html += '<p class="summary-json-hint">No version snapshot found in this log.</p>';
        }
        html += '</div>';

        if (summary.rtm) {
          const r = summary.rtm;
          html += '<div class="summary-card summary-json-card"><h3 class="summary-card-title">RTM</h3>';
          html += '<dl>';
          html += '<dt>Enabled</dt><dd>' + (r.enabled ? 'yes' : 'no') + '</dd>';
          html += '<dt>Presence</dt><dd>' + (r.presence_enabled ? 'yes' : 'no') + '</dd>';
          html += '<dt>Metadata</dt><dd>' + (r.metadata_enabled ? 'yes' : 'no') + '</dd>';
          html += '<dt>Lock</dt><dd>' + (r.lock_enabled ? 'yes' : 'no') + '</dd>';
          if (r.channel) html += '<dt>Channel</dt><dd>' + escapeHtml(String(r.channel)) + '</dd>';
          if (r.user_id) html += '<dt>UID</dt><dd>' + escapeHtml(String(r.user_id)) + '</dd>';
          html += '</dl>';
          html += '</div>';
        }

        if (summary.tools) {
          const t = summary.tools;
          html += '<div class="summary-card summary-json-card"><h3 class="summary-card-title">Tools</h3>';
          html += '<dl>';
          if (t.is_tool_call_available != null) html += '<dt>Tool calling available</dt><dd>' + (t.is_tool_call_available ? 'yes' : 'no') + '</dd>';
          if (t.total_tools != null) html += '<dt>Total tools</dt><dd>' + escapeHtml(String(t.total_tools)) + '</dd>';
          if (t.servers && t.servers.length) html += '<dt>MCP servers</dt><dd>' + escapeHtml(t.servers.map(function (s) { return s.name + (s.transport ? ' (' + s.transport + ')' : '') + (s.url ? ' — ' + s.url : ''); }).join('\n')) + '</dd>';
          html += '</dl>';
          if (t.mcp_errors && t.mcp_errors.length) {
            html += '<p class="summary-json-hint">MCP errors: ' + escapeHtml(String(t.mcp_errors.length)) + ' (see Insights → Tools for details)</p>';
          }
          html += '</div>';
        }

        html += '<div class="summary-card summary-json-card"><h3 class="summary-card-title">Raw JSON</h3>';
        html += '<p class="summary-json-hint">Open a syntax-colored JSON viewer with copy.</p>';
        if (summary.eventStartInfo) html += '<button type="button" class="summary-json-toggle open-json-modal" data-json-kind="eventStart">View event start JSON</button>';
        if (summary.createRequestBody) html += '<button type="button" class="summary-json-toggle open-json-modal" data-json-kind="createReq">View create request JSON</button>';
        html += '</div>';
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
            const text = (row.text || '').slice(0, 300) + (row.text && row.text.length > 300 ? '…' : '');
            const finalStr = row.final === true ? 'yes' : row.final === false ? 'no' : '—';
            const tsAttr = escapeHtml(row.ts || '');
            const idxAttr = row.entryIndex != null ? ' data-index="' + row.entryIndex + '"' : '';
            html += `<tr class="msg-row source-${row.source}" data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(row.ts)}</td><td>${escapeHtml(row.source)}</td><td>${escapeHtml(text)}</td><td>${finalStr}</td><td>${row.turn_id != null ? row.turn_id : '—'}</td><td>${row.start_ms != null ? row.start_ms : '—'}</td><td>${row.duration_ms != null ? row.duration_ms : '—'}</td></tr>`;
          }
          html += '</tbody></table>';
        } else html += '<p class="insight-empty">No text messages found.</p>';
        html += '</div>';

        const turnsList = buildTurnsList(insights);
        html += '<div class="insight-tab-panel" data-panel="turns">';
        if (turnsList.length) {
          html += '<div class="turns-toolbar"><label><input type="checkbox" id="turnsFinalOnly" /> Show only final</label></div>';
          html += '<table id="turnsTable" class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Turn','Speaker','Time','Text','Final','Start (ms)','Duration (ms)','Language']) + '</tr></thead><tbody>';
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
            for (const s of series) {
              const pts = pointsBySeries[s.key];
              svg += '<g data-series="' + escapeHtml(s.key) + '">';
              if (pts.length < 2) {
                for (const p of pts) {
                  const cx = xPos(p.i), cy = yPos(p.v);
                  if (s.marker === 'triangle') {
                    svg += '<polygon points="' + cx + ',' + (cy - triH) + ' ' + (cx + triW) + ',' + (cy + triH) + ' ' + (cx - triW) + ',' + (cy + triH) + '" fill="' + s.color + '" stroke="none"/>';
                    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + hitR + '" fill="rgba(0,0,0,0.001)" style="cursor:pointer;pointer-events:all"><title>' + pointTitle(s, p) + '</title></circle>';
                  } else {
                    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + markerR + '" fill="' + s.color + '" stroke="var(--bg)" stroke-width="0.3"/>';
                    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + hitR + '" fill="rgba(0,0,0,0.001)" style="cursor:pointer;pointer-events:all"><title>' + pointTitle(s, p) + '</title></circle>';
                  }
                }
              } else {
                let path = 'M' + xPos(pts[0].i) + ',' + yPos(pts[0].v);
                for (let k = 1; k < pts.length; k++) { path += 'L' + xPos(pts[k].i) + ',' + yPos(pts[k].v); }
                svg += '<path d="' + path + '" fill="none" stroke="' + s.color + '" stroke-width="' + strokeW + '" stroke-linecap="round" stroke-linejoin="round"/>';
                for (const p of pts) {
                  const cx = xPos(p.i), cy = yPos(p.v);
                  if (s.marker === 'triangle') {
                    svg += '<polygon points="' + cx + ',' + (cy - triH) + ' ' + (cx + triW) + ',' + (cy + triH) + ' ' + (cx - triW) + ',' + (cy + triH) + '" fill="' + s.color + '" stroke="var(--bg)" stroke-width="0.3"/>';
                    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + hitR + '" fill="rgba(0,0,0,0.001)" style="cursor:pointer;pointer-events:all"><title>' + pointTitle(s, p) + '</title></circle>';
                  } else {
                    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + markerR + '" fill="' + s.color + '" stroke="var(--bg)" stroke-width="0.3"/>';
                    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + hitR + '" fill="rgba(0,0,0,0.001)" style="cursor:pointer;pointer-events:all"><title>' + pointTitle(s, p) + '</title></circle>';
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
            { label: 'BHVS Delay (ms)', title: 'BHVS: behavioral hold / barge-in window (ms) before ASR finalize; often 120 ms when BHVS is on.' },
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
            html += `<tr><td>${row.turn_id}</td><td>${vad}</td><td>${aivad}</td><td>${bhvs}</td><td>${asrTtlw}</td><td>${llmConn}</td><td>${llmTtfb}</td><td>${llmTtfs}</td><td>${ttsTtfb}</td><td>${totalStr}</td></tr>`;
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
        if (stt && (stt.transcripts.length || stt.metrics.length || (stt.errors && stt.errors.length))) {
          if (stt.transcripts.length) {
            html += '<p><strong>Transcripts / vendor results</strong></p><table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Text','Final audio (ms)','Total audio (ms)']) + '</tr></thead><tbody>';
            for (const t of stt.transcripts) {
              const text = t.user ? '(user) ' + (t.text || '').slice(0, 80) : (t.text || '').slice(0, 80);
              const tsAttr = escapeHtml(t.ts || '');
              const idxAttr = t.entryIndex != null ? ' data-index="' + t.entryIndex + '"' : '';
              html += `<tr data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(t.ts)}</td><td>${escapeHtml(text)}</td><td>${t.final_audio_proc_ms != null ? t.final_audio_proc_ms : '—'}</td><td>${t.total_audio_proc_ms != null ? t.total_audio_proc_ms : (t.input_audio_duration_ms != null ? t.input_audio_duration_ms : '—')}</td></tr>`;
            }
            html += '</tbody></table>';
          }
          if (stt.metrics.length) {
            html += '<p><strong>ASR metrics</strong></p><table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Actual send (ms)','Delta','Input duration (ms)']) + '</tr></thead><tbody>';
            for (const m of stt.metrics) {
              const tsAttr = escapeHtml(m.ts || '');
              const idxAttr = m.entryIndex != null ? ' data-index="' + m.entryIndex + '"' : '';
              html += `<tr data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(m.ts)}</td><td>${m.actual_send != null ? m.actual_send : '—'}</td><td>${m.actual_send_delta != null ? m.actual_send_delta : '—'}</td><td>${m.input_audio_duration_ms != null ? m.input_audio_duration_ms : '—'}</td></tr>`;
            }
            html += '</tbody></table>';
          }

          if (stt.errors && stt.errors.length) {
            const timelineErrs = stt.errors.filter(function (err) { return !err.kind || err.kind === 'timeline'; });
            const vendorErrs = stt.errors.filter(function (err) { return err.kind === 'asr_error'; });
            if (timelineErrs.length) {
              html += '<p><strong>ASR timeline errors</strong></p><table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Requested time (ms)','Timeline duration (ms)','Message']) + '</tr></thead><tbody>';
              for (const err of timelineErrs) {
                const tsAttr = escapeHtml(err.ts || '');
                const idxAttr = err.entryIndex != null ? ' data-index="' + err.entryIndex + '"' : '';
                html += `<tr data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(err.ts)}</td><td>${err.requested_time_ms != null ? escapeHtml(String(err.requested_time_ms)) : '—'}</td><td>${err.timeline_duration_ms != null ? escapeHtml(String(err.timeline_duration_ms)) : '—'}</td><td>${escapeHtml((err.detail || '').slice(0, 90) || '—')}</td></tr>`;
              }
              html += '</tbody></table>';
            }
            if (vendorErrs.length) {
              html += '<p><strong>ASR vendor / protocol errors</strong> <span class="summary-json-hint">(from <code>send asr_error:</code> lines, often logged as <code>I</code>)</span></p><table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Code','Vendor','Message','Vendor detail']) + '</tr></thead><tbody>';
              for (const err of vendorErrs) {
                const tsAttr = escapeHtml(err.ts || '');
                const idxAttr = err.entryIndex != null ? ' data-index="' + err.entryIndex + '"' : '';
                const vm = err.vendor_message || err.message || '';
                html += `<tr class="llm-row error" data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(err.ts)}</td><td>${err.code != null ? escapeHtml(String(err.code)) : '—'}</td><td>${err.vendor != null ? escapeHtml(String(err.vendor)) : '—'}</td><td>${escapeHtml((err.message || '').slice(0, 120) || '—')}</td><td>${escapeHtml(vm.slice(0, 120) || '—')}</td></tr>`;
              }
              html += '</tbody></table>';
            }
          }
        } else html += '<p class="insight-empty">No STT/ASR data found.</p>';
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
        if (sumForLlm.llmModel || sumForLlm.llmSystemPrompt) {
          html += '<p class="summary-json-hint"><strong>Model</strong>: ' + escapeHtml(sumForLlm.llmModel || '—') + '</p>';
          if (sumForLlm.llmSystemPrompt) {
            const preview = String(sumForLlm.llmSystemPrompt).slice(0, 320);
            html += '<details><summary>System prompt preview</summary><pre class="summary-json-view">' + escapeHtml(preview + (String(sumForLlm.llmSystemPrompt).length > 320 ? '\n... (truncated)' : '')) + '</pre></details>';
          }
        }
        if (insights.llm && insights.llm.length) {
          html += '<table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','URL / Status','Duration (ms)','Model','Finish / Error']) + '</tr></thead><tbody>';
          for (const r of insights.llm) {
            const status = r.status ? (r.status === '500' ? '<span style="color:var(--error)">500</span>' : r.status) : '—';
            const err = r.error || r.err_message || (r.finish_reason === 'error' ? 'error' : r.finish_reason || '');
            const tsAttr = escapeHtml(r.ts || '');
            const idxAttr = r.entryIndex != null ? ' data-index="' + r.entryIndex + '"' : '';
            const isErrorRow = (r.status === '500' || r.error || r.err_message || r.finish_reason === 'error');
            html += `<tr class="llm-row ${isErrorRow ? 'error' : ''}" data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(r.ts)}</td><td><span class="url" title="${escapeHtml(r.url || '')}">${escapeHtml((r.url || '').replace(/^https?:\/\//, '').slice(0, 50))}</span> ${status}</td><td>${r.duration_ms != null ? r.duration_ms : '—'}</td><td>${escapeHtml(r.model || '—')}</td><td>${escapeHtml(String(err).slice(0, 80))}</td></tr>`;
          }
          html += '</tbody></table>';
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
          html += '<div class="summary-card summary-json-card"><h3 class="summary-card-title">MCP</h3><dl>';
          if (tools.isToolCallAvailable != null) html += '<dt>Tool calling available</dt><dd>' + (tools.isToolCallAvailable ? 'yes' : 'no') + '</dd>';
          if (tools.totalTools != null) html += '<dt>Total tools</dt><dd>' + escapeHtml(String(tools.totalTools)) + '</dd>';
          if (tools.servers && tools.servers.length) html += '<dt>Servers</dt><dd>' + escapeHtml(tools.servers.map(function (s) { return s.name + (s.transport ? ' (' + s.transport + ')' : '') + (s.url ? ' — ' + s.url : ''); }).join('\n')) + '</dd>';
          if (tools.mcpErrors && tools.mcpErrors.length) html += '<dt>MCP errors</dt><dd>' + escapeHtml(String(tools.mcpErrors.length)) + '</dd>';
          html += '</dl></div>';
          if (callNames.length) {
            html += '<div class="summary-card summary-json-card"><h3 class="summary-card-title">Observed tool calls</h3><dl>';
            for (const n of callNames) html += '<dt>' + escapeHtml(n) + '</dt><dd>' + escapeHtml(String(tools.toolCalls[n])) + '</dd>';
            html += '</dl></div>';
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
          html += '<p><strong>TTS issues &amp; hints</strong></p><table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Severity','Issue','Code','Detail']) + '</tr></thead><tbody>';
          for (const r of ttsIssues) {
            const tsAttr = escapeHtml(r.ts || '');
            const idxAttr = r.entryIndex != null ? ' data-index="' + r.entryIndex + '"' : '';
            const sev = r.kind === 'error' ? '<span style="color:var(--error)">error</span>' : r.kind === 'warning' ? 'warning' : 'info';
            html += `<tr class="${r.kind === 'error' ? 'llm-row error' : ''}" data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(r.ts)}</td><td>${sev}</td><td>${escapeHtml(r.issue || '—')}</td><td>${escapeHtml(r.code || '—')}</td><td>${escapeHtml((r.detail || '').slice(0, 100))}</td></tr>`;
          }
          html += '</tbody></table>';
        } else {
          html += '<p class="insight-empty">No TTS errors or warnings detected.</p>';
        }
        const ttsOut = insights.tts || [];
        if (ttsOut.length) {
          html += '<p><strong>TTS output (transcripts / text results)</strong></p><table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Turn','Text','Duration (ms)']) + '</tr></thead><tbody>';
          for (const t of ttsOut) {
            const tsAttr = escapeHtml(t.ts || '');
            const idxAttr = t.entryIndex != null ? ' data-index="' + t.entryIndex + '"' : '';
            const text = (t.text || '').slice(0, 200) + ((t.text || '').length > 200 ? '…' : '');
            html += `<tr data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(t.ts)}</td><td>${t.turn_id != null ? escapeHtml(String(t.turn_id)) : '—'}</td><td>${escapeHtml(text || '—')}</td><td>${t.duration_ms != null ? t.duration_ms : '—'}</td></tr>`;
          }
          html += '</tbody></table>';
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
          html += '<p><strong>Keypoints Memory history</strong></p><table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Agent','Start','Stop','Timestamp(ms)','Role','Turn','Source','Interrupted','Confidence','Text']) + '</tr></thead><tbody>';
          for (const m of ncs.memoryItems) {
            const tsAttr = escapeHtml(m.ts || '');
            const idxAttr = m.entryIndex != null ? ' data-index="' + m.entryIndex + '"' : '';
            const text = (m.text || '').slice(0, 240) + ((m.text || '').length > 240 ? '…' : '');
            const interruptedStr = m.interrupted ? 'yes' : '—';
            const confidenceStr = m.confidence != null ? escapeHtml(String(m.confidence)) : '—';
            html += `<tr data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(m.ts)}</td><td>${escapeHtml(m.agent_id || '—')}</td><td>${m.start_ts != null ? escapeHtml(String(m.start_ts)) : '—'}</td><td>${m.stop_ts != null ? escapeHtml(String(m.stop_ts)) : '—'}</td><td>${m.timestamp_ms != null ? escapeHtml(String(m.timestamp_ms)) : '—'}</td><td>${escapeHtml(m.role || '—')}</td><td>${m.turn_id != null ? escapeHtml(String(m.turn_id)) : '—'}</td><td>${escapeHtml(m.source || '—')}</td><td>${escapeHtml(interruptedStr)}</td><td>${confidenceStr}</td><td>${escapeHtml(text || '—')}</td></tr>`;
          }
          html += '</tbody></table>';

          const interruptedItems = (ncs.memoryItems || []).filter(m => m.interrupted);
          if (interruptedItems.length) {
            html += '<p><strong>Interrupted items</strong></p><table class="insight-table insight-filterable insight-rows-clickable"><thead><tr>' + insightHeaderRow(['Time','Agent','Timestamp(ms)','Role','Turn','Source','Confidence','Interrupt ts','Text']) + '</tr></thead><tbody>';
            for (const m of interruptedItems) {
              const tsAttr = escapeHtml(m.ts || '');
              const idxAttr = m.entryIndex != null ? ' data-index="' + m.entryIndex + '"' : '';
              const text = (m.text || '').slice(0, 240) + ((m.text || '').length > 240 ? '…' : '');
              const confidenceStr = m.confidence != null ? escapeHtml(String(m.confidence)) : '—';
              html += `<tr data-ts="${tsAttr}"${idxAttr}><td>${escapeHtml(m.ts)}</td><td>${escapeHtml(m.agent_id || '—')}</td><td>${m.timestamp_ms != null ? escapeHtml(String(m.timestamp_ms)) : '—'}</td><td>${escapeHtml(m.role || '—')}</td><td>${m.turn_id != null ? escapeHtml(String(m.turn_id)) : '—'}</td><td>${escapeHtml(m.source || '—')}</td><td>${confidenceStr}</td><td>${m.interrupt_timestamp_ms != null ? escapeHtml(String(m.interrupt_timestamp_ms)) : '—'}</td><td>${escapeHtml(text || '—')}</td></tr>`;
            }
            html += '</tbody></table>';
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
              openJsonModal('Create request JSON', 'Parsed from log', sum.createRequestBody);
            }
          });
        });

        root.querySelectorAll('.perf-chart-wrap').forEach(function (wrap) {
          if (!wrap.querySelector('.perf-chart-svg-wrap svg')) return;
          wrap.querySelectorAll('.perf-legend-item').forEach(function (el) {
            el.addEventListener('click', function () {
              const key = el.getAttribute('data-series');
              if (!key) return;
              wrap.querySelectorAll('g[data-series="' + key + '"]').forEach(function (g) { g.classList.toggle('perf-series-off'); });
              el.classList.toggle('dimmed');
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
            tr.style.display = textOk && colOk ? '' : 'none';
          });
        });
      }

      let state = {
        entries: [],
        summary: {},
        extensions: [],
        insights: null,
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

      function setParseOverlay(show, message) {
        var ov = document.getElementById('parseOverlay');
        var msg = document.getElementById('parseOverlayMsg');
        if (message) msg.textContent = message;
        ov.setAttribute('aria-hidden', show ? 'false' : 'true');
        ov.style.display = show ? 'flex' : 'none';
        document.body.classList.toggle('parse-busy', !!show);
      }

      function onFileLoad(text, fileName) {
        document.getElementById('parseOverlayMsg').textContent = 'Parsing log…';
        document.getElementById('fileName').textContent = fileName || 'ten.err.log';
        document.getElementById('loading').style.display = 'block';
        document.getElementById('emptyState').style.display = 'none';
        document.getElementById('logEntries').style.display = 'none';

        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            try {
          const entries = parseLines(text);
          const summary = extractSummary(entries);
          const extensions = collectExtensions(entries);
          state = {
            entries,
            summary,
            extensions,
            insights: null,
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
          document.getElementById('sumLlm').textContent = summary.llmUrl || summary.llmModule || '—';
          document.getElementById('sumTts').textContent = summary.ttsModule || '—';
          document.getElementById('sumStt').textContent = summary.sttModule || '—';
          const stopCard = document.getElementById('summaryStopCard');
          if (summary.stopTs != null || summary.stopStatus || summary.stopMessage) {
            stopCard.style.display = 'block';
            document.getElementById('sumStopTs').textContent = summary.stopTs != null ? String(summary.stopTs) : '—';
            document.getElementById('sumStopStatus').textContent = summary.stopStatus || '—';
            document.getElementById('sumStopMessage').textContent = summary.stopMessage || '—';
          } else stopCard.style.display = 'none';

          const eventStartCard = document.getElementById('summaryEventStartCard');
          if (summary.eventStartInfo && summary.eventStartInfo.taskInfo) {
            eventStartCard.style.display = 'block';
            const ti = summary.eventStartInfo.taskInfo;
            const info = ti.info || {};
            const fields = [];
            if (ti.taskId != null) fields.push(['Task ID', ti.taskId]);
            if (ti.appId != null) fields.push(['App ID', ti.appId]);
            if (ti.taskName != null) fields.push(['Task name', ti.taskName]);
            if (ti.agentName != null) fields.push(['Agent name', ti.agentName]);
            if (ti.graphName != null) fields.push(['Graph', ti.graphName]);
            if (ti.template != null) fields.push(['Template', ti.template]);
            if (info.ASR_VENDOR != null) fields.push(['ASR (STT)', info.ASR_VENDOR]);
            if (info.TTS_VENDOR != null) fields.push(['TTS', info.TTS_VENDOR]);
            if (info.ASR_LANGUAGE != null) fields.push(['ASR language', info.ASR_LANGUAGE]);
            if (ti.createTs != null) fields.push(['Create TS', String(ti.createTs)]);
            if (ti.service != null) fields.push(['Service', ti.service]);
            document.getElementById('sumEventStartFields').innerHTML = '<dl>' + fields.map(([k, v]) => '<dt>' + escapeHtml(k) + '</dt><dd>' + escapeHtml(String(v)) + '</dd>').join('') + '</dl>';
            document.getElementById('sumEventStartJson').textContent = JSON.stringify(summary.eventStartInfo, null, 2);
          } else eventStartCard.style.display = 'none';

          const createReqCard = document.getElementById('summaryCreateReqCard');
          if (summary.createRequestBody && summary.createRequestBody.properties) {
            createReqCard.style.display = 'block';
            const p = summary.createRequestBody.properties;
            const fields = [];
            if (summary.createRequestBody.name != null) fields.push(['Name', summary.createRequestBody.name]);
            if (p.channel != null) fields.push(['Channel', p.channel]);
            if (p.llm) {
              const url = p.llm.url || (typeof p.llm === 'string' ? p.llm : null);
              fields.push(['LLM', url ? url.replace(/^https?:\/\//, '').slice(0, 60) + (url.length > 60 ? '…' : '') : (p.llm.vendor || '—')]);
            }
            if (p.tts && (p.tts.vendor || p.tts.vendor_name)) fields.push(['TTS', p.tts.vendor || p.tts.vendor_name]);
            if (p.asr && (p.asr.vendor || p.asr.vendor_name)) fields.push(['ASR (STT)', p.asr.vendor || p.asr.vendor_name]);
            if (p.asr && p.asr.language) fields.push(['ASR language', p.asr.language]);
            document.getElementById('sumCreateReqFields').innerHTML = '<dl>' + fields.map(([k, v]) => '<dt>' + escapeHtml(k) + '</dt><dd>' + escapeHtml(String(v)) + '</dd>').join('') + '</dl>';
            document.getElementById('sumCreateReqJson').textContent = JSON.stringify(summary.createRequestBody, null, 2);
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
          if (ev.target.checked) list = list.filter(function (r) { return r.final === true; });
          const tbody = turnsTable.querySelector('tbody');
          if (tbody) tbody.innerHTML = list.map(buildTurnRowHtml).join('');
          return;
        }
      });

      document.getElementById('insightsContent').addEventListener('click', function (ev) {
        if (window.getSelection().toString().trim()) return;
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
        if (e.key === 'Escape') closeJsonModal();
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
  
