-- Sprint: Stock write-offs (Level 1)
-- Append-only record of inventory write-offs (брак) for НАП tax compliance.
-- Every write-off is immutable after INSERT — revoke UPDATE + DELETE at the
-- table level so even a compromised app role cannot quietly tamper with an
-- existing write-off record.

BEGIN;

CREATE TABLE IF NOT EXISTS stock_writeoffs (
  id                SERIAL PRIMARY KEY,
  document_number   VARCHAR(64) NOT NULL UNIQUE,   -- e.g. "БРАК-2026-0001"
  product_id        INT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  batch_id          INT REFERENCES batches(id) ON DELETE SET NULL,
  warehouse_id      INT NOT NULL REFERENCES warehouses(id) DEFAULT 1,
  quantity          NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit_cost         NUMERIC(10,2) NOT NULL CHECK (unit_cost >= 0),
  total_cost        NUMERIC(12,2) NOT NULL CHECK (total_cost >= 0),
  reason            VARCHAR(32) NOT NULL CHECK (reason IN
                      ('expired','damaged','theft','count_correction','recall','other')),
  notes             TEXT,
  pdf_path          TEXT,                   -- populated by Level 3
  written_off_by    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  written_off_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_writeoffs_product ON stock_writeoffs(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_writeoffs_batch ON stock_writeoffs(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_writeoffs_date ON stock_writeoffs(written_off_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_writeoffs_reason ON stock_writeoffs(reason);

-- Document number generation sequence (shared across all years — the
-- document_number field embeds the year, so a single monotonic sequence
-- guarantees uniqueness without per-year sequence drift).
CREATE SEQUENCE IF NOT EXISTS stock_writeoff_doc_seq MINVALUE 1 START 1;

-- Append-only — НАП requires immutable write-off records.
REVOKE UPDATE, DELETE ON stock_writeoffs FROM PUBLIC;
GRANT SELECT, INSERT ON stock_writeoffs TO PUBLIC;

COMMIT;
