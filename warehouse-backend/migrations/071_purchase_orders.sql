-- Migration 071: Purchase Orders (Заявки) — supplier-side procurement
--
-- Workflow: warehouse staff drafts an order against a single supplier with
-- a list of products + quantities, exports a PDF (with prominent SKU column
-- so Chinese suppliers can match on code), marks it sent. When goods arrive,
-- one click converts the order into an `incoming_goods` receipt that the
-- existing receipt-pipeline picks up — keeping stock in sync without
-- duplicate data entry.
--
-- No prices, no currency — supplier-side cost is negotiated separately and
-- captured later in the receipt. The `Заявки` module is purely a planning
-- and document-generation tool.

CREATE TABLE purchase_orders (
    id                      SERIAL PRIMARY KEY,
    supplier_id             INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    status                  VARCHAR(20) NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'sent', 'received')),
    notes                   TEXT,
    expected_delivery_date  DATE,
    sent_at                 TIMESTAMPTZ,
    received_at             TIMESTAMPTZ,
    incoming_goods_id       INTEGER REFERENCES incoming_goods(id) ON DELETE SET NULL,
    created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE purchase_order_items (
    id                  SERIAL PRIMARY KEY,
    purchase_order_id   INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    product_id          INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity            NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_purchase_orders_supplier ON purchase_orders(supplier_id);
CREATE INDEX idx_purchase_orders_status ON purchase_orders(status);
CREATE INDEX idx_purchase_order_items_order ON purchase_order_items(purchase_order_id);
CREATE INDEX idx_purchase_order_items_product ON purchase_order_items(product_id);
