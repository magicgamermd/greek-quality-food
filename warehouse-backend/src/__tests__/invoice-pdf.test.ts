import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import {
  calculateLineSegments,
  generateInvoicePdf,
  measurePartyFieldsHeight,
} from "../services/invoice-pdf.js";

const TEST_OUTPUT_DIR = path.resolve("/tmp/mertm-test-pdfs");

function getPdfPageCount(filePath: string): number {
  const content = fs.readFileSync(filePath, "latin1");
  return (content.match(/\/Type\s*\/Page\b/g) || []).length;
}

function getTestData(overrides: Record<string, any> = {}) {
  return {
    invoice: {
      invoice_number: "GF-2026-0001",
      invoice_date: "2026-03-10",
      total_net: 100,
      total_vat: 20,
      total_gross: 120,
      ...overrides.invoice,
    },
    partner: {
      name: "Test Partner OOD",
      eik: "123456789",
      vat_number: "BG123456789",
      address: "ul. Test 1, Sofia",
      contact_person: "Ivan Petrov",
      ...overrides.partner,
    },
    company: overrides.company ?? {
      company_name: "BAKALIA GREEK DELI FOOD",
      address: "ул. Калогяново 14, 1618 София, България",
      eik: "202860357",
      vat_number: "BG202860357",
      iban: "BG80UNCR76301078901234",
      phone: "00886291003",
      email: "info@mertm.bg",
      bank_name: "UniCredit Bulbank",
      bic: "UNCRBGSF",
      mol: "Евгени Терзийски",
    },
    items: overrides.items ?? [
      {
        name_bg: "Зехтин",
        name_en: "Olive Oil",
        sku: "OIL-001",
        unit: "l",
        quantity: 10,
        unit_price: 10,
        total_price: 100,
      },
    ],
    vatRate: overrides.vatRate ?? 20,
    includeVat: overrides.includeVat ?? true,
    documentType: overrides.documentType ?? "invoice",
    relatedInvoiceNumber: overrides.relatedInvoiceNumber,
    outputPath: overrides.outputPath ?? path.join(TEST_OUTPUT_DIR, "test.pdf"),
    copies: overrides.copies, // pass-through; undefined if absent
  };
}

describe("generateInvoicePdf", () => {
  afterEach(() => {
    if (fs.existsSync(TEST_OUTPUT_DIR)) {
      fs.rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  it("generates standard, no-VAT, and credit note PDFs", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });

    const standardPath = path.join(TEST_OUTPUT_DIR, "invoice.pdf");
    await generateInvoicePdf(getTestData({ outputPath: standardPath }));
    expect(fs.existsSync(standardPath)).toBe(true);
    expect(fs.statSync(standardPath).size).toBeGreaterThan(1000);
    expect(getPdfPageCount(standardPath)).toBe(1);

    const noVatPath = path.join(TEST_OUTPUT_DIR, "no-vat.pdf");
    await generateInvoicePdf(
      getTestData({
        outputPath: noVatPath,
        includeVat: false,
        vatRate: 0,
        invoice: { total_vat: 0, total_gross: 100 },
      }),
    );
    expect(getPdfPageCount(noVatPath)).toBe(1);

    const creditPath = path.join(TEST_OUTPUT_DIR, "credit-note.pdf");
    await generateInvoicePdf(
      getTestData({
        outputPath: creditPath,
        documentType: "credit_note",
        relatedInvoiceNumber: "GF-2026-0001",
        invoice: {
          invoice_number: "КИ-0000000001",
          total_net: -100,
          total_vat: -20,
          total_gross: -120,
        },
        items: [
          {
            name_bg: "Зехтин",
            name_en: "Olive Oil",
            sku: "OIL-001",
            unit: "l",
            quantity: -10,
            unit_price: 10,
            total_price: -100,
          },
        ],
      }),
    );
    expect(getPdfPageCount(creditPath)).toBe(1);
  });

  it("handles string number values and multiple items", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "multi-items.pdf");
    await generateInvoicePdf(
      getTestData({
        outputPath,
        invoice: {
          total_net: "350.50",
          total_vat: "70.10",
          total_gross: "420.60",
        },
        items: [
          {
            name_bg: "Зехтин",
            name_en: "Olive Oil",
            sku: "OIL-001",
            unit: "l",
            quantity: "10",
            unit_price: "10.10",
            total_price: "101.00",
          },
          {
            name_bg: "Макарони",
            name_en: "Pasta",
            sku: "PST-001",
            unit: "kg",
            quantity: 5,
            unit_price: 20,
            total_price: 100,
          },
          {
            name_bg: "Мед",
            name_en: "Honey",
            sku: "HNY-001",
            unit: "kg",
            quantity: 3,
            unit_price: 50,
            total_price: 150,
          },
        ],
      }),
    );

    expect(fs.existsSync(outputPath)).toBe(true);
    expect(getPdfPageCount(outputPath)).toBe(1);
  });

  it('renders a single page labeled "Оригинал" by default (copies=1)', async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "single-copy.pdf");
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    let renderedStrings: string[] = [];

    try {
      await generateInvoicePdf(getTestData({ outputPath }));
      renderedStrings = textSpy.mock.calls
        .map(([text]) => (typeof text === "string" ? text : String(text ?? "")))
        .filter(Boolean);
    } finally {
      textSpy.mockRestore();
    }

    expect(getPdfPageCount(outputPath)).toBe(1);
    expect(renderedStrings).toContain("Оригинал");
  });

  it('renders two "Оригинал" pages when copies=2', async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "two-copies.pdf");
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    let renderedStrings: string[] = [];

    try {
      await generateInvoicePdf(getTestData({ outputPath, copies: 2 }));
      renderedStrings = textSpy.mock.calls
        .map(([text]) => (typeof text === "string" ? text : String(text ?? "")))
        .filter(Boolean);
    } finally {
      textSpy.mockRestore();
    }

    const originalLabels = renderedStrings.filter((s) => s === "Оригинал");
    expect(originalLabels.length).toBe(2);
    expect(getPdfPageCount(outputPath)).toBe(2);
  });

  it("splits wrapped table rows into predictable page segments", () => {
    expect(calculateLineSegments(120, [28, 40])).toEqual([28, 40, 40, 12]);
  });

  it("measures long header fields taller than short ones", () => {
    const doc = new PDFDocument({ autoFirstPage: false });
    doc.addPage();

    const shortHeight = measurePartyFieldsHeight(
      doc,
      [{ label: "Company", value: "Short Name" }],
      120,
    );
    const longHeight = measurePartyFieldsHeight(
      doc,
      [
        {
          label: "Company",
          value:
            "Very Long Company Name With Multiple Legal Identifiers And Additional Address Context That Must Wrap Cleanly Across Several Lines",
        },
      ],
      120,
    );

    expect(longHeight).toBeGreaterThan(shortHeight);
  });

  it("keeps long buyer and supplier headers stable without extra pages", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "long-header.pdf");

    await generateInvoicePdf(
      getTestData({
        outputPath,
        partner: {
          name: "Client Partner With Extended Legal Name, Additional Trade Name, Regional Branch, And Secondary Identifier",
          address:
            "бул. Дълъг адрес 123, вх. Б, ет. 8, ап. 24, Индустриална зона Запад, София 1618, България",
          city: "София - Западна промишлена зона с допълнително описание",
          contact_person: "Maria Petrova Georgieva-Kostadinova",
          card_number: "CL-2026-VERY-LONG-CUSTOMER-NUMBER-000123",
        },
        company: {
          company_name:
            "BAKALIA GREEK DELI FOOD TRADING AND DISTRIBUTION COMPANY WITH EXTENDED OFFICIAL NAME",
          address:
            "ул. Калогяново 14, складова база 7, район Витоша, София 1618, България",
          eik: "202860357",
          vat_number: "BG202860357",
          iban: "BG80UNCR76301078901234",
          phone: "00886291003 / 00359889999888",
          email: "very.long.finance.department@mertm.example.bg",
          bank_name: "UniCredit Bulbank Corporate Clients Division",
          bic: "UNCRBGSF",
          mol: "Евгени Терзийски - Управител и законен представител",
        },
      }),
    );

    expect(getPdfPageCount(outputPath)).toBe(1);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(1500);
  });

  it("handles long wrapped descriptions without page explosion", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "wrapped-descriptions.pdf");
    const longDescription = Array.from(
      { length: 24 },
      (_, idx) => `wrapped-description-segment-${idx + 1}`,
    ).join(" ");

    const items = Array.from({ length: 6 }, (_, idx) => ({
      name_bg: `Продукт ${idx + 1} ${longDescription}`,
      name_en: `Product ${idx + 1}`,
      sku: `SKU-${String(idx + 1).padStart(3, "0")}`,
      unit: "kg",
      quantity: 1 + idx / 10,
      unit_price: 10 + idx,
      total_price: (1 + idx / 10) * (10 + idx),
    }));

    await generateInvoicePdf(
      getTestData({
        outputPath,
        invoice: {
          total_net: items.reduce((sum, item) => sum + item.total_price, 0),
          total_vat:
            items.reduce((sum, item) => sum + item.total_price, 0) * 0.2,
          total_gross:
            items.reduce((sum, item) => sum + item.total_price, 0) * 1.2,
        },
        items,
      }),
    );

    const pageCount = getPdfPageCount(outputPath);
    expect(pageCount).toBeGreaterThanOrEqual(2);
    expect(pageCount).toBeLessThanOrEqual(4);
  });
});
