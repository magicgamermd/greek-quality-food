// Смятане в полето за количество, като в Microinvest: „3*2“ → 6,
// „2,5+1“ → 3.5, „12/4“ → 3. Безопасен разбор — без eval: числа с точка
// или запетая, + − * / и скоби; „x“, „х“ (кирилско) и „×“ също умножават.
// Резултатът е закръглен до 3 знака — точността на количеството.

import { roundQuantity } from "@/lib/linePricing";

type Token =
  | { kind: "number"; value: number }
  | { kind: "op"; value: "+" | "-" | "*" | "/" }
  | { kind: "paren"; value: "(" | ")" };

const MULTIPLY = new Set(["*", "x", "X", "х", "Х", "×"]);

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === " ") {
      i += 1;
      continue;
    }
    if (/[0-9.,]/.test(ch)) {
      let text = "";
      while (i < input.length && /[0-9.,]/.test(input[i])) {
        text += input[i];
        i += 1;
      }
      // Една десетична запетая/точка: „2,5“ и „2.5“ — да; „1.2.3“ — не.
      const normalized = text.replace(",", ".");
      if (!/^(\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
      tokens.push({ kind: "number", value: parseFloat(normalized) });
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "/") {
      tokens.push({ kind: "op", value: ch });
    } else if (MULTIPLY.has(ch)) {
      tokens.push({ kind: "op", value: "*" });
    } else if (ch === "(" || ch === ")") {
      tokens.push({ kind: "paren", value: ch });
    } else {
      return null;
    }
    i += 1;
  }
  return tokens;
}

/**
 * Пресмята израза; null, ако не е валиден (празен, непознат знак,
 * незатворена скоба, деление на нула).
 */
export function evaluateQuantityExpression(input: string): number | null {
  const tokens = tokenize(String(input ?? "").trim());
  if (!tokens || tokens.length === 0) return null;
  let pos = 0;

  const parseExpression = (): number | null => {
    let left = parseTerm();
    while (left !== null && pos < tokens.length) {
      const token = tokens[pos];
      if (token.kind !== "op" || (token.value !== "+" && token.value !== "-")) {
        break;
      }
      pos += 1;
      const right = parseTerm();
      if (right === null) return null;
      left = token.value === "+" ? left + right : left - right;
    }
    return left;
  };

  const parseTerm = (): number | null => {
    let left = parseFactor();
    while (left !== null && pos < tokens.length) {
      const token = tokens[pos];
      if (token.kind !== "op" || (token.value !== "*" && token.value !== "/")) {
        break;
      }
      pos += 1;
      const right = parseFactor();
      if (right === null) return null;
      if (token.value === "/" && right === 0) return null;
      left = token.value === "*" ? left * right : left / right;
    }
    return left;
  };

  const parseFactor = (): number | null => {
    const token = tokens[pos];
    if (!token) return null;
    if (token.kind === "number") {
      pos += 1;
      return token.value;
    }
    if (token.kind === "op" && token.value === "-") {
      pos += 1;
      const value = parseFactor();
      return value === null ? null : -value;
    }
    if (token.kind === "paren" && token.value === "(") {
      pos += 1;
      const value = parseExpression();
      const closing = tokens[pos];
      if (
        value === null ||
        closing?.kind !== "paren" ||
        closing.value !== ")"
      ) {
        return null;
      }
      pos += 1;
      return value;
    }
    return null;
  };

  const result = parseExpression();
  if (result === null || pos !== tokens.length || !Number.isFinite(result)) {
    return null;
  }
  return roundQuantity(result);
}

/** Има ли в полето действие за смятане (а не само число). */
export function isQuantityExpression(input: string): boolean {
  return (
    /[+*/()xXхХ×]/.test(String(input ?? "")) ||
    /\d\s*-\s*\d/.test(String(input ?? ""))
  );
}

/**
 * Количеството от полето като число: число или израз („3*2“ → 6);
 * NaN, ако не е валидно — за проверките, които вече очакват число.
 */
export function quantityValue(
  input: string | number | null | undefined,
): number {
  if (typeof input === "number") return input;
  const value = evaluateQuantityExpression(String(input ?? ""));
  return value === null ? NaN : value;
}
