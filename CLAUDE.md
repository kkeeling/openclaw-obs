# OpenClaw Observability Plugin + Dashboard

## Project Overview
An OpenClaw plugin that captures LLM calls, tool invocations, and session metadata via native plugin hooks and diagnostic events — writing to local SQLite. A React dashboard served from the same process displays traces, sessions, and cost/token analytics.

## Spec
Full spec at `SPEC.md` in this directory. Read it first.

## Key Architecture Decisions
- **Two tables only**: `traces` and `spans` in SQLite
- **WAL mode** + busy_timeout=5000ms
- **better-sqlite3** (synchronous, no async overhead)
- **10KB payload cap** on input_json/output_json at write time (configurable)
- **Buffer + batch flush**: every 100ms or 50 events
- **Express + static SPA**: single process serves API + React frontend
- **Port**: localhost:19100 (fallback 19101-19109)
- **7-day retention** default, configurable
- **No OTEL SDK, no WebSocket, no auth, no SSR**

## OpenClaw Plugin SDK Reference
- Plugin structure: `{ id, name, description, configSchema, register(api) }`
- api.on(hookName, handler) for hooks
- api.registerService({ id, start(ctx), stop(ctx) }) for services
- onDiagnosticEvent(listener) for diagnostic events (import from "openclaw/plugin-sdk")
- Available hooks: session_start, session_end, before_agent_start, agent_end, before_tool_call, after_tool_call, tool_result_persist, message_received, message_sending, message_sent, before_compaction, after_compaction, before_reset, gateway_start, gateway_stop
- Key diagnostic event: model.usage (has sessionKey, model, provider, usage{input,output,cacheRead,cacheWrite}, costUsd, durationMs)
- Reference implementation: ~/openclaw/extensions/diagnostics-otel/ (same pattern, writes to OTEL instead of SQLite)

## Plugin Hook Type Signatures (from plugin SDK)
```typescript
// Hook contexts
type PluginHookAgentContext = { agentId?: string; sessionKey?: string; sessionId?: string; workspaceDir?: string; messageProvider?: string; }
type PluginHookSessionContext = { agentId?: string; sessionId: string; }
type PluginHookToolContext = { agentId?: string; sessionKey?: string; toolName: string; }

// Hook events
type PluginHookSessionStartEvent = { sessionId: string; resumedFrom?: string; }
type PluginHookSessionEndEvent = { sessionId: string; messageCount: number; durationMs?: number; }
type PluginHookBeforeAgentStartEvent = { prompt: string; messages?: unknown[]; }
type PluginHookAgentEndEvent = { messages: unknown[]; success: boolean; error?: string; durationMs?: number; }
type PluginHookBeforeToolCallEvent = { toolName: string; params: Record<string, unknown>; }
type PluginHookAfterToolCallEvent = { toolName: string; params: Record<string, unknown>; result?: unknown; error?: string; durationMs?: number; }

// Diagnostic event
type DiagnosticUsageEvent = { type: "model.usage"; sessionKey?: string; sessionId?: string; channel?: string; provider?: string; model?: string; usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; promptTokens?: number; total?: number; }; context?: { limit?: number; used?: number; }; costUsd?: number; durationMs?: number; }
```

## Tech Stack
- TypeScript (ESM)
- better-sqlite3 for SQLite
- Express for API server
- React + Vite + Tailwind CSS for dashboard
- Recharts for charts
- TanStack Table for data tables
- react-window for virtual scrolling

## Project Structure
```
openclaw-obs/
├── package.json
├── tsconfig.json
├── SPEC.md
├── CLAUDE.md
├── src/
│   ├── plugin/           # OpenClaw plugin (hooks, diagnostics, SQLite writer)
│   │   ├── index.ts      # Plugin entry point
│   │   ├── db.ts         # SQLite schema, writer, queries
│   │   └── buffer.ts     # Event buffer with batch flush
│   ├── server/           # Express API server
│   │   ├── index.ts      # Server setup, static serving, port fallback
│   │   └── routes.ts     # API endpoints
│   └── cli.ts            # CLI entry point (npx openclaw-obs)
├── dashboard/            # React + Vite frontend
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   ├── tailwind.config.js
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       ├── views/
│       │   ├── Overview.tsx
│       │   ├── TraceList.tsx
│       │   └── TraceDetail.tsx
│       ├── components/
│       │   ├── Sidebar.tsx
│       │   ├── MetricCard.tsx
│       │   ├── Waterfall.tsx
│       │   └── FilterPills.tsx
│       └── hooks/
│           └── useApi.ts
└── dist/                 # Built output
```

## Implementation Order
1. Plugin: SQLite schema + writer module (db.ts, buffer.ts)
2. Plugin: Hook registration + event capture (plugin/index.ts)
3. Dashboard: API server + endpoints (server/)
4. Dashboard: Trace List view
5. Dashboard: Trace Detail view with waterfall
6. Dashboard: Overview/Analytics view
7. Integration: Retention, startup, port fallback

## Commands
```bash
npm install          # Install deps
npm run build        # Build plugin + dashboard
npm run dev          # Dev mode (server + vite dev)
npx openclaw-obs     # Start dashboard
```

## Quality Gates
- TypeScript strict mode
- All code must handle errors gracefully (never crash the observed system)
- Payload truncation at 10KB write time
- WAL mode enabled on every DB open
