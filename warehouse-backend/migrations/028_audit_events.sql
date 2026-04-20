-- Sprint 2-3: Audit log table
-- Append-only event log of changes to business entities.
-- users.id is UUID in this schema, so actor_user_id is UUID.

CREATE TABLE IF NOT EXISTS audit_events (
  id            BIGSERIAL PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email   TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     BIGINT,
  diff          JSONB,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_events(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);

-- Append-only: revoke UPDATE and DELETE from PUBLIC.
-- Application role should also not receive UPDATE/DELETE on this table.
REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;
