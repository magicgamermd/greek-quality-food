import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import {
  generateCommercialDocPdf,
  generateIncomingStockReceiptPdf,
  generateStockDispatchPdf,
} from "../services/document-pdf.js";

const TEST_OUTPUT_DIR = path.resolve("/tmp/mertm-document-test-pdfs");

function getPdfPageCount(filePath: string): number {
  const content = fs.readFileSync(filePath, "latin1");
  return (content.match(/\/Type\s*\/Page\b/g) || []).length;
}

const company = {
  company_name: "BAKALIA GREEK DELI FOOD",
  address: "ул. Калогяново 14, София 1618, България",
  city: "София",
  eik: "202860357",
  vat_number: "BG202860357",
  phone: "0886291003",
  mol: "Евгени Терзийски",
  vet_reg_number: "BG-12345-678",
};

const partner = {
  name: "Test Partner OOD",
  eik: "123456789",
  vat_number: "BG123456789",
  address: "ул. Тест 1, София",
  city: "София",
  phone: "0888123456",
  mol: "Иван Петров",
};

describe("document pdf layout regression", () => {
  afterEach(() => {
    if (fs.existsSync(TEST_OUTPUT_DIR)) {
      fs.rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
    }
  });


  it("стоковата разписка показва ДДС ред, когато цените са БЕЗ ДДС", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "incoming-vat-added.pdf");
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    let rendered: string[] = [];

    try {
      await generateIncomingStockReceiptPdf({
        doc_number: "ISR-VAT-1",
        doc_date: "2026-03-12",
        buyer: partner,
        supplier: partner,
        // 10 × 5.00 = 50.00 без ДДС → ДДС 20% = 10.00 → общо 60.00
        items: [
          {
            sku: "SKU-1",
            name_bg: "Зехтин",
            unit: "l",
            quantity: 10,
            unit_price: 5,
            total_price: 50,
            currency: "EUR",
          },
        ],
        vat_rate: 20,
        prices_include_vat: false,
        outputPath,
      });
      rendered = textSpy.mock.calls
        .map(([t]) => (typeof t === "string" ? t : String(t ?? "")))
        .filter(Boolean);
    } finally {
      textSpy.mockRestore();
    }

    expect(rendered).toContain("Данъчна основа:");
    expect(rendered).toContain("ДДС 20%:");
    expect(rendered).toContain("Общо с ДДС:");
    // Сумите: основа 50, ДДС 10, общо 60.
    expect(rendered).toContain("50.00 EUR");
    expect(rendered).toContain("10.00 EUR");
    expect(rendered).toContain("60.00 EUR");
  });

  it("при вградено ДДС показва „в т.ч.“ и НЕ начислява втори път", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "incoming-vat-included.pdf");
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    let rendered: string[] = [];

    try {
      await generateIncomingStockReceiptPdf({
        doc_number: "ISR-VAT-2",
        doc_date: "2026-03-12",
        buyer: partner,
        supplier: partner,
        // 10 × 6.00 = 60.00 вече С ДДС → основа 50.00, в т.ч. ДДС 10.00
        items: [
          {
            sku: "SKU-1",
            name_bg: "Зехтин",
            unit: "l",
            quantity: 10,
            unit_price: 6,
            total_price: 60,
            currency: "EUR",
          },
        ],
        vat_rate: 20,
        prices_include_vat: true,
        outputPath,
      });
      rendered = textSpy.mock.calls
        .map(([t]) => (typeof t === "string" ? t : String(t ?? "")))
        .filter(Boolean);
    } finally {
      textSpy.mockRestore();
    }

    expect(rendered).toContain("в т.ч. ДДС 20%:");
    expect(rendered).toContain("Общо (с ДДС):");
    // Крайното е 60.00 — не 72.00. Точно това щеше да е двойното ДДС.
    expect(rendered).toContain("60.00 EUR");
    expect(rendered).not.toContain("72.00 EUR");
  });

  it("без ставка разписката изглежда както преди (без ДДС редове)", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "incoming-no-vat.pdf");
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    let rendered: string[] = [];

    try {
      await generateIncomingStockReceiptPdf({
        doc_number: "ISR-VAT-3",
        doc_date: "2026-03-12",
        buyer: partner,
        supplier: partner,
        items: [
          {
            sku: "SKU-1",
            name_bg: "Зехтин",
            unit: "l",
            quantity: 10,
            unit_price: 5,
            total_price: 50,
            currency: "EUR",
          },
        ],
        outputPath,
      });
      rendered = textSpy.mock.calls
        .map(([t]) => (typeof t === "string" ? t : String(t ?? "")))
        .filter(Boolean);
    } finally {
      textSpy.mockRestore();
    }

    expect(rendered).toContain("Общо:");
    expect(rendered.some((t) => t.startsWith("ДДС "))).toBe(false);
    expect(rendered).not.toContain("Данъчна основа:");
  });

  it("keeps incoming receipt buyer and supplier boxes stable with long text", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "incoming-party-boxes.pdf");

    await generateIncomingStockReceiptPdf({
      doc_number: "ISR-2026-0001",
      doc_date: "2026-03-12",
      reference_number: "GF-2026-0001",
      buyer: {
        ...partner,
        name: "Buyer With Extremely Long Legal Name And Additional Branch Identifier For Logistics And Procurement Department",
        address:
          "бул. Много дълъг адрес 123, склад 7, вход Б, ет. 4, София, България, с допълнително описание за приемна зона",
        city: "София - западна логистична зона с допълнително уточнение",
        mol: "Мария Петрова Георгиева-Костадинова",
      },
      supplier: {
        ...partner,
        name: "Supplier With Long Official Name, Secondary Trade Name, And Pan-European Distribution Identifier",
        address:
          "ул. Доставчик 42, индустриален парк север, хале 18, София, България, сектор B2",
        city: "София - северен индустриален парк",
        mol: "Никола Димитров Александров",
      },
      warehouse_name:
        "Основен входящ склад с разширено описание за тест на оформлението",
      items: [
        {
          sku: "SKU-001",
          name_bg: "Зехтин",
          unit: "l",
          quantity: 10,
          unit_price: 5,
          total_price: 50,
          currency: "EUR",
          discount_percent: 0,
        },
      ],
      outputPath,
    });

    expect(getPdfPageCount(outputPath)).toBe(1);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(1500);
  });

  it("renders stock dispatch with template-style sections on a single page", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(
      TEST_OUTPUT_DIR,
      "stock-dispatch-template.pdf",
    );

    await generateStockDispatchPdf({
      doc_number: "SD-2026-0001",
      doc_date: "2026-03-12",
      company,
      partner,
      warehouse_name: "Склад Овча Купел",
      items: [
        {
          sku: "SKU-001",
          name_bg: "Екстра върджин зехтин Каламата",
          unit: "l",
          quantity: 3.125,
          unit_price: 8.4,
          total_price: 24.89,
          currency: "EUR",
          discount_percent: 5.5,
        },
        {
          sku: "SKU-002",
          name_bg: "Фета PDO вакуум разфасовка",
          unit: "kg",
          quantity: 1.75,
          unit_price: 12.8,
          total_price: 22.4,
          currency: "EUR",
        },
      ],
      vat_rate: 20,
      outputPath,
    });

    expect(getPdfPageCount(outputPath)).toBe(1);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(2000);
  });

  it("paginates long stock dispatch descriptions without runaway pages", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(
      TEST_OUTPUT_DIR,
      "stock-dispatch-multipage.pdf",
    );
    const longDescription = Array.from(
      { length: 34 },
      (_, idx) => `dispatch-line-${idx + 1}`,
    ).join(" ");
    const items = Array.from({ length: 18 }, (_, idx) => ({
      sku: `SKU-${idx + 1}`,
      name_bg: `Стокова позиция ${idx + 1} ${longDescription}`,
      unit: "kg",
      quantity: 1.25 + idx / 20,
      unit_price: 8 + idx,
      total_price: (1.25 + idx / 20) * (8 + idx),
      currency: "EUR",
      discount_percent: idx % 3 === 0 ? 1.5 : 0,
    }));

    await generateStockDispatchPdf({
      doc_number: "SD-2026-0002",
      doc_date: "2026-03-12",
      company,
      partner,
      warehouse_name: "Основен склад",
      items,
      vat_rate: 20,
      outputPath,
    });

    const pageCount = getPdfPageCount(outputPath);
    expect(pageCount).toBeGreaterThan(1);
    expect(pageCount).toBeLessThanOrEqual(5);
  });

  it("keeps commercial document multi-page output stable", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "commercial-document.pdf");
    const longDescription = Array.from(
      { length: 28 },
      (_, idx) => `commercial-segment-${idx + 1}`,
    ).join(" ");
    const items = Array.from({ length: 22 }, (_, idx) => ({
      sku: `CMD-${idx + 1}`,
      name_bg: `Търговски артикул ${idx + 1} ${longDescription}`,
      unit: "pcs",
      quantity: 2 + idx,
      batch_number: `BATCH-${2026000 + idx}`,
      expiry_date: "2027-12-31",
    }));

    await generateCommercialDocPdf({
      doc_number: "CD-2026-0001",
      doc_date: "2026-03-12",
      company,
      partner: {
        ...partner,
        name: "Commercial Partner With Long Name For Repeated Header Regression Coverage",
      },
      items,
      outputPath,
    });

    const pageCount = getPdfPageCount(outputPath);
    expect(pageCount).toBeGreaterThan(1);
    expect(pageCount).toBeLessThanOrEqual(5);
  });

  it("renders sale wording and EUR amount in words for order documents", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const stockOutputPath = path.join(
      TEST_OUTPUT_DIR,
      "stock-dispatch-wording.pdf",
    );
    const commercialOutputPath = path.join(
      TEST_OUTPUT_DIR,
      "commercial-wording.pdf",
    );
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    let renderedStrings: string[] = [];

    try {
      await generateStockDispatchPdf({
        doc_number: "SD-2026-0003",
        doc_date: "2026-03-12",
        company,
        partner,
        warehouse_name: "Склад Овча Купел",
        items: [
          {
            sku: "SKU-003",
            name_bg: "Каламата маслини",
            unit: "kg",
            quantity: 2,
            unit_price: 10,
            total_price: 20,
            currency: "EUR",
            discount_percent: 0,
          },
        ],
        vat_rate: 20,
        outputPath: stockOutputPath,
      });

      await generateCommercialDocPdf({
        doc_number: "CD-2026-0002",
        doc_date: "2026-03-12",
        company,
        partner,
        items: [
          {
            sku: "CMD-1",
            name_bg: "Сирене фета",
            unit: "pcs",
            quantity: 3,
            batch_number: "BATCH-1",
            expiry_date: "2027-12-31",
          },
        ],
        outputPath: commercialOutputPath,
      });

      renderedStrings = textSpy.mock.calls
        .map(([text]) => (typeof text === "string" ? text : String(text ?? "")))
        .filter(Boolean);
    } finally {
      textSpy.mockRestore();
    }

    expect(renderedStrings).toContain("Стокова разписка");
    expect(renderedStrings).toContain("за продажба на стоки");
    expect(renderedStrings).toContain("Търговски документ");
    expect(renderedStrings).toContain(
      "Декларирам, че горепосочените продукти са предназначени за човешка консумация и са произведени съгласно регламентите на ЕС, касаещи безопасността на храните.",
    );
    expect(renderedStrings).toContain("Словом: Двадесет и четири евро");
    expect(renderedStrings).not.toContain(
      "Словом: Четиридесет и шест лева и 94 ст.",
    );
    expect(fs.statSync(stockOutputPath).size).toBeGreaterThan(1500);
    expect(fs.statSync(commercialOutputPath).size).toBeGreaterThan(1500);
  });

  it("renders EUR cents in words for stock dispatch without abbreviated Bulgarian suffix", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(
      TEST_OUTPUT_DIR,
      "stock-dispatch-eur-cents.pdf",
    );
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    let renderedStrings: string[] = [];

    try {
      await generateStockDispatchPdf({
        doc_number: "SD-2026-0004",
        doc_date: "2026-03-12",
        company,
        partner,
        warehouse_name: "Склад Овча Купел",
        items: [
          {
            sku: "SKU-004",
            name_bg: "Тахан халва",
            unit: "pcs",
            quantity: 1,
            unit_price: 1.78,
            total_price: 1.78,
            currency: "EUR",
            discount_percent: 0,
          },
        ],
        vat_rate: 0,
        outputPath,
      });

      renderedStrings = textSpy.mock.calls
        .map(([text]) => (typeof text === "string" ? text : String(text ?? "")))
        .filter(Boolean);
    } finally {
      textSpy.mockRestore();
    }

    expect(renderedStrings).toContain("Словом: Едно евро и 78 цента");
    expect(renderedStrings).not.toContain("Словом: Едно евро и 78 е.ц.");
    expect(fs.statSync(outputPath).size).toBeGreaterThan(1500);
  });
});
