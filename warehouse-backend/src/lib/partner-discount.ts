// Отстъпка по подразбиране за нов ред в поръчка (Microinvest, 04.11.2026):
// своята отстъпка на партньора, ако има; иначе тази на ценовата му група;
// иначе 0. Складът може да я смени на всеки ред.

function percent(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : 0;
}

export function pickDefaultDiscount(
  ownDiscount: unknown,
  priceGroupDiscount: unknown,
): number {
  const own = percent(ownDiscount);
  if (own > 0) return own;
  return percent(priceGroupDiscount);
}
