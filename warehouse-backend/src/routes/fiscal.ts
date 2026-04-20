import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  printReceiptForOrder,
  getFiscalStatus,
  printDailyReport,
  printFiscalReceipt,
  getFiscalSettings,
} from "../services/fiscal-printer.js";

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  if (request.user.role !== "admin") {
    throw Object.assign(new Error("Admin access required"), {
      statusCode: 403,
    });
  }
}

const receiptSchema = z.object({
  order_id: z.number().int().positive(),
  payment_type: z.enum(["cash", "card", "bank"]).default("cash"),
});

const reportSchema = z.object({
  type: z.enum(["Z", "X"]).default("Z"),
});

export default async function fiscalRoutes(app: FastifyInstance) {
  // POST /fiscal/receipt — print fiscal receipt for an order
  app.post("/receipt", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (reply.statusCode >= 400) return;

    const body = receiptSchema.parse(request.body);
    const result = await printReceiptForOrder(body.order_id);

    if (!result.success) {
      return reply.status(500).send({
        error: "Грешка при печат на фискален бон",
        details: result.error,
      });
    }

    return {
      message: "Фискален бон отпечатан успешно",
      receiptNumber: result.receiptNumber,
    };
  });

  // GET /fiscal/status — get printer status
  app.get("/status", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (reply.statusCode >= 400) return;

    const status = await getFiscalStatus();
    return status;
  });

  // POST /fiscal/daily-report — generate daily Z or X report
  app.post(
    "/daily-report",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request, reply);
      if (reply.statusCode >= 400) return;

      const body = reportSchema.parse(request.body || {});
      const result = await printDailyReport(body.type);

      if (!result.success) {
        return reply.status(500).send({
          error: "Грешка при генериране на дневен отчет",
          details: result.error,
        });
      }

      return {
        message:
          body.type === "Z"
            ? "Z-отчет генериран успешно"
            : "X-отчет генериран успешно",
        closure: result.receiptNumber,
      };
    },
  );

  // POST /fiscal/test — print test receipt
  app.post("/test", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAdmin(request, reply);
    if (reply.statusCode >= 400) return;

    const testItems = [
      {
        name: "Тест продукт",
        quantity: 1,
        unitPrice: 0.01,
        taxGroup: "Б",
      },
    ];

    const result = await printFiscalReceipt(testItems, "cash");

    if (!result.success) {
      return reply.status(500).send({
        error: "Грешка при тестов печат",
        details: result.error,
      });
    }

    return {
      message: "Тестов бон отпечатан успешно",
      receiptNumber: result.receiptNumber,
    };
  });

  // GET /fiscal/config — get fiscal printer configuration
  app.get("/config", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAdmin(request, reply);
    if (reply.statusCode >= 400) return;

    const settings = await getFiscalSettings();
    // Don't expose operator password in response
    return {
      ...settings,
      fiscal_operator_password: settings.fiscal_operator_password ? "****" : "",
    };
  });
}
