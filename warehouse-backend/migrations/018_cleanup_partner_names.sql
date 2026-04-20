-- Clean up partner names: move internal notes (after long whitespace) to a separate field
-- First, ensure we have a notes column
ALTER TABLE partners ADD COLUMN IF NOT EXISTS internal_notes TEXT;

-- Move internal notes from names that have excessive whitespace (3+ spaces = internal note separator)
UPDATE partners
SET internal_notes = TRIM(regexp_replace(name, '^[^[:space:]]{2,}([[:space:]]{0,2}[^[:space:]]+)*', '')),
    name = TRIM(regexp_replace(name, '\\s{3,}.*$', ''))
WHERE name ~ '\\s{3,}';

-- Also clean up the test partner with EIK 999999999
UPDATE partners SET internal_notes = COALESCE(internal_notes || ' ', '') || 'тестов партньор'
WHERE eik = '999999999';

-- Trim any remaining excessive whitespace in all names
UPDATE partners SET name = TRIM(regexp_replace(name, '\\s{2,}', ' ', 'g'))
WHERE name ~ '\\s{2,}';
