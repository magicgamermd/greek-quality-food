import { describe, it, expect } from "vitest";
import * as iconv from "iconv-lite";
import {
  formatDate,
  formatDocNumber,
  getVatGroup,
  buildDocLine,
  buildVatLine,
  DocLineParams,
} from "../routes/export.js";

describe("formatDate", () => {
  it("should format date as DD.MM.YYYY", () => {
    expect(formatDate("2024-05-01")).toBe("01.05.2024");
  });

  it("should pad single-digit day and month", () => {
    expect(formatDate("2024-01-03")).toBe("03.01.2024");
  });

  it("should preserve date-only ISO strings without timezone shifting", () => {
    expect(formatDate("2024-05-01T00:00:00.000Z")).toBe("01.05.2024");
    expect(formatDate("2024-05-01 15:30:00")).toBe("01.05.2024");
  });

  it("should handle Date objects", () => {
    expect(formatDate(new Date(2024, 11, 25))).toBe("25.12.2024");
  });
});

describe("formatDocNumber", () => {
  it("should pad pure numeric strings to 10 digits", () => {
    expect(formatDocNumber("17188")).toBe("0000017188");
  });

  it("should strip GF- prefix and dashes", () => {
    expect(formatDocNumber("GF-2026-0001")).toBe("0020260001");
  });

  it("should strip КИ- prefix", () => {
    expect(formatDocNumber("КИ-0000000001")).toBe("0000000001");
  });

  it("should handle already 10-digit numbers", () => {
    expect(formatDocNumber("0000020295")).toBe("0000020295");
  });

  it("should handle empty string", () => {
    expect(formatDocNumber("")).toBe("0000000000");
  });
});

describe("getVatGroup", () => {
  it("should return 11 for Greek EL-prefixed VAT numbers", () => {
    expect(getVatGroup("EL162507551")).toBe(11);
  });

  it("should return 11 for GR-prefixed VAT numbers", () => {
    expect(getVatGroup("GR123456789")).toBe(11);
  });

  it("should return 8 when include_vat is false", () => {
    expect(getVatGroup("BG123456789", false)).toBe(8);
  });

  it("should return 16 for BG partners with VAT", () => {
    expect(getVatGroup("BG202370897", true)).toBe(16);
  });

  it("should return 16 when include_vat is undefined (default)", () => {
    expect(getVatGroup("BG202370897")).toBe(16);
  });

  it("should return 16 for null VAT number with VAT included", () => {
    expect(getVatGroup(null, true)).toBe(16);
  });

  it("should return 8 for null VAT number without VAT", () => {
    expect(getVatGroup(null, false)).toBe(8);
  });

  it("should prioritize EL prefix over include_vat=false", () => {
    expect(getVatGroup("EL162507551", false)).toBe(11);
  });
});

describe("buildDocLine", () => {
  const baseSalesDoc: DocLineParams = {
    typeCode: 2,
    date: "01.05.2024",
    docNum: "0000017188",
    docType: "Ф-ра",
    amount: "72.89",
    vatGroup: 16,
    company: "СИ ЕЙЧ БИ КЪМПАНИ ЕООД",
    mol: "Евгени Терзийски",
    city: "София",
    address: "ул.Нишава 36 ет.1 оф.2",
    vatNumber: "BG202370897",
    eik: "202370897",
    reason: "Издадена фактура",
    vatAmount: "12.15",
  };

  it("should produce 16 pipe-delimited fields for a sales invoice", () => {
    const line = buildDocLine(baseSalesDoc);
    const fields = line.split("|");
    expect(fields).toHaveLength(16);
  });

  it("should match PRODAJBIEXPORT format for a BG sales invoice", () => {
    const line = buildDocLine(baseSalesDoc);
    expect(line).toBe(
      "2|01.05.2024|0000017188|Ф-ра|72.89|16|СИ ЕЙЧ БИ КЪМПАНИ ЕООД|Евгени Терзийски|София|ул.Нишава 36 ет.1 оф.2|BG202370897|202370897|   |Издадена фактура| |12.15",
    );
  });

  it("should produce correct format for a Greek purchase invoice", () => {
    const doc: DocLineParams = {
      typeCode: 1,
      date: "01.05.2024",
      docNum: "0000020295",
      docType: "Ф-ра",
      amount: "909.04",
      vatGroup: 11,
      company: "DAGKOS ATHANASIOS",
      mol: "DAGKOS ATHANASIOS",
      city: "THESALONIKI",
      address: "CHRISOSTOMOU SMIRNIS 71 DIAVATA",
      vatNumber: "EL162507551",
      eik: "EL162507551",
      reason: "Получена фактура",
      vatAmount: "0.00",
    };
    const line = buildDocLine(doc);
    expect(line).toBe(
      "1|01.05.2024|0000020295|Ф-ра|909.04|11|DAGKOS ATHANASIOS|DAGKOS ATHANASIOS|THESALONIKI|CHRISOSTOMOU SMIRNIS 71 DIAVATA|EL162507551|EL162507551|   |Получена фактура| |0.00",
    );
  });

  it("should produce correct format for credit notes", () => {
    const doc: DocLineParams = {
      ...baseSalesDoc,
      typeCode: 9,
      docType: "КИ",
      reason: "Кредитно известие",
    };
    const fields = buildDocLine(doc).split("|");
    expect(fields[0]).toBe("9");
    expect(fields[3]).toBe("КИ");
    expect(fields[13]).toBe("Кредитно известие");
  });

  it("should produce correct format for debit notes", () => {
    const doc: DocLineParams = {
      ...baseSalesDoc,
      typeCode: 7,
      docType: "Д-ги",
      reason: "Дебитно известие",
    };
    const fields = buildDocLine(doc).split("|");
    expect(fields[0]).toBe("7");
    expect(fields[3]).toBe("Д-ги");
    expect(fields[13]).toBe("Дебитно известие");
  });

  it("should have 3 spaces in field 12", () => {
    const fields = buildDocLine(baseSalesDoc).split("|");
    expect(fields[12]).toBe("   ");
  });

  it("should have single space in field 14", () => {
    const fields = buildDocLine(baseSalesDoc).split("|");
    expect(fields[14]).toBe(" ");
  });
});

describe("buildVatLine", () => {
  const doc: DocLineParams = {
    typeCode: 2,
    date: "01.05.2024",
    docNum: "0000017188",
    docType: "Ф-ра",
    amount: "72.89",
    vatGroup: 16,
    company: "СИ ЕЙЧ БИ КЪМПАНИ ЕООД",
    mol: "Евгени Терзийски",
    city: "София",
    address: "ул.Нишава 36 ет.1 оф.2",
    vatNumber: "BG202370897",
    eik: "202370897",
    reason: "Издадена фактура",
    vatAmount: "12.15",
  };

  it("should always use type 10", () => {
    const fields = buildVatLine(doc).split("|");
    expect(fields[0]).toBe("10");
  });

  it("should always use vatgroup 8", () => {
    const fields = buildVatLine(doc).split("|");
    expect(fields[5]).toBe("8");
  });

  it("should always have 'Плащане в брой' as reason", () => {
    const fields = buildVatLine(doc).split("|");
    expect(fields[13]).toBe("Плащане в брой");
  });

  it("should always have 0.00 as VAT amount", () => {
    const fields = buildVatLine(doc).split("|");
    expect(fields[15]).toBe("0.00");
  });

  it("should match PRODAJBIEXPORT payment line format", () => {
    const line = buildVatLine(doc);
    expect(line).toBe(
      "10|01.05.2024|0000017188|Ф-ра|72.89|8|СИ ЕЙЧ БИ КЪМПАНИ ЕООД|Евгени Терзийски|София|ул.Нишава 36 ет.1 оф.2|BG202370897|202370897|   |Плащане в брой| |0.00",
    );
  });

  it("should produce 16 fields", () => {
    const fields = buildVatLine(doc).split("|");
    expect(fields).toHaveLength(16);
  });
});

describe("CP1251 encoding", () => {
  it("should encode Cyrillic characters to CP1251", () => {
    const text = "Издадена фактура";
    const encoded = iconv.encode(text, "win1251");
    const decoded = iconv.decode(encoded, "win1251");
    expect(decoded).toBe(text);
  });

  it("should encode critical Bulgarian characters (Ш, Щ, Ъ, Ь, Ю, Я)", () => {
    const text = "ШЩЪЬЮЯ";
    const encoded = iconv.encode(text, "win1251");
    const decoded = iconv.decode(encoded, "win1251");
    expect(decoded).toBe(text);
  });

  it("should produce correct byte length for Cyrillic (1 byte per char in CP1251)", () => {
    const text = "АБВГ";
    const encoded = iconv.encode(text, "win1251");
    expect(encoded.length).toBe(4);
  });

  it("should handle mixed Latin and Cyrillic", () => {
    const line =
      "2|01.05.2024|0000017188|Ф-ра|72.89|16|ТЕСТ|Иван|София|ул.Тест 1|BG123|123|   |Издадена фактура| |12.15";
    const encoded = iconv.encode(line, "win1251");
    const decoded = iconv.decode(encoded, "win1251");
    expect(decoded).toBe(line);
  });
});

describe("full export line pairs", () => {
  it("should produce matching doc + VAT line pair for BG sales", () => {
    const doc: DocLineParams = {
      typeCode: 2,
      date: "03.05.2024",
      docNum: "0000017212",
      docType: "Ф-ра",
      amount: "103.69",
      vatGroup: 16,
      company: "Ескада Н ООД",
      mol: "Адриана Асенова",
      city: "Костинброд",
      address: "ъл. Вишня 2А",
      vatNumber: "BG131443087",
      eik: "131443087",
      reason: "Издадена фактура",
      vatAmount: "17.28",
    };

    const docLine = buildDocLine(doc);
    const vatLine = buildVatLine(doc);

    // Verify doc line fields
    const docFields = docLine.split("|");
    expect(docFields[0]).toBe("2");
    expect(docFields[5]).toBe("16");
    expect(docFields[15]).toBe("17.28");

    // Verify VAT line inherits same doc data
    const vatFields = vatLine.split("|");
    expect(vatFields[0]).toBe("10");
    expect(vatFields[1]).toBe(docFields[1]); // same date
    expect(vatFields[2]).toBe(docFields[2]); // same doc number
    expect(vatFields[4]).toBe(docFields[4]); // same amount
    expect(vatFields[5]).toBe("8"); // always 8
    expect(vatFields[15]).toBe("0.00"); // always 0
  });

  it("should produce correct pair for Greek purchase", () => {
    const doc: DocLineParams = {
      typeCode: 1,
      date: "10.05.2024",
      docNum: "0000000133",
      docType: "Ф-ра",
      amount: "964.06",
      vatGroup: 11,
      company: "DAGKOS ATHANASIOS",
      mol: "DAGKOS ATHANASIOS",
      city: "THESALONIKI",
      address: "CHRISOSTOMOU SMIRNIS 71 DIAVATA",
      vatNumber: "EL162507551",
      eik: "EL162507551",
      reason: "Получена фактура",
      vatAmount: "0.00",
    };

    const docFields = buildDocLine(doc).split("|");
    expect(docFields[0]).toBe("1");
    expect(docFields[5]).toBe("11");
    expect(docFields[15]).toBe("0.00");

    const vatFields = buildVatLine(doc).split("|");
    expect(vatFields[0]).toBe("10");
    expect(vatFields[5]).toBe("8");
  });

  it("should encode a full line pair to CP1251 and back", () => {
    const doc: DocLineParams = {
      typeCode: 2,
      date: "01.05.2024",
      docNum: "0000017188",
      docType: "Ф-ра",
      amount: "72.89",
      vatGroup: 16,
      company: "СИ ЕЙЧ БИ КЪМПАНИ ЕООД",
      mol: "Евгени Терзийски",
      city: "София",
      address: "ул.Нишава 36 ет.1 оф.2",
      vatNumber: "BG202370897",
      eik: "202370897",
      reason: "Издадена фактура",
      vatAmount: "12.15",
    };

    const content = [buildDocLine(doc), buildVatLine(doc)].join("\r\n");
    const encoded = iconv.encode(content, "win1251");
    const decoded = iconv.decode(encoded, "win1251");
    expect(decoded).toBe(content);
    expect(decoded).toContain("\r\n");
  });
});
