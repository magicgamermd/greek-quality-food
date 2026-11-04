// Колона „Т.О. %“ на печатните документи (Microinvest, 04.11.2026;
// magic: „на всички нови документи“). Новият документ печата цената
// ПРЕДИ отстъпката, отстъпката и записаната стойност; вече издаденият
// (print_line_discount = false) — точно както е издаден: само цената
// след отстъпката. Без отстъпка на нито един ред колоната не се показва.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { generateInvoicePdf } from "../services/invoice-pdf.js";
import { generateStockDispatchPdf } from "../services/document-pdf.js";
import { generateOfferPdf } from "../services/offer-pdf.js";
import { generateProtocolPdf } from "../services/protocol-pdf.js";
import {
  computeLineTotal,
  documentShowsLineDiscount,
  formatDiscountPercent,
} from "../lib/line-pricing.js";

const OUT_DIR = path.resolve("/tmp/gqf-line-discount-test-pdfs");

const company = {
  company_name: "ГРИИК КУОЛИТИ ФУУД ООД",
  address: "гр. София, р-н Овча купел, Калояново 14",
  eik: "208708334",
  vat_number: "BG208708334",
  iban: "BG06UNCR70001527560715",
  bank_name: "УНИКРЕДИТ БУЛБАНК АД",
  bic: "UNCRBGSF",
  mol: "Светлин Стойнев",
};

const partner = {
  name: "3 МАТ ЕООД",
  eik: "175009142",
  vat_number: "BG175009142",
  address: "ул. Тестова 1",
  city: "София",
};

// 2,8 кг по 6,317 € с 7,5 % отстъпка → 16,36 (цена след отстъпка 5,843).
const discounted = {
  sku: "D1109",
  name_bg: "Портокалопита",
  name_en: "Orange pie",
  unit: "kg",
  quantity: 2.8,
  unit_price: 6.317,
  discount_percent: 7.5,
  total_price: computeLineTotal(2.8, 6.317, 7.5),
};
const plain = {
  sku: "D1002",
  name_bg: "Баклавички",
  name_en: "Baklava",
  unit: "kg",
  quantity: 2.8,
  unit_price: 6.317,
  discount_percent: 0,
  total_price: 17.69,
};

async function printedStrings(render: () => Promise<void>): Promise<string[]> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const spy = vi.spyOn(PDFDocument.prototype, "text");
  try {
    await render();
    return spy.mock.calls
      .map(([text]) => (typeof text === "string" ? text : String(text ?? "")))
      .filter(Boolean);
  } finally {
    spy.mockRestore();
  }
}

const out = (name: string) =>
  path.join(OUT_DIR, `${name}-${Math.random()}.pdf`);

function invoiceData(items: any[], overrides: Record<string, any> = {}) {
  return {
    invoice: {
      invoice_number: "0000000500",
      invoice_date: "2026-11-05",
      total_net: 34.05,
      total_vat: 6.81,
      total_gross: 40.86,
    },
    partner,
    company,
    items,
    vatRate: 20,
    includeVat: true,
    documentType: "invoice",
    unitPriceRule: "entered",
    outputPath: out("invoice"),
    ...overrides,
  } as any;
}

describe("правилото: кога има колона „Т.О. %“", () => {
  it("само нов документ и само ако някой ред има отстъпка", () => {
    expect(documentShowsLineDiscount(true, [plain, discounted])).toBe(true);
    expect(documentShowsLineDiscount(true, [plain])).toBe(false);
    expect(documentShowsLineDiscount(false, [discounted])).toBe(false);
    expect(documentShowsLineDiscount(undefined, [discounted])).toBe(false);
  });

  it("отстъпката за печат: „7,5“, „10“, празно при 0", () => {
    expect(formatDiscountPercent(7.5)).toBe("7,5");
    expect(formatDiscountPercent(7.5, ".")).toBe("7.5");
    expect(formatDiscountPercent("10.00")).toBe("10");
    expect(formatDiscountPercent(0)).toBe("");
    expect(formatDiscountPercent(null)).toBe("");
  });
});

describe("фактура / проформа", () => {
  afterEach(() => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

  it("нова фактура: цена преди отстъпката, Т.О. % и записаната стойност", async () => {
    const texts = await printedStrings(() =>
      generateInvoicePdf(
        invoiceData([plain, discounted], { lineDiscountColumn: true }),
      ),
    );
    expect(texts).toContain("Т.О. %");
    expect(texts).toContain("7,5");
    expect(texts).toContain("16,36");
    // и на реда с отстъпка цената е 6,317, не 5,843
    expect(texts.filter((t) => t === "6,317")).toHaveLength(2);
    expect(texts).not.toContain("5,843");
  });

  it("издадена фактура (без флаг) — както е издадена: цената след отстъпката", async () => {
    const texts = await printedStrings(() =>
      generateInvoicePdf(invoiceData([plain, discounted])),
    );
    expect(texts).not.toContain("Т.О. %");
    expect(texts).toContain("5,843");
    expect(texts).toContain("16,36");
  });

  it("нова фактура без отстъпки — без колона", async () => {
    const texts = await printedStrings(() =>
      generateInvoicePdf(invoiceData([plain], { lineDiscountColumn: true })),
    );
    expect(texts).not.toContain("Т.О. %");
    expect(texts).toContain("6,317");
  });

  it("без ДДС (износ) и на английски — също", async () => {
    const texts = await printedStrings(() =>
      generateInvoicePdf(
        invoiceData([discounted], {
          lineDiscountColumn: true,
          includeVat: false,
          lang: "en",
        }),
      ),
    );
    expect(texts).toContain("Disc. %");
    expect(texts).toContain("7,5");
    expect(texts).toContain("6,317");
  });
});

describe("стокова разписка, оферта, протокол", () => {
  afterEach(() => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

  const dispatch = (show: boolean | undefined) =>
    generateStockDispatchPdf({
      doc_number: "SR-0000500",
      doc_date: "2026-11-05",
      company: { ...company, city: "София" } as any,
      partner: partner as any,
      items: [plain, discounted] as any,
      vat_rate: 20,
      outputPath: out("dispatch"),
      show_line_discount: show,
    });

  // Стоковата разписка печата цените с точка — и отстъпката.
  it("стокова разписка на нова поръчка: Цена · Т.О. % · Валута · Ст-ст", async () => {
    const texts = await printedStrings(() => dispatch(true));
    expect(texts).toContain("Т.О. %");
    expect(texts).toContain("7.5");
    expect(texts.filter((t) => t === "6.317")).toHaveLength(2);
    expect(texts).not.toContain("5.843");
  });

  it("стокова разписка на стара поръчка — без колона", async () => {
    const texts = await printedStrings(() => dispatch(undefined));
    expect(texts).not.toContain("Т.О. %");
    expect(texts).toContain("5.843");
  });

  const offer = (show: boolean) =>
    generateOfferPdf({
      offerNumber: "OF-0000500",
      date: "2026-11-05",
      partner: partner as any,
      company: {
        name: company.company_name,
        eik: company.eik,
        vat_number: company.vat_number,
        address: company.address,
      } as any,
      items: [plain, discounted] as any,
      totalNet: 34.05,
      totalVat: 6.81,
      totalGross: 40.86,
      outputPath: out("offer"),
      showLineDiscount: show,
    } as any);

  it("оферта: с колона на нова поръчка, без — на стара", async () => {
    const withColumn = await printedStrings(() => offer(true));
    expect(withColumn).toContain("Т.О. %");
    expect(withColumn).toContain("7,5");
    expect(withColumn.some((t) => t.startsWith("5,843"))).toBe(false);
    const asIssued = await printedStrings(() => offer(false));
    expect(asIssued).not.toContain("Т.О. %");
    expect(asIssued.some((t) => t.startsWith("5,843"))).toBe(true);
  });

  const protocol = (show: boolean) =>
    generateProtocolPdf({
      protocolNumber: "PR-0000500",
      orderNumber: 500,
      date: "2026-11-05",
      place: "София",
      seller: {
        name: company.company_name,
        eik: company.eik,
        vat_number: company.vat_number,
        address: company.address,
        rep: company.mol,
      },
      buyer: {
        name: partner.name,
        eik: partner.eik,
        vat_number: partner.vat_number,
        address: partner.address,
        rep: "",
      },
      items: [plain, discounted],
      totalAmount: 34.05,
      outputPath: out("protocol"),
      showLineDiscount: show,
    } as any);

  it("протокол: с колона на нова поръчка, без — на стара", async () => {
    const withColumn = await printedStrings(() => protocol(true));
    expect(withColumn).toContain("Т.О. %");
    expect(withColumn).toContain("7,5");
    const asIssued = await printedStrings(() => protocol(false));
    expect(asIssued).not.toContain("Т.О. %");
  });
});
