# MERT-M reconciliation checks

Minimal read-only reconciliation checks for correctness-drift jobs.

> **Note for MERT-M**: scripts named `batch-expiry-consistency.ts` are
> Greek Foods leftovers — MERT-M sells durable goods and does not track
> batches/expiry, so that script is a no-op against the MERT-M schema.
> Pending Phase 4 cleanup to remove batch/expiry-specific scripts.

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
3. `postgres://mertm:mertm_secret@127.0.0.1:5433/mertm_warehouse`
4. `postgres://mertm:mertm_secret@localhost:5433/mertm_warehouse`
5. Docker fallback via `mertm-postgres-1`

Override Docker container name with `RECON_POSTGRES_CONTAINER` if needed.

## Exit codes

- `0` — no mismatches found
- `1` — mismatches found or the check could not run
