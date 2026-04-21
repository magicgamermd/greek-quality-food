import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "node:fs";
import path from "node:path";

function getFontPath(filename: string): string {
  const candidates = [
    path.resolve(__dirname, "..", "fonts", filename),
    path.resolve(__dirname, "..", "..", "src", "fonts", filename),
    path.resolve(process.cwd(), "src", "fonts", filename),
    path.resolve(process.cwd(), "dist", "fonts", filename),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`Font not found: ${filename}`);
}

function getTemplatePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "assets", "warranty-card-template.pdf"),
    path.resolve(__dirname, "..", "..", "assets", "warranty-card-template.pdf"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("warranty-card-template.pdf not found");
}

export interface WarrantyCardData {
  serial_number: string;
  outputPath: string;
}

const SERIAL_POSITION = { x: 395, y: 772 };

export async function generateWarrantyCardPdf(
  data: WarrantyCardData,
): Promise<void> {
  const templateBytes = fs.readFileSync(getTemplatePath());
  const pdfDoc = await PDFDocument.load(templateBytes);
  pdfDoc.registerFontkit(fontkit);

  const boldBytes = fs.readFileSync(getFontPath("Roboto-Bold.ttf"));
  const fontBold = await pdfDoc.embedFont(boldBytes);

  const page = pdfDoc.getPages()[0];
  const accent = rgb(0.1, 0.23, 0.43);

  page.drawText(`Сериен №: ${data.serial_number}`, {
    x: SERIAL_POSITION.x,
    y: SERIAL_POSITION.y,
    size: 10,
    font: fontBold,
    color: accent,
  });

  const out = await pdfDoc.save();
  fs.writeFileSync(data.outputPath, out);
}
