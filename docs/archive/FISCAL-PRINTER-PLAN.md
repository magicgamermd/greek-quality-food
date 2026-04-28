# Fiscal Printer Integration Plan — DAISY

## Overview

Integration of a DAISY fiscal printer into the Greek Foods warehouse platform for issuing fiscal receipts as required by Bulgarian tax law (NRA/НАП).

## Architecture Decision: FPGate REST API

**Recommended approach: FPGate** (https://github.com/edabg/fpgate)

### Why FPGate over direct serial:

- REST API accessible from browser/web app — no need for native serial drivers
- Supports DAISY, Datecs, Tremol, and other Bulgarian fiscal printers
- Handles protocol framing, checksums, and retry logic
- Open source, actively maintained
- Can run on the same machine as the fiscal printer (Windows/Linux)

### Alternative: Direct serial communication

- Requires a backend service running on the machine with the printer physically connected
- Binary protocol with CRC-16 checksums, command framing (STX/ETX)
- More complex but gives full control
- Not recommended for web-based apps

## FPGate Setup

```
┌──────────────┐      REST API      ┌──────────────┐      Serial/USB      ┌────────────┐
│  Warehouse   │ ──────────────────→ │   FPGate     │ ──────────────────→  │   DAISY    │
│  Frontend    │   HTTP POST/GET     │  (Java app)  │   COM port           │  Printer   │
│  or Backend  │                     │  port 8182   │                      │            │
└──────────────┘                     └──────────────┘                      └────────────┘
```

FPGate runs as a service on the machine with the printer connected. The warehouse app sends REST requests to FPGate.

## FPGate Commands Needed

### 1. Open Fiscal Receipt

```http
POST http://{fpgate_host}:8182/fiscal/receipt/open
Content-Type: application/json

{
  "operator": "1",
  "operatorPassword": "0000"
}
```

### 2. Add Sale Line

```http
POST http://{fpgate_host}:8182/fiscal/receipt/sale
Content-Type: application/json

{
  "text": "Product Name",
  "taxGroup": "B",       // B = 20% VAT in Bulgaria
  "price": 12.50,
  "quantity": 2,
  "discount": 0
}
```

### 3. Payment & Close Receipt

```http
POST http://{fpgate_host}:8182/fiscal/receipt/payment
Content-Type: application/json

{
  "paymentType": "cash",  // cash, card, bank
  "amount": 25.00
}
```

### 4. Close Receipt

```http
POST http://{fpgate_host}:8182/fiscal/receipt/close
```

### 5. Daily Report (Z-Report)

```http
POST http://{fpgate_host}:8182/fiscal/report/daily
Content-Type: application/json

{
  "type": "Z"  // Z = closing report, X = check report
}
```

### 6. Printer Status

```http
GET http://{fpgate_host}:8182/fiscal/status
```

## Backend Integration Points

### New Route: `warehouse-backend/src/routes/fiscal.ts`

```typescript
// POST /fiscal/receipt — print fiscal receipt for an order/invoice
// POST /fiscal/status — check printer status
// POST /fiscal/z-report — daily closing report
// GET  /fiscal/config — get fiscal printer settings
// PUT  /fiscal/config — update fiscal printer settings
```

### Where to trigger fiscal printing:

| Trigger                      | When                       | Why                     |
| ---------------------------- | -------------------------- | ----------------------- |
| **After order fulfillment**  | `POST /orders/:id/fulfill` | Cash sales at warehouse |
| **After invoice generation** | `POST /invoices`           | Formal fiscal receipt   |
| **Manual**                   | Button in invoice detail   | Re-print or late print  |

**Recommended: After invoice generation.** The fiscal receipt should correspond 1:1 with the invoice for audit purposes.

### Implementation in `invoices.ts`:

```typescript
// After successful invoice creation and PDF generation:
if (settings.fiscal_printer_enabled) {
  try {
    await printFiscalReceipt(invoice, items, settings);
  } catch (err) {
    // Log but don't fail the invoice creation
    // Set invoice.fiscal_status = 'pending'
    request.log.error("Fiscal print failed:", err);
  }
}
```

## Database Changes

### Migration: `016_fiscal_printer.sql`

```sql
-- Fiscal printer settings
ALTER TABLE settings ADD COLUMN IF NOT EXISTS fiscal_printer_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS fiscal_printer_host VARCHAR(255) DEFAULT 'localhost';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS fiscal_printer_port INTEGER DEFAULT 8182;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS fiscal_operator_id VARCHAR(10) DEFAULT '1';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS fiscal_operator_password VARCHAR(20) DEFAULT '0000';

-- Track fiscal receipt status on invoices
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fiscal_status VARCHAR(20) DEFAULT NULL;
-- Values: NULL (not attempted), 'printed', 'pending', 'failed'
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fiscal_receipt_number VARCHAR(50) DEFAULT NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fiscal_printed_at TIMESTAMPTZ DEFAULT NULL;
```

## Frontend Changes

### Settings Page — New Section: "Фискален принтер"

Add to Settings.tsx under the company tab:

- **Toggle:** Enable/disable fiscal printer
- **Host:** FPGate server IP/hostname (default: localhost)
- **Port:** FPGate port (default: 8182)
- **Operator ID:** Fiscal operator number
- **Operator Password:** Fiscal operator password
- **Test Connection** button — calls `GET /fiscal/status`

### Invoice Page — Fiscal Status Column

- Show fiscal receipt status badge (printed/pending/failed)
- Add "Print Fiscal Receipt" button for manual printing
- Add "Re-print" option for failed prints

### Dashboard — Fiscal Widget

- Show count of invoices without fiscal receipts
- Quick action to batch-print pending

## Tax Groups (Bulgarian)

| Group | VAT Rate | Usage                              |
| ----- | -------- | ---------------------------------- |
| A     | 0%       | Exempt                             |
| B     | 20%      | Standard rate (most products)      |
| C     | 9%       | Reduced rate (hotels, restaurants) |
| D     | 0%       | Tax-free                           |

For Greek Foods: All products use **Group B (20% VAT)**.

## Error Handling

1. **Printer offline:** Queue the receipt, mark as `pending`, retry on next print
2. **Paper out:** Show alert in notification bell, block new prints until resolved
3. **Communication error:** Retry 3 times with 1s delay, then mark as `failed`
4. **Daily report failure:** Alert admin, cannot open new fiscal day without closing previous

## Security Considerations

- FPGate should only be accessible from the local network
- Operator passwords should be stored encrypted in settings
- Fiscal receipt numbers are sequential and tamper-proof (enforced by printer hardware)
- Z-reports are legally required daily when the printer is active

## Implementation Phases

### Phase 1: Basic Integration (1-2 days)

- [ ] Create `fiscal.ts` route with status check and receipt printing
- [ ] Add migration `016_fiscal_printer.sql`
- [ ] Add fiscal settings to Settings page
- [ ] Add print button to Invoice detail

### Phase 2: Automatic Printing (1 day)

- [ ] Auto-print after invoice generation
- [ ] Retry queue for failed prints
- [ ] Fiscal status column in invoices table

### Phase 3: Reporting (0.5 day)

- [ ] Z-report / X-report buttons in Settings
- [ ] Daily fiscal summary in Dashboard
- [ ] Fiscal audit log

## Prerequisites

1. Install FPGate on the machine with the DAISY printer
2. Configure COM port in FPGate settings
3. Set FPGate to run as a Windows service
4. Ensure the warehouse backend can reach FPGate (same LAN)
5. Test with a fiscal receipt in test mode before going live
