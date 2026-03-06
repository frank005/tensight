# TEN Log Reader

A web-based log reader for **ten.err.log** (Agora TEN / Conversational AI runtime logs). It parses the log format and surfaces session info, errors, and conversation turns.

## Features

- **Summary panel** – App version, build time, Agent ID, Channel, Graph ID, and counts of errors/warnings
- **Conversation** – Extracted user/assistant turns from chat completion history (with “Something went wrong” / LLM failure highlighted)
- **Filter by level** – Info, Debug, Warn, Error
- **Filter by extension** – e.g. `llm`, `agora_rtc`, `message_collector`, `event_bus_go`
- **Search** – Text search in log messages
- **Expandable JSON** – Inline JSON in a line can be expanded/collapsed
- **Highlighting** – Error-level lines and lines mentioning “llm failure”, “Something went wrong”, “Request failed”, “500”, and “Failed to send message” are visually highlighted

## How to use

1. Open `index.html` in a browser (double-click or `open index.html`).
2. Click **Choose log file** and select your `ten.err.log` (or any `.log` file in the same format).
3. The summary and log list update automatically. Use the filters and search to narrow down.

No server is required; everything runs in the browser. Large files (e.g. several MB) may take a few seconds to parse.

## Log format supported

- Lines with RFC3339 timestamp + PID(TID) + level (I/D/W/E) + message
- Optional `[extension_name]` tag in the message
- Multi-line entries (continuation lines indented or JSON)
- First-line header: `app_version`, `commit`, `build_time`
- Tab-separated Go-style lines with level names (INFO, WARN, ERROR, DEBUG)
- `SESS_CTRL:` lines (attributed to `agora_sess_ctrl`)
