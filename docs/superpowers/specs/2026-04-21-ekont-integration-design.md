# Ekont Integration — Design Spec

**Date:** 2026-04-21
**Status:** Approved (autonomous-mode — user asleep, executing overnight)
**Parent project:** MERT-M Warehouse Software
**Scope:** Port Ekont (Еконт) shipping integration from mert-m-demo into production MERT-M app.

---

## 1. Goal

Give MERT-M the ability to:

1. Search Econt cities & offices from inside an order (autocomplete).
2. Calculate shipping cost before dispatch.
3. Create a shipping label (товарителница) and download/print its PDF.
4. Track a shipment by its Econt number.
5. Update/recreate a label when an order changes.

All functionality must plug into the existing Orders flow without requiring a new top-level page.

## 2. Non-Goals

- No manifest-level operations (daily collection pickup scheduling). Econt handles this on their side.
- No webhook listener for tracking events (poll-on-demand is enough for v1).
- No B2B-portal account binding for MERT-M's customers (MERT-M is the only Econt client here).
- No multi-carrier abstraction (Econt only, for now).
- No separate `WarehousePacking.tsx` page — actions land inside the order detail modal in `Orders.tsx` instead. (Simpler; matches how MERT-M works today.)

## 3. User Stories

- **As accountant**, I create an order and fill in Econt receiver details (city + office OR address) directly in the create-order form. Shipping cost previews automatically.
- **As warehouse**, I open an order ready to ship, click "Създай товарителница", and get a printable PDF + tracking URL within a few seconds.
- **As warehouse**, I re-open an order whose items changed after the waybill was created, click "Актуализирай товарителница" and the old label is deleted and a new one created with the updated COD/weight.
- **As any role**, I click "Проследи" and see the latest Econt statuses for a shipment.

## 4. Architecture

### 4.1 Backend — Fastify routes

New file `warehouse-backend/src/routes/econt.ts`, registered at prefix `/econt` in `src/index.ts`. Routes (all JWT-protected):

| Method | Path                                        | Purpose                                             |
| ------ | ------------------------------------------- | --------------------------------------------------- |
| `GET`  | `/econt/cities?q=…`                         | Autocomplete city search (Bulgaria)                 |
| `GET`  | `/econt/offices?city=…`                     | List Econt offices in given city                    |
| `POST` | `/econt/calculate`                          | Calculate price for a hypothetical shipment         |
| `POST` | `/econt/create-shipment`                    | Create a label and persist shipment info on order   |
| `POST` | `/econt/update-shipment`                    | Delete old label, recalc COD/weight, create new one |
| `GET`  | `/econt/label-pdf/:shipmentNumber`          | Get (possibly cached) PDF URL                       |
| `GET`  | `/econt/label-pdf-download/:shipmentNumber` | Stream PDF binary through backend                   |
| `GET`  | `/econt/track/:shipmentNumber`              | Get Econt statuses for a shipment                   |

Implementation is ported from mert-m-demo with these improvements:

- **SENDER hardcode eliminated.** Read from env vars:
  ```
  ECONT_SENDER_NAME
  ECONT_SENDER_PHONE
  ECONT_SENDER_CITY         (default: "София")
  ECONT_SENDER_POSTCODE
  ECONT_SENDER_QUARTER      (optional)
  ECONT_SENDER_STREET       (optional — either this OR quarter+other)
  ECONT_SENDER_STREET_NUM   (optional)
  ECONT_SENDER_OTHER        (optional — apartment/block/entrance)
  ```
  A single helper `getSender()` in `econt.ts` builds the SENDER object and throws `{statusCode: 500, message: "Econt sender not configured"}` if `ECONT_SENDER_NAME` or `ECONT_SENDER_PHONE` are missing.
- **Cities & offices cached in-process** (same as demo). Reset on restart. Acceptable because they change rarely.
- **All external calls through one helper** `econtPost(path, body)` — keeps auth/error-shape centralised.

### 4.2 Database — migration 046

Add remaining Econt columns to `orders` table. Migration `046_mertm_econt_fields.sql`:

```sql
-- Production MERT-M Econt fields. Columns use demo naming convention
-- (econt_office_code/name instead of econt_office) for precision.
-- Legacy columns from 019_order_econt_fields.sql are left untouched
-- (ADD COLUMN IF NOT EXISTS handles duplicates) but marked deprecated.
COMMENT ON COLUMN orders.econt_office IS
  'DEPRECATED v0.2.0 — use econt_office_code + econt_office_name instead. '
  'Will be dropped in v1.1 migration.';
COMMENT ON COLUMN orders.econt_tracking IS
  'DEPRECATED v0.2.0 — use econt_shipment_number + econt_tracking_url instead. '
  'Will be dropped in v1.1 migration.';

ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_receiver_name VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_receiver_phone VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_delivery_type  VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_office_code    VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_office_name    VARCHAR(500);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_street         VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_street_num     VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_cod_amount     NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_weight         NUMERIC(10,3);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_shipping_cost  NUMERIC(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_shipment_number VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_tracking_url   TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_pdf_url        TEXT;
```

Note: `econt_city` already exists (from 019) — reused as-is.

### 4.3 Orders route — extend createOrderSchema

`warehouse-backend/src/routes/orders.ts` `createOrderSchema` gets these optional fields:

```typescript
econt_receiver_name:  z.string().trim().max(255).optional(),
econt_receiver_phone: z.string().trim().max(50).optional(),
econt_delivery_type:  z.enum(["office", "address"]).optional(),
econt_city:           z.string().trim().max(255).optional(),
econt_office_code:    z.string().trim().max(50).optional(),
econt_office_name:    z.string().trim().max(500).optional(),
econt_street:         z.string().trim().max(255).optional(),
econt_street_num:     z.string().trim().max(20).optional(),
econt_cod_amount:     z.coerce.number().nonnegative().optional(),
econt_weight:         z.coerce.number().positive().optional(),
econt_shipping_cost:  z.coerce.number().nonnegative().optional(),
```

INSERT in `POST /orders` is extended to include these columns (parameterised).

### 4.4 Frontend — reusable component

To avoid bloating the 3359-line `Orders.tsx`, we put the shipping UI in its own component:

- **`src/components/EcontShippingPicker.tsx`** — autocomplete city + office + address fields, weight, COD toggle, price preview. Emits a value object that parent stores in form state. Internally uses React Query (`useQuery` for cities/offices, `useMutation` for calculate).
- **`src/components/EcontShipmentActions.tsx`** — shown in order detail modal if `order.econt_city` is set. Buttons: "Създай товарителница", "Отвори PDF", "Проследи", "Актуализирай".

Integration points in `Orders.tsx`:

- `CreateOrderModal` (or equivalent) — mount `<EcontShippingPicker>` below existing delivery fields.
- `OrderDetailModal` — mount `<EcontShipmentActions order={order} />` near the header.

Types live in `src/types/order.ts` (extend existing Order type with optional Econt fields).

### 4.5 Env & config

`warehouse-backend/.env.example` gets a new section:

```
# Econt shipping (https://ee.econt.com)
ECONT_USERNAME=
ECONT_PASSWORD=
ECONT_SENDER_NAME=
ECONT_SENDER_PHONE=
ECONT_SENDER_CITY=София
ECONT_SENDER_POSTCODE=
ECONT_SENDER_QUARTER=
ECONT_SENDER_STREET=
ECONT_SENDER_STREET_NUM=
ECONT_SENDER_OTHER=
```

All empty except city default. MERT-M office address is filled by the user during deployment.

## 5. Data Flow

```
CreateOrder (UI)           Backend                        Econt API
─────────────────────────────────────────────────────────────────────
city input  ───GET /econt/cities?q ──►  (cache lookup)───►getCities.json
                                                         (cache hit → skip)
office input ──GET /econt/offices?city ► (cache lookup)──►getOffices.json

weight,COD ───POST /econt/calculate ──► build label ─────►createLabel (mode:calculate)
                          ◄──────────────{price,priceBGN,currency}

[save order] ──POST /orders ──────────► INSERT orders (econt_* fields)

─── later, in warehouse ──────────────────────────────────────────────

click Create  ──POST /econt/create-shipment ──► build label ──►createLabel (mode:create)
                          ◄───────────── save shipmentNumber, pdfURL, trackingUrl
                                        on order row via UPDATE

click PDF    ──GET /econt/label-pdf/:sn ───►  (DB has cached URL?)
                          yes → return URL
                          no  → printLabels.json → cache + return
```

## 6. Error Handling

- **Econt API down** → backend returns `502 { error: "Econt API error: ..." }`. Frontend shows a toast.
- **Missing sender config** → backend returns `500 { error: "Econt sender not configured" }`. Frontend shows a friendly message prompting admin to fill settings.
- **No office found in city** → backend returns `400 { error: "Не мога да намеря офис на Еконт в <city>. Уточнете офис или адрес." }`. Frontend shows inline validation error.
- **Shipment already created, trying to create again** → frontend prevents (button shows "Актуализирай" when `econt_shipment_number` is set).
- **Delete-old fails during update** → we swallow the error (Econt may have already processed the label). Continue to create the new one.

## 7. Testing

New tests in `warehouse-backend/src/__tests__/` following the existing mock-db pattern:

- **`econt-routes.test.ts`** — asserts:
  - `/econt/cities` without `q` returns empty list.
  - `/econt/cities` with `q` calls Econt API once, caches, filters by name.
  - `/econt/offices` filters by city name.
  - `/econt/calculate` builds the right label for office vs. address mode.
  - `/econt/calculate` converts EUR → BGN for COD (1.95583 rate).
  - `/econt/create-shipment` persists `econt_shipment_number`/`econt_tracking_url`/`econt_pdf_url` on order.
  - `/econt/create-shipment` with no office + no street returns 400.
  - `/econt/update-shipment` deletes old label, recalculates COD/weight from items.
  - `/econt/label-pdf/:sn` returns cached URL without hitting API.
  - All routes require auth (no user → 401).

- Mocks: `global.fetch` with `vi.fn()` for Econt API; `vi.mock("../db.js")` for DB.

Frontend: component tests deferred to later (v0.2.1). Manual smoke test covers the golden path.

## 8. Security

- Econt credentials stored in env only (never logged, never returned in API responses).
- All routes require JWT auth (rejects anonymous calls with 401).
- Parameterised SQL only (queries go through `query()` helper which uses pg `$1/$2` placeholders).
- SENDER env vars validated once at route registration; missing required fields produce a boot-time warning (not crash — allows partial config during deployment).

## 9. Backwards Compatibility

- Legacy columns from migration 019 (`econt_office`, `econt_tracking`) are kept as deprecated with SQL comments. No data migration needed because production has no Econt data yet (MERT-M hasn't shipped anything).
- `GET /orders/:id` continues to return all columns. Frontend consumers that don't care about Econt fields see them as `null` — harmless.

## 10. Deployment

- After merging, run `npm run migrate` in backend to apply migration 046.
- Admin adds env vars in `.env` (production) with MERT-M's actual Econt account + sender address.
- Restart backend (Docker compose restart or pm2 restart).

## 11. Out-of-Scope Follow-ups (noted for later)

- Batch/bulk waybill creation (select many orders, print all labels at once).
- Cron-based status polling (auto-update `last_econt_status` on orders).
- Econt API rate limit handling (none observed in practice, but may need backoff later).
- Manifest pickup scheduling (send daily pickup request to Econt).
- Customer-visible tracking link in invoice PDFs.

---

## Appendix A — Decisions Log (autonomous)

Made overnight while user is asleep. User reviews in the morning.

| Decision                       | Alternatives considered                                             | Chosen                              | Reason                                                                    |
| ------------------------------ | ------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| Migration strategy             | (a) drop incomplete 019 and replace; (b) add 046 that extends       | **(b)** add 046                     | Additive-only rule; 019's columns are unused, so renaming is churn        |
| SENDER source                  | (a) settings table, (b) env vars                                    | **(b)** env vars                    | MERT-M office is stable; env vars stay secret; no UI needed for v1        |
| Frontend structure             | (a) monolithic port into Orders.tsx; (b) extract reusable component | **(b)** reusable component          | Orders.tsx is already 3359 lines; adding 400 more is harmful              |
| WarehousePacking port          | (a) port as new page, (b) inline into OrderDetailModal              | **(b)** inline                      | Demo only had it because it was a demo; MERT-M already sees orders inline |
| Test pattern                   | (a) testsprite, (b) vi.mock pattern                                 | **(b)** existing `__tests__/`       | Matches production convention                                             |
| Cache TTL on cities/offices    | (a) in-memory forever, (b) TTL refresh                              | **(a)** forever (resets on restart) | Matches demo; restart is cheap; Econt nomenclature changes rarely         |
| In-EUR or in-BGN persisted COD | demo stores EUR on order, converts on API call                      | **keep**                            | Rest of MERT-M uses EUR internally; conversion at boundary only           |
| Shipping cost currency         | demo returns EUR + BGN                                              | **keep**                            | EUR primary UI, BGN shown as secondary for user trust                     |
