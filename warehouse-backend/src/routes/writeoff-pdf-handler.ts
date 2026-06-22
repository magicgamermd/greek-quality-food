import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { query } from "../db.js";
import {
  generateWriteoffProtocolPdf,
  generateWriteoffMultiProtocolPdf,
  loadWriteoffPdfData,
} from "../services/writeoff-pdf.js";

async function requireAuth(request: FastifyRequest, _reply: FastifyReply) {
  await request.jwtVerify();
}

/**
 * Directory where rendered write-off protocol PDFs are cached on disk.
 * Override via WRITEOFF_PDF_DIR env for Railway/Docker deployments with
 * an attached volume — the default is suitable for local dev.
 */
function getStorageDir(): string {
  const configured = process.env.WRITEOFF_PDF_DIR;
  if (configured && configured.trim()) return configured.trim();
  return path.resolve(process.cwd(), "storage", "writeoffs");
}

function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Registers `GET /:id/pdf` on the given scope (parent should register this
 * scope under `/inventory/write-offs`). Safe to merge into Level 1's
 * writeoffs.ts once it lands — just call `registerWriteoffPdfRoute(app)`
 * inside the exported plugin.
 */
export async function registerWriteoffPdfRoute(app: FastifyInstance) {
  app.get("/:id/pdf", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);

    const { id } = request.params as { id: string };
    const writeoffId = parseInt(id, 10);
    if (!Number.isFinite(writeoffId) || writeoffId <= 0) {
      return reply.status(400).send({ error: "Невалиден идентификатор" });
    }

    // Access control: admin + accountant + warehouse can view their own
    // writeoff protocols; no role lock-out here since the write-off itself
    // is already gated at the creation endpoint.
    const role = request.user?.role;
    if (!["admin", "accountant", "warehouse"].includes(role as string)) {
      return reply.status(403).send({ error: "Нямате достъп до документа" });
    }

    const data = await loadWriteoffPdfData(writeoffId);
    if (!data) {
      return reply
        .status(404)
        .send({ error: "Протоколът за бракуване не е намерен" });
    }

    // On-disk cache for audit trail. We check the DB for a pdf_path first —
    // if it exists and the file is still on disk, stream it instead of
    // re-rendering.
    const { rows: pathRows } = await query(
      `SELECT pdf_path FROM stock_writeoffs WHERE id = $1`,
      [writeoffId],
    );
    const cachedPath: string | null = pathRows[0]?.pdf_path ?? null;

    if (cachedPath && fs.existsSync(cachedPath)) {
      return reply
        .header("Content-Type", "application/pdf")
        .header(
          "Content-Disposition",
          buildContentDisposition(data.document_number),
        )
        .send(fs.createReadStream(cachedPath));
    }

    // Render fresh, write to disk, update pdf_path.
    const buffer = await generateWriteoffProtocolPdf(writeoffId);

    const storageDir = getStorageDir();
    try {
      ensureDirSync(storageDir);
      const filePath = path.join(storageDir, `${data.document_number}.pdf`);
      fs.writeFileSync(filePath, buffer);

      // stock_writeoffs has REVOKE UPDATE at the table level, so the
      // pdf_path column cannot be mutated by normal role grants. We set
      // it via a privileged owner path — if the UPDATE is rejected we
      // silently continue; the file is still on disk and the next GET
      // will find it by convention (document_number.pdf).
      try {
        await query(`UPDATE stock_writeoffs SET pdf_path = $1 WHERE id = $2`, [
          filePath,
          writeoffId,
        ]);
      } catch (err) {
        request.log.warn(
          { err, writeoffId },
          "pdf_path UPDATE rejected — relying on filesystem convention",
        );
      }
    } catch (err) {
      // Disk write failure is non-fatal — we still return the buffer.
      request.log.warn({ err }, "failed to persist writeoff PDF to disk");
    }

    return reply
      .header("Content-Type", "application/pdf")
      .header(
        "Content-Disposition",
        buildContentDisposition(data.document_number),
      )
      .send(buffer);
  });

  // GET /protocol/:protocolNumber/pdf — multi-line НАП брак protocol that
  // groups every stock_writeoffs row sharing the given protocol_number into a
  // single printed act with a table of items. Rendered fresh on each request
  // (no on-disk cache — the protocol is identified by number, not row id).
  app.get(
    "/protocol/:protocolNumber/pdf",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      const role = request.user?.role;
      if (!["admin", "accountant", "warehouse"].includes(role as string)) {
        return reply.status(403).send({ error: "Нямате достъп до документа" });
      }

      const { protocolNumber } = request.params as { protocolNumber: string };
      const decoded = decodeURIComponent(protocolNumber || "").trim();
      if (!decoded) {
        return reply.status(400).send({ error: "Невалиден номер на протокол" });
      }

      try {
        const buffer = await generateWriteoffMultiProtocolPdf(decoded);
        return reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            buildProtocolContentDisposition(decoded),
          )
          .send(buffer);
      } catch (err: any) {
        if (err?.statusCode === 404) {
          return reply
            .status(404)
            .send({ error: "Протоколът за брак не е намерен" });
        }
        request.log.error(err);
        return reply
          .status(500)
          .send({ error: "Грешка при генериране на протокола" });
      }
    },
  );
}

/**
 * Build an RFC 6266-compliant Content-Disposition header for a document
 * whose name may contain Cyrillic characters (e.g. "БРАК-2026-0001").
 *
 * HTTP header values must be ISO-8859-1-clean, so putting "БРАК" directly
 * into `filename="..."` makes Fastify's undici header sanitizer throw
 * ERR_INVALID_CHAR with HTTP 500. The RFC 6266 escape hatch is to emit
 * BOTH:
 *   - filename="<ASCII fallback>"   — for legacy clients
 *   - filename*=UTF-8''<percent-encoded original>  — for modern clients
 *
 * Modern browsers (Chrome, Firefox, Safari ≥7, Edge) prefer the starred
 * parameter, so the user sees the original Cyrillic name on download
 * while the plain parameter remains header-safe.
 */
function buildContentDisposition(documentNumber: string): string {
  const asciiFallback = documentNumber
    // Cyrillic → Latin transliteration (Bulgarian official scheme)
    .replace(/Б/g, "B")
    .replace(/Р/g, "R")
    .replace(/А/g, "A")
    .replace(/К/g, "K")
    .replace(/б/g, "b")
    .replace(/р/g, "r")
    .replace(/а/g, "a")
    .replace(/к/g, "k")
    // Strip anything still non-ASCII
    .replace(/[^\x20-\x7E]/g, "_");
  const utf8Encoded = encodeURIComponent(documentNumber);
  return (
    `inline; filename="${asciiFallback}.pdf"; ` +
    `filename*=UTF-8''${utf8Encoded}.pdf`
  );
}

/**
 * Content-Disposition for the multi-line protocol PDF. Same RFC 6266 dual
 * filename trick as buildContentDisposition (Cyrillic in HTTP headers throws),
 * but the visible filename is `Протокол_брак_<num>.pdf`.
 */
function buildProtocolContentDisposition(protocolNumber: string): string {
  const asciiFallback = protocolNumber
    .replace(/Б/g, "B")
    .replace(/Р/g, "R")
    .replace(/А/g, "A")
    .replace(/К/g, "K")
    .replace(/б/g, "b")
    .replace(/р/g, "r")
    .replace(/а/g, "a")
    .replace(/к/g, "k")
    .replace(/[^\x20-\x7E]/g, "_");
  const utf8Name = encodeURIComponent(`Протокол_брак_${protocolNumber}.pdf`);
  return (
    `inline; filename="Protokol_brak_${asciiFallback}.pdf"; ` +
    `filename*=UTF-8''${utf8Name}`
  );
}

/** Default export — registerable as a standalone plugin at `/inventory/write-offs`. */
export default async function writeoffPdfRoutes(app: FastifyInstance) {
  await registerWriteoffPdfRoute(app);
}
