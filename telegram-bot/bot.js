import TelegramBot from "node-telegram-bot-api";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  createWriteStream,
  existsSync,
  appendFileSync,
  readdirSync,
  mkdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { pipeline } from "stream/promises";
import { createTransport } from "nodemailer";
import Imap from "imap";
import { simpleParser } from "mailparser";
import cron from "node-cron";

// Load .env manually when present (no dotenv dependency)
const envFileUrl = new URL(".env", import.meta.url);
const env = existsSync(envFileUrl)
  ? Object.fromEntries(
      readFileSync(envFileUrl, "utf-8")
        .split("\n")
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    )
  : {};

const TELEGRAM_BOT_TOKEN =
  env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const API_URL = env.API_URL || process.env.API_URL;
const API_EMAIL = env.API_EMAIL || process.env.API_EMAIL;
const API_PASSWORD = env.API_PASSWORD || process.env.API_PASSWORD;
const OPENAI_API_KEY = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
const ALLOWED_USERS = (env.ALLOWED_USERS || process.env.ALLOWED_USERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

// SMTP config
const SMTP_HOST = env.SMTP_HOST || process.env.SMTP_HOST;
const SMTP_PORT = parseInt(env.SMTP_PORT || process.env.SMTP_PORT || "465", 10);
const SMTP_USER = env.SMTP_USER || process.env.SMTP_USER;
const SMTP_PASS = env.SMTP_PASS || process.env.SMTP_PASS;
const SMTP_FROM = env.SMTP_FROM || process.env.SMTP_FROM || SMTP_USER;

// IMAP config
const IMAP_HOST = env.IMAP_HOST || process.env.IMAP_HOST;
const IMAP_PORT = parseInt(env.IMAP_PORT || process.env.IMAP_PORT || "993", 10);
const IMAP_USER = env.IMAP_USER || process.env.IMAP_USER;
const IMAP_PASS = env.IMAP_PASS || process.env.IMAP_PASS;

const TELEGRAM_NOTIFY_USER =
  env.TELEGRAM_NOTIFY_USER || process.env.TELEGRAM_NOTIFY_USER;
const OPENROUTER_API_KEY =
  env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required via .env or process.env");
  process.exit(1);
}

// --- Agent files ---
const AGENT_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "agent");

function loadAgentFile(name) {
  const filePath = join(AGENT_DIR, name);
  if (existsSync(filePath)) return readFileSync(filePath, "utf-8");
  return "";
}

function appendToMemory(lesson) {
  const memPath = join(AGENT_DIR, "MEMORY.md");
  const timestamp = new Date().toISOString().slice(0, 10);
  const entry = `\n- ${lesson} (${timestamp})`;
  appendFileSync(memPath, entry, "utf-8");
  AGENT_MEMORY += entry;
  console.log(`[Agent] Memory updated: ${lesson}`);
}

const AGENT_SOUL = loadAgentFile("SOUL.md");
let AGENT_MEMORY = loadAgentFile("MEMORY.md");

if (AGENT_SOUL) console.log("[Agent] SOUL loaded:", AGENT_SOUL.length, "chars");
if (AGENT_MEMORY)
  console.log("[Agent] MEMORY loaded:", AGENT_MEMORY.length, "chars");

// --- Knowledge Base ---
const KB_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "KB");
function loadKnowledgeBase() {
  if (!existsSync(KB_DIR)) return "";
  const files = readdirSync(KB_DIR).filter((f) => f.endsWith(".md"));
  return files
    .map((f) => {
      const content = readFileSync(join(KB_DIR, f), "utf-8");
      return `\n### ${f.replace(".md", "").toUpperCase()}\n${content}`;
    })
    .join("\n");
}
const KNOWLEDGE_BASE = loadKnowledgeBase();
if (KNOWLEDGE_BASE)
  console.log("[KB] Knowledge base loaded:", KNOWLEDGE_BASE.length, "chars");

// State
let jwtToken = null;
let tokenRefreshTimer = null;
const userHistories = new Map(); // userId -> [{role, content}]
const MAX_HISTORY = 20;
const lastInvoicePerUser = new Map(); // userId -> { invoiceId, invoiceNumber, orderId }
const userState = {}; // userId -> { lastOrderId, lastInvoiceId, lastPartnerName }

// --- SMTP transporter ---
let smtpTransporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  smtpTransporter = createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: false },
  });
  console.log("SMTP configured:", SMTP_HOST);
}

// --- Auth ---
async function login() {
  console.log("Logging in to backend...");
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: API_EMAIL, password: API_PASSWORD }),
  });
  if (!res.ok)
    throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  jwtToken = data.token;
  console.log("Logged in successfully");
}

async function ensureAuth() {
  if (!jwtToken) await login();
}

function scheduleTokenRefresh() {
  if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
  tokenRefreshTimer = setInterval(
    async () => {
      try {
        await login();
      } catch (err) {
        console.error("Token refresh failed:", err.message);
      }
    },
    6 * 60 * 60 * 1000,
  );
}

// --- API helper with auto-retry on 401 ---
async function apiCall(method, path, body = null) {
  await ensureAuth();
  const opts = {
    method,
    headers: { Authorization: `Bearer ${jwtToken}` },
  };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  let res = await fetch(`${API_URL}${path}`, opts);

  if (res.status === 401) {
    await login();
    opts.headers.Authorization = `Bearer ${jwtToken}`;
    res = await fetch(`${API_URL}${path}`, opts);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${method} ${path} failed: ${res.status} ${errText}`);
  }
  return res;
}

// --- Chat API ---
function buildSystemContext() {
  const parts = [];
  if (AGENT_SOUL) parts.push(AGENT_SOUL);
  if (AGENT_MEMORY) parts.push(AGENT_MEMORY);
  if (KNOWLEDGE_BASE) parts.push("--- KNOWLEDGE BASE ---\n" + KNOWLEDGE_BASE);
  return parts.join("\n\n---\n\n").slice(0, 6000);
}

async function sendToBackend(message, history, userId) {
  const body = { message, history };
  const ctx = buildSystemContext();

  // Inject active state into context
  const state = userState[userId] || {};
  const stateLines = [];
  if (state.lastOrderId)
    stateLines.push(`Активна поръчка: #${state.lastOrderId}`);
  if (state.lastInvoiceId)
    stateLines.push(`Последна фактура ID: ${state.lastInvoiceId}`);
  if (state.lastPartnerName)
    stateLines.push(`Последен клиент: ${state.lastPartnerName}`);

  const lastInv = lastInvoicePerUser.get(userId);
  if (lastInv)
    stateLines.push(
      `Фактура за email: ${lastInv.invoiceNumber} (ID: ${lastInv.invoiceId})`,
    );

  const stateCtx =
    stateLines.length > 0
      ? `\n\n--- АКТИВЕН КОНТЕКСТ ---\n${stateLines.join("\n")}`
      : "";

  if (ctx || stateCtx) body.system_context = (ctx + stateCtx).slice(0, 8000);
  const res = await apiCall("POST", "/chat", body);
  return res.json();
}

// --- Order detection ---
function extractOrderId(text) {
  // Strip markdown bold/italic before matching
  const clean = text.replace(/\*{1,2}/g, "");
  const match = clean.match(/[Пп]оръчка\s*#\s*(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function isOrderCreationResponse(text) {
  const clean = text.replace(/\*{1,2}/g, "");
  return (
    /[Пп]оръчка\s*#\s*\d+/i.test(clean) &&
    /създаде|създаден|създадена|успешно/i.test(clean)
  );
}

// Extract invoice number from AI reply (handles markdown)
function extractInvoiceId(text) {
  const clean = text.replace(/\*{1,2}/g, "");
  const match = clean.match(/GF-\d{4}-\d+|фактура\s*#?\s*(\d+)/i);
  return match ? match[0] : null;
}

// --- Invoice API ---
async function createInvoice(orderId) {
  const res = await apiCall("POST", "/invoices", {
    order_id: orderId,
    include_vat: true,
  });
  return res.json();
}

async function downloadInvoicePdf(invoiceId) {
  const res = await apiCall("GET", `/invoices/${invoiceId}/pdf`);
  return Buffer.from(await res.arrayBuffer());
}

async function downloadWaybillPdf(shipmentNumber) {
  // Try label-pdf endpoint first (gets URL)
  try {
    const res = await apiCall("GET", `/econt/label-pdf/${shipmentNumber}`);
    const data = await res.json();
    if (data.pdfURL) {
      const pdfFetch = await fetch(data.pdfURL);
      if (pdfFetch.ok) {
        const buf = Buffer.from(await pdfFetch.arrayBuffer());
        if (buf.length > 500 && buf[0] === 0x25) return buf; // %PDF
      }
    }
  } catch {}
  // Fallback: proxy endpoint
  const res = await apiCall(
    "GET",
    `/econt/label-pdf-download/${shipmentNumber}`,
  );
  return Buffer.from(await res.arrayBuffer());
}

async function getInvoice(invoiceId) {
  const res = await apiCall("GET", `/invoices/${invoiceId}`);
  return res.json();
}

// --- Cancel order API ---
async function cancelOrder(orderId) {
  await apiCall("DELETE", `/orders/${orderId}`);
  return true;
}

// --- Search products ---
async function searchProducts(query) {
  const res = await apiCall(
    "GET",
    `/products?search=${encodeURIComponent(query)}`,
  );
  return res.json();
}

// --- Create order via API ---
async function createOrderFromEmail(orderData) {
  const res = await apiCall("POST", "/orders", orderData);
  return res.json();
}

// --- History ---
function getHistory(userId) {
  if (!userHistories.has(userId)) userHistories.set(userId, []);
  return userHistories.get(userId);
}

function addToHistory(userId, userMsg, aiMsg) {
  const history = getHistory(userId);
  history.push({ role: "user", content: userMsg });
  history.push({ role: "assistant", content: aiMsg });
  while (history.length > MAX_HISTORY * 2) history.shift();
}

function clearHistory(userId) {
  userHistories.delete(userId);
}

// --- Telegram formatting ---
function formatForTelegram(text) {
  if (text.includes("|")) {
    text = text.replace(/\|[^\n]+\|/g, (line) => {
      return line
        .split("|")
        .filter(Boolean)
        .map((c) => c.trim())
        .join(" | ");
    });
    text = text.replace(/\n\s*\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?\s*\n/g, "\n");
  }
  return text;
}

async function sendMessage(bot, chatId, text, extra = {}) {
  const formatted = formatForTelegram(text);
  try {
    await bot.sendMessage(chatId, formatted, {
      parse_mode: "Markdown",
      ...extra,
    });
  } catch {
    await bot.sendMessage(chatId, formatted, extra);
  }
}

// --- Access control ---
function isAllowed(userId) {
  if (ALLOWED_USERS.length === 0) return true;
  return ALLOWED_USERS.includes(userId);
}

// --- Voice transcription via Whisper ---
async function transcribeVoice(bot, fileId, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const fileUrl = await bot.getFileLink(fileId);
      const tmpPath = join(tmpdir(), `voice-${Date.now()}.ogg`);

      const res = await fetch(fileUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      const fileStream = createWriteStream(tmpPath);
      await pipeline(res.body, fileStream);

      const formData = new FormData();
      const fileBuffer = readFileSync(tmpPath);
      formData.append(
        "file",
        new Blob([fileBuffer], { type: "audio/ogg" }),
        "voice.ogg",
      );
      formData.append("model", "whisper-1");
      formData.append("language", "bg");
      formData.append(
        "prompt",
        "фритюрник, месомелачка, конвектомат, съдомиялна, скара, вакуум машина, колбасорезачка, Еконт, поръчка, фактура, товарителница, ЕИК, булстат, наличност, склад, МЕРТ-М",
      );

      const whisperRes = await fetch(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
          body: formData,
          signal: AbortSignal.timeout(30000),
        },
      );

      try {
        unlinkSync(tmpPath);
      } catch {}

      if (!whisperRes.ok) {
        const errText = await whisperRes.text();
        throw new Error(`Whisper error ${whisperRes.status}: ${errText}`);
      }

      const data = await whisperRes.json();
      return data.text;
    } catch (err) {
      console.error(
        `Voice attempt ${attempt + 1}/${retries + 1} failed:`,
        err.message,
      );
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

// ============================
// Feature 1: Send Invoice Email
// ============================

function buildInvoiceEmailHtml(invoice) {
  const invoiceNumber =
    invoice.invoice_number || invoice.invoiceNumber || `#${invoice.id}`;
  const date = invoice.date || new Date().toLocaleDateString("bg-BG");
  const totalGross =
    (invoice.total_gross || invoice.total) != null
      ? Number(invoice.total_gross || invoice.total).toFixed(2)
      : "N/A";

  return `
<div style="font-family: Arial, sans-serif; max-width: 600px;">
  <p>Здравейте,</p>
  <p>Изпращаме Ви фактура <strong>${invoiceNumber}</strong> от дата ${date} на стойност <strong>${totalGross} €</strong> (с ДДС).</p>
  <p>Фактурата е прикачена към този имейл.</p>
  <hr style="border: none; border-top: 1px solid #ccc;">
  <p><strong>Банкови реквизити за плащане:</strong></p>
  <table style="border-collapse: collapse;">
    <tr><td style="padding: 2px 10px 2px 0;">IBAN:</td><td>BG80BNBG96611020345678</td></tr>
    <tr><td style="padding: 2px 10px 2px 0;">Банка:</td><td>Уникредит Булбанк</td></tr>
    <tr><td style="padding: 2px 10px 2px 0;">BIC:</td><td>UNCRBGSF</td></tr>
    <tr><td style="padding: 2px 10px 2px 0;">Основание:</td><td>${invoiceNumber}</td></tr>
  </table>
  <hr style="border: none; border-top: 1px solid #ccc;">
  <p>С уважение,<br>
  <strong>МЕРТ-М ЕООД</strong><br>
  гр. Пловдив, ул. Полет 80<br>
  Тел: 0885 165 719</p>
</div>`;
}

async function sendInvoiceEmail(toEmail, invoiceId) {
  if (!smtpTransporter) throw new Error("SMTP не е конфигуриран");

  // Get invoice details
  let invoice;
  try {
    invoice = await getInvoice(invoiceId);
  } catch {
    invoice = { id: invoiceId, invoice_number: `MM-${invoiceId}` };
  }

  const invoiceNumber =
    invoice.invoice_number || invoice.invoiceNumber || `MM-${invoiceId}`;

  // Download PDF
  const pdfBuffer = await downloadInvoicePdf(invoiceId);

  // Send email
  const info = await smtpTransporter.sendMail({
    from: SMTP_FROM,
    to: toEmail,
    subject: `Фактура ${invoiceNumber} от МЕРТ-М ЕООД`,
    html: buildInvoiceEmailHtml(invoice),
    attachments: [
      {
        filename: `${invoiceNumber}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  });

  console.log(`Email sent to ${toEmail}: ${info.messageId}`);
  return { invoiceNumber, invoice };
}

// Detect email send request - multiple patterns
function extractEmailSendRequest(text) {
  // Pattern 1: "изпрати на email@..."
  const p1 = /изпрати\s+(?:фактурата\s+)?на\s+([\w.+-]+@[\w.-]+\.\w+)/i;
  const m1 = text.match(p1);
  if (m1) return m1[1];

  // Pattern 2: bare email address (user just typed the email)
  const p2 = /^([\w.+-]+@[\w.-]+\.\w+)$/i;
  const m2 = text.trim().match(p2);
  if (m2) return m2[1];

  // Pattern 3: "на email@..."
  const p3 = /на\s+([\w.+-]+@[\w.-]+\.\w+)/i;
  const m3 = text.match(p3);
  if (m3) return m3[1];

  return null;
}

// ============================
// Feature 2: Email-to-Order (IMAP watcher)
// ============================

async function parseEmailWithAI(emailText, fromAddress) {
  // Try OpenRouter first, fallback to OpenAI
  const apiUrl = OPENROUTER_API_KEY
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";
  const apiKey = OPENROUTER_API_KEY || OPENAI_API_KEY;
  const model = OPENROUTER_API_KEY ? "openai/gpt-4.1-nano" : "gpt-4.1-nano";

  if (!apiKey) return null;

  const systemPrompt = `Parse this email as a product order for a commercial kitchen equipment supplier.
Extract:
- Partner/company name
- Products with quantities
- Delivery details (city, address, phone)
- Any notes

Return ONLY valid JSON:
{
  "partner_name": "...",
  "items": [{"product_name": "...", "quantity": 1}],
  "delivery": {"city": "...", "phone": "...", "type": "office or address", "address": "..."},
  "notes": "..."
}

If this email is NOT an order (it's spam, newsletter, notification, etc.), return: {"not_order": true}`;

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `From: ${fromAddress}\n\n${emailText}` },
      ],
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    console.error("AI parse error:", res.status, await res.text());
    return null;
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";

  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    console.error("Failed to parse AI response:", content);
    return null;
  }
}

function startEmailWatcher(bot) {
  if (!IMAP_HOST || !IMAP_USER || !IMAP_PASS) {
    console.log("IMAP not configured, email watcher disabled");
    return;
  }

  if (!TELEGRAM_NOTIFY_USER) {
    console.log("TELEGRAM_NOTIFY_USER not set, email watcher disabled");
    return;
  }

  console.log("Starting email watcher...");
  let lastSeenUid = 0;

  function checkEmails() {
    const imap = new Imap({
      user: IMAP_USER,
      password: IMAP_PASS,
      host: IMAP_HOST,
      port: IMAP_PORT,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });

    imap.once("ready", () => {
      imap.openBox("INBOX", true, (err, box) => {
        if (err) {
          console.error("IMAP openBox error:", err.message);
          imap.end();
          return;
        }

        // Search for unseen messages
        imap.search(["UNSEEN"], (err, uids) => {
          if (err) {
            console.error("IMAP search error:", err.message);
            imap.end();
            return;
          }

          if (!uids || uids.length === 0) {
            imap.end();
            return;
          }

          // Only process UIDs we haven't seen
          const newUids = uids.filter((uid) => uid > lastSeenUid);
          if (newUids.length === 0) {
            imap.end();
            return;
          }

          const f = imap.fetch(newUids, { bodies: "", struct: true });

          f.on("message", (msg, seqno) => {
            let uid = 0;
            msg.on("attributes", (attrs) => {
              uid = attrs.uid;
            });

            msg.on("body", (stream) => {
              let buffer = "";
              stream.on("data", (chunk) => {
                buffer += chunk.toString("utf8");
              });
              stream.on("end", async () => {
                try {
                  const parsed = await simpleParser(buffer);
                  const fromAddr =
                    parsed.from?.value?.[0]?.address || "unknown";
                  const subject = parsed.subject || "(без тема)";
                  const textBody = parsed.text || "";

                  // Skip if from ourselves
                  if (fromAddr === IMAP_USER) return;

                  console.log(`📨 New email from ${fromAddr}: ${subject}`);

                  // Parse with AI
                  const orderData = await parseEmailWithAI(
                    `Subject: ${subject}\n\n${textBody}`,
                    fromAddr,
                  );

                  if (!orderData || orderData.not_order) {
                    console.log("Email is not an order, skipping");
                    return;
                  }

                  // Try to match products and create order
                  await processEmailOrder(bot, orderData, fromAddr, subject);
                } catch (e) {
                  console.error("Email processing error:", e.message);
                }
              });
            });

            msg.once("end", () => {
              if (uid > lastSeenUid) lastSeenUid = uid;
            });
          });

          f.once("error", (err) => {
            console.error("IMAP fetch error:", err.message);
          });

          f.once("end", () => {
            imap.end();
          });
        });
      });
    });

    imap.once("error", (err) => {
      console.error("IMAP connection error:", err.message);
    });

    imap.connect();
  }

  // Poll every 30 seconds
  checkEmails();
  setInterval(checkEmails, 30_000);
}

async function processEmailOrder(bot, orderData, fromEmail, subject) {
  const chatId = parseInt(TELEGRAM_NOTIFY_USER, 10);

  // Build items summary
  let itemsText = "";
  let matchedItems = [];

  for (const item of orderData.items || []) {
    try {
      const products = await searchProducts(item.product_name);
      const productList = Array.isArray(products)
        ? products
        : products.data || products.products || [];
      const matched = productList[0]; // Best match

      if (matched) {
        const price = Number(matched.price || matched.sell_price || 0);
        const lineTotal = price * item.quantity;
        itemsText += `• ${item.quantity}x ${matched.name} — ${lineTotal.toFixed(2)} €\n`;
        matchedItems.push({
          product_id: matched.id,
          quantity: item.quantity,
          price,
        });
      } else {
        itemsText += `• ${item.quantity}x ${item.product_name} — ⚠️ не е намерен\n`;
      }
    } catch {
      itemsText += `• ${item.quantity}x ${item.product_name} — ⚠️ грешка при търсене\n`;
    }
  }

  // Create pending order if we have matched items
  let orderId = null;
  if (matchedItems.length > 0) {
    try {
      const order = await createOrderFromEmail({
        partner_name: orderData.partner_name || fromEmail,
        items: matchedItems,
        delivery: orderData.delivery || {},
        notes: `Импортирана от email: ${fromEmail}\n${orderData.notes || ""}`,
        status: "pending",
      });
      orderId = order.id;
    } catch (e) {
      console.error("Failed to create order from email:", e.message);
    }
  }

  // Calculate total
  const total = matchedItems.reduce((sum, i) => sum + i.price * i.quantity, 0);

  // Send Telegram notification
  let text =
    `📨 *Нова поръчка от email!*\n` +
    `От: ${fromEmail}\n` +
    `Тема: ${subject}\n`;

  if (orderData.partner_name) {
    text += `Партньор: ${orderData.partner_name}\n`;
  }

  text += `\n${itemsText}`;

  if (total > 0) {
    text += `\n*Общо: ${total.toFixed(2)} €*`;
  }

  if (orderData.delivery?.city) {
    text += `\nДоставка: ${orderData.delivery.city}`;
    if (orderData.delivery.address) text += `, ${orderData.delivery.address}`;
  }

  const buttons = [];
  if (orderId) {
    text += `\n\nПоръчка #${orderId} (чакаща потвърждение)`;
    buttons.push([
      { text: "✅ Потвърди", callback_data: `confirm_emailorder_${orderId}` },
      { text: "✏️ Редактирай", callback_data: `edit_emailorder_${orderId}` },
      { text: "❌ Откажи", callback_data: `reject_emailorder_${orderId}` },
    ]);
  }

  await sendMessage(bot, chatId, text, {
    reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
  });
}

// ============================
// Process a user message
// ============================

// --- Hardcoded action: generate invoice and send PDF ---
async function handleGenerateInvoice(bot, chatId, userId, orderId) {
  bot.sendChatAction(chatId, "upload_document");

  try {
    // FIRST check if order already has invoice — just send PDF
    try {
      const checkRes = await apiCall("GET", `/orders/${orderId}`);
      const checkOrder = await checkRes.json();
      const co = checkOrder.data || checkOrder;
      if (co.invoice_id) {
        return await sendInvoicePdfDirect(
          bot,
          chatId,
          userId,
          co.invoice_id,
          orderId,
        );
      }
    } catch {}

    let invoice;
    try {
      invoice = await createInvoice(orderId);
    } catch (createErr) {
      // Maybe invoice was just created — check again
      try {
        const orderRes = await apiCall("GET", `/orders/${orderId}`);
        const order = await orderRes.json();
        const o = order.data || order;
        if (o.invoice_id) {
          return await sendInvoicePdfDirect(
            bot,
            chatId,
            userId,
            o.invoice_id,
            orderId,
          );
        }
      } catch {}
      await bot.sendMessage(
        chatId,
        `❌ Грешка при генериране на фактура: ${createErr.message}`,
      );
      return;
    }

    const invoiceId = invoice.id;
    userState[userId] = { ...userState[userId], lastInvoiceId: invoiceId };
    lastInvoicePerUser.set(userId, {
      invoiceId,
      invoiceNumber:
        invoice.invoice_number || invoice.invoiceNumber || `#${invoiceId}`,
      orderId,
    });
    await sendInvoicePdfDirect(bot, chatId, userId, invoiceId, orderId);
  } catch (err) {
    console.error("Invoice error:", err.message);
    await bot.sendMessage(chatId, "❌ Грешка при генериране на фактурата.");
  }
}

// --- Hardcoded action: send invoice PDF to chat ---
async function sendInvoicePdfDirect(bot, chatId, userId, invoiceId, orderId) {
  console.log(
    `[PDF] sendInvoicePdfDirect called: invoiceId=${invoiceId}, orderId=${orderId}`,
  );
  const pdfBuffer = await downloadInvoicePdf(invoiceId);
  console.log(`[PDF] Downloaded ${pdfBuffer.length} bytes`);

  let inv;
  try {
    inv = await getInvoice(invoiceId);
  } catch {
    inv = { id: invoiceId };
  }

  const invoiceNumber =
    inv.invoice_number || inv.invoiceNumber || `#${invoiceId}`;
  const tmpPath = join(tmpdir(), `faktura-${invoiceNumber}.pdf`);
  writeFileSync(tmpPath, pdfBuffer);

  let caption = `🧾 Фактура ${invoiceNumber}`;
  const invTotal = inv.total_gross || inv.total;
  if (invTotal != null) {
    caption += `\nОбщо: ${Number(invTotal).toFixed(2)} €`;
  }

  const buttons = [
    [{ text: "📧 Изпрати на email", callback_data: `email_ask_${invoiceId}` }],
  ];
  if (orderId) {
    buttons[0].push({
      text: "🚛 Товарителница",
      callback_data: `waybill_${orderId}`,
    });
    buttons.push([
      { text: "📦 Към склада", callback_data: `fulfill_${orderId}` },
    ]);
  }

  await bot.sendDocument(chatId, tmpPath, {
    caption,
    reply_markup: { inline_keyboard: buttons },
  });

  try {
    unlinkSync(tmpPath);
  } catch {}

  userState[userId] = { ...userState[userId], lastInvoiceId: invoiceId };
  lastInvoicePerUser.set(userId, { invoiceId, invoiceNumber, orderId });
}

// --- Hardcoded action: create waybill ---
async function handleCreateWaybill(bot, chatId, userId, orderId) {
  bot.sendChatAction(chatId, "typing");

  try {
    const orderRes = await apiCall("GET", `/orders/${orderId}`);
    const order = await orderRes.json();
    const o = order.data || order;

    if (!o.econt_city || !o.econt_receiver_name || !o.econt_receiver_phone) {
      await bot.sendMessage(
        chatId,
        `⚠️ Поръчка #${orderId} няма данни за доставка.\nМоля, кажете: получател, телефон, град и офис/адрес.`,
      );
      return;
    }

    if (o.econt_shipment_number) {
      await sendMessage(
        bot,
        chatId,
        `🚛 Поръчка #${orderId} — товарителница: ${o.econt_shipment_number}\n📍 https://www.econt.com/services/track-shipment/${o.econt_shipment_number}`,
      );
      // Send waybill PDF
      try {
        const pdfBuffer = await downloadWaybillPdf(o.econt_shipment_number);
        const tmpPath = `/tmp/waybill-${o.econt_shipment_number}.pdf`;
        writeFileSync(tmpPath, pdfBuffer);
        const waybillButtons = [
          [
            {
              text: "📧 Email",
              callback_data: `email_ask_${o.invoice_id || 0}`,
            },
            { text: "📦 Към склада", callback_data: `fulfill_${orderId}` },
          ],
          [{ text: "🆕 Нова поръчка", callback_data: "new_order" }],
        ];
        await bot.sendDocument(chatId, tmpPath, {
          caption: `📄 Товарителница ${o.econt_shipment_number}`,
          reply_markup: { inline_keyboard: waybillButtons },
        });
        try {
          unlinkSync(tmpPath);
        } catch {}
      } catch (e) {
        console.log("Existing waybill PDF:", e.message);
      }
      return;
    }

    const shipRes = await apiCall("POST", "/econt/create-shipment", {
      order_id: orderId,
      receiverName: o.econt_receiver_name,
      receiverPhone: o.econt_receiver_phone,
      receiverCity: o.econt_city,
      receiverOfficeCode: o.econt_office_code || undefined,
      receiverOfficeName: o.econt_office_name || undefined,
      receiverStreet: o.econt_street || undefined,
      receiverNum: o.econt_street_num || undefined,
      weight: parseFloat(o.econt_weight) || 1,
      codAmount: o.econt_cod_amount
        ? parseFloat(o.econt_cod_amount)
        : undefined,
      shipmentDescription: "Кухненско оборудване",
    });
    const shipData = await shipRes.json();

    if (shipData.shipmentNumber) {
      await sendMessage(
        bot,
        chatId,
        `🚛 Товарителница създадена!\nНомер: ${shipData.shipmentNumber}\n📍 ${shipData.trackingUrl || `https://www.econt.com/services/track-shipment/${shipData.shipmentNumber}`}`,
      );
      // Try to send waybill PDF via proxy
      try {
        const pdfBuffer = await downloadWaybillPdf(shipData.shipmentNumber);
        const tmpPath = `/tmp/waybill-${shipData.shipmentNumber}.pdf`;
        writeFileSync(tmpPath, pdfBuffer);
        const newWaybillButtons = [
          [
            {
              text: "📧 Email",
              callback_data: `email_ask_${o.invoice_id || 0}`,
            },
            { text: "📦 Към склада", callback_data: `fulfill_${orderId}` },
          ],
          [{ text: "🆕 Нова поръчка", callback_data: "new_order" }],
        ];
        await bot.sendDocument(chatId, tmpPath, {
          caption: `📄 Товарителница ${shipData.shipmentNumber}`,
          reply_markup: { inline_keyboard: newWaybillButtons },
        });
        try {
          unlinkSync(tmpPath);
        } catch {}
      } catch (pdfErr) {
        console.log("Waybill PDF not available:", pdfErr.message);
      }
    } else {
      await bot.sendMessage(
        chatId,
        `❌ ${shipData.error || "Грешка при създаване на товарителница"}`,
      );
    }
  } catch (err) {
    console.error("Waybill error:", err.message);
    await bot.sendMessage(chatId, "❌ Грешка при товарителницата.");
  }
}

// --- Hardcoded action: send invoice via email ---
async function handleSendEmail(bot, chatId, userId, toEmail, invoiceId) {
  bot.sendChatAction(chatId, "typing");

  try {
    const result = await sendInvoiceEmail(toEmail, invoiceId);
    const kwState = userState[userId] || {};
    const kwOrderId = kwState.lastOrderId;
    await bot.sendMessage(
      chatId,
      `✅ Фактурата ${result.invoiceNumber} е изпратена на ${toEmail}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🚛 Товарителница",
                callback_data: `waybill_${kwOrderId}`,
              },
              { text: "📦 Към склада", callback_data: `fulfill_${kwOrderId}` },
            ],
            [{ text: "🆕 Нова поръчка", callback_data: "new_order" }],
          ],
        },
      },
    );
  } catch (err) {
    console.error("Email send error:", err.message);
    await bot.sendMessage(
      chatId,
      `❌ Грешка при изпращане на email: ${err.message}`,
    );
  }
}

// Deduplication: prevent processing same message twice
const _processedMessages = new Map();
// Per-user processing lock to prevent concurrent handling
const _userLocks = new Map();

async function processUserMessage(
  bot,
  chatId,
  userId,
  userName,
  text,
  messageId,
) {
  // Deduplicate by message_id (unique per Telegram message) — bulletproof
  if (messageId) {
    if (_processedMessages.has(messageId)) {
      console.log(
        `[DEDUP] Skipping duplicate message_id=${messageId}: ${text.substring(0, 50)}`,
      );
      return;
    }
    _processedMessages.set(messageId, Date.now());
  }

  // Fallback dedup: same user + same text within 3 seconds
  const dedupeKey = `${userId}_${text}`;
  const now = Date.now();
  if (
    !messageId &&
    _processedMessages.has(dedupeKey) &&
    now - _processedMessages.get(dedupeKey) < 3000
  ) {
    console.log(`[DEDUP] Skipping duplicate text: ${text.substring(0, 50)}`);
    return;
  }
  if (!messageId) _processedMessages.set(dedupeKey, now);

  // Cleanup old entries
  if (_processedMessages.size > 200) {
    for (const [k, t] of _processedMessages) {
      if (now - t > 30000) _processedMessages.delete(k);
    }
  }

  // Per-user lock: prevent concurrent processing (e.g. voice + text race)
  if (_userLocks.has(userId)) {
    console.log(
      `[LOCK] User ${userId} already processing, skipping: ${text.substring(0, 50)}`,
    );
    return;
  }
  _userLocks.set(userId, true);
  try {
    await _processUserMessageInner(bot, chatId, userId, userName, text);
  } finally {
    _userLocks.delete(userId);
  }
}

async function _processUserMessageInner(bot, chatId, userId, userName, text) {
  // === HARDCODED ACTIONS — handle before AI ===
  const state = userState[userId] || {};

  // Pre-extract order ID from user text (e.g. "#23", "поръчка 23")
  const userOrderId = extractOrderId(text);
  if (userOrderId) {
    state.lastOrderId = userOrderId;
    userState[userId] = { ...userState[userId], lastOrderId: userOrderId };
  }

  // 0. Greeting detection → show menu buttons
  if (
    /^(здрасти|здравей|здравейте|привет|hi|hello|hey|добър ден|здр|zdr|zdravei)\s*[!.✅]?$/i.test(
      text.trim(),
    )
  ) {
    await bot.sendMessage(chatId, "Здравейте! 👋 Какво правим?", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🛒 Нова поръчка", callback_data: "new_order" },
            { text: "📦 Наличности", callback_data: "menu_inventory" },
          ],
          [
            { text: "📋 Днешни поръчки", callback_data: "menu_orders_today" },
            { text: "❓ Друго", callback_data: "menu_other" },
          ],
        ],
      },
    });
    return;
  }

  // 1. "изпрати на EMAIL" pattern (check first — most specific)
  const emailTarget = extractEmailSendRequest(text);
  if (emailTarget) {
    const lastInvoice = lastInvoicePerUser.get(userId);
    if (lastInvoice) {
      // Show confirmation with buttons
      await sendMessage(
        bot,
        chatId,
        `📧 Ще изпратя фактура ${lastInvoice.invoiceNumber} на ${emailTarget}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Изпрати",
                  callback_data: `email_send_${lastInvoice.invoiceId}_${emailTarget}`,
                },
                {
                  text: "✏️ Промени email",
                  callback_data: `email_ask_${lastInvoice.invoiceId}`,
                },
              ],
            ],
          },
        },
      );
      return;
    } else if (state.lastInvoiceId) {
      await handleSendEmail(
        bot,
        chatId,
        userId,
        emailTarget,
        state.lastInvoiceId,
      );
      return;
    } else {
      // No invoice context — let AI handle (it has send_email tool)
      // Don't block, fall through to AI
    }
  }

  // 2. "справка" / "наличности" / "inventory" — top-30 stocked products as text
  if (
    /(?:справка|наличност|inventory|всички продукти|цялата база)/i.test(text)
  ) {
    bot.sendChatAction(chatId, "typing");
    try {
      const res = await apiCall("GET", "/inventory?limit=30&has_stock=true");
      const data = await res.json();
      const rows = data.data || data.rows || data.items || [];
      if (!rows.length) {
        await bot.sendMessage(chatId, "📦 Няма налични продукти в момента.");
        return;
      }
      const lines = rows.slice(0, 30).map((r, i) => {
        const name = r.name_bg || r.name || r.product_name || "?";
        const sku = r.sku || "";
        const qty = r.total_quantity ?? r.quantity ?? r.stock_level ?? "?";
        const price = r.selling_price ?? r.price ?? "";
        return `${i + 1}. ${name}${sku ? ` [${sku}]` : ""} — ${qty} бр${price ? ` · ${price} лв` : ""}`;
      });
      const body = lines.join("\n");
      await bot.sendMessage(
        chatId,
        `📦 Топ 30 с наличност:\n\n${body}\n\nПълна справка: ${API_URL.replace(/\/+$/, "")}/inventory`,
      );
    } catch (err) {
      console.error("Inventory report error:", err.message);
      await bot.sendMessage(chatId, "❌ Грешка при генериране на справката.");
    }
    return;
  }

  // 3. "да" after "Искаш ли фактура?" — generate invoice directly
  // ONLY if last AI message asked about invoice (not order confirmation)
  const lastAiMsg = getHistory(userId)
    .filter((m) => m.role === "assistant")
    .pop();
  const lastAiAskedInvoice =
    lastAiMsg &&
    /[Ии]скаш ли фактура|[Фф]актура\?|[Гг]енерирам ли фактура/i.test(
      lastAiMsg.content || "",
    );
  if (
    /^(да|да,?\s*искам|искам фактура|разбира се)\s*[.!]?$/i.test(text.trim()) &&
    state.lastOrderId &&
    lastAiAskedInvoice
  ) {
    await handleGenerateInvoice(bot, chatId, userId, state.lastOrderId);
    return;
  }
  // 3b. "фактура" or "тук в чата" — generate/send invoice (when lastOrderId exists)
  if (
    /фактур/i.test(text) &&
    state.lastOrderId &&
    !/изпрати.*(?:на|до)\s+\S+@/i.test(text)
  ) {
    await handleGenerateInvoice(bot, chatId, userId, state.lastOrderId);
    return;
  }
  // 3. "товарителница" / "tovaritelnica" — send waybill PDF
  if (/товарителниц|tovaritelni[ct]/i.test(text) && state.lastOrderId) {
    await handleCreateWaybill(bot, chatId, userId, state.lastOrderId);
    return;
  }

  // "тук в чата" / "прати ми" / "prati mi" — context-aware: check what was asked
  const matchSendMe =
    /(?:тук|чата|прати ми|пращам тук|прати|изпрати|prati|izprati|isprati)\s*(?:ми|mi)?/i.test(
      text,
    );
  console.log(
    `[MATCH] "send me" pattern: ${matchSendMe}, lastOrderId: ${state.lastOrderId}`,
  );
  if (matchSendMe && state.lastOrderId) {
    // Check last AI message to determine what to send
    const lastAi = getHistory(userId)
      .filter((m) => m.role === "assistant")
      .pop();
    const lastAiText = lastAi?.content || "";
    const askedAboutWaybill =
      /товарителниц|tovaritelni|tracking|shipment/i.test(lastAiText);

    if (askedAboutWaybill) {
      // AI was talking about waybill → send waybill PDF
      await handleCreateWaybill(bot, chatId, userId, state.lastOrderId);
      return;
    }
    // Otherwise check if order has shipment and user said "прати ми"
    try {
      const orderRes = await apiCall("GET", `/orders/${state.lastOrderId}`);
      const orderData = await orderRes.json();
      const o = orderData.data || orderData;
      if (
        o.econt_shipment_number &&
        /(?:прати|изпрати|prati|izprati)/i.test(text)
      ) {
        // Ambiguous — let AI handle it
      } else if (o.invoice_id) {
        await handleGenerateInvoice(bot, chatId, userId, state.lastOrderId);
        return;
      }
    } catch {}
  }

  // === Otherwise: send to AI ===
  bot.sendChatAction(chatId, "typing");

  try {
    const history = getHistory(userId);
    const response = await sendToBackend(text, history, userId);
    const aiReply =
      response.reply ||
      response.message ||
      response.response ||
      "Няма отговор от системата.";

    console.log(
      `[${new Date().toISOString()}] AI -> ${userName}: ${aiReply.substring(0, 100)}...`,
    );
    addToHistory(userId, text, aiReply);

    // If AI says it sent email, actually send it from bot
    const emailSentMatch = aiReply.match(
      /(?:изпрат|пуснах|пратих).*?(?:на|до)\s+([\w.+-]+@[\w.-]+\.\w+)/i,
    );
    if (emailSentMatch && smtpTransporter) {
      const toEmail = emailSentMatch[1];
      // Extract subject from context or use default
      const subjectMatch = aiReply.match(
        /тема[:\s]+[«"']?(.+?)[»"']?(?:\n|$)/i,
      );
      const subject = subjectMatch
        ? subjectMatch[1]
        : "Съобщение от МЕРТ-М ЕООД";
      // Extract body - everything after the confirmation line
      const bodyMatch = aiReply.match(
        /(?:текст|съобщение)[:\s]+(.+?)(?:\n|✅|$)/is,
      );
      const body = bodyMatch ? bodyMatch[1].trim() : text;

      try {
        await smtpTransporter.sendMail({
          from: process.env.SMTP_FROM,
          to: toEmail,
          subject: subject,
          html: `<div style="font-family:Arial,sans-serif;"><p>${body.replace(/\n/g, "<br>")}</p><hr><p>С уважение,<br><strong>МЕРТ-М ЕООД</strong><br>гр. Пловдив, ул. Полет 80<br>Тел: 0885 165 719</p></div>`,
        });
        console.log(`[Bot SMTP] Email sent to ${toEmail}`);
      } catch (err) {
        console.error(`[Bot SMTP] Failed to send to ${toEmail}:`, err.message);
      }
    }

    // Strip markdown for pattern matching (keep original for display)
    const cleanAiReply = aiReply.replace(/\*{1,2}/g, "");

    // Track any order ID mentioned in AI reply
    const mentionedOrderId = extractOrderId(aiReply);
    if (mentionedOrderId) {
      userState[userId] = {
        ...userState[userId],
        lastOrderId: mentionedOrderId,
      };
    }

    // --- Auto-detect: Order created → show buttons ---
    if (isOrderCreationResponse(aiReply)) {
      const orderId = extractOrderId(aiReply);
      if (orderId) {
        userState[userId] = { ...userState[userId], lastOrderId: orderId };

        const formatted = formatForTelegram(aiReply);

        // Check if order has econt data or invoice already
        let hasEcont = false;
        let invoiceId = null;
        try {
          const orderRes = await apiCall("GET", `/orders/${orderId}`);
          const orderData = await orderRes.json();
          const o = orderData.data || orderData;
          hasEcont = !!o.econt_city;
          invoiceId = o.invoice_id || null;
        } catch {}

        const buttons = [
          { text: "📄 Фактура", callback_data: `invoice_${orderId}` },
        ];
        if (hasEcont) {
          buttons.push({
            text: "🚛 Товарителница",
            callback_data: `waybill_${orderId}`,
          });
        }
        buttons.push({ text: "❌ Отмени", callback_data: `cancel_${orderId}` });

        console.log(
          `[BUTTONS] Order #${orderId} created → showing ${buttons.length} buttons`,
        );

        const opts = { reply_markup: { inline_keyboard: [buttons] } };
        try {
          await bot.sendMessage(chatId, formatted, {
            ...opts,
            parse_mode: "Markdown",
          });
        } catch {
          await bot.sendMessage(chatId, formatted, opts);
        }

        // If AI also created invoice in same response → send PDF too
        if (invoiceId) {
          console.log(
            `[PDF] Order #${orderId} has invoice ${invoiceId} → sending PDF`,
          );
          try {
            await sendInvoicePdfDirect(bot, chatId, userId, invoiceId, orderId);
          } catch (e) {
            console.error("Auto invoice PDF after order:", e.message);
          }
        }
        return;
      }
    }

    // --- Auto-detect: Invoice created in AI reply → send PDF ---
    const hasInvoiceRef =
      /фактура|invoice|GF-\d{4}/i.test(cleanAiReply) &&
      /готов|създаде|генерир|✅|📄/i.test(cleanAiReply);
    if (hasInvoiceRef) {
      const curState = userState[userId] || {};
      const orderId = curState.lastOrderId;
      console.log(`[PDF-DETECT] Invoice ref in AI reply, orderId=${orderId}`);
      if (orderId) {
        try {
          const orderRes = await apiCall("GET", `/orders/${orderId}`);
          const orderData = await orderRes.json();
          const o = orderData.data || orderData;
          if (o.invoice_id) {
            console.log(`[PDF] Sending invoice PDF: invoiceId=${o.invoice_id}`);
            await sendMessage(bot, chatId, aiReply);
            await sendInvoicePdfDirect(
              bot,
              chatId,
              userId,
              o.invoice_id,
              orderId,
            );
            return;
          }
        } catch (e) {
          console.error("Auto PDF send error:", e.message);
        }
      }
    }

    // NOTE: Auto-waybill after econt save REMOVED — AI handles full flow
    // (was causing errors when econt data was incomplete)

    // --- Auto-detect: Waybill created in AI reply → send PDF ---
    const waybillMatch =
      cleanAiReply.match(/(?:товарителница|shipment).*?(\d{10,})/i) ||
      cleanAiReply.match(/(\d{10,}).*(?:товарителница|tracking)/i);
    if (waybillMatch) {
      const shipNum = waybillMatch[1];
      console.log(`[PDF] Waybill detected: ${shipNum}`);
      await sendMessage(bot, chatId, aiReply);
      try {
        const pdfBuffer = await downloadWaybillPdf(shipNum);
        const tmpPath = `/tmp/waybill-${shipNum}.pdf`;
        writeFileSync(tmpPath, pdfBuffer);
        const curState = userState[userId] || {};
        const autoWbOrderId = curState.lastOrderId;
        const autoWbButtons = [
          [
            {
              text: "📦 Към склада",
              callback_data: `fulfill_${autoWbOrderId || 0}`,
            },
          ],
          [{ text: "🆕 Нова поръчка", callback_data: "new_order" }],
        ];
        await bot.sendDocument(chatId, tmpPath, {
          caption: `📄 Товарителница ${shipNum}`,
          reply_markup: { inline_keyboard: autoWbButtons },
        });
        try {
          unlinkSync(tmpPath);
        } catch {}
      } catch (e) {
        console.log("Waybill PDF auto-send:", e.message);
      }
      return;
    }

    // "чия сметка" — just send the AI text, no buttons (user answers by voice/text)

    await sendMessage(bot, chatId, aiReply);
  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(
      chatId,
      "Възникна грешка при обработката. Моля, опитайте отново.",
    );
  }
}

// ============================
// Bot main
// ============================

async function main() {
  await login();
  scheduleTokenRefresh();

  const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  console.log("Bot started, waiting for messages...");

  // Graceful shutdown: stop polling before exit to prevent 409 Conflict
  const shutdown = (signal) => {
    console.log(`[${signal}] Stopping bot polling...`);
    bot.stopPolling();
    setTimeout(() => process.exit(0), 1000);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Start email watcher
  startEmailWatcher(bot);

  // --- Cron jobs ---
  if (TELEGRAM_NOTIFY_USER) {
    const notifyChat = parseInt(TELEGRAM_NOTIFY_USER, 10);

    // Morning report (08:00 Sofia time)
    cron.schedule(
      "0 8 * * *",
      async () => {
        console.log("[Cron] Morning report");
        try {
          const [ordersRes, statsRes] = await Promise.all([
            apiCall("GET", "/orders?status=pending")
              .then((r) => r.json())
              .catch(() => ({ data: [] })),
            apiCall("GET", "/analytics/dashboard")
              .then((r) => r.json())
              .catch(() => ({})),
          ]);

          const pendingOrders = Array.isArray(ordersRes)
            ? ordersRes.length
            : ordersRes.data?.length || 0;
          const lowStock =
            statsRes.low_stock_count || statsRes.lowStockCount || 0;
          const unpaid =
            statsRes.unpaid_invoices || statsRes.unpaidInvoices || 0;

          await sendMessage(
            bot,
            notifyChat,
            `☀️ *Добро утро! Дневен отчет:*\n` +
              `📦 Чакащи поръчки: ${pendingOrders}\n` +
              `⚠️ Нисък запас: ${lowStock} продукта\n` +
              `💰 Неплатени фактури: ${unpaid}`,
          );
        } catch (err) {
          console.error("[Cron] Morning report error:", err.message);
        }
      },
      { timezone: "Europe/Sofia" },
    );

    // Midday check (12:00) — stuck orders
    cron.schedule(
      "0 12 * * *",
      async () => {
        console.log("[Cron] Midday check");
        try {
          const res = await apiCall("GET", "/orders?status=pending")
            .then((r) => r.json())
            .catch(() => []);
          const orders = Array.isArray(res) ? res : res.data || [];
          const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
          const stuck = orders.filter(
            (o) =>
              new Date(o.order_date || o.created_at).getTime() < fourHoursAgo,
          );

          if (stuck.length > 0) {
            const list = stuck
              .slice(0, 5)
              .map((o) => `• #${o.id} — ${o.partner_name || "?"}`)
              .join("\n");
            await sendMessage(
              bot,
              notifyChat,
              `⏰ *${stuck.length} поръчки чакат повече от 4 часа:*\n${list}`,
            );
          }
        } catch (err) {
          console.error("[Cron] Midday check error:", err.message);
        }
      },
      { timezone: "Europe/Sofia" },
    );

    // Evening summary (17:00)
    cron.schedule(
      "0 17 * * *",
      async () => {
        console.log("[Cron] Evening summary");
        try {
          const stats = await apiCall("GET", "/analytics/dashboard")
            .then((r) => r.json())
            .catch(() => ({}));
          const todayOrders = stats.orders_today || stats.ordersToday || 0;
          const todayRevenue = stats.revenue_today || stats.revenueToday || 0;
          const fulfilled = stats.fulfilled_today || stats.fulfilledToday || 0;

          await sendMessage(
            bot,
            notifyChat,
            `🌆 *Дневно обобщение:*\n` +
              `📦 Поръчки днес: ${todayOrders}\n` +
              `✅ Изпълнени: ${fulfilled}\n` +
              `💰 Приход: ${Number(todayRevenue).toFixed(2)} €`,
          );
        } catch (err) {
          console.error("[Cron] Evening summary error:", err.message);
        }
      },
      { timezone: "Europe/Sofia" },
    );

    console.log(
      "[Cron] Scheduled: 08:00 morning, 12:00 midday, 17:00 evening (Europe/Sofia)",
    );
  }

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!isAllowed(userId)) {
      bot.sendMessage(chatId, "Нямате достъп до тази система.");
      return;
    }
    bot.sendMessage(
      chatId,
      `Здравейте! 👋 Аз съм AI асистентът на *МЕРТ-М* склад.\n\nКакво искате да направим?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🛒 Нова поръчка", callback_data: "new_order" },
              {
                text: "📦 Справка наличности",
                callback_data: "menu_inventory",
              },
            ],
            [
              { text: "📋 Днешни поръчки", callback_data: "menu_orders_today" },
              { text: "❓ Друго", callback_data: "menu_other" },
            ],
          ],
        },
      },
    );
  });

  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAllowed(msg.from.id)) return;
    bot.sendMessage(
      chatId,
      `*Примерни въпроси:*\n\n` +
        `- Колко фритюрника имаме?\n` +
        `- Покажи наличности за Hendi\n` +
        `- Направи поръчка за Ресторант Средец: 2 фритюрника Hendi\n` +
        `- Кои партньори са от София?\n` +
        `- Какво е продадено този месец?\n\n` +
        `📧 *Email фактура:*\n` +
        `- "изпрати на client@email.com"\n\n` +
        `*Команди:*\n` +
        `/health — Провери дали системата работи\n` +
        `/bug <описание> — Докладвай проблем\n` +
        `/clear — Изчисти историята на разговора`,
      { parse_mode: "Markdown" },
    );
  });

  bot.onText(/\/health/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAllowed(msg.from.id)) return;
    try {
      const res = await fetch(`${API_URL}/health`);
      if (res.ok) {
        bot.sendMessage(chatId, "✅ Системата е онлайн и работи нормално!");
      } else {
        bot.sendMessage(
          chatId,
          `⚠️ Системата отговаря, но с грешка: HTTP ${res.status}`,
        );
      }
    } catch (e) {
      bot.sendMessage(
        chatId,
        "❌ Системата не отговаря! Може да е в процес на рестартиране. Опитайте отново след 2-3 минути.",
      );
    }
  });

  bot.onText(/\/bug (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAllowed(msg.from.id)) return;
    const report = match[1];
    const ticketsDir = join(KB_DIR, "tickets");
    if (!existsSync(ticketsDir)) mkdirSync(ticketsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ticket = `# Bug Report\n- **Дата:** ${new Date().toLocaleString("bg-BG")}\n- **Потребител:** ${msg.from.first_name} (${msg.from.id})\n- **Описание:** ${report}\n- **Статус:** Нов\n`;
    writeFileSync(join(ticketsDir, `bug-${timestamp}.md`), ticket);
    bot.sendMessage(
      chatId,
      `🐛 Бъгът е записан! Ticket ID: bug-${timestamp}\nЩе бъде прегледан от екипа.`,
    );
  });

  bot.onText(/\/clear/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAllowed(msg.from.id)) return;
    clearHistory(msg.from.id);
    bot.sendMessage(chatId, "Историята на разговора е изчистена.");
  });

  bot.onText(/^\/reset$/, async (msg) => {
    const userId = msg.from.id;
    if (!isAllowed(userId)) return;
    userHistories.delete(userId);
    if (userState[userId]) delete userState[userId];
    lastInvoicePerUser.delete(userId);
    await bot.sendMessage(msg.chat.id, "✅ State изчистено.");
  });

  // --- Callback query handler (inline buttons) ---
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const userName = query.from.first_name || query.from.username || "Unknown";

    if (!isAllowed(userId)) {
      await bot.answerCallbackQuery(query.id, { text: "Нямате достъп." });
      return;
    }

    const data = query.data;

    // --- Invoice generation: invoice_ORDER_ID ---
    if (data.startsWith("invoice_")) {
      const orderId = parseInt(data.replace("invoice_", ""), 10);
      // Debounce: prevent double-click
      const debounceKey = `inv_${userId}_${orderId}`;
      if (global._invoiceDebounce?.[debounceKey]) {
        await bot.answerCallbackQuery(query.id, {
          text: "Вече се генерира...",
        });
        return;
      }
      global._invoiceDebounce = global._invoiceDebounce || {};
      global._invoiceDebounce[debounceKey] = true;
      setTimeout(() => {
        delete global._invoiceDebounce[debounceKey];
      }, 5000);

      await bot.answerCallbackQuery(query.id, {
        text: "Генериране на фактура...",
      });

      userState[userId] = { ...userState[userId], lastOrderId: orderId };
      await handleGenerateInvoice(bot, chatId, userId, orderId);

      // Remove buttons from original message
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: query.message.message_id },
        );
      } catch {}
      return;
    }

    // --- Cancel order: cancel_ORDER_ID ---
    if (data.startsWith("cancel_")) {
      const orderId = parseInt(data.replace("cancel_", ""), 10);
      await bot.answerCallbackQuery(query.id, {
        text: "Отмяна на поръчката...",
      });

      try {
        await cancelOrder(orderId);
        await bot.sendMessage(chatId, `❌ Поръчка #${orderId} е отменена.`);
        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: chatId, message_id: query.message.message_id },
          );
        } catch {}
      } catch (err) {
        console.error("Cancel order error:", err.message);
        await bot.sendMessage(
          chatId,
          `❌ Грешка при отмяна на поръчка #${orderId}: ${err.message}`,
        );
      }
      return;
    }

    // --- Ask for email: email_ask_INVOICEID ---
    if (data.startsWith("email_ask_")) {
      const invoiceId = parseInt(data.replace("email_ask_", ""), 10);
      await bot.answerCallbackQuery(query.id);

      if (!invoiceId || invoiceId === 0) {
        await bot.sendMessage(
          chatId,
          `⚠️ Няма генерирана фактура за тази поръчка. Първо генерирайте фактура.`,
        );
        return;
      }

      // Save invoice context
      lastInvoicePerUser.set(userId, {
        invoiceId,
        invoiceNumber: `#${invoiceId}`,
        orderId: null,
      });

      await bot.sendMessage(
        chatId,
        `📧 Напишете email адреса:\n\n_Пример: "изпрати на client@email.com"_`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    // --- Send email: email_send_INVOICEID_EMAIL ---
    if (data.startsWith("email_send_")) {
      const parts = data.replace("email_send_", "").split("_");
      const invoiceId = parseInt(parts[0], 10);
      const toEmail = parts.slice(1).join("_"); // Email may not contain _, but be safe

      await bot.answerCallbackQuery(query.id, {
        text: "Изпращане на email...",
      });
      bot.sendChatAction(chatId, "typing");

      try {
        const result = await sendInvoiceEmail(toEmail, invoiceId);
        const emailState = userState[userId] || {};
        const emailOrderId = emailState.lastOrderId;
        const emailButtons = [
          [
            {
              text: "🚛 Товарителница",
              callback_data: `waybill_${emailOrderId}`,
            },
            { text: "📦 Към склада", callback_data: `fulfill_${emailOrderId}` },
          ],
          [{ text: "🆕 Нова поръчка", callback_data: "new_order" }],
        ];
        await bot.sendMessage(
          chatId,
          `✅ Фактурата ${result.invoiceNumber} е изпратена на ${toEmail}`,
          { reply_markup: { inline_keyboard: emailButtons } },
        );

        // Remove confirmation buttons
        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: chatId, message_id: query.message.message_id },
          );
        } catch {}
      } catch (err) {
        console.error("Email send error:", err.message);
        await bot.sendMessage(
          chatId,
          `❌ Грешка при изпращане на email: ${err.message}`,
        );
      }
      return;
    }

    // --- Waybill creation: waybill_ORDER_ID ---
    if (data.startsWith("waybill_")) {
      const orderId = parseInt(data.replace("waybill_", ""), 10);
      await bot.answerCallbackQuery(query.id, {
        text: "Създаване на товарителница...",
      });

      userState[userId] = { ...userState[userId], lastOrderId: orderId };
      await handleCreateWaybill(bot, chatId, userId, orderId);

      // Remove buttons from original message
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: query.message.message_id },
        );
      } catch {}
      return;
    }

    // --- Confirm email order: confirm_emailorder_ORDER_ID ---
    if (data.startsWith("confirm_emailorder_")) {
      const orderId = parseInt(data.replace("confirm_emailorder_", ""), 10);
      await bot.answerCallbackQuery(query.id, { text: "Потвърждаване..." });

      try {
        await apiCall("PUT", `/orders/${orderId}/status`, {
          status: "confirmed",
        });
        await bot.sendMessage(
          chatId,
          `✅ Поръчка #${orderId} от email е потвърдена.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "📄 Фактура", callback_data: `invoice_${orderId}` },
                  {
                    text: "📧 Email фактура",
                    callback_data: `email_invoice_order_${orderId}`,
                  },
                ],
              ],
            },
          },
        );
        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: chatId, message_id: query.message.message_id },
          );
        } catch {}
      } catch (err) {
        console.error("Confirm order error:", err.message);
        await bot.sendMessage(
          chatId,
          `❌ Грешка при потвърждаване: ${err.message}`,
        );
      }
      return;
    }

    // --- Reject email order: reject_emailorder_ORDER_ID ---
    if (data.startsWith("reject_emailorder_")) {
      const orderId = parseInt(data.replace("reject_emailorder_", ""), 10);
      await bot.answerCallbackQuery(query.id, { text: "Отказване..." });

      try {
        await cancelOrder(orderId);
        await bot.sendMessage(
          chatId,
          `❌ Email поръчка #${orderId} е отказана и изтрита.`,
        );
        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: chatId, message_id: query.message.message_id },
          );
        } catch {}
      } catch (err) {
        console.error("Reject order error:", err.message);
        await bot.sendMessage(
          chatId,
          `❌ Грешка при отказване: ${err.message}`,
        );
      }
      return;
    }

    // --- Edit email order: opens web ---
    if (data.startsWith("edit_emailorder_")) {
      const orderId = parseInt(data.replace("edit_emailorder_", ""), 10);
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(
        chatId,
        `✏️ Редактирайте поръчка #${orderId} тук:\n${API_URL}/orders/${orderId}`,
      );
      return;
    }

    // --- Email invoice for confirmed order ---
    if (data.startsWith("email_invoice_order_")) {
      const orderId = parseInt(data.replace("email_invoice_order_", ""), 10);
      await bot.answerCallbackQuery(query.id);
      // First generate invoice, then ask for email
      try {
        bot.sendChatAction(chatId, "typing");
        const invoice = await createInvoice(orderId);
        const invoiceId = invoice.id;
        const invoiceNumber =
          invoice.invoice_number || invoice.invoiceNumber || `#${invoiceId}`;
        lastInvoicePerUser.set(userId, { invoiceId, invoiceNumber, orderId });
        await bot.sendMessage(
          chatId,
          `🧾 Фактура ${invoiceNumber} генерирана.\n📧 Напишете email адреса:\n_"изпрати на client@email.com"_`,
          { parse_mode: "Markdown" },
        );
      } catch (err) {
        await bot.sendMessage(chatId, `❌ Грешка: ${err.message}`);
      }
      return;
    }

    // --- Fulfill order: fulfill_ORDER_ID ---
    if (data.startsWith("fulfill_")) {
      const orderId = parseInt(data.replace("fulfill_", ""), 10);
      if (!orderId) {
        await bot.answerCallbackQuery(query.id, { text: "Невалидна поръчка." });
        return;
      }
      await bot.answerCallbackQuery(query.id, {
        text: "Изпълняване на поръчката...",
      });
      bot.sendChatAction(chatId, "typing");

      try {
        await apiCall("PUT", `/orders/${orderId}/status`, {
          status: "processing",
        });
        await bot.sendMessage(
          chatId,
          `📦 Поръчка #${orderId} е изпратена към склада за пакетиране.`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🆕 Нова поръчка", callback_data: "new_order" }],
              ],
            },
          },
        );
        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: chatId, message_id: query.message.message_id },
          );
        } catch {}
      } catch (err) {
        console.error("Fulfill order error:", err.message);
        await bot.sendMessage(
          chatId,
          `❌ Грешка при изпълняване на поръчка #${orderId}: ${err.message}`,
        );
      }
      return;
    }

    // --- New order: clear history and prompt ---
    if (data === "menu_inventory") {
      await bot.answerCallbackQuery(query.id, { text: "📦" });
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: query.message.message_id },
        );
      } catch {}
      await bot.sendMessage(
        chatId,
        "📦 За кой продукт искаш да проверя наличностите? Напиши името или кажи с гласова.",
      );
      return;
    }
    if (data === "menu_orders_today") {
      await bot.answerCallbackQuery(query.id, { text: "📋" });
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: query.message.message_id },
        );
      } catch {}
      bot.sendChatAction(chatId, "typing");
      await processUserMessage(
        bot,
        chatId,
        userId,
        userName,
        "Покажи колко поръчки има направени днес, списък с номер, клиент, сума и статус на всяка",
      );
      return;
    }
    if (data === "menu_other") {
      await bot.answerCallbackQuery(query.id, { text: "Пишете свободно!" });
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: query.message.message_id },
        );
      } catch {}
      await bot.sendMessage(
        chatId,
        "Питайте каквото искате — разбирам гласови и текстови съобщения! 🎤",
      );
      return;
    }
    // --- Shipping payment buttons ---
    // --- Done (fulfill) order: done_ORDER_ID ---
    if (data.startsWith("done_")) {
      const orderId = parseInt(data.replace("done_", ""), 10);
      if (!orderId) {
        await bot.answerCallbackQuery(query.id, { text: "Невалидна поръчка." });
        return;
      }
      await bot.answerCallbackQuery(query.id, { text: "Изпълняване..." });
      try {
        await apiCall("POST", `/orders/${orderId}/fulfill`);
        await bot.sendMessage(
          chatId,
          `✅ Поръчка #${orderId} е изпълнена! Наличностите са дръпнати от склада.`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🆕 Нова поръчка", callback_data: "new_order" }],
              ],
            },
          },
        );
        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: chatId, message_id: query.message.message_id },
          );
        } catch {}
      } catch (e) {
        await bot.sendMessage(chatId, `❌ Грешка: ${e.message}`);
      }
      return;
    }

    if (data === "new_order") {
      await bot.answerCallbackQuery(query.id, { text: "Нова поръчка..." });
      clearHistory(userId);
      userState[userId] = {};
      await bot.sendMessage(
        chatId,
        "🆕 Готов за нова поръчка! Кажете какво да поръчаме.",
      );
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: query.message.message_id },
        );
      } catch {}
      return;
    }

    // Fallback
    await bot.answerCallbackQuery(query.id);
  });

  // --- Voice message handler ---
  bot.on("voice", async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name || "Unknown";

    if (!isAllowed(userId)) {
      bot.sendMessage(chatId, "Нямате достъп до тази система.");
      return;
    }

    if (!OPENAI_API_KEY) {
      bot.sendMessage(chatId, "Гласовите съобщения не са конфигурирани.");
      return;
    }

    console.log(
      `[${new Date().toISOString()}] 🎤 ${userName} (${userId}): voice message`,
    );
    bot.sendChatAction(chatId, "typing");

    try {
      const transcript = await transcribeVoice(bot, msg.voice.file_id);
      console.log(`[${new Date().toISOString()}] 🎤 Transcript: ${transcript}`);

      if (!transcript || transcript.trim().length === 0) {
        await bot.sendMessage(
          chatId,
          "Не успях да разбера гласовото съобщение. Моля, опитайте отново.",
        );
        return;
      }

      await processUserMessage(
        bot,
        chatId,
        userId,
        userName,
        transcript,
        msg.message_id,
      );
    } catch (err) {
      console.error("Voice error:", err.message);
      bot.sendMessage(
        chatId,
        "Грешка при обработка на гласовото съобщение. Опитайте отново.",
      );
    }
  });

  // --- Text message handler ---
  bot.on("message", async (msg) => {
    if (msg.text && msg.text.startsWith("/")) return;
    if (!msg.text) return;
    if (msg.voice) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name || "Unknown";

    if (!isAllowed(userId)) {
      bot.sendMessage(chatId, "Нямате достъп до тази система.");
      return;
    }

    console.log(
      `[${new Date().toISOString()}] ${userName} (${userId}): ${msg.text}`,
    );
    await processUserMessage(
      bot,
      chatId,
      userId,
      userName,
      msg.text,
      msg.message_id,
    );
  });

  bot.on("polling_error", (err) => {
    console.error("Polling error:", err.message);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
