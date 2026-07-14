-- 102: Проформа номерата получават префикс "PR.INV" (по избор на magic).
--
-- Проформите и реалните фактури живеят в ЕДНА таблица (invoices) с
-- unique constraint на invoice_number, но досега деляха и ЕДИН формат
-- (LPAD(n,10,'0')). Двете поредици неизбежно се засичат: фактурите
-- стигнаха 0000000015, а проформа броячът (current_val=5) поиска
-- 0000000006 — зает от фактура → duplicate key
-- "invoices_invoice_number_key" при издаване на проформа.
--
-- Префиксът разделя поредиците завинаги. Броячът НЕ се пипа — следващата
-- проформа е "PR.INV0000000006" (продължава видимата поредица от 6, както е
-- настроено при go-live). Старите проформи (ако има с чисто цифров
-- номер) не се преименуват — историята остава.

CREATE OR REPLACE FUNCTION public.generate_proforma_number()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  next_num BIGINT;
  proforma_num TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('proforma_number_global'));
  UPDATE document_counters
     SET current_val = current_val + 1
   WHERE type = 'proforma'
  RETURNING current_val INTO next_num;
  IF next_num IS NULL THEN
    -- Row missing (shouldn't happen after the INSERT above, but be safe).
    INSERT INTO document_counters (type, current_val) VALUES ('proforma', 200);
    next_num := 200;
  END IF;
  proforma_num := 'PR.INV' || LPAD(next_num::TEXT, 10, '0');
  RETURN proforma_num;
END;
$function$;
