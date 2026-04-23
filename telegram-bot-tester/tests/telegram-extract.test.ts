import { describe, it, expect } from "vitest";
import { extractDocument, extractButtons } from "../src/telegram/client.js";
import type { Api } from "telegram";

function makeMessage(overrides: Partial<Record<string, unknown>>): Api.Message {
  return overrides as unknown as Api.Message;
}

describe("extractDocument", () => {
  it("returns undefined when message has no document", () => {
    const msg = makeMessage({ document: undefined });
    expect(extractDocument(msg)).toBeUndefined();
  });

  it("extracts file name, mime type and size from document attributes", () => {
    const msg = makeMessage({
      document: {
        mimeType: "application/pdf",
        size: 45678,
        attributes: [
          {
            className: "DocumentAttributeFilename",
            fileName: "faktura-42.pdf",
          },
        ],
      },
    });
    expect(extractDocument(msg)).toEqual({
      fileName: "faktura-42.pdf",
      mimeType: "application/pdf",
      size: 45678,
    });
  });

  it("falls back to 'unknown' filename when no DocumentAttributeFilename", () => {
    const msg = makeMessage({
      document: {
        mimeType: "application/octet-stream",
        size: 100,
        attributes: [{ className: "DocumentAttributeAudio" }],
      },
    });
    const doc = extractDocument(msg);
    expect(doc?.fileName).toBe("unknown");
    expect(doc?.mimeType).toBe("application/octet-stream");
  });

  it("coerces size to a number when size is BigInteger-like", () => {
    const msg = makeMessage({
      document: {
        mimeType: "application/pdf",
        size: { toString: () => "1024" },
        attributes: [
          { className: "DocumentAttributeFilename", fileName: "x.pdf" },
        ],
      },
    });
    const doc = extractDocument(msg);
    expect(typeof doc?.size).toBe("number");
    expect(doc?.size).toBe(1024);
  });
});

describe("extractButtons", () => {
  it("returns undefined when message has no replyMarkup", () => {
    const msg = makeMessage({ replyMarkup: undefined });
    expect(extractButtons(msg)).toBeUndefined();
  });

  it("returns undefined for non-inline reply markup", () => {
    const msg = makeMessage({
      replyMarkup: { className: "ReplyKeyboardMarkup", rows: [] },
    });
    expect(extractButtons(msg)).toBeUndefined();
  });

  it("extracts callback buttons with text and callback data", () => {
    const msg = makeMessage({
      replyMarkup: {
        className: "ReplyInlineMarkup",
        rows: [
          {
            buttons: [
              {
                className: "KeyboardButtonCallback",
                text: "Товарителница",
                data: Buffer.from("waybill_42", "utf-8"),
              },
              {
                className: "KeyboardButtonCallback",
                text: "Изпрати имейл",
                data: Buffer.from("email_ask_42", "utf-8"),
              },
            ],
          },
        ],
      },
    });
    const btns = extractButtons(msg);
    expect(btns).toHaveLength(2);
    expect(btns?.[0]).toEqual({
      text: "Товарителница",
      callbackData: "waybill_42",
    });
    expect(btns?.[1]).toEqual({
      text: "Изпрати имейл",
      callbackData: "email_ask_42",
    });
  });

  it("skips non-callback buttons (e.g. url buttons)", () => {
    const msg = makeMessage({
      replyMarkup: {
        className: "ReplyInlineMarkup",
        rows: [
          {
            buttons: [
              {
                className: "KeyboardButtonUrl",
                text: "Open",
                url: "https://example.com",
              },
              {
                className: "KeyboardButtonCallback",
                text: "Keep",
                data: Buffer.from("keep_1", "utf-8"),
              },
            ],
          },
        ],
      },
    });
    const btns = extractButtons(msg);
    expect(btns).toEqual([{ text: "Keep", callbackData: "keep_1" }]);
  });

  it("returns undefined when inline markup has zero callback buttons", () => {
    const msg = makeMessage({
      replyMarkup: {
        className: "ReplyInlineMarkup",
        rows: [
          {
            buttons: [
              {
                className: "KeyboardButtonUrl",
                text: "Only url",
                url: "https://example.com",
              },
            ],
          },
        ],
      },
    });
    expect(extractButtons(msg)).toBeUndefined();
  });

  it("flattens buttons across multiple rows", () => {
    const msg = makeMessage({
      replyMarkup: {
        className: "ReplyInlineMarkup",
        rows: [
          {
            buttons: [
              {
                className: "KeyboardButtonCallback",
                text: "A",
                data: Buffer.from("a", "utf-8"),
              },
            ],
          },
          {
            buttons: [
              {
                className: "KeyboardButtonCallback",
                text: "B",
                data: Buffer.from("b", "utf-8"),
              },
            ],
          },
        ],
      },
    });
    const btns = extractButtons(msg);
    expect(btns?.map((b) => b.text)).toEqual(["A", "B"]);
  });
});
