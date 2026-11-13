// „Продължи въпреки склада“ (magic, 13.11.2026: „дай им свобода“).
//
// Потребител с правото orders.stock_override (администраторите) не се спира
// от проверките за наличност и срок. Сървърът пак отказва, но към отказа
// добавя can_override_stock; формата пита и праща заявката наново с
// изричното „да“ (allow_stock_override). Останалите виждат отказа както
// досега.

/** Изричното „да“ в тялото на заявката. */
export interface StockOverrideFlag {
  allow_stock_override?: true;
}

interface RefusalBody {
  can_override_stock?: unknown;
  error?: unknown;
  message?: unknown;
}

/**
 * Съобщението на отказа, ако сървърът предлага да се продължи въпреки
 * склада; иначе null (друга грешка или потребител без правото).
 */
export function stockOverrideOffer(error: unknown): string | null {
  const body = (error as { response?: { data?: RefusalBody } } | null)?.response
    ?.data;
  if (!body || body.can_override_stock !== true) return null;
  const text = [body.error, body.message].find(
    (value): value is string => typeof value === "string" && value !== "",
  );
  return text ?? "Складът не позволява това.";
}

/**
 * Пуска заявката. При отказ с предложение пита (`ask`) и при „да“ я праща
 * пак с allow_stock_override. При „не“ или друга грешка — първата грешка,
 * за да се покаже както досега.
 */
export async function withStockOverride<T>(
  send: (flag: StockOverrideFlag) => Promise<T>,
  ask: (message: string) => Promise<boolean>,
): Promise<T> {
  try {
    return await send({});
  } catch (error) {
    const message = stockOverrideOffer(error);
    if (message === null || !(await ask(message))) throw error;
    return send({ allow_stock_override: true });
  }
}

/** Какво е надделяно — от отговора на сървъра (stock_override_notes). */
export function stockOverrideNotes(payload: unknown): string[] {
  const notes = (payload as { stock_override_notes?: unknown } | null)
    ?.stock_override_notes;
  return Array.isArray(notes)
    ? notes.filter((note): note is string => typeof note === "string")
    : [];
}
