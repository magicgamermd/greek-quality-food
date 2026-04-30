import type { Pool } from "pg";

// Idempotent re-seed of reference rows the UI assumes always exist.
// Runs once on backend boot to recover from accidental deletion or
// import scripts that TRUNCATE the underlying tables. Each entry is
// re-created from the migration that introduced it.
export async function ensureSeedData(pool: Pool): Promise<{
  individualPartnerCreated: boolean;
}> {
  // "Физическо лице — краен потребител" — referenced by the New Order
  // dialog's customer-type toggle (Orders.tsx). Without this row the
  // toggle stays disabled and walk-in sales are impossible. Originally
  // seeded by migration 050.
  const result = await pool.query(`
    INSERT INTO partners (name, print_name, partner_type)
    SELECT 'Физическо лице — краен потребител',
           'Физическо лице — краен потребител',
           'individual'
    WHERE NOT EXISTS (
      SELECT 1 FROM partners
      WHERE name = 'Физическо лице — краен потребител'
        AND partner_type = 'individual'
    )
  `);

  return {
    individualPartnerCreated: (result.rowCount ?? 0) > 0,
  };
}
