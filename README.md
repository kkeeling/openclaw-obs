# openclaw-obs

Local-first observability for [OpenClaw](https://openclaw.dev) agents. Captures LLM traces, tool invocations, conversation messages, sub-agent spawns, and session metadata — all stored in a local SQLite database with a built-in web dashboard.

**Zero data leaves your machine.**

## What It Captures

| Hook | What's recorded |
|------|----------------|
| `session_start` / `session_end` | Trace lifecycle (one trace per session) |
| `llm_input` / `llm_output` | LLM calls with model, token counts, cost, and full conversation messages |
| `before_tool_call` / `after_tool_call` | Tool invocations with input/output, duration, and errors |
| `subagent_spawned` / `subagent_ended` | Sub-agent traces linked to parent via `parent_trace_id` |
| `before_agent_start` / `agent_end` | Agent-level spans with status |

All events are buffered in memory and flushed in batches for minimal performance impact.

## Install

```bash
cd ~/projects/openclaw-obs
npm install
npm run build
cd dashboard && npm install && npm run build && cd ..
```

The plugin registers itself via `openclaw.plugin.json`. OpenClaw discovers it automatically when the package is linked or listed in your gateway config.

## Start the Dashboard

```bash
# Standalone — opens browser automatically
npx openclaw-obs

# Or start the server programmatically
node dist/cli.js
```

The dashboard launches at **http://127.0.0.1:19100** (auto-increments port if taken).

### Dashboard Views

- **Overview** — Trace count, total cost, token usage, error rate, model breakdown, per-agent and per-day trends
- **Trace List** — Filterable list of all traces with status, agent, model, cost, and duration
- **Trace Detail** — Waterfall timeline of spans, conversation browser with chat-style message display, sub-agent links
- **Conversation Browser** — Full session replay showing user/assistant/system/tool messages with expandable content and pagination

## Configuration

All configuration is via environment variables (no config files needed):

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_OBS_PORT` | `19100` | Dashboard server port |
| `OPENCLAW_OBS_DB_PATH` | `~/.openclaw/observability/traces.db` | SQLite database location |
| `OPENCLAW_OBS_RETENTION_DAYS` | `7` | Auto-prune traces older than N days |
| `OPENCLAW_OBS_MAX_DB_MB` | `0` (unlimited) | Max database size — oldest traces pruned when exceeded |
| `OPENCLAW_OBS_MAX_PAYLOAD_KB` | `10` | Max size for stored LLM input/output payloads |

## Pruning & Maintenance

Traces are automatically pruned on startup and via a periodic interval while the plugin is running:

- **Time-based**: Traces older than `OPENCLAW_OBS_RETENTION_DAYS` (default 7) are deleted
- **Size-based**: If `OPENCLAW_OBS_MAX_DB_MB` is set, oldest traces are removed until the DB is under the limit
- **Manual**: `POST /api/prune` triggers immediate pruning + `VACUUM`

The database uses WAL mode for concurrent reads during writes.

### Database Location

The default database lives at `~/.openclaw/observability/traces.db`. You can inspect it directly:

```bash
sqlite3 ~/.openclaw/observability/traces.db "SELECT agent_name, COUNT(*) FROM traces GROUP BY agent_name"
```

## API

All endpoints are served from the dashboard server:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/traces` | List traces (filters: `status`, `agent`, `model`, `since`, `until`, `minCost`, `search`, `limit`, `offset`) |
| `GET` | `/api/traces/:id` | Get trace with spans, messages, and child traces |
| `GET` | `/api/traces/:id/messages` | Get conversation messages for a trace |
| `GET` | `/api/stats` | Aggregated analytics (filters: `since`, `until`) |
| `GET` | `/api/health` | Health check — DB size, trace count, retention config |
| `POST` | `/api/prune` | Manual prune + VACUUM |

## Architecture

```
openclaw-obs/
├── src/
│   ├── plugin/
│   │   ├── index.ts    # OpenClaw plugin hooks — event capture + buffering
│   │   ├── db.ts       # SQLite schema, queries, pruning, migrations
│   │   └── buffer.ts   # In-memory event buffer with batch flush
│   ├── server/
│   │   ├── index.ts    # Express server + SPA static file serving
│   │   └── routes.ts   # REST API endpoints
│   └── cli.ts          # Standalone entry point
├── dashboard/
│   └── src/
│       ├── views/       # TraceList, TraceDetail, Overview
│       ├── components/  # ConversationView, SubAgentLinks
│       └── hooks/       # useApi data fetching
└── openclaw.plugin.json # Plugin manifest
```

**Data flow:** OpenClaw gateway → plugin hooks → EventBuffer → SQLite (WAL mode) → Express API → React dashboard

## License

MIT
