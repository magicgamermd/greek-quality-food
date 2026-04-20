# Telegram Agent Integration Implementation Plan (v0.3.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring up a Telegram bot that lets MERT-M warehouse staff chat with the warehouse-backend via natural language, voice, and email, reusing the production-ready demo bot plus a new `/chat` endpoint.

**Architecture:** New `POST /chat` route in warehouse-backend that proxies to OpenRouter with tool-calling over existing domain routes. Bot (`telegram-bot/`) is ported wholesale from `/Users/magic/Projects/mert-m-demo/telegram-bot/` with MERT-M endpoint adjustments. Single polling process, in-memory user state, cron jobs for scheduled reports.

**Tech Stack:**

- Backend: Fastify 5 + TS, Zod, `fetch` → OpenRouter (model: `anthropic/claude-3.5-haiku`)
- Bot: Node.js ESM + node-telegram-bot-api + nodemailer + imap + node-cron (copied)

---

## Task 1: Copy demo bot + housekeeping

**Files:**

- Create: `telegram-bot/` (entire directory tree) — copied from `/Users/magic/Projects/mert-m-demo/telegram-bot/`
- Modify: `telegram-bot/.env` (rewrite with MERT-M config)
- Modify: `telegram-bot/package.json` (rename to `mertm-telegram-bot`)
- Modify: `.gitignore` at repo root (ensure `telegram-bot/.env`, `telegram-bot/node_modules`, `telegram-bot/logs/` ignored)

- [ ] **Step 1: Copy the tree**

```bash
cd /Users/magic/Projects/mert-m
cp -R /Users/magic/Projects/mert-m-demo/telegram-bot ./telegram-bot
rm -rf telegram-bot/node_modules telegram-bot/logs telegram-bot/.env
```

- [ ] **Step 2: Extend repo-root `.gitignore`**

Append to `/Users/magic/Projects/mert-m/.gitignore` (create the file if missing):

```
telegram-bot/.env
telegram-bot/node_modules
telegram-bot/logs/
telegram-bot/*.log
```

- [ ] **Step 3: Create the bot `.env` from template**

Write `telegram-bot/.env.example`:

```
TELEGRAM_BOT_TOKEN=
ALLOWED_USERS=
TELEGRAM_NOTIFY_USER=

API_URL=http://localhost:3000
API_EMAIL=bot@mertm.local
API_PASSWORD=CHANGE_ME

OPENROUTER_API_KEY=
OPENAI_API_KEY=

SMTP_HOST=
SMTP_PORT=465
SMTP_USER=
SMTP_PASS=
SMTP_FROM=

IMAP_HOST=
IMAP_PORT=993
IMAP_USER=
IMAP_PASS=
```

Then `cp telegram-bot/.env.example telegram-bot/.env` (user fills in real values later).

- [ ] **Step 4: Rename package in package.json**

```bash
sed -i '' 's/"mertm-telegram-bot"/"mertm-warehouse-bot"/' telegram-bot/package.json
```

(If the existing value is already `mertm-telegram-bot`, keep it — just verify the `name` field exists and matches one of these.)

- [ ] **Step 5: Install deps**

```bash
cd telegram-bot && npm install
```

Expected: node_modules populated, no fatal errors. Log warnings are OK.

- [ ] **Step 6: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add .gitignore telegram-bot/
git commit -m "feat(bot): import demo Telegram bot as starting point"
```

---

## Task 2: Add chat-schemas.ts in backend

**Files:**

- Create: `warehouse-backend/src/routes/chat-schemas.ts`

- [ ] **Step 1: Write schemas**

```typescript
import { z } from "zod";

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});

export const ChatRequestSchema = z.object({
  message: z.string().min(1),
  history: z.array(ChatMessageSchema).max(20).optional().default([]),
  system_context: z.string().max(8000).optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ToolArgsSearchProducts = z.object({
  query: z.string().min(1),
});
export const ToolArgsGetOrder = z.object({ id: z.number().int().positive() });
export const ToolArgsListOrders = z.object({
  status: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
});
export const ToolArgsCancelOrder = z.object({
  id: z.number().int().positive(),
  reason: z.string().optional(),
});
export const ToolArgsGenerateInvoice = z.object({
  order_id: z.number().int().positive(),
  include_vat: z.boolean().optional().default(true),
});
export const ToolArgsSendInvoiceEmail = z.object({
  invoice_id: z.number().int().positive(),
  to_email: z.string().email(),
});
export const ToolArgsCreateEcontShipment = z.object({
  order_id: z.number().int().positive(),
});
export const ToolArgsTrackShipment = z.object({
  shipment_number: z.string().min(1),
});

export const TOOL_NAMES = [
  "search_products",
  "get_order",
  "list_orders",
  "cancel_order",
  "generate_invoice",
  "send_invoice_email",
  "get_inventory_report",
  "create_econt_shipment",
  "track_shipment",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
```

- [ ] **Step 2: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/chat-schemas.ts
git commit -m "feat(chat): add Zod schemas for /chat endpoint + tool args"
```

---

## Task 3: Implement /chat route with OpenRouter + tool dispatcher

**Files:**

- Create: `warehouse-backend/src/routes/chat.ts`
- Create: `warehouse-backend/src/__tests__/chat-tool-dispatch.test.ts`

Purpose: single `POST /chat` route that:

1. Validates body
2. Posts to OpenRouter with tool definitions
3. When LLM requests a tool, invokes the matching SQL/domain function, loops until LLM responds without further tool requests (max 3 turns)
4. Returns `{ reply, tool_calls }`

- [ ] **Step 1: Write the route**

```typescript
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
      description: "Search products by SKU/name/barcode (Bulgarian+translit).",
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
        "Create an Econt waybill for an order. Requires econt_* fields to be populated on the order.",
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

    const toolCalls: Array<{ name: string; args: unknown; result: unknown }> =
      [];

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
        // @ts-expect-error — OpenRouter/OpenAI schema allows extra fields
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
          // @ts-expect-error — tool_call_id is in OpenAI/OpenRouter schema but not our ChatMessage
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
```

- [ ] **Step 2: Write tool-dispatch test**

File: `warehouse-backend/src/__tests__/chat-tool-dispatch.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import chatRoutes from "../routes/chat.js";

vi.mock("../db.js", () => ({
  query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM products")) {
      return { rows: [{ id: 1, name: "Фритюрник", sku: "HD-42" }] };
    }
    return { rows: [] };
  }),
}));

function buildApp() {
  const app = Fastify({ logger: false });
  app.register(jwt, { secret: "test-secret" });
  app.register(chatRoutes);
  return app;
}

describe("/chat", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  it("returns 401 without auth", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns LLM reply when no tool calls requested", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", content: "Здравейте!" } },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp();
    const token = app.jwt.sign({ userId: 1, role: "admin" });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: { message: "Здравей", history: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reply: "Здравейте!" });
  });

  it("dispatches search_products tool", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "tc1",
                      function: {
                        name: "search_products",
                        arguments: '{"query":"фрит"}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Намерих 1 продукт: Фритюрник (HD-42)",
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp();
    const token = app.jwt.sign({ userId: 1, role: "admin" });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: { message: "търси фритюрници" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.reply).toContain("Фритюрник");
    expect(data.tool_calls).toHaveLength(1);
    expect(data.tool_calls[0].name).toBe("search_products");
  });

  it("returns 500 when OPENROUTER_API_KEY missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const app = buildApp();
    const token = app.jwt.sign({ userId: 1, role: "admin" });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: "no_llm_key" });
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd warehouse-backend && npx vitest run src/__tests__/chat-tool-dispatch.test.ts
```

Expected: 4/4 pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/chat.ts warehouse-backend/src/__tests__/chat-tool-dispatch.test.ts
git commit -m "feat(chat): add /chat endpoint with OpenRouter + tool dispatcher"
```

---

## Task 4: Register /chat route + add OPENROUTER_API_KEY to .env.example

**Files:**

- Modify: `warehouse-backend/src/index.ts` (register chatRoutes)
- Modify: `warehouse-backend/.env.example` (add OPENROUTER_API_KEY, CHAT_MODEL)
- Modify: `warehouse-backend/.env` (same keys with empty values)

- [ ] **Step 1: Register chat route**

Find the block in `warehouse-backend/src/index.ts` where other routes are registered (`await app.register(econtRoutes, { prefix: "/econt" });`). Add BELOW it:

```typescript
import chatRoutes from "./routes/chat.js";
// … existing imports …

// … inside the same async function …
await app.register(chatRoutes);
```

- [ ] **Step 2: Append to .env.example**

```
# Chat (LLM) — OpenRouter key for /chat endpoint used by Telegram bot
OPENROUTER_API_KEY=
CHAT_MODEL=anthropic/claude-3.5-haiku
```

- [ ] **Step 3: Append same to .env**

Copy the same two lines to `warehouse-backend/.env` with empty values.

- [ ] **Step 4: Type-check + full test**

```bash
cd warehouse-backend && npx tsc --noEmit && npx vitest run
```

Expected: no TS errors; all tests (40 files / 192+ tests) pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/index.ts warehouse-backend/.env.example warehouse-backend/.env
git commit -m "feat(chat): register /chat route + add OPENROUTER_API_KEY env vars"
```

---

## Task 5: Adapt bot.js to MERT-M backend

**Files:**

- Modify: `telegram-bot/bot.js`

Purpose: remove dead `/batches` calls, point at new `/econt/*` and `/chat`.

- [ ] **Step 1: Audit calls to backend**

```bash
cd /Users/magic/Projects/mert-m/telegram-bot
grep -n "apiCall(" bot.js | head -40
```

- [ ] **Step 2: Remove `/batches` path references**

Search `bot.js` for `"/batches"` and `"batches"` (string). If any remain, replace the function body with a toast "Батчове не се ползват в МЕРТ-М" and `return;`.

- [ ] **Step 3: Ensure Econt function exists**

Locate `handleCreateWaybill` (around line 910 in original). Verify it posts to `/econt/create-shipment`. If it references a different path (e.g. `/shipments`), rewrite the body:

```javascript
async function handleCreateWaybill(bot, chatId, userId, orderId) {
  await ensureAuth();
  await bot.sendChatAction(chatId, "typing");
  try {
    const res = await apiCall("POST", "/econt/create-shipment", {
      order_id: orderId,
    });
    const data = await res.json();
    const sn = data.shipmentNumber;
    const pdfUrl = data.pdfURL;
    await sendMessage(
      bot,
      chatId,
      `✅ Товарителница ${sn}\nПДФ: ${pdfUrl || "—"}`,
    );
  } catch (err) {
    await sendMessage(bot, chatId, `❌ ${err.message}`);
  }
}
```

- [ ] **Step 4: Smoke start**

```bash
cd telegram-bot
timeout 5 node bot.js 2>&1 | head -20 || true
```

Expected: prints "Logging in to backend..." and "Bot started, waiting for messages..." (timeout kills it after 5s — that's fine). If it prints a login failure, note the error but proceed — real creds set up later.

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot/bot.js
git commit -m "feat(bot): adapt demo bot calls to MERT-M backend endpoints"
```

---

## Task 6: Update KB + agent prompts for MERT-M

**Files:**

- Modify: `telegram-bot/KB/system-overview.md`
- Modify: `telegram-bot/KB/products.md`
- Modify: `telegram-bot/agent/SOUL.md`

- [ ] **Step 1: Rewrite system-overview.md**

Replace contents with:

```markdown
# МЕРТ-М Склад — системен преглед

МЕРТ-М е български дистрибутор на професионална кухненска техника
(марки: Hendi, Bartscher, KitchenAid, Liebherr, Unox, Fiamma).

## Архитектура

- warehouse-backend (Fastify + PostgreSQL 16) — REST API + /chat за AI
- warehouse-frontend (React + Vite) — admin панел
- telegram-bot (Node.js) — този бот (говори с backend чрез /chat)

## Ключови модули

- Поръчки (orders) — клиентска поръчка, статус pending/confirmed/fulfilled/cancelled
- Фактури (invoices) — издаване, ПДФ, изпращане по имейл, кредитни известия
- Еконт (econt) — създаване на товарителница, проследяване, PDF етикет
- Склад (inventory) — наличности по продукти, справки в PDF

## Не следим:

- срокове на годност
- партидни номера
  (МЕРТ-М продава дълготрайни стоки, не бързоразвалящи се.)
```

- [ ] **Step 2: Rewrite products.md**

```markdown
# МЕРТ-М продуктови категории

## Марки в портфолиото

- Hendi — професионални фритюрници, грилове, кантари
- Bartscher — готварски печки, фурни
- KitchenAid — миксери, блендери, роботи
- Liebherr — хладилни и фризерни шкафове
- Unox — комбинирани фурни
- Fiamma — еспресо машини

## Въпроси към AI

Винаги може да търси продукт по:

- SKU (напр. "HD-42")
- Име (българско или транслит: "fritjurnik")
- Баркод

Пример: "колко на склад имам HD-42?" → AI ползва search_products → показва наличност.
```

- [ ] **Step 3: Rewrite SOUL.md**

```markdown
# АЗ СЪМ

Аз съм AI асистент на МЕРТ-М склад. Отговарям на български.

## Моите принципи

1. Кратки отговори — никой в склада няма време за романи.
2. Винаги потвърждавам разрушителни действия (изтриване, анулиране).
3. Когато съм несигурен — питам, а не предположавам.
4. Форматирам числата с 2 знака след запетаята и лв./€ където е уместно.
5. Ако някой метод фейлне — казвам точната грешка, не измислям успех.

## Стил

- Професионален, но топъл.
- Без излишни емоджи освен в менюта и потвърждения.
- Използвам "вие" за клиенти, "ти" за колеги от склада.
```

- [ ] **Step 4: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot/KB/system-overview.md telegram-bot/KB/products.md telegram-bot/agent/SOUL.md
git commit -m "docs(bot): update KB + agent persona for MERT-M context"
```

---

## Task 7: Write telegram-bot README

**Files:**

- Modify: `telegram-bot/README.md`

- [ ] **Step 1: Rewrite README**

````markdown
# МЕРТ-М Склад — Telegram Bot

Telegram бот за комуникация с warehouse-backend чрез AI асистент (/chat).

## Бързо стартиране

1. Попълни `.env` по шаблона `.env.example`.
   - `TELEGRAM_BOT_TOKEN` — от @BotFather
   - `ALLOWED_USERS` — списък Telegram user IDs (от @userinfobot)
   - `API_URL` — backend URL (локално: http://localhost:3000)
   - `API_EMAIL` / `API_PASSWORD` — сервизен акаунт в backend (роля: admin)
   - `OPENROUTER_API_KEY` — за AI отговори (backend /chat)
   - `OPENAI_API_KEY` — за гласови съобщения (Whisper)
   - SMTP + IMAP — при нужда от email интеграция

2. Инсталирай зависимостите:
   ```bash
   npm install
   ```
````

3. Стартирай:
   ```bash
   npm start
   ```
   или с auto-restart:
   ```bash
   npm run dev
   ```

## Команди

- `/start` — менюто с бутони
- `/help` — примерни въпроси
- `/clear` — изчисти разговорната история
- `/health` — проверка на връзката към backend
- `/bug <текст>` — докладвай бъг

## Крон задачи

- 08:00 — утринен отчет (чакащи поръчки, нисък запас, неплатени фактури)
- 12:00 — stuck orders (над 4ч. pending)
- 17:00 — вечерно обобщение (поръчки + оборот)

## Deployment

Self-hosted на Mac Mini (MERT-M офис). Използвай `pm2` или Docker (виж Dockerfile).

````

- [ ] **Step 2: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot/README.md
git commit -m "docs(bot): MERT-M-specific README with setup + commands"
````

---

## Task 8: E2E verification + tag

- [ ] **Step 1: Backend still works**

```bash
cd warehouse-backend && npx vitest run 2>&1 | tail -5
```

Expected: all tests pass (40+ files).

- [ ] **Step 2: Bot starts without crash**

```bash
cd telegram-bot && timeout 3 node -e "import('./bot.js').catch(e => { console.error(e.message); process.exit(0); })" 2>&1 | head -20 || true
```

Expected: no syntax errors. Login may fail (no backend creds set) — that's OK.

- [ ] **Step 3: Verify Greek Foods baseline untouched**

```bash
cd /Users/magic/Projects/greek-foods-platform && git rev-parse HEAD
```

Expected: `9f55c3205d60ba41a7d7c706a25553d94d95c71a` (unchanged since foundation).

- [ ] **Step 4: Tag the milestone**

```bash
cd /Users/magic/Projects/mert-m
git tag v0.3.0-telegram -m "Telegram agent + /chat endpoint (autonomous overnight build)"
git log --oneline v0.2.0-ekont..HEAD
```

- [ ] **Step 5: Status check**

```bash
cd /Users/magic/Projects/mert-m && git status
```

Expected: clean tree. If not, commit leftovers with `chore: cleanup after v0.3.0`.

---

## Exit Criteria

- `POST /chat` returns 401 without auth, 500 with `error=no_llm_key` when API key missing, 200 with `{reply, tool_calls}` when working.
- Backend vitest passes (all tests).
- `telegram-bot/` directory exists with KB/, agent/, bot.js, package.json, README.md.
- `npm install` in telegram-bot/ succeeds.
- `node bot.js` doesn't crash on import.
- Tag `v0.3.0-telegram` exists.
- Greek Foods SHA unchanged.
