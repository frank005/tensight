# TEN Log Reader (Tensight)

Web-based reader for **ten.err** / **ten.err.log** (Agora TEN / Conversational AI runtime logs). Parses the log in the browser and surfaces session info, structured **Insights**, and the raw log with filters.

No server required — open `index.html` or host the folder on GitHub Pages.

## How to use

1. Open **`index.html`** in a browser, or drag-and-drop a log file onto the page.
2. Use **Choose log file** to load `ten.err`, `ten.err.log`, or any file in the supported format.
3. **Log** view: filter by level (I/D/W/E), extension, time range, and search. Quick filter chips (LLM, TTS, KEYPOINT, etc.) and **Clear** reset search and exit “jump from Insights” mode.
4. **Insights** view: tables derived from the log. **Keypoints** opens first (NCS join/leave/memory, including interrupt + ASR confidence where present). Click a row to jump to that line in the log (filters reset so the line is visible; the log panel scrolls to it). Use **Full log** / **Clear filters** / **Done** on the context bar to widen or dismiss.

Large files (multi‑MB) may take a few seconds to parse.

## Features

### Summary

- App version, build, Agent ID, channel (+ Argus by channel), RTC SID (+ Argus by SID), graph, LLM/TTS/STT hints, optional stop card and task/create-request blocks. Argus URLs include `fromTs`/`toTs` from the session when known.

### Insights tabs (extracted data)

| Tab | Contents |
|-----|----------|
| **Keypoints** | NCS `on_agent_joined` / `on_agent_left` / `on_agent_memory` (memory table + interrupted rows + confidence) |
| **Text messages** | User ASR + agent TTS + STT lines |
| **Turns** | User & agent turns (glue / eval / ASR) |
| **States / State reports** | State machine transitions and reports |
| **Performance** | Per-turn latency chart + module timings |
| **STT / ASR** | Transcripts, metrics, **ASR timeline errors** (e.g. requested time vs timeline duration) |
| **RTC / Agora** | Cert/token warnings, graph routing failures, Agora extension **E** lines + serious **W** (onError, token, connection, etc.) — by category: routing / cert / sdk |
| **LLM** | Requests, failures, exceptions, `finish_reason` / error payloads |
| **TTS** | WebSocket/auth issues (e.g. HTTP 401), empty `api_key` hints, base_dir warnings; TTS text results |
| **Events** | `KEYPOINT [event_type:…]` lines |

### Log view

- **Highlighting** for many failure patterns (LLM, NCS leave, TTS WS errors, ASR timeline, RTC cert/routing, etc.), not only raw `E` lines.
- **JSON** in a line can be expanded/collapsed.

## Log format supported

- RFC3339-style timestamp + `PID(TID)` + level `I`/`D`/`W`/`E` + message  
- Optional `[extension]` in the message  
- Continuation / multi-line entries  
- Header lines: `app_version`, `commit`, `build_time`  
- Tab-separated Go-style lines (`INFO`, `WARN`, …)  
- `SESS_CTRL:` lines  

Log files are not committed to the repo (see `.gitignore`).
