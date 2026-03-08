import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  ".openclaw",
  "observability",
  "traces.db",
);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT DEFAULT 'running',
  parent_trace_id TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS spans (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES traces(id),
  parent_span_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  input_json TEXT,
  output_json TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  model TEXT,
  error TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES traces(id),
  role TEXT NOT NULL,
  content TEXT,
  tool_name TEXT,
  timestamp INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_kind ON spans(kind);
CREATE INDEX IF NOT EXISTS idx_traces_agent ON traces(agent_name);
CREATE INDEX IF NOT EXISTS idx_traces_started ON traces(started_at);
CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_trace ON messages(trace_id);
`;

const MIGRATIONS = [
  // Add parent_trace_id to traces if missing
  `ALTER TABLE traces ADD COLUMN parent_trace_id TEXT`,
  // Create messages table if missing (for existing DBs)
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL REFERENCES traces(id),
    role TEXT NOT NULL,
    content TEXT,
    tool_name TEXT,
    timestamp INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    metadata TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_trace ON messages(trace_id)`,
];

export interface TraceRow {
  id: string;
  session_id: string;
  agent_name: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  parent_trace_id: string | null;
  metadata: string | null;
}

export interface MessageRow {
  id: string;
  trace_id: string;
  role: string;
  content: string | null;
  tool_name: string | null;
  timestamp: number;
  sequence: number;
  metadata: string | null;
}

export interface SpanRow {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  kind: string;
  name: string;
  started_at: number;
  ended_at: number | null;
  input_json: string | null;
  output_json: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  model: string | null;
  error: string | null;
  metadata: string | null;
}

function getDbPath(): string {
  return process.env.OPENCLAW_OBS_DB_PATH || DEFAULT_DB_PATH;
}

function getMaxPayloadBytes(): number {
  const kb = parseInt(process.env.OPENCLAW_OBS_MAX_PAYLOAD_KB || "10", 10);
  if (kb === 0) return Infinity;
  return kb * 1024;
}

function getRetentionDays(): number {
  return parseInt(process.env.OPENCLAW_OBS_RETENTION_DAYS || "7", 10);
}

export function truncatePayload(
  json: string | null | undefined,
): string | null {
  if (json == null) return null;
  const max = getMaxPayloadBytes();
  if (max === Infinity) return json;
  if (Buffer.byteLength(json, "utf-8") > max) {
    // Truncate by slicing bytes, then find valid UTF-8 boundary
    const buf = Buffer.from(json, "utf-8");
    const truncated = buf.subarray(0, max).toString("utf-8");
    return truncated + "...[truncated]";
  }
  return json;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  // Integrity check
  const check = db.pragma("integrity_check") as Array<{
    integrity_check: string;
  }>;
  if (check[0]?.integrity_check !== "ok") {
    const bakPath = dbPath + ".bak";
    db.close();
    db = null;
    fs.renameSync(dbPath, bakPath);
    console.error(
      `[openclaw-obs] DB corrupt, renamed to ${bakPath}, starting fresh`,
    );
    return getDb();
  }

  db.exec(SCHEMA);

  // Run migrations for existing DBs
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // Ignore errors (e.g., column already exists)
    }
  }

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ---- Write operations ----

export function upsertTrace(trace: Omit<TraceRow, "metadata" | "parent_trace_id"> & { metadata?: Record<string, unknown> | null; parent_trace_id?: string | null }): void {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO traces (id, session_id, agent_name, started_at, ended_at, status, parent_trace_id, metadata)
    VALUES (@id, @session_id, @agent_name, @started_at, @ended_at, @status, @parent_trace_id, @metadata)
    ON CONFLICT(id) DO UPDATE SET
      ended_at = COALESCE(@ended_at, traces.ended_at),
      status = COALESCE(@status, traces.status),
      parent_trace_id = COALESCE(@parent_trace_id, traces.parent_trace_id),
      metadata = COALESCE(@metadata, traces.metadata)
  `);
  stmt.run({
    ...trace,
    ended_at: trace.ended_at ?? null,
    parent_trace_id: trace.parent_trace_id ?? null,
    metadata: trace.metadata ? JSON.stringify(trace.metadata) : null,
  });
}

const MAX_MESSAGE_CONTENT_BYTES = 100 * 1024; // 100KB

function truncateMessageContent(content: string | null | undefined): string | null {
  if (content == null) return null;
  if (Buffer.byteLength(content, "utf-8") > MAX_MESSAGE_CONTENT_BYTES) {
    const buf = Buffer.from(content, "utf-8");
    return buf.subarray(0, MAX_MESSAGE_CONTENT_BYTES).toString("utf-8") + "\n[truncated]";
  }
  return content;
}

export function insertMessage(msg: MessageRow): void {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR IGNORE INTO messages (id, trace_id, role, content, tool_name, timestamp, sequence, metadata)
    VALUES (@id, @trace_id, @role, @content, @tool_name, @timestamp, @sequence, @metadata)
  `);
  stmt.run({
    ...msg,
    content: truncateMessageContent(msg.content),
    tool_name: msg.tool_name ?? null,
    metadata: msg.metadata ?? null,
  });
}

export function getMessages(traceId: string): MessageRow[] {
  const d = getDb();
  return d
    .prepare("SELECT * FROM messages WHERE trace_id = @traceId ORDER BY sequence ASC, timestamp ASC")
    .all({ traceId }) as MessageRow[];
}

export function insertSpan(span: Omit<SpanRow, "input_json" | "output_json"> & { input_json?: string | null; output_json?: string | null }): void {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO spans (id, trace_id, parent_span_id, kind, name, started_at, ended_at,
      input_json, output_json, tokens_in, tokens_out, cost_usd, model, error, metadata)
    VALUES (@id, @trace_id, @parent_span_id, @kind, @name, @started_at, @ended_at,
      @input_json, @output_json, @tokens_in, @tokens_out, @cost_usd, @model, @error, @metadata)
  `);
  stmt.run({
    ...span,
    parent_span_id: span.parent_span_id ?? null,
    ended_at: span.ended_at ?? null,
    input_json: truncatePayload(span.input_json ?? null),
    output_json: truncatePayload(span.output_json ?? null),
    tokens_in: span.tokens_in ?? null,
    tokens_out: span.tokens_out ?? null,
    cost_usd: span.cost_usd ?? null,
    model: span.model ?? null,
    error: span.error ?? null,
    metadata: span.metadata ?? null,
  });
}

export function updateSpan(id: string, updates: Partial<SpanRow>): void {
  const d = getDb();
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, val] of Object.entries(updates)) {
    if (key === "id") continue;
    const dbVal =
      key === "input_json" || key === "output_json"
        ? truncatePayload(val as string | null)
        : val;
    fields.push(`${key} = @${key}`);
    values[key] = dbVal ?? null;
  }

  if (fields.length === 0) return;
  d.prepare(`UPDATE spans SET ${fields.join(", ")} WHERE id = @id`).run(values);
}

export function updateTrace(id: string, updates: Partial<TraceRow>): void {
  const d = getDb();
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, val] of Object.entries(updates)) {
    if (key === "id") continue;
    fields.push(`${key} = @${key}`);
    values[key] = val ?? null;
  }

  if (fields.length === 0) return;
  d.prepare(`UPDATE traces SET ${fields.join(", ")} WHERE id = @id`).run(
    values,
  );
}

// ---- Read operations (for API) ----

export interface TraceListParams {
  status?: string;
  agent?: string;
  model?: string;
  since?: number;
  until?: number;
  minCost?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

export function listTraces(params: TraceListParams): TraceRow[] {
  const d = getDb();
  const conditions: string[] = [];
  const values: Record<string, unknown> = {};

  if (params.status) {
    conditions.push("t.status = @status");
    values.status = params.status;
  }
  if (params.agent) {
    conditions.push("t.agent_name = @agent");
    values.agent = params.agent;
  }
  if (params.since) {
    conditions.push("t.started_at >= @since");
    values.since = params.since;
  }
  if (params.until) {
    conditions.push("t.started_at <= @until");
    values.until = params.until;
  }
  if (params.search) {
    conditions.push("t.session_id LIKE @search");
    values.search = `%${params.search}%`;
  }
  if (params.model) {
    conditions.push(
      "EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = t.id AND s.model = @model)",
    );
    values.model = params.model;
  }
  if (params.minCost) {
    conditions.push(
      "(SELECT COALESCE(SUM(s.cost_usd), 0) FROM spans s WHERE s.trace_id = t.id) >= @minCost",
    );
    values.minCost = params.minCost;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit || 100;
  const offset = params.offset || 0;

  return d
    .prepare(
      `SELECT t.*,
        (SELECT GROUP_CONCAT(DISTINCT s.model) FROM spans s WHERE s.trace_id = t.id AND s.model IS NOT NULL) AS models,
        (SELECT COALESCE(SUM(s.tokens_in), 0) FROM spans s WHERE s.trace_id = t.id) AS total_tokens_in,
        (SELECT COALESCE(SUM(s.tokens_out), 0) FROM spans s WHERE s.trace_id = t.id) AS total_tokens_out,
        (SELECT COALESCE(SUM(s.cost_usd), 0) FROM spans s WHERE s.trace_id = t.id) AS total_cost
      FROM traces t ${where} ORDER BY t.started_at DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...values, limit, offset }) as TraceRow[];
}

export function getTrace(id: string): (TraceRow & { spans: SpanRow[]; messages: MessageRow[]; children: Array<{ id: string; agent_name: string; started_at: number; status: string }> }) | null {
  const d = getDb();
  const trace = d
    .prepare("SELECT * FROM traces WHERE id = @id")
    .get({ id }) as TraceRow | undefined;
  if (!trace) return null;
  const spans = d
    .prepare("SELECT * FROM spans WHERE trace_id = @id ORDER BY started_at ASC")
    .all({ id }) as SpanRow[];
  const messages = d
    .prepare("SELECT * FROM messages WHERE trace_id = @id ORDER BY sequence ASC, timestamp ASC")
    .all({ id }) as MessageRow[];
  const children = d
    .prepare("SELECT id, agent_name, started_at, status FROM traces WHERE parent_trace_id = @id ORDER BY started_at ASC")
    .all({ id }) as Array<{ id: string; agent_name: string; started_at: number; status: string }>;
  return { ...trace, spans, messages, children };
}

export interface StatsParams {
  since?: number;
  until?: number;
}

export function getStats(params: StatsParams) {
  const d = getDb();
  const conditions: string[] = [];
  const values: Record<string, unknown> = {};

  if (params.since) {
    conditions.push("t.started_at >= @since");
    values.since = params.since;
  }
  if (params.until) {
    conditions.push("t.started_at <= @until");
    values.until = params.until;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const summary = d
    .prepare(
      `SELECT
        COUNT(*) as trace_count,
        COALESCE(SUM(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END), 0) as error_count,
        COALESCE(AVG(t.ended_at - t.started_at), 0) as avg_duration_ms
      FROM traces t ${where}`,
    )
    .get(values) as { trace_count: number; error_count: number; avg_duration_ms: number };

  const totalCost = d
    .prepare(
      `SELECT COALESCE(SUM(s.cost_usd), 0) as total_cost
      FROM spans s
      JOIN traces t ON s.trace_id = t.id
      ${where}`,
    )
    .get(values) as { total_cost: number };

  const costByAgent = d
    .prepare(
      `SELECT t.agent_name, COALESCE(SUM(s.cost_usd), 0) as cost
      FROM traces t
      LEFT JOIN spans s ON s.trace_id = t.id
      ${where}
      GROUP BY t.agent_name
      ORDER BY cost DESC`,
    )
    .all(values) as Array<{ agent_name: string; cost: number }>;

  const costByDay = d
    .prepare(
      `SELECT
        date(t.started_at / 1000, 'unixepoch') as day,
        COALESCE(SUM(s.cost_usd), 0) as cost,
        COALESCE(SUM(s.tokens_in), 0) as tokens_in,
        COALESCE(SUM(s.tokens_out), 0) as tokens_out,
        COUNT(DISTINCT t.id) as trace_count,
        SUM(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END) as error_count
      FROM traces t
      LEFT JOIN spans s ON s.trace_id = t.id
      ${where}
      GROUP BY day
      ORDER BY day ASC`,
    )
    .all(values) as Array<{
    day: string;
    cost: number;
    tokens_in: number;
    tokens_out: number;
    trace_count: number;
    error_count: number;
  }>;

  const modelWhere = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")} AND s.model IS NOT NULL`
    : "WHERE s.model IS NOT NULL";

  const modelBreakdown = d
    .prepare(
      `SELECT
        s.model,
        COUNT(*) as call_count,
        COALESCE(SUM(s.tokens_in), 0) as total_tokens_in,
        COALESCE(SUM(s.tokens_out), 0) as total_tokens_out,
        COALESCE(SUM(s.cost_usd), 0) as total_cost
      FROM spans s
      JOIN traces t ON s.trace_id = t.id
      ${modelWhere}
      GROUP BY s.model
      ORDER BY total_cost DESC`,
    )
    .all(values) as Array<{
    model: string;
    call_count: number;
    total_tokens_in: number;
    total_tokens_out: number;
    total_cost: number;
  }>;

  return {
    ...summary,
    total_cost: totalCost.total_cost,
    cost_by_agent: costByAgent,
    cost_by_day: costByDay,
    model_breakdown: modelBreakdown,
  };
}

export function getHealth() {
  const d = getDb();
  const dbPath = getDbPath();

  let dbSizeBytes = 0;
  try {
    dbSizeBytes = fs.statSync(dbPath).size;
  } catch {
    // DB might not exist yet
  }

  const counts = d
    .prepare(
      "SELECT COUNT(*) as trace_count, MIN(started_at) as oldest, MAX(started_at) as newest FROM traces",
    )
    .get() as { trace_count: number; oldest: number | null; newest: number | null };

  return {
    db_size_bytes: dbSizeBytes,
    trace_count: counts.trace_count,
    oldest_trace: counts.oldest,
    newest_trace: counts.newest,
    retention_days: getRetentionDays(),
  };
}

// ---- Retention / Pruning ----

export function pruneOldTraces(): number {
  const d = getDb();
  const cutoff = Date.now() - getRetentionDays() * 24 * 60 * 60 * 1000;

  d.prepare("DELETE FROM messages WHERE trace_id IN (SELECT id FROM traces WHERE started_at < @cutoff)").run({ cutoff });
  d.prepare("DELETE FROM spans WHERE trace_id IN (SELECT id FROM traces WHERE started_at < @cutoff)").run({ cutoff });
  const result = d.prepare("DELETE FROM traces WHERE started_at < @cutoff").run({ cutoff });
  return result.changes;
}

export function pruneBySize(): number {
  const maxMb = parseInt(process.env.OPENCLAW_OBS_MAX_DB_MB || "0", 10);
  if (!maxMb) return 0;

  const dbPath = getDbPath();
  let totalDeleted = 0;
  const d = getDb();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(dbPath).size;
    } catch {
      break;
    }
    if (sizeBytes <= maxMb * 1024 * 1024) break;

    const oldest = d
      .prepare("SELECT id FROM traces ORDER BY started_at ASC LIMIT 10")
      .all() as Array<{ id: string }>;
    if (oldest.length === 0) break;

    const ids = oldest.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    d.prepare(`DELETE FROM messages WHERE trace_id IN (${placeholders})`).run(ids);
    d.prepare(`DELETE FROM spans WHERE trace_id IN (${placeholders})`).run(ids);
    const result = d
      .prepare(`DELETE FROM traces WHERE id IN (${placeholders})`)
      .run(ids);
    totalDeleted += result.changes;
  }

  return totalDeleted;
}

export function vacuum(): void {
  getDb().exec("VACUUM");
}

export function pruneAll(): { deleted: number; dbSizeBytes: number } {
  const deleted = pruneOldTraces() + pruneBySize();
  vacuum();
  const dbPath = getDbPath();
  let dbSizeBytes = 0;
  try {
    dbSizeBytes = fs.statSync(dbPath).size;
  } catch {
    // ignore
  }
  return { deleted, dbSizeBytes };
}
