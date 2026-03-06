# Feature: OpenClaw Local Observability Plugin + Dashboard (v1)

## Problem Statement

We run a multi-agent team that burns real money on LLM calls. When an agent gets stuck in a loop, fails silently, or burns $15 on a bad session, nobody knows until someone manually checks. There's no way to answer "how much did we spend today?" or "what went wrong in that Delores session?" without digging through raw logs. We need local-first tracing with cost visibility — something that captures every LLM call, tool invocation, and sub-agent spawn, then surfaces it in a dashboard you can check in 10 seconds.

## Who Asked For This

Director (Keenan) + Grace (Team Lead). Director wants cost visibility across agents. Grace wants debugging capability for failed sessions. Both want it fully local — zero data leaves the machine.

## Rejected Approaches (And Why)

- **OpenTelemetry SDK + Collector:** Massive dependency for a local SQLite tool. We'd be importing 40+ packages to write to a file. OTEL is for distributed systems shipping telemetry to Datadog, not for a localhost debug tool.
- **Langfuse / Phoenix / Opik self-hosted:** External services with Docker requirements, databases, auth systems. We want `npx openclaw-obs` and done.
- **WebSocket real-time streaming:** Adds complexity for negligible UX gain on localhost. 5s polling is indistinguishable from real-time for a debug tool.
- **Electron / Tauri desktop app:** Desktop wrapper around a web page. Adds build complexity, binary distribution, auto-update. Overkill for a local web server.
- **Separate plugin + dashboard packages:** Two npm packages = two things to install, version, coordinate. One package, one process.

## Solution

An OpenClaw plugin that hooks into native event hooks and diagnostic events to capture LLM calls, tool invocations, and session metadata — writing everything to a local SQLite database. A lightweight React dashboard served from the same process lets you browse traces, inspect sessions, and track cost/token analytics. Single command to start: `npx openclaw-obs`.

---

## Architecture

### Plugin (Trace Capture → SQLite)

**Event Sources:**
1. **Plugin Hooks** (via `api.registerHook`):
   - `session_start` / `session_end` — trace lifecycle
   - `before_tool_call` / `after_tool_call` — tool span capture
   - `agent_end` — session completion status, duration
   - `before_agent_start` — initial context

2. **Diagnostic Events** (via `onDiagnosticEvent`):
   - `model.usage` — provider, model, token counts, costUsd, durationMs
   - `session.state` — state transitions

**Write Strategy:**
- Buffer events in-process, flush to SQLite in batches (every 100ms or 50 events, whichever comes first)
- Non-blocking: trace writes must never add latency to LLM calls
- Single write connection per process, held open for plugin lifetime
- On write failure: log to stderr, continue. Never crash the observed system.

**SQLite Configuration:**
- `PRAGMA journal_mode=WAL` — mandatory
- `PRAGMA busy_timeout=5000` — handles concurrent writer contention
- DB location: `~/.openclaw/observability/traces.db` (configurable via `OPENCLAW_OBS_DB_PATH`)

### Schema (Two Tables)

```sql
CREATE TABLE traces (
  id TEXT PRIMARY KEY,          -- UUID
  session_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,  -- Unix ms
  ended_at INTEGER,
  status TEXT DEFAULT 'running', -- running | success | error
  metadata TEXT                 -- JSON
);

CREATE TABLE spans (
  id TEXT PRIMARY KEY,          -- UUID
  trace_id TEXT NOT NULL REFERENCES traces(id),
  parent_span_id TEXT,
  kind TEXT NOT NULL,           -- llm | tool | subagent
  name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  input_json TEXT,              -- Truncated to 10KB by default
  output_json TEXT,             -- Truncated to 10KB by default
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  model TEXT,
  error TEXT,
  metadata TEXT                 -- JSON
);

CREATE INDEX idx_spans_trace ON spans(trace_id);
CREATE INDEX idx_spans_kind ON spans(kind);
CREATE INDEX idx_traces_agent ON traces(agent_name);
CREATE INDEX idx_traces_started ON traces(started_at);
CREATE INDEX idx_traces_session ON traces(session_id);
```

**Storage Cap:** `input_json` and `output_json` truncated to 10KB at write time by default. Configurable via `OPENCLAW_OBS_MAX_PAYLOAD_KB` (set to 0 for unlimited). Critical for preventing SQLite file bloat.

**Sub-agent spans:** No dedicated hooks exist. Infer from tool calls with names matching `subagents/*` or `sessions_spawn`. Known limitation for v1, documented, acceptable.

### Dashboard Serving

- **Frontend:** React + Vite static build
- **API:** Express server, read-only against SQLite, ~5 endpoints
- **Single process:** Same Express server serves static files + API
- **Port:** `localhost:19100` (fallback: try 19100-19109, pick first available)
- **Launch:** `npx openclaw-obs` starts the server, opens browser

### Data Retention

- Default: 7 days. Configurable via `OPENCLAW_OBS_RETENTION_DAYS`
- Prune on startup + hourly during runtime
- Cascade: delete spans for expired traces, then delete traces
- VACUUM only on explicit user command (manual prune button in dashboard)
- Optional max DB size: `OPENCLAW_OBS_MAX_DB_MB` — prunes oldest traces until under limit

---

## User Stories & Acceptance Criteria

### US-1: Daily Cost Check
**As** the Director, **I want** to see today's total cost across all agents **so that** I can track my burn rate.

- **Given:** Dashboard is open at localhost:19100
- **When:** I land on the Overview page
- **Then:** I see 4 metric cards: 24h Total Cost, Trace Count, Error Rate, Avg Duration
- **And:** Cost-by-agent bar chart shows each agent's spend, sorted highest first
- **And:** Cost-over-time line chart shows 7-day trend by default

### US-2: Find Failed Sessions
**As** Grace, **I want** to find failed sessions for a specific agent **so that** I can debug what went wrong.

- **Given:** I'm on the Trace List page
- **When:** I apply filters: Status = Error, Agent = Delores
- **Then:** I see only failed Delores sessions, sorted newest first
- **And:** Each row shows: status dot, session ID, agent, model, duration, tokens (in/out), cost, started time
- **And:** I can click any row to open the Trace Detail view

### US-3: Debug a Session
**As** Grace, **I want** to see the full timeline of a session **so that** I can trace the sequence of calls.

- **Given:** I've clicked into a trace from the Trace List
- **When:** The Trace Detail view loads
- **Then:** I see a summary card: session ID, agent, model, duration, total cost, status
- **And:** Below it, a waterfall timeline showing all spans (LLM 🧠, Tool 🔧, Sub-agent 🤖) positioned by time
- **And:** Clicking a span expands inline details: input/output (first 200 chars with "show full" toggle), tokens, cost, error if any

### US-4: Spot Expensive Sessions
**As** the Director, **I want** abnormally expensive sessions flagged **so that** I can investigate or kill runaway agents.

- **Given:** A session has accumulated cost exceeding $5 (configurable via `OPENCLAW_OBS_COST_ALERT_USD`)
- **When:** I view the Trace List
- **Then:** That session's row has a ⚠️ warning indicator
- **And:** Cost cell is highlighted in warning color (orange)

### US-5: Model Cost Breakdown
**As** the Director, **I want** to see cost broken down by model **so that** I can evaluate model choices.

- **Given:** I'm on the Overview/Analytics view
- **When:** I look at the model breakdown table
- **Then:** I see each model with: call count, total tokens, total cost
- **And:** Sorted by cost descending

### US-6: Manual Data Prune
**As** an operator, **I want** to manually prune old traces **so that** I can reclaim disk space.

- **Given:** I click the prune button in the dashboard header
- **When:** I confirm the action
- **Then:** Traces older than the retention period are deleted
- **And:** VACUUM runs to reclaim disk space
- **And:** Dashboard shows updated DB size

---

## Dashboard Views

### View 1: Overview (Landing Page)

**Layout:** Full-width content area with fixed left sidebar (240px, collapsible to 48px icon rail).

**Sidebar Nav Items:** Traces, Analytics, Settings/Prune. Collapse to icon rail at <1280px viewport width. Below 1024px, collapse to hamburger menu (lowest priority given laptop-minimum target).

**Components:**
1. **4 Metric Cards** (top row, single row): 24h Cost, Trace Count, Error Rate, Avg Duration
2. **Charts** (2-column grid below metric cards):
   - **Cost Over Time** — line chart, 7-day default, Recharts
   - **Cost By Agent** — horizontal bar chart, sorted highest first
   - **Token Usage** — line chart (input vs output tokens over time)
   - **Error Rate** — line chart with threshold line
3. **Model Breakdown** — table: model, call count, tokens, cost (full-width below charts)

**Refresh:** Poll API every 30s for analytics data.

**Empty State:** "Not enough data for charts" when no traces exist in the selected time range.

### View 2: Trace List

**Layout:** Full-width data table.

**Columns:** Status (dot) | Session ID | Agent | Model | Duration | Tokens (In / Out) | Cost | Started

_Tokens In/Out combined into a single "4.2K / 1.8K" column to save horizontal space on 13" screens (8 columns instead of 9)._

**Features:**
- Filter pills: Status, Agent, Model, Date Range, Cost Threshold
- Free text search on Session ID
- Sort by any column (default: newest first)
- Virtual scrolling (react-window) for 1000+ traces
- Rows with cost > threshold show ⚠️ indicator
- Click row → navigate to Trace Detail

**Empty State:** "No traces recorded yet" when the database has no traces matching current filters.

**Refresh:** Poll API every 5s for trace list.

### View 3: Trace Detail

**Layout:** Full-width replacement view (not modal, not drawer). Breadcrumb back-nav to Trace List.

**Components:**
1. **Summary Card:** Session ID, Agent, Model, Duration, Total Cost, Status, Started timestamp (absolute), Ended timestamp (absolute)
2. **Waterfall Timeline:**
   - Left column: span tree (indented), with icons by kind (🧠 LLM / 🔧 Tool / 🤖 Sub-agent)
   - Right column: horizontal bars positioned by time, colored by kind
   - Click span to expand inline: input/output preview (200 chars, "show full" toggle), tokens, cost, error
3. **Span count** and **total cost** in header

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/traces` | List traces. Query: `status`, `agent`, `model`, `since`, `until`, `minCost`, `search`, `limit`, `offset` |
| GET | `/api/traces/:id` | Get single trace with all spans |
| GET | `/api/stats` | Aggregated analytics: cost/tokens/errors by agent, model, day. Query: `since`, `until` |
| POST | `/api/prune` | Manual prune + VACUUM. Returns new DB size |
| GET | `/api/health` | DB size, trace count, oldest/newest trace, retention config |

All endpoints read-only except prune. No auth (localhost only).

---

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Plugin runtime | OpenClaw plugin SDK | Native hooks + diagnostic events |
| SQLite driver | better-sqlite3 | Synchronous, no async overhead, WAL-compatible |
| API server | Express | Team knows it, minimal setup |
| Frontend | React + Vite | Consistent with Agora/MC stack |
| Charts | Recharts | Lightweight, good defaults |
| Tables | TanStack Table | Sorting, filtering, pagination |
| Virtual scroll | react-window | Handle 1000+ trace rows |
| Styling | Tailwind CSS | Fast dev, dev-tool aesthetic |

---

## Design Guidelines (Elena's "Clarity Over Chrome")

- **Light mode default**, dark mode fully supported
- **System font stack** — no custom fonts. Localhost tool = no font loading
- **13px base** font size (dev tool standard), monospace for IDs/JSON/timings
- **Color:** Primary accent #228BE6. Status colors: green (success), red (error), orange (warning/timeout), blue (running)
- **WCAG AA minimum** (4.5:1) on all text
- **Minimal animation:** 100ms hover, 150ms expand, skeleton loading states
- **`prefers-reduced-motion`** respected on all animations
- **Keyboard:** `/` to search, `j/k` navigate list, `Enter` to open, `Esc` to go back, `d` to toggle dark mode
- **Loading States:** Skeleton rows for trace list, skeleton cards for metric cards, spinner for waterfall timeline
- **Empty States:** Each view has a defined empty state (see view specs above)
- **Cost Alert Styling:** ⚠️ indicator uses orange background (#E8590C) with dark text — not just emoji (emoji rendering varies by OS)

---

## Implementation Tasks

1. **Plugin: SQLite schema + writer module** — Create DB, tables, indexes. Implement buffered write queue with batch flush. Config handling (env vars). _(1 day)_

2. **Plugin: Hook registration + event capture** — Register all plugin hooks and diagnostic event listeners. Map events to trace/span records. Handle sub-agent inference from tool call names. _(1 day)_

3. **Dashboard: API server + endpoints** — Express server with 5 endpoints. SQLite read queries. Prune endpoint. Health endpoint. Static file serving. _(1 day)_

4. **Dashboard: Trace List view** — Data table with TanStack Table, filter pills, virtual scrolling, cost threshold indicators. _(1.5 days)_

5. **Dashboard: Trace Detail view** — Summary card + waterfall timeline component. Span expand/collapse with input/output preview. _(1.5 days)_

6. **Dashboard: Overview/Analytics view** — 4 metric cards + 5 charts with Recharts. Polling refresh. _(1 day)_

7. **Integration: Data retention + startup** — Prune-on-startup, hourly prune, manual prune button, port fallback, browser auto-open. _(0.5 day)_

**Total: ~7.5 days** (aligns with Delores's 6-8 day estimate)

---

## Out of Scope (v1)

- Real-time WebSocket streaming
- Alerting / notifications / webhooks
- Cost forecasting or budgets
- Multi-machine / remote access
- Dashboard auth
- Custom dashboard layouts / widget customization
- Saved filter presets
- Export (CSV, JSON)
- Full OpenTelemetry compatibility
- Mobile responsive design (laptop minimum)
- Comparison views (session A vs session B)
- Per-agent custom dashboards
- Log aggregation (stdout/stderr capture)

These are all Phase Never unless a real user asks for them.

## DO NOT DO THIS

- **Do not add OpenTelemetry SDK.** We are not building a generic tracing platform.
- **Do not add WebSocket streaming.** Polling is fine for localhost.
- **Do not add auth.** It's localhost:19100. If someone has access to your machine, they have bigger problems.
- **Do not normalize the schema beyond two tables.** JSON columns handle the complexity.
- **Do not add a connection pool for SQLite.** It's embedded. One connection is correct.
- **Do not store unlimited payloads.** 10KB default cap on input/output JSON. The DB will balloon otherwise.
- **Do not add SSR.** This is a local SPA, not a public website.
- **Do not build "Phase 2" features.** If it's not in this spec, it doesn't exist.

---

## Configuration Reference

| Env Var | Default | Description |
|---------|---------|-------------|
| `OPENCLAW_OBS_DB_PATH` | `~/.openclaw/observability/traces.db` | SQLite database location |
| `OPENCLAW_OBS_RETENTION_DAYS` | `7` | Auto-prune traces older than N days |
| `OPENCLAW_OBS_MAX_DB_MB` | (unlimited) | Max DB size; prunes oldest when exceeded |
| `OPENCLAW_OBS_MAX_PAYLOAD_KB` | `10` | Max size for input/output JSON per span (0 = unlimited) |
| `OPENCLAW_OBS_COST_ALERT_USD` | `5` | Cost threshold for ⚠️ indicator on trace list |
| `OPENCLAW_OBS_PORT` | `19100` | Dashboard port (falls back to 19101-19109) |
| `OPENCLAW_OBS_POLL_TRACES_MS` | `5000` | Trace list poll interval |
| `OPENCLAW_OBS_POLL_STATS_MS` | `30000` | Analytics poll interval |

---

## Failure Modes

| Failure | Handling |
|---------|----------|
| SQLite locked (>5s) | Log warning to stderr, drop the span. Never block the agent. |
| Disk full | Catch error, disable tracing gracefully, log warning. |
| Port 19100 in use | Try 19101-19109, pick first available. |
| Corrupt SQLite | `PRAGMA integrity_check` on startup. Fail = rename to `.bak`, start fresh. |
| Plugin crash | Catch all exceptions in hook handlers. Log to stderr. Never crash the observed system. |

---

*Spec author: Max (Product Analyst) | 2026-03-06*
*Inputs: Rex (Architecture), Delores (Feasibility), Elena (Design), Grace (Direction)*
*Status: v1.1 — Elena UI/UX amendments incorporated. Pending Grace approval for implementation handoff. Marie/Dorothy input welcome as further amendments.*
