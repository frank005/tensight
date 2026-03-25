# TEN Log Reader (Tensight)

Web-based reader for **`ten.err`** / **`ten.err.log`** (Agora TEN / Conversational AI runtime logs).
It parses logs fully in the browser and surfaces a searchable log viewer plus structured **Insights**.

No backend required.

## Run

- Open **`index.html`** directly in a browser, or host the folder (for example with GitHub Pages).
- Load a file via **Choose log file** (or drag-and-drop).

## Project structure

- **`index.html`**: UI layout/markup
- **`styles.css`**: all styling
- **`app.js`**: parsing, extraction, rendering, interactions

## What it supports

### Log parsing

- RFC3339-style lines (`timestamp pid(tid) level message`)
- Alternate timestamp format (`MM-DD HH:MM:SS(.ms) ...`) used by some STT logs
- Levels `I/D/W/E` plus `M` (mapped to info)
- Optional `[extension]` extraction with guards against bracketed JSON blobs
- Continuation multi-line entries
- Tab-separated Go-style lines (`INFO`, `WARN`, etc.)
- `SESS_CTRL:` lines

### Log view

- Level toggles, extension filter, time range, search
- Quick event chips + “More filters”
- Per-line copy button
- Global line **Expand all / Collapse all** with per-line double-click expand
- Match highlighting for search/filter text
- Context jump from Insights rows and “Full log / Clear filters / Done” controls
- Large-log handling: debounced filtering + chunked rendering + spinner overlay

### Summary cards

- App/build info, channel, graph, RTC SID, Argus links, stop status
- Dynamic `ENABLE_*` + `SAL_MODE` options table
- Task version snapshot (when present)
- Event-start / create-request JSON modal viewer (highlighted + copy)
- LLM/ASR/TTS hints from graph + event payloads
- MLLM/V2V summary card (only when enabled/signaled)

### Insights tabs

| Tab | Contents |
|-----|----------|
| **Summary** | Pretty summary cards + options + task versions |
| **Keypoints** | NCS joined/left/memory events |
| **Text messages** | ASR/TTS/turn text stream |
| **Turns (user & agent)** | Consolidated turn timeline |
| **States / State reports** | State transitions and reporter outputs |
| **Performance** | Per-turn latency graph/table (ASR/LLM/TTS/VAD/AIVAD/BHVS + totals) |
| **RTC / Agora** | RTC warnings/errors by category |
| **STT / ASR metrics** | Transcripts, metrics, timeline errors, **`vendor_error:`** (often `E`) and **`send asr_error:`** JSON (often `I`) |
| **LLM** | Request/status/error rows, model, and system-prompt preview when available |
| **MLLM / V2V** | V2V events/transcriptions (strictly gated by `ENABLE_MLLM` when flag exists) |
| **TTS** | TTS-specific issues (incl. **`tts_error:`** / `send_tts_error` JSON) and outputs |
| **Avatar** | Avatar-related config/events |
| **SIP** | `ENABLE_SIP`, SIP defaults, from/to/campaign/call IDs, sip-manager events |
| **RTM** | Presence/message/set_presence activity |
| **Tools** | MCP/tool-call availability, servers, call counts, MCP errors |
| **Events** | Generic `KEYPOINT [event_type:...]` timeline |

## Notes

- Parsing and extraction are frontend-only; large logs can still take a moment.
- Log files are excluded from git (see `.gitignore`).
