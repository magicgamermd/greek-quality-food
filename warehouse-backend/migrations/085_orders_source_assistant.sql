-- 082_orders_source_assistant.sql
-- Allow source='assistant' on orders, so we can distinguish voice-created
-- orders (Mert-M Telegram / mobile assistant) from cashier-typed ones.
-- The UI uses this to show a 🎤 icon next to the order number in lists.
--
-- Same set of values as before + 'assistant' appended. Drop-and-recreate
-- because PostgreSQL doesn't have ALTER ... DROP/ADD value on CHECK
-- constraints (those exist only on enums; this column is a varchar).

BEGIN;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_source_check
  CHECK (source::text = ANY (ARRAY[
    'manual'::character varying,
    'comarch'::character varying,
    'web'::character varying,
    'assistant'::character varying
  ]::text[]));

COMMIT;
