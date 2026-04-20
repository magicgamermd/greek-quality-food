function normalizeToken(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const token = String(value).trim().toLowerCase();
  return token.length > 0 ? token : null;
}

export function parseMicroinvestYesNo(value: unknown): boolean | null {
  const token = normalizeToken(value);
  if (!token) return null;

  if (["да", "yes", "y", "true", "1"].includes(token)) return true;
  if (["не", "no", "n", "false", "0"].includes(token)) return false;
  return null;
}

export function parseProductActiveStatus(value: unknown): boolean | null {
  const token = normalizeToken(value);
  if (!token) return null;

  if (token.includes("не се използва")) return false;
  if (token.includes("се използва")) return true;

  return parseMicroinvestYesNo(token);
}
