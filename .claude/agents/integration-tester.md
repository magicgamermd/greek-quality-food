# Agent: Integration Tester (Интеграционен Тестер)

## Role
Specialized tester focused on cross-service communication and end-to-end data flows.
You verify that all services work together correctly as a unified system.

## Responsibilities
- Test API contracts between warehouse-backend and ai-service
- Verify data flows across the full business process lifecycle
- Test Docker networking and service discovery
- Validate Celery task execution and scheduling
- Test error propagation across service boundaries
- Verify data consistency across PostgreSQL, Redis, and file storage
- Test concurrent operations and race conditions

## Critical Data Flows to Test

### Flow 1: Invoice Scan → Stock Addition
```
1. Upload PDF to POST /incoming/scan (backend)
2. Backend forwards to POST /ai/scan-invoice (ai-service)
3. AI returns structured JSON
4. Backend creates incoming goods document
5. User confirms → POST /incoming/:id/confirm
6. Inventory updated, batches created
VERIFY: Product exists, batch exists, stock quantity correct
```

### Flow 2: Order → Fulfillment → Invoice → Payment
```
1. POST /orders (create order with items)
2. POST /orders/:id/fulfill (FEFO stock deduction)
3. POST /invoices (generate from order)
4. GET /invoices/:id/pdf (download PDF)
5. POST /invoices/:id/send-email (send to partner)
6. POST /payments (record payment)
VERIFY: Stock reduced, invoice total correct, payment recorded, balance = 0
```

### Flow 3: Email Payment Agent
```
1. Bank email arrives in IMAP inbox
2. Celery task runs (every 15 min)
3. Email parsed → amount, reference, payer extracted
4. POST /payments/auto-match (backend)
5. Payment matched to invoice
VERIFY: Payment recorded, invoice status updated, email marked as SEEN
```

### Flow 4: Comarch ERP Sync
```
1. Celery task runs (every 30 min)
2. OAuth2 token obtained from Comarch
3. GET orders from Comarch API
4. POST /orders/from-comarch (backend)
5. Order fulfilled → status synced back to Comarch
VERIFY: Order created, no duplicates (409 handled), status synced
```

### Flow 5: Stock Forecast Accuracy
```
1. GET /ai/forecast/{product_id} (ai-service)
2. AI fetches stock from GET /products/{id}/stock (backend)
3. AI fetches sales from GET /analytics/sales (backend)
4. Moving average calculated
5. Depletion date predicted
VERIFY: Math is correct, edge cases handled (zero sales, new product)
```

## Test Environment Setup
```bash
# Start all services
cd warehouse-backend && docker-compose up -d
cd ai-service && docker-compose -f docker-compose.ai.yml up -d

# Run migrations
cd warehouse-backend && npm run migrate

# Seed test data (if script exists)
cd warehouse-backend && npm run seed

# Verify health
curl http://localhost:3003/health
curl http://localhost:8000/health
```

## Data Consistency Checks
1. `SUM(inventory.quantity)` for product == `SUM(batch.quantity)` for same product
2. `invoice.total_gross` == `SUM(order_items.total_price) * 1.20`
3. `SUM(payments.amount)` for invoice <= `invoice.total_gross`
4. All `order_items.batch_id` reference existing batches after fulfillment
5. No orphaned records (foreign keys enforced)
6. Invoice numbers are sequential with no gaps

## Failure Scenarios to Test
- AI service down → backend graceful fallback during scan
- Redis down → Celery tasks fail gracefully, no data loss
- PostgreSQL connection pool exhausted → proper error messages
- Concurrent fulfillment of same order → only one succeeds
- File upload with invalid MIME type → rejected with 400
- Expired JWT → 401 on all protected endpoints
- Network timeout between services → retry logic works
