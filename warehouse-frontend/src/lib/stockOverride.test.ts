// „Продължи въпреки склада“ — администраторът не се спира от наличност и срок.
import { describe, expect, it, vi } from "vitest";
import {
  stockOverrideNotes,
  stockOverrideOffer,
  withStockOverride,
} from "./stockOverride";

const SHORTAGE =
  "„Мини тартички“ — партида (без номер): налични 0.18, избрани 3.";

const refusal = (data: Record<string, unknown>) => ({
  isAxiosError: true,
  response: { status: 409, data },
});

describe("stockOverrideOffer", () => {
  it("сървърът предлага да се продължи → съобщението на отказа", () => {
    expect(
      stockOverrideOffer(
        refusal({ error: SHORTAGE, can_override_stock: true }),
      ),
    ).toBe(SHORTAGE);
  });

  it("отказ без предложение (потребител без правото) → null", () => {
    expect(stockOverrideOffer(refusal({ error: SHORTAGE }))).toBeNull();
  });

  it("друга грешка → null", () => {
    expect(stockOverrideOffer(new Error("мрежа"))).toBeNull();
    expect(stockOverrideOffer(null)).toBeNull();
  });

  it("предложение без текст → общо съобщение", () => {
    expect(stockOverrideOffer(refusal({ can_override_stock: true }))).toBe(
      "Складът не позволява това.",
    );
  });
});

describe("withStockOverride", () => {
  it("без отказ → една заявка, без въпрос", async () => {
    const send = vi.fn(async () => "ok");
    const ask = vi.fn(async () => true);
    await expect(withStockOverride(send, ask)).resolves.toBe("ok");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({});
    expect(ask).not.toHaveBeenCalled();
  });

  it("отказ с предложение и „да“ → втора заявка с изричното „да“", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        refusal({ error: SHORTAGE, can_override_stock: true }),
      )
      .mockResolvedValueOnce("записано");
    const ask = vi.fn(async () => true);
    await expect(withStockOverride(send, ask)).resolves.toBe("записано");
    expect(ask).toHaveBeenCalledWith(SHORTAGE);
    expect(send).toHaveBeenNthCalledWith(2, { allow_stock_override: true });
  });

  it("отказ с предложение и „не“ → първата грешка, без втора заявка", async () => {
    const error = refusal({ error: SHORTAGE, can_override_stock: true });
    const send = vi.fn().mockRejectedValueOnce(error);
    const ask = vi.fn(async () => false);
    await expect(withStockOverride(send, ask)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("отказ без предложение → грешката, без въпрос", async () => {
    const error = refusal({ error: SHORTAGE });
    const send = vi.fn().mockRejectedValueOnce(error);
    const ask = vi.fn(async () => true);
    await expect(withStockOverride(send, ask)).rejects.toBe(error);
    expect(ask).not.toHaveBeenCalled();
  });

  it("втората заявка също отказва → нейната грешка, без нов въпрос", async () => {
    const second = refusal({ error: "Forbidden" });
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        refusal({ error: SHORTAGE, can_override_stock: true }),
      )
      .mockRejectedValueOnce(second);
    const ask = vi.fn(async () => true);
    await expect(withStockOverride(send, ask)).rejects.toBe(second);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe("stockOverrideNotes", () => {
  it("взима бележките от отговора", () => {
    expect(stockOverrideNotes({ stock_override_notes: [SHORTAGE] })).toEqual([
      SHORTAGE,
    ]);
  });

  it("няма бележки → празно", () => {
    expect(stockOverrideNotes({})).toEqual([]);
    expect(stockOverrideNotes(null)).toEqual([]);
    expect(stockOverrideNotes({ stock_override_notes: "x" })).toEqual([]);
  });
});
