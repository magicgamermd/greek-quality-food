-- Greek Foods Warehouse — Initial Schema
-- All tables as per WAREHOUSE-SPEC.md

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    role            VARCHAR(20) NOT NULL DEFAULT 'readonly'
                    CHECK (role IN ('admin', 'warehouse', 'readonly')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CATEGORIES
-- ============================================================
CREATE TABLE categories (
    id          SERIAL PRIMARY KEY,
    name_bg     VARCHAR(255) NOT NULL,
    name_en     VARCHAR(255) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- PRODUCTS
-- ============================================================
CREATE TABLE products (
    id          SERIAL PRIMARY KEY,
    name_bg     VARCHAR(255) NOT NULL,
    name_en     VARCHAR(255) NOT NULL,
    sku         VARCHAR(50) UNIQUE NOT NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    unit        VARCHAR(20) NOT NULL DEFAULT 'kg',
    description TEXT,
    image_url   TEXT,
    low_stock_threshold NUMERIC(10,2) DEFAULT 10,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_category ON products(category_id);

-- ============================================================
-- WAREHOUSES
-- ============================================================
CREATE TABLE warehouses (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    address     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default warehouse
INSERT INTO warehouses (name, address) VALUES ('Основен склад', 'Sofia, Bulgaria');

-- ============================================================
-- BATCHES
-- ============================================================
CREATE TABLE batches (
    id              SERIAL PRIMARY KEY,
    product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    batch_number    VARCHAR(100) NOT NULL,
    expiry_date     DATE,
    quantity         NUMERIC(12,3) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_batches_product ON batches(product_id);
CREATE INDEX idx_batches_expiry ON batches(expiry_date);

-- ============================================================
-- INVENTORY (current stock levels per product/batch/warehouse)
-- ============================================================
CREATE TABLE inventory (
    id              SERIAL PRIMARY KEY,
    product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    batch_id        INTEGER REFERENCES batches(id) ON DELETE SET NULL,
    warehouse_id    INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    quantity        NUMERIC(12,3) NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(product_id, batch_id, warehouse_id)
);

CREATE INDEX idx_inventory_product ON inventory(product_id);
CREATE INDEX idx_inventory_warehouse ON inventory(warehouse_id);

-- ============================================================
-- SUPPLIERS
-- ============================================================
CREATE TABLE suppliers (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    eik             VARCHAR(20),
    vat_number      VARCHAR(20),
    address         TEXT,
    contact_person  VARCHAR(255),
    phone           VARCHAR(50),
    email           VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- PRICE LISTS
-- ============================================================
CREATE TABLE price_lists (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- PARTNERS (clients)
-- ============================================================
CREATE TABLE partners (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    eik             VARCHAR(20),
    vat_number      VARCHAR(20),
    address         TEXT,
    contact_person  VARCHAR(255),
    phone           VARCHAR(50),
    email           VARCHAR(255),
    price_list_id   INTEGER REFERENCES price_lists(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- PRICE LIST ITEMS
-- ============================================================
CREATE TABLE price_list_items (
    id              SERIAL PRIMARY KEY,
    price_list_id   INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
    product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price           NUMERIC(10,2) NOT NULL,
    UNIQUE(price_list_id, product_id)
);

-- ============================================================
-- INCOMING GOODS (stock-in documents)
-- ============================================================
CREATE TABLE incoming_goods (
    id                  SERIAL PRIMARY KEY,
    supplier_id         INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    invoice_number      VARCHAR(100),
    invoice_date        DATE,
    document_type       VARCHAR(50) DEFAULT 'invoice',
    scanned_file_path   TEXT,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'confirmed', 'cancelled')),
    total_amount        NUMERIC(12,2) DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INCOMING ITEMS
-- ============================================================
CREATE TABLE incoming_items (
    id                  SERIAL PRIMARY KEY,
    incoming_goods_id   INTEGER NOT NULL REFERENCES incoming_goods(id) ON DELETE CASCADE,
    product_id          INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    batch_id            INTEGER REFERENCES batches(id) ON DELETE SET NULL,
    quantity            NUMERIC(12,3) NOT NULL,
    unit_price          NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_price         NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX idx_incoming_items_goods ON incoming_items(incoming_goods_id);

-- ============================================================
-- INVOICES (outgoing)
-- ============================================================
CREATE TABLE invoices (
    id              SERIAL PRIMARY KEY,
    invoice_number  VARCHAR(50) NOT NULL UNIQUE,
    invoice_date    DATE NOT NULL DEFAULT CURRENT_DATE,
    partner_id      INTEGER NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
    total_net       NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_vat       NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_gross     NUMERIC(12,2) NOT NULL DEFAULT 0,
    pdf_path        TEXT,
    sent_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invoices_partner ON invoices(partner_id);
CREATE INDEX idx_invoices_number ON invoices(invoice_number);

-- ============================================================
-- ORDERS
-- ============================================================
CREATE TABLE orders (
    id              SERIAL PRIMARY KEY,
    partner_id      INTEGER NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'confirmed', 'processing', 'fulfilled', 'cancelled')),
    order_date      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivery_date   DATE,
    total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
    notes           TEXT,
    source          VARCHAR(20) NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual', 'comarch', 'web')),
    invoice_id      INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_partner ON orders(partner_id);
CREATE INDEX idx_orders_status ON orders(status);

-- ============================================================
-- ORDER ITEMS
-- ============================================================
CREATE TABLE order_items (
    id              SERIAL PRIMARY KEY,
    order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    batch_id        INTEGER REFERENCES batches(id) ON DELETE SET NULL,
    quantity        NUMERIC(12,3) NOT NULL,
    unit_price      NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_price     NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX idx_order_items_order ON order_items(order_id);

-- ============================================================
-- PAYMENTS
-- ============================================================
CREATE TABLE payments (
    id                  SERIAL PRIMARY KEY,
    invoice_id          INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    amount              NUMERIC(12,2) NOT NULL,
    payment_method      VARCHAR(20) NOT NULL DEFAULT 'bank'
                        CHECK (payment_method IN ('cash', 'bank', 'card')),
    paid_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bank_reference      VARCHAR(255),
    matched_by_agent    BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_invoice ON payments(invoice_id);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE notifications (
    id          SERIAL PRIMARY KEY,
    type        VARCHAR(50) NOT NULL,
    message     TEXT NOT NULL,
    read        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_read ON notifications(read) WHERE read = FALSE;

-- ============================================================
-- COMARCH SYNC
-- ============================================================
CREATE TABLE comarch_sync (
    id                  SERIAL PRIMARY KEY,
    comarch_order_id    VARCHAR(100) NOT NULL,
    order_id            INTEGER REFERENCES orders(id) ON DELETE SET NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'synced', 'failed')),
    synced_at           TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_comarch_sync_order ON comarch_sync(comarch_order_id);

-- ============================================================
-- INVOICE NUMBER SEQUENCE
-- ============================================================
CREATE SEQUENCE invoice_number_seq START WITH 1 INCREMENT BY 1;

-- Helper function to generate invoice numbers in GF-YYYY-XXXX format
CREATE OR REPLACE FUNCTION generate_invoice_number() RETURNS TEXT AS $$
DECLARE
    seq_val INTEGER;
BEGIN
    seq_val := nextval('invoice_number_seq');
    RETURN 'GF-' || EXTRACT(YEAR FROM CURRENT_DATE)::TEXT || '-' || LPAD(seq_val::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;
