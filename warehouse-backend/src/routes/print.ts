// CUPS-direct printing for label-style documents — Econt waybills and
// stock-dispatch labels go straight to the configured Zebra printer
// without bouncing through the browser's print dialog. Other documents
// (invoice, warranty, offer, etc.) keep using window.print() so the
// cashier still sees a preview before paper is consumed.
//
// Implementation: read the PDF the front-end already fetched, write it
// to a temp file, exec `lp -d <queue> <file>`. Works on macOS out of
// the box once the printer is added in System Settings → Printers.

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { query } from "../db.js";
import { requirePermission, PERMISSIONS } from "../lib/permissions.js";

const execFileAsync = promisify(execFile);

const printSchema = z
  .object({
    // Path to a PDF on the backend's filesystem (returned by upstream
    // PDF endpoints in their `pdf_path` field). Validated to live inside
    // the data/documents or uploads directory before printing.
    pdf_path: z.string().min(1).optional(),
    // External PDF URL (e.g. Econt's labelPath). Backend fetches it and
    // writes to a temp file before spooling. Limited to https/http.
    pdf_url: z.string().url().optional(),
    // Order id — convenience: backend regenerates the matching PDF
    // (stock-dispatch / waybill) on demand without trusting paths.
    order_id: z.number().int().positive().optional(),
    doc_type: z.enum(["stock-dispatch", "waybill"]).optional(),
    copies: z.number().int().min(1).max(10).optional(),
  })
  .refine((d) => d.pdf_path || d.pdf_url || (d.order_id && d.doc_type), {
    message: "Must provide pdf_path, pdf_url, or {order_id, doc_type}",
  });

async function jwtVerify(request: FastifyRequest) {
  await request.jwtVerify();
}

const ordersManagePreHandler = [
  jwtVerify,
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
];

function isPathAllowed(p: string): boolean {
  // Resolve and confine to known roots so a malicious path can't escape.
  const abs = path.resolve(p);
  const allowedRoots = [
    path.resolve(process.cwd(), "data", "documents"),
    path.resolve(process.cwd(), "uploads"),
    path.resolve(
      process.cwd(),
      "/Applications/MERT-M/warehouse-backend/uploads",
    ),
    path.resolve(process.cwd(), "/Applications/MERT-M/warehouse-backend/data"),
  ];
  return allowedRoots.some(
    (root) => abs.startsWith(root + path.sep) || abs === root,
  );
}

export default async function printRoutes(app: FastifyInstance) {
  // POST /print/zebra — send a PDF straight to the configured Zebra
  // printer queue via CUPS. Used by the FE for waybill + stock-dispatch
  // labels; everything else still goes through the browser dialog.
  app.post(
    "/zebra",
    { preHandler: ordersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = printSchema.parse(request.body);

      const { rows } = await query(
        "SELECT zebra_printer_name FROM settings WHERE id = 1",
      );
      const rawName = rows[0]?.zebra_printer_name?.trim();
      if (!rawName) {
        return reply.status(400).send({
          error:
            "Zebra принтерът не е конфигуриран. Задайте име в Настройки → Принтери.",
        });
      }

      // CUPS queue names cannot contain spaces — when a printer was
      // installed with a friendly name like "Zebra LP2844", CUPS stores
      // it as "Zebra_LP2844". Resolve against `lpstat -p` so the cashier
      // can configure either form (and we error clearly when no match).
      let printer = rawName;
      try {
        const { stdout } = await execFileAsync("/usr/bin/lpstat", ["-p"], {
          timeout: 5000,
        });
        const queues: string[] = [];
        for (const line of stdout.split("\n")) {
          const m = /^printer\s+(\S+)/.exec(line);
          if (m) queues.push(m[1]);
        }
        const normalize = (s: string) =>
          s.toLowerCase().replace(/[\s_-]+/g, "");
        const target = normalize(rawName);
        const match = queues.find((q) => normalize(q) === target);
        if (match) {
          printer = match;
        } else {
          return reply.status(400).send({
            error: `Принтер „${rawName}" не е намерен в CUPS. Налични: ${
              queues.join(", ") || "(няма)"
            }`,
          });
        }
      } catch (err: any) {
        // lpstat failure is non-fatal — fall through with rawName and
        // let lp report the actual error.
        printer = rawName.replace(/\s+/g, "_");
      }

      // Resolve a local file path. For pdf_url we download to a temp
      // file and clean it up after spooling. pdf_path uses the backend's
      // own data/uploads dirs (path-allowlist enforced).
      let filePath: string;
      let cleanupPath: string | null = null;
      if (body.pdf_path) {
        if (!isPathAllowed(body.pdf_path)) {
          return reply
            .status(400)
            .send({ error: "Невалиден път до PDF файла." });
        }
        try {
          await fs.access(body.pdf_path);
        } catch {
          return reply
            .status(404)
            .send({ error: "PDF файлът не е намерен на сървъра." });
        }
        filePath = body.pdf_path;
      } else if (body.pdf_url) {
        const res = await fetch(body.pdf_url);
        if (!res.ok) {
          return reply
            .status(502)
            .send({ error: `Неуспешно изтегляне на PDF от ${body.pdf_url}` });
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 100 || buf[0] !== 0x25 /* '%' */) {
          return reply
            .status(400)
            .send({ error: "Получен файл не е валиден PDF." });
        }
        const tmp = path.join(
          os.tmpdir(),
          `print-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`,
        );
        await fs.writeFile(tmp, buf);
        filePath = tmp;
        cleanupPath = tmp;
      } else {
        return reply
          .status(400)
          .send({ error: "Подайте pdf_path или pdf_url." });
      }

      const args = ["-d", printer];
      if (body.copies && body.copies > 1) {
        args.push("-n", String(body.copies));
      }
      // Zebra LP2844 label settings. PDFs are now generated at the
      // exact label size (4x4 inch / 288 x 288 pt — see packing-label-
      // pdf.ts), so no scaling is needed: media=Custom.4x4in tells CUPS
      // the page size, ColorModel=Gray maps to monochrome thermal.
      // For external PDFs that aren't pre-sized (e.g. the Econt
      // waybill PDF, which comes back as A4) we still ask CUPS to fit
      // them, otherwise they'd get cropped at the label edge.
      args.push("-o", "media=Custom.4x4in");
      args.push("-o", "ColorModel=Gray");
      if (body.pdf_url) {
        args.push("-o", "fit-to-page");
      }
      args.push(filePath);

      try {
        const { stdout } = await execFileAsync("/usr/bin/lp", args, {
          timeout: 15000,
        });
        const jobIdMatch = /request id is (\S+)/.exec(stdout);
        return {
          ok: true,
          printer,
          job_id: jobIdMatch ? jobIdMatch[1] : null,
        };
      } catch (err: any) {
        return reply.status(500).send({
          error: `Грешка при изпращане към принтер: ${err.message ?? err}`,
        });
      } finally {
        if (cleanupPath) {
          fs.unlink(cleanupPath).catch(() => {});
        }
      }
    },
  );

  // GET /print/printers — list available CUPS queues so the Settings
  // page can offer a dropdown instead of free-text printer names.
  app.get("/printers", { preHandler: ordersManagePreHandler }, async () => {
    try {
      const { stdout } = await execFileAsync("/usr/bin/lpstat", ["-p"], {
        timeout: 5000,
      });
      // Lines look like: "printer Zebra_ZD420 is idle.  enabled since …"
      const printers: string[] = [];
      for (const line of stdout.split("\n")) {
        const m = /^printer\s+(\S+)/.exec(line);
        if (m) printers.push(m[1]);
      }
      return { printers };
    } catch (err: any) {
      // lpstat exits non-zero when there are no printers — that's fine,
      // return an empty list rather than 500.
      return { printers: [], error: err.message ?? String(err) };
    }
  });
}
