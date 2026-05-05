-- 067_drop_notifications_read_column.sql
-- Per-user read state lives in notification_reads (user_id,
-- notification_id, read_at). The global notifications.read boolean is
-- vestigial — drop it. Anything currently using it falls back to
-- notification_reads.read_at IS NOT NULL.

BEGIN;

ALTER TABLE notifications DROP COLUMN IF EXISTS read;

COMMIT;
