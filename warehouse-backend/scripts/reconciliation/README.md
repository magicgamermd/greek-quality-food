# Greek Foods reconciliation checks

Minimal read-only reconciliation checks for the first three correctness-drift jobs in `docs/GREEK-FOODS-RECONCILIATION-SCOPE.md`.

## Commands

Run from `warehouse-backend/`:

```bash
npx tsx scripts/reconciliation/accepted-invoices-vs-stock.ts
npx tsx scripts/reconciliation/batch-expiry-consistency.ts
npx tsx scripts/reconciliation/product-price-surface-drift.ts
npx tsx scripts/reconciliation/run-all.ts
```

Optional flags:

```bash
--json
--sample-limit=10
```

## Connection behavior

The scripts try, in order:

1. `RECON_DATABASE_URL`
2. `DATABASE_URL`
3. `postgres://greekfoods:greekfoods_secret@127.0.0.1:5432/greekfoods_warehouse`
4. `postgres://greekfoods:greekfoods_secret@localhost:5432/greekfoods_warehouse`
5. Docker fallback via `warehouse-backend-postgres-1`

Override Docker container name with `RECON_POSTGRES_CONTAINER` if needed.

## Exit codes

- `0` — no mismatches found
- `1` — mismatches found or the check could not run
