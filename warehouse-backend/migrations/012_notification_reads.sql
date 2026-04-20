CREATE TABLE IF NOT EXISTS notification_reads (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  notification_id VARCHAR(64) NOT NULL,
  dismissed BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, notification_id)
);
CREATE INDEX IF NOT EXISTS idx_notif_reads_user ON notification_reads(user_id);
