// Plugin storage: the SQLite schema and every query against it — usage
// events (cost tracking), session transcript events, and prompt versions.
// Handlers and the CLI call these; nothing here touches bb beyond the db.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type Db = ReturnType<BbPluginApi["storage"]["database"]>;

/** Migrations are index-recorded: always append, never insert or reorder. */
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_text INTEGER NOT NULL DEFAULT 0,
      input_audio INTEGER NOT NULL DEFAULT 0,
      cached_text INTEGER NOT NULL DEFAULT 0,
      cached_audio INTEGER NOT NULL DEFAULT 0,
      output_text INTEGER NOT NULL DEFAULT 0,
      output_audio INTEGER NOT NULL DEFAULT 0
    )`,
  `ALTER TABLE usage_events ADD COLUMN session_id TEXT`,
  `CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    )`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events (session_id, ts)`,
  `CREATE TABLE IF NOT EXISTS prompt_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      note TEXT,
      content TEXT NOT NULL
    )`,
  `ALTER TABLE usage_events ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 0`,
];

// USD per 1M tokens for the gpt-realtime family (openai.com/api/pricing,
// checked 2026-02). Cached input (text or audio) is a flat $0.40.
export const RATES = {
  textIn: 4,
  audioIn: 32,
  cachedIn: 0.4,
  textOut: 16,
  audioOut: 64,
  // GPT-Live bills the voice frontend per minute (billed per second), not per
  // token. Backend (Responses) usage is billed separately by OpenAI and is not
  // tracked here.
  liveMinute: 0.05,
};

export interface UsageRow {
  ts: number;
  model: string;
  input_text: number;
  input_audio: number;
  cached_text: number;
  cached_audio: number;
  output_text: number;
  output_audio: number;
  /** GPT-Live voice duration in seconds (cumulative snapshot); 0 for realtime rows. */
  duration_seconds: number;
}

/** Estimated USD cost of one usage row at current RATES. */
export function costUsd(row: UsageRow): number {
  const uncachedText = Math.max(0, row.input_text - row.cached_text);
  const uncachedAudio = Math.max(0, row.input_audio - row.cached_audio);
  return (
    (uncachedText * RATES.textIn +
      uncachedAudio * RATES.audioIn +
      (row.cached_text + row.cached_audio) * RATES.cachedIn +
      row.output_text * RATES.textOut +
      row.output_audio * RATES.audioOut) /
      1_000_000 +
    ((row.duration_seconds ?? 0) / 60) * RATES.liveMinute
  );
}

/** All usage rows since `since` (epoch ms), oldest first. */
export function usageEventsSince(db: Db, since: number): UsageRow[] {
  return db.prepare("SELECT * FROM usage_events WHERE ts >= ? ORDER BY ts").all(since) as UsageRow[];
}

/**
 * Record one usage report. GPT-Live duration snapshots are CUMULATIVE seconds,
 * so one row per session and the largest snapshot wins — never sum snapshots.
 * Token reports (realtime response.done) append a row each.
 */
export function recordUsageEvent(
  db: Db,
  input: { model: string | null; sessionId: string | null; usage: Record<string, unknown> },
  configuredModel: string,
): void {
  const { model, sessionId, usage } = input;
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const seconds = num(usage.seconds);
  if (seconds > 0 && sessionId) {
    const existing = db
      .prepare("SELECT id, duration_seconds FROM usage_events WHERE session_id = ? AND duration_seconds > 0")
      .get(sessionId) as { id: number; duration_seconds: number } | undefined;
    if (existing) {
      db.prepare("UPDATE usage_events SET ts = ?, duration_seconds = ? WHERE id = ?").run(
        Date.now(),
        Math.max(existing.duration_seconds, seconds),
        existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO usage_events (ts, model, session_id, duration_seconds) VALUES (?, ?, ?, ?)`,
      ).run(Date.now(), model ?? configuredModel, sessionId, seconds);
    }
    return;
  }
  const inDetails = (usage.input_token_details ?? {}) as Record<string, unknown>;
  const outDetails = (usage.output_token_details ?? {}) as Record<string, unknown>;
  const cachedDetails = (inDetails.cached_tokens_details ?? {}) as Record<string, unknown>;
  db.prepare(
    `INSERT INTO usage_events (ts, model, session_id, input_text, input_audio, cached_text, cached_audio, output_text, output_audio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(),
    model ?? configuredModel,
    sessionId,
    num(inDetails.text_tokens),
    num(inDetails.audio_tokens),
    num(cachedDetails.text_tokens),
    num(cachedDetails.audio_tokens),
    num(outDetails.text_tokens),
    num(outDetails.audio_tokens),
  );
}

/** Append one event to a session's transcript log; returns its row id. */
export function insertSessionEvent(
  db: Db,
  sessionId: string,
  kind: string,
  payload: Record<string, unknown>,
  ts = Date.now(),
): number {
  const result = db
    .prepare("INSERT INTO session_events (session_id, ts, kind, payload) VALUES (?, ?, ?, ?)")
    .run(sessionId, ts, kind, JSON.stringify(payload));
  return Number(result.lastInsertRowid);
}

/** Full event log for one session, oldest first. */
export function sessionEvents(db: Db, sessionId: string) {
  return db
    .prepare("SELECT id, ts, kind, payload FROM session_events WHERE session_id = ? ORDER BY ts, id")
    .all(sessionId) as { id: number; ts: number; kind: string; payload: string }[];
}

/**
 * Page through grouped sessions newest-first. Fetches one extra row past the
 * page to tell the client whether a "Load more" is worthwhile, then drops it.
 */
export function listSessions(db: Db, offset: number) {
  const pageSize = 30;
  const rows = db
    .prepare(
      `SELECT session_id AS id, MIN(ts) AS startedAt, MAX(ts) AS lastEventAt, COUNT(*) AS events,
              SUM(CASE WHEN kind = 'session.stopped' THEN 1 ELSE 0 END) AS stopped
       FROM session_events GROUP BY session_id ORDER BY startedAt DESC LIMIT ? OFFSET ?`,
    )
    .all(pageSize + 1, offset) as { id: string; startedAt: number; lastEventAt: number; events: number; stopped: number }[];
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const costStmt = db.prepare("SELECT * FROM usage_events WHERE session_id = ?");
  // First thing the user said, as a scannable preview; fall back to Aide's
  // opening line so a row is never blank.
  const previewStmt = db.prepare(
    "SELECT payload FROM session_events WHERE session_id = ? AND kind IN ('user', 'assistant') ORDER BY (kind = 'assistant'), ts, id LIMIT 1",
  );
  const errorStmt = db.prepare(
    `SELECT 1 FROM session_events WHERE session_id = ? AND (
      kind = 'error' OR (kind = 'tool.result' AND (
        json_extract(payload, '$.status') = 'error' OR
        (json_extract(payload, '$.status') IS NULL AND (
          json_extract(payload, '$.output') LIKE 'Tool error%' OR
          json_extract(payload, '$.output') LIKE 'Error:%'
        ))
      ))
    ) LIMIT 1`,
  );
  const deviceStmt = db.prepare(
    "SELECT payload FROM session_events WHERE session_id = ? AND kind = 'session.started' ORDER BY ts LIMIT 1",
  );
  const device = (sessionId: string) => {
    const found = deviceStmt.get(sessionId) as { payload: string } | undefined;
    if (!found) return null;
    try {
      const d = (JSON.parse(found.payload) as { device?: unknown }).device;
      if (!d || typeof d !== "object") return null;
      const o = d as Record<string, unknown>;
      return {
        label: String(o.label ?? ""),
        mobile: Boolean(o.mobile),
        platform: String(o.platform ?? ""),
        browser: String(o.browser ?? ""),
        runtime: String(o.runtime ?? ""),
      };
    } catch {
      return null;
    }
  };
  const preview = (sessionId: string): string => {
    const found = previewStmt.get(sessionId) as { payload: string } | undefined;
    if (!found) return "";
    try {
      const text = (JSON.parse(found.payload) as { text?: unknown }).text;
      return typeof text === "string" ? text.slice(0, 140) : "";
    } catch {
      return "";
    }
  };
  return {
    hasMore,
    sessions: page.map((row) => ({
      id: row.id,
      startedAt: row.startedAt,
      lastEventAt: row.lastEventAt,
      events: row.events,
      // Ended if it logged session.stopped, OR it went quiet long ago: a
      // call that dies uncleanly (page unload, torn-down WebRTC on
      // navigation, app killed on mobile) never logs session.stopped, so
      // without this stale check every crashed session shows "live" forever.
      // The active window overrides this to keep a genuinely live call live.
      ended: row.stopped > 0 || Date.now() - row.lastEventAt > 300_000,
      costUsd: Number(
        (costStmt.all(row.id) as UsageRow[]).reduce((sum, usage) => sum + costUsd(usage), 0).toFixed(4),
      ),
      preview: preview(row.id),
      hasError: errorStmt.get(row.id) !== undefined,
      device: device(row.id),
    })),
  };
}

/** The active prompt body: newest saved version, else the given default. */
export function activePrompt(db: Db, defaultPrompt: string): string {
  const row = db.prepare("SELECT content FROM prompt_versions ORDER BY id DESC LIMIT 1").get() as
    | { content: string }
    | undefined;
  return row?.content ?? defaultPrompt;
}

/** Save a new prompt version (becomes active for the next session). */
export function insertPromptVersion(
  db: Db,
  content: string,
  source: "user" | "agent",
  note: string | null,
): void {
  db.prepare("INSERT INTO prompt_versions (ts, source, note, content) VALUES (?, ?, ?, ?)").run(
    Date.now(),
    source,
    note,
    content,
  );
}

/** The 50 newest prompt versions, for the settings history view. */
export function promptVersions(db: Db) {
  return db
    .prepare("SELECT id, ts, source, note, content FROM prompt_versions ORDER BY id DESC LIMIT 50")
    .all() as { id: number; ts: number; source: string; note: string | null; content: string }[];
}
