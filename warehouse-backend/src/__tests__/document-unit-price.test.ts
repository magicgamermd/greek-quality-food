import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { generateInvoicePdf } from "../services/invoice-pdf.js";
import { generateStockDispatchPdf } from "../services/document-pdf.js";
import { generateOfferPdf } from "../services/offer-pdf.js";

// Какво РЕАЛНО се печата в колоната „Цена“. Досегашните тестове на
// документите гледаха само брой страници и размер — затова никой не видя,
// че поръчка 259 (2.800 × 6.317 = 17.69) излиза с цена 6.318.
//
// Текстът в PDF-а е компресиран, затова следим какво се подава на
// PDFDocument.text.

const OUT_DIR = path.resolve("/tmp/gqf-unit-price-test-pdfs");

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
  name: "ДАР Г.Н. ООД",
  eik: "831556063",
  vat_number: "BG831556063",
  address: "жк Младост 3",
  city: "София",
};

// Поръчка 259, ред за ред.
const order259 = [
  {
    sku: "D1002",
    name_bg: "Баклавички",
    unit: "kg",
    quantity: 2.8,
    unit_price: 6.317,
    total_price: 17.69,
    discount_percent: 0,
  },
];

// Поръчка 202: същата цена с 10% отстъпка.
const order202 = [
  {
    sku: "D1109",
    name_bg: "Портокалопита",
    unit: "kg",
    quantity: 2.8,
    unit_price: 6.317,
    total_price: 15.92,
    discount_percent: 10,
  },
];

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

function invoiceData(items: any[], overrides: Record<string, any> = {}) {
  return {
    invoice: {
      invoice_number: "0000000259",
      invoice_date: "2026-09-23",
      total_net: 17.69,
      total_vat: 3.54,
      total_gross: 21.23,
    },
    partner,
    company,
    items,
    vatRate: 20,
    includeVat: true,
    documentType: "invoice",
    outputPath: path.join(OUT_DIR, `invoice-${Math.random()}.pdf`),
    ...overrides,
  } as any;
}

describe("печатна единична цена = въведената", () => {
  afterEach(() => {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  });

  it("фактура: 6,317 (не 6,318) и стойност 17,69", async () => {
    const texts = await printedStrings(() =>
      generateInvoicePdf(invoiceData(order259)),
    );
    expect(texts).toContain("6,317");
    expect(texts).not.toContain("6,318");
    expect(texts).toContain("17,69");
  });

  it("фактура с отстъпка: 5,685 (цената след 10%), не 5,686", async () => {
    const texts = await printedStrings(() =>
      generateInvoicePdf(
        invoiceData(order202, {
          invoice: {
            invoice_number: "0000000202",
            invoice_date: "2026-09-23",
            total_net: 15.92,
            total_vat: 3.18,
            total_gross: 19.1,
          },
        }),
      ),
    );
    expect(texts).toContain("5,685");
    expect(texts).not.toContain("5,686");
    expect(texts).toContain("15,92");
  });

  it("кредитно известие с отстъпка печата същата цена като фактурата", async () => {
    const texts = await printedStrings(() =>
      generateInvoicePdf(
        invoiceData(
          order202.map((item) => ({
            ...item,
            quantity: -2.8,
            total_price: -15.92,
          })),
          {
            documentType: "credit_note",
            relatedInvoiceNumber: "0000000202",
            invoice: {
              invoice_number: "КИ-0000000001",
              invoice_date: "2026-09-23",
              total_net: -15.92,
              total_vat: -3.18,
              total_gross: -19.1,
            },
          },
        ),
      ),
    );
    expect(texts).toContain("5,685");
  });

  it("стокова разписка: 6.317 (не 6.318)", async () => {
    const texts = await printedStrings(() =>
      generateStockDispatchPdf({
        doc_number: "SR-0000259",
        doc_date: "2026-09-23",
        company: company as any,
        partner: partner as any,
        items: order259.map((item) => ({ ...item, currency: "EUR" })),
        vat_rate: 20,
        outputPath: path.join(OUT_DIR, "dispatch.pdf"),
      } as any),
    );
    expect(texts).toContain("6.317");
    expect(texts).not.toContain("6.318");
  });

  it("стокова разписка: безплатен ред (стойност 0) не се превръща в кол. × цена", async () => {
    const texts = await printedStrings(() =>
      generateStockDispatchPdf({
        doc_number: "SR-0000260",
        doc_date: "2026-09-23",
        company: company as any,
        partner: partner as any,
        items: [
          { ...order259[0], currency: "EUR" },
          {
            sku: "GIFT",
            name_bg: "Мостра",
            unit: "kg",
            quantity: 3,
            unit_price: 4.317,
            total_price: 0,
            discount_percent: 100,
            currency: "EUR",
          },
        ],
        vat_rate: 20,
        outputPath: path.join(OUT_DIR, "dispatch-gift.pdf"),
      } as any),
    );
    // Сумата е само платеният ред: 17.69 + 20% = 21.23. Преди мострата
    // тихо ставаше 3 × 4.317 = 12.95 и вдигаше сумата.
    expect(
      texts.some((text) => text.includes("21.23") || text.includes("21,23")),
    ).toBe(true);
    expect(
      texts.some((text) => text.includes("12.95") || text.includes("12,95")),
    ).toBe(false);
  });

  it("оферта: 6,317 € и обща сума С ДДС като фактурата (21,23, не 17,69)", async () => {
    const texts = await printedStrings(() =>
      generateOfferPdf({
        offerNumber: "OF-0000259",
        date: "2026-09-23",
        partner: { name: partner.name },
        company: {
          name: company.company_name,
          eik: company.eik,
          address: company.address,
        },
        items: order259.map((item) => ({ ...item, unit: "kg" })),
        totalNet: 17.69,
        totalVat: 3.54,
        totalGross: 21.23,
        outputPath: path.join(OUT_DIR, "offer.pdf"),
      } as any),
    );
    expect(texts.some((text) => text.startsWith("6,317"))).toBe(true);
    expect(texts.some((text) => text.startsWith("6,318"))).toBe(false);
  });

  it("ИЗДАДЕНА преди поправката фактура се чертае точно както е издадена (6,318)", async () => {
    // Сървърът няма постоянен диск за PDF-ите — след всеки деплой старите
    // фактури се чертаят наново. Те трябва да изглеждат като издадените.
    const texts = await printedStrings(() =>
      generateInvoicePdf(
        invoiceData(order259, { unitPriceRule: "legacy_total_div_qty" }),
      ),
    );
    expect(texts).toContain("6,318");
    expect(texts).not.toContain("6,317");
    expect(texts).toContain("17,69");
  });

  it("нова фактура (правило entered) печата въведената цена", async () => {
    const texts = await printedStrings(() =>
      generateInvoicePdf(invoiceData(order259, { unitPriceRule: "entered" })),
    );
    expect(texts).toContain("6,317");
  });
});
