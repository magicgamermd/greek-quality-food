import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db.js";
import { ChatRequestSchema, type ChatMessage } from "./chat-schemas.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-3.5-haiku";
const DEFAULT_OLLAMA_MODEL = "qwen3:8b";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const MAX_TOOL_TURNS = 3;
const OLLAMA_CONFIDENCE_THRESHOLD = 0.5;

// Whitelist of allowed local-LLM actions and their required arguments.
// Used to validate the JSON action fallback returned by Ollama (qwen3:8b).
const OLLAMA_ALLOWED_ACTIONS: Record<
  string,
  { required: string[]; optional?: string[] }
> = {
  search_products: { required: ["query"] },
  get_order: { required: ["id"] },
  list_orders: {
    required: [],
    optional: ["status", "date_from", "date_to"],
  },
  generate_invoice: { required: ["order_id"], optional: ["include_vat"] },
  create_econt_shipment: { required: ["order_id"] },
  track_shipment: { required: ["shipment_number"] },
};

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
        `SELECT p.id,
                p.name_bg,
                p.name_en,
                p.name_bg AS name,
                p.sku,
                p.brand,
                p.microinvest_code,
                p.unit,
                p.selling_price,
                COALESCE(SUM(inv.quantity), 0)::numeric AS stock_level
           FROM products p
           LEFT JOIN inventory inv ON inv.product_id = p.id
          WHERE p.name_bg ILIKE $1
             OR p.name_en ILIKE $1
             OR p.sku ILIKE $1
             OR p.brand ILIKE $1
             OR p.microinvest_code ILIKE $1
          GROUP BY p.id
          ORDER BY p.name_bg
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
        `SELECT id, order_number, partner_id, status, order_date, total_amount
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

// Per-action arg aliases: small-LLM JSON often emits intuitive but mismatched
// keys (e.g. order_id for get_order, tracking_number for track_shipment).
// Only narrow, well-known aliases — never auto-coerce unrelated fields.
const OLLAMA_ARG_ALIASES: Record<string, Record<string, string>> = {
  get_order: { order_id: "id", orderId: "id" },
  track_shipment: {
    tracking_number: "shipment_number",
    trackingNumber: "shipment_number",
    waybill: "shipment_number",
  },
};

function normalizeOllamaArgs(
  action: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const aliases = OLLAMA_ARG_ALIASES[action];
  if (!aliases) return raw;
  const out: Record<string, unknown> = { ...raw };
  for (const [from, to] of Object.entries(aliases)) {
    if (out[to] === undefined && out[from] !== undefined) {
      out[to] = out[from];
    }
  }
  return out;
}

function buildOllamaArgs(
  action: Record<string, unknown>,
  spec: { required: string[]; optional?: string[] },
  toolName: string,
): { ok: true; args: Record<string, unknown> } | { ok: false } {
  const normalized = normalizeOllamaArgs(toolName, action);
  const args: Record<string, unknown> = {};
  for (const key of spec.required) {
    if (normalized[key] === undefined || normalized[key] === null) {
      return { ok: false };
    }
    args[key] = normalized[key];
  }
  for (const key of spec.optional || []) {
    if (normalized[key] !== undefined && normalized[key] !== null) {
      args[key] = normalized[key];
    }
  }
  return { ok: true, args };
}

function parseOllamaActionContent(
  content: string | null | undefined,
): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

async function callOllama(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
): Promise<{
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> | string };
    }>;
  };
}> {
  // qwen3-safe defaults for tool/action mode on 16GB local hardware.
  // Any of these may be overridden by env.
  const numCtxRaw = process.env.OLLAMA_NUM_CTX;
  const numCtxParsed = numCtxRaw ? Number(numCtxRaw) : NaN;
  const numCtx = Number.isFinite(numCtxParsed) ? numCtxParsed : 4096;

  const tempRaw = process.env.OLLAMA_TEMPERATURE;
  const tempParsed = tempRaw ? Number(tempRaw) : NaN;
  const temperature = Number.isFinite(tempParsed) ? tempParsed : 0;

  // Default: no format constraint — we want the model free to emit native
  // tool_calls. Setting OLLAMA_FORMAT=json forces JSON content output and
  // suppresses tool_calls, so only use it when explicitly opted in.
  const format =
    process.env.OLLAMA_FORMAT !== undefined && process.env.OLLAMA_FORMAT !== ""
      ? process.env.OLLAMA_FORMAT
      : undefined;

  const think =
    process.env.OLLAMA_THINK !== undefined
      ? process.env.OLLAMA_THINK === "true"
      : false;

  let keepAlive: number | string = 0;
  if (process.env.OLLAMA_KEEP_ALIVE !== undefined) {
    const k = Number(process.env.OLLAMA_KEEP_ALIVE);
    keepAlive = Number.isFinite(k) ? k : process.env.OLLAMA_KEEP_ALIVE;
  }

  const payload: Record<string, unknown> = {
    model,
    stream: false,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    tools: TOOLS,
    think,
    keep_alive: keepAlive,
    options: { num_ctx: numCtx, temperature },
  };
  if (format) {
    payload.format = format;
  }

  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ollama_error:${res.status}:${text}`);
  }
  return res.json() as Promise<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        function: { name: string; arguments: Record<string, unknown> | string };
      }>;
    };
  }>;
}

export default async function chatRoutes(app: FastifyInstance) {
  app.post("/chat", { preHandler: requireAuth }, async (request, reply) => {
    const body = ChatRequestSchema.parse(request.body);
    const provider = (process.env.CHAT_PROVIDER || "openrouter").toLowerCase();
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (provider !== "ollama" && !apiKey) {
      return reply.code(500).send({ error: "no_llm_key" });
    }

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

    if (provider === "ollama") {
      const ollamaBase = process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL;
      const ollamaModel = process.env.CHAT_MODEL || DEFAULT_OLLAMA_MODEL;

      // Ollama native chat supports a "tool" role in messages for tool results.
      // Our base ChatMessage type only permits user/assistant/system, so we
      // widen locally for the agentic loop.
      type OllamaTurn = { role: string; content: string };

      // Anti-stalling system note for local qwen3-style models: they tend to
      // parrot "Секунда, проверявам..." from SOUL.md as a final reply, instead
      // of actually emitting tool_calls. Force agentic behaviour. Placed AFTER
      // the bot-supplied system_context so it overrides SOUL.md's hint that
      // encouraged the stall phrase.
      const OLLAMA_AGENT_NOTE = [
        "=== ПРАВИЛА ЗА ДЕЙСТВИЕ (override над SOUL.md) ===",
        "Ти си agentic асистент — ПЪРВО извикваш tool, СЛЕД това говориш.",
        "",
        "АБСОЛЮТНО ЗАБРАНЕНИ ОТГОВОРИ (регресии):",
        "- 'Секунда, проверявам...' без tool_call — FORBIDDEN.",
        "- 'Момент...' без tool_call — FORBIDDEN.",
        "- Едно-думни 'Готово.' — FORBIDDEN. Винаги обобщавай резултата.",
        "",
        "ПОВЕДЕНИЕ:",
        "1. Има подходящ tool → извикай го веднага.",
        "2. Няма tool за задачата → кажи: 'Не мога да направя това през чат — използвайте интерфейса.'",
        "3. Tool върне резултат → обобщи на 1-2 изречения с конкретни данни.",
        "",
        "НАЛИЧНИ TOOLS: search_products, get_order, list_orders, generate_invoice, create_econt_shipment, track_shipment.",
        "НЯМА tool за: създаване на поръчка, партньор, продукт, фактура от нулата, добавяне на склад. Кажи честно че не можеш.",
      ].join("\n");

      // Layout: [bot system_context] + [history] + [agent override note] + [user msg]
      // Agent note sits right before the user message so Qwen reads it last,
      // which overrides SOUL.md's "Секунда, проверявам..." hint.
      const baseSystem = messages.slice(0, 1).map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const history = messages.slice(1, -1).map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const lastUser = messages[messages.length - 1];
      const convo: OllamaTurn[] = [
        ...baseSystem,
        ...history,
        { role: "system", content: OLLAMA_AGENT_NOTE },
        { role: lastUser.role, content: lastUser.content },
      ];

      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        let ollamaData;
        try {
          ollamaData = await callOllama(
            ollamaBase,
            ollamaModel,
            convo as ChatMessage[],
          );
        } catch (err) {
          return reply
            .code(502)
            .send({ error: "llm_error", message: String(err) });
        }
        const choice = ollamaData.message;
        if (!choice) return reply.code(502).send({ error: "empty_llm" });

        const nativeCalls = choice.tool_calls || [];

        // No tool calls → this is the final assistant reply (or fallback).
        if (nativeCalls.length === 0) {
          // JSON action fallback: {action, ..., confidence, requires_confirmation}.
          const action = parseOllamaActionContent(choice.content);
          if (action && typeof action.action === "string") {
            const name = action.action;
            const spec = OLLAMA_ALLOWED_ACTIONS[name];
            const confidence =
              typeof action.confidence === "number" ? action.confidence : 1;
            if (spec && confidence >= OLLAMA_CONFIDENCE_THRESHOLD) {
              const built = buildOllamaArgs(action, spec, name);
              if (built.ok) {
                if (action.requires_confirmation === true) {
                  return reply.send({
                    reply: `Моля, потвърдете действие ${name} преди изпълнение.`,
                    tool_calls: [],
                  });
                }
                const result = await runTool(name, built.args, jwt, baseUrl);
                toolCalls.push({ name, args: built.args, result });
                return reply.send({
                  reply: `Изпълних действие ${name}.`,
                  tool_calls: toolCalls,
                });
              }
            }
          }

          if (toolCalls.length > 0) {
            return reply.send({
              reply:
                choice.content?.trim() ||
                "Действието е изпълнено, но не получих описание.",
              tool_calls: toolCalls,
            });
          }

          if (choice.content?.trim()) {
            return reply.send({
              reply: choice.content.trim(),
              tool_calls: [],
            });
          }

          return reply.send({
            reply:
              "Моля, уточнете заявката — не разбрах кое действие да изпълня.",
            tool_calls: [],
          });
        }

        // Execute tool calls and append results back into the conversation so
        // the model can produce a final human-readable reply on the next turn.
        convo.push({
          role: "assistant",
          content: choice.content || "",
        });

        let executedAny = false;
        for (const tc of nativeCalls) {
          const name = tc.function?.name;
          if (!name || !OLLAMA_ALLOWED_ACTIONS[name]) continue;
          let rawArgs: Record<string, unknown> = {};
          if (typeof tc.function.arguments === "string") {
            try {
              const parsed = JSON.parse(tc.function.arguments || "{}");
              if (parsed && typeof parsed === "object") {
                rawArgs = parsed as Record<string, unknown>;
              }
            } catch {
              rawArgs = {};
            }
          } else if (
            tc.function.arguments &&
            typeof tc.function.arguments === "object"
          ) {
            rawArgs = tc.function.arguments;
          }
          const built = buildOllamaArgs(
            rawArgs,
            OLLAMA_ALLOWED_ACTIONS[name],
            name,
          );
          if (!built.ok) {
            convo.push({
              role: "tool",
              content: JSON.stringify({
                error: "invalid_arguments",
                received: rawArgs,
              }),
            });
            continue;
          }
          const result = await runTool(name, built.args, jwt, baseUrl);
          toolCalls.push({ name, args: built.args, result });
          convo.push({
            role: "tool",
            content: JSON.stringify(result),
          });
          executedAny = true;
        }

        if (!executedAny) {
          return reply.send({
            reply:
              "Опитах действие, но аргументите не бяха валидни. Моля, уточнете.",
            tool_calls: toolCalls,
          });
        }
        // Loop: ask the model to summarise the tool output for the user.
      }

      // MAX_TOOL_TURNS exhausted without a clean final reply.
      return reply.send({
        reply:
          toolCalls.length > 0
            ? "Действията са изпълнени, но не успях да съставя обобщение."
            : "Заявката изисква твърде много стъпки. Моля, опитайте по-конкретно.",
        tool_calls: toolCalls,
      });
    }

    const model = process.env.CHAT_MODEL || DEFAULT_OPENROUTER_MODEL;

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const llmRes = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
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
