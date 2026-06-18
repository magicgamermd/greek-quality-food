-- 080_assistant_telemetry.sql
-- Observability for the voice assistant. Records every LLM call, tool
-- invocation and intent execution so we can audit cost, debug
-- regressions, and identify which flows are slow or failing.
-- No data is mutated based on these rows — they are write-only logs.

CREATE TABLE IF NOT EXISTS assistant_telemetry (
  id            BIGSERIAL PRIMARY KEY,
  -- Who made the call. Nullable for system events that lack auth context.
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  -- LLM session id (in-memory by default, opaque string).
  session_id    VARCHAR(64),
  -- One of: 'converse', 'tool', 'action'. Defines which other columns
  -- are meaningful for the row.
  event_type    VARCHAR(20) NOT NULL
                CHECK (event_type IN ('converse', 'tool', 'action')),
  -- For event_type='tool' — LLM tool name (e.g. 'search_products').
  -- For event_type='action' — intent name (e.g. 'order.create').
  -- Null for the wrapping 'converse' rows.
  name          VARCHAR(80),
  latency_ms    INTEGER,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  success       BOOLEAN NOT NULL DEFAULT TRUE,
  -- HTTP status code or short app-level error tag.
  error_code    VARCHAR(40),
  error_detail  TEXT,
  -- Free-form payload: tool args, response shape, anything useful for
  -- debugging without ballooning the row. Trim sensitive fields here.
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Common query: "how often does tool X run / fail in the last 7 days".
CREATE INDEX IF NOT EXISTS idx_assistant_telemetry_event_name
  ON assistant_telemetry (event_type, name, created_at DESC);

-- Per-user usage and cost queries.
CREATE INDEX IF NOT EXISTS idx_assistant_telemetry_user_created
  ON assistant_telemetry (user_id, created_at DESC);

-- Filter by session when diagnosing a specific conversation.
CREATE INDEX IF NOT EXISTS idx_assistant_telemetry_session
  ON assistant_telemetry (session_id, created_at);

COMMENT ON TABLE assistant_telemetry IS
  'Write-only observability log for the voice assistant. Each row is one LLM call, one tool invocation, or one intent execution.';
