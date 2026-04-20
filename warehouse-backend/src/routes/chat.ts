import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db.js";
import { ChatRequestSchema, type ChatMessage } from "./chat-schemas.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.CHAT_MODEL || "anthropic/claude-3.5-haiku";
const MAX_TOOL_TURNS = 3;

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: "unauthorized" });
  }
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search products by SKU/name (Bulgarian+translit).",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order",
      description: "Fetch one order with items by id.",
      parameters: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_orders",
      description: "List orders with optional status/date filters.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string" },
          date_from: { type: "string" },
          date_to: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_invoice",
      description: "Generate an invoice for an order.",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "integer" },
          include_vat: { type: "boolean" },
        },
        required: ["order_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_econt_shipment",
      description:
        "Create an Econt waybill for an order. Requires econt_* fields populated on the order.",
      parameters: {
        type: "object",
        properties: { order_id: { type: "integer" } },
        required: ["order_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "track_shipment",
      description: "Get Econt shipment status by number.",
      parameters: {
        type: "object",
        properties: { shipment_number: { type: "string" } },
        required: ["shipment_number"],
      },
    },
  },
];

async function runTool(
  name: string,
  args: Record<string, unknown>,
  jwt: string,
  baseUrl: string,
): Promise<unknown> {
  switch (name) {
    case "search_products": {
      const q = String(args.query ?? "");
      const r = await query(
        `SELECT id, name, sku, stock_level, selling_price
           FROM products
          WHERE (name ILIKE $1 OR sku ILIKE $1)
            AND deleted_at IS NULL
          LIMIT 10`,
        [`%${q}%`],
      );
      return { products: r.rows };
    }
    case "get_order": {
      const id = Number(args.id);
      const r = await query(`SELECT * FROM orders WHERE id = $1`, [id]);
      if (!r.rows[0]) return { error: "order_not_found" };
      const items = await query(
        `SELECT oi.*, p.name AS product_name
           FROM order_items oi JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = $1`,
        [id],
      );
      return { order: r.rows[0], items: items.rows };
    }
    case "list_orders": {
      const status = args.status ? String(args.status) : null;
      const dateFrom = args.date_from ? String(args.date_from) : null;
      const dateTo = args.date_to ? String(args.date_to) : null;
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (status) {
        params.push(status);
        clauses.push(`status = $${params.length}`);
      }
      if (dateFrom) {
        params.push(dateFrom);
        clauses.push(`order_date >= $${params.length}`);
      }
      if (dateTo) {
        params.push(dateTo);
        clauses.push(`order_date <= $${params.length}`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const r = await query(
        `SELECT id, order_number, partner_id, status, order_date, total_price
           FROM orders ${where}
          ORDER BY id DESC LIMIT 20`,
        params,
      );
      return { orders: r.rows };
    }
    case "generate_invoice": {
      const res = await fetch(`${baseUrl}/invoices`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          order_id: Number(args.order_id),
          include_vat: args.include_vat !== false,
        }),
      });
      const data = await res.json();
      return res.ok ? { invoice: data } : { error: data };
    }
    case "create_econt_shipment": {
      const orderId = Number(args.order_id);
      const or = await query(
        `SELECT id, econt_receiver_name, econt_receiver_phone, econt_city,
                econt_office_code, econt_street, econt_street_num,
                econt_weight, econt_cod_amount
           FROM orders WHERE id = $1`,
        [orderId],
      );
      const o = or.rows[0];
      if (!o) return { error: "order_not_found" };
      const res = await fetch(`${baseUrl}/econt/create-shipment`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          order_id: orderId,
          receiverName: o.econt_receiver_name,
          receiverPhone: o.econt_receiver_phone,
          receiverCity: o.econt_city,
          receiverOfficeCode: o.econt_office_code,
          receiverStreet: o.econt_street,
          receiverNum: o.econt_street_num,
          weight: Number(o.econt_weight) || 1,
          codAmount: Number(o.econt_cod_amount) || undefined,
        }),
      });
      const data = await res.json();
      return res.ok ? data : { error: data };
    }
    case "track_shipment": {
      const sn = String(args.shipment_number);
      const res = await fetch(`${baseUrl}/econt/track/${sn}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const data = await res.json();
      return res.ok ? data : { error: data };
    }
    default:
      return { error: "unknown_tool" };
  }
}

export default async function chatRoutes(app: FastifyInstance) {
  app.post("/chat", { preHandler: requireAuth }, async (request, reply) => {
    const body = ChatRequestSchema.parse(request.body);
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return reply.code(500).send({ error: "no_llm_key" });

    const authHeader = request.headers.authorization || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    const baseUrl = `http://127.0.0.1:${process.env.PORT || 3000}`;

    const systemPrompt =
      body.system_context ||
      "You are the МЕРТ-М warehouse assistant. Respond in Bulgarian.";

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...(body.history || []),
      { role: "user", content: body.message },
    ];

    const toolCalls: Array<{
      name: string;
      args: unknown;
      result: unknown;
    }> = [];

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const llmRes = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          tools: TOOLS,
          tool_choice: "auto",
        }),
      });
      if (!llmRes.ok) {
        const text = await llmRes.text();
        return reply.code(502).send({ error: "llm_error", message: text });
      }
      const llmData = (await llmRes.json()) as {
        choices: Array<{
          message: {
            role: "assistant";
            content: string | null;
            tool_calls?: Array<{
              id: string;
              function: { name: string; arguments: string };
            }>;
          };
        }>;
      };
      const choice = llmData.choices[0]?.message;
      if (!choice) return reply.code(502).send({ error: "empty_llm" });

      const requestedCalls = choice.tool_calls || [];
      if (requestedCalls.length === 0) {
        return reply.send({
          reply: choice.content || "",
          tool_calls: toolCalls,
        });
      }

      messages.push({
        role: "assistant",
        content: choice.content || "",
        // @ts-expect-error — OpenRouter schema allows tool_calls on assistant msg
        tool_calls: requestedCalls,
      } as ChatMessage);
      for (const tc of requestedCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await runTool(tc.function.name, args, jwt, baseUrl);
        toolCalls.push({
          name: tc.function.name,
          args,
          result,
        });
        messages.push({
          role: "tool" as unknown as ChatMessage["role"],
          content: JSON.stringify(result),
          // @ts-expect-error — tool_call_id is OpenRouter-specific
          tool_call_id: tc.id,
        } as ChatMessage);
      }
    }
    return reply.send({
      reply: "…превишен лимит на tool calls.",
      tool_calls: toolCalls,
    });
  });
}
