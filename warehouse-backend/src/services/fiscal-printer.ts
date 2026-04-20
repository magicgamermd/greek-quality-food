/**
 * DAISY Compact M 02 Fiscal Printer Integration
 *
 * Two modes:
 * 1. FPGate REST API (recommended) — communicates via FPGate Java service
 * 2. Direct serial — implements DAISY binary protocol (STX/LEN/SEQ/CMD/DATA/BCC/ETX)
 *
 * Protocol reference: DAISY EURO protocol v2.0-2 2025
 * Currency: EUR
 * Tax groups: А=0%, Б=20% (standard), В=9%, Г=0%
 */

import { query } from "../db.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FiscalSettings {
  fiscal_enabled: boolean;
  fiscal_connection_type: "fpgate" | "serial";
  fiscal_fpgate_url: string;
  fiscal_printer_id: string | null;
  fiscal_serial_port: string | null;
  fiscal_auto_print: boolean;
  fiscal_operator_id: string;
  fiscal_operator_password: string;
}

export interface FiscalSaleItem {
  name: string;
  quantity: number;
  unitPrice: number;
  taxGroup: string; // А, Б, В, Г (Cyrillic) or A, B, C, D (Latin)
}

export interface FiscalReceiptResult {
  success: boolean;
  receiptNumber?: string;
  error?: string;
}

export interface FiscalStatusResult {
  connected: boolean;
  hasError: boolean;
  paperOk: boolean;
  fiscalReceiptOpen: boolean;
  details?: Record<string, any>;
  error?: string;
}

// ─── Settings loader ─────────────────────────────────────────────────────────

export async function getFiscalSettings(): Promise<FiscalSettings> {
  const { rows } = await query("SELECT * FROM settings WHERE id = 1");
  const s = rows[0] || {};
  return {
    fiscal_enabled: s.fiscal_enabled ?? false,
    fiscal_connection_type: s.fiscal_connection_type || "fpgate",
    fiscal_fpgate_url: s.fiscal_fpgate_url || "http://localhost:8182",
    fiscal_printer_id: s.fiscal_printer_id || null,
    fiscal_serial_port: s.fiscal_serial_port || null,
    fiscal_auto_print: s.fiscal_auto_print ?? false,
    fiscal_operator_id: s.fiscal_operator_id || "1",
    fiscal_operator_password: s.fiscal_operator_password || "0000",
  };
}

// ─── FPGate JSON-RPC Client ─────────────────────────────────────────────────

let fpgateRpcId = 1;

async function fpgateJsonRpc(
  settings: FiscalSettings,
  method: string,
  params?: Record<string, any>,
): Promise<any> {
  const url = `${settings.fiscal_fpgate_url}/print/`;
  const body = {
    method,
    params: params || {},
    id: String(fpgateRpcId++),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`FPGate HTTP error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as {
    result?: any;
    error?: { code?: number; message?: string };
  };
  if (json.error) {
    throw new Error(
      `FPGate RPC error ${json.error.code || ""}: ${json.error.message || JSON.stringify(json.error)}`,
    );
  }
  return json.result;
}

async function fpgatePrintReceipt(
  settings: FiscalSettings,
  items: FiscalSaleItem[],
  paymentType: "cash" | "card" | "bank" = "cash",
): Promise<FiscalReceiptResult> {
  try {
    // Build arguments array using FPGate EDA subcommand format
    // Each argument is a tab-delimited string
    const args: string[] = [];

    // Set operator credentials (SOC=code, SOP=password, SON=name)
    args.push(`SOC\t${settings.fiscal_operator_id}`);
    args.push(`SOP\t${settings.fiscal_operator_password}`);
    args.push(`SON\tOperator ${settings.fiscal_operator_id}`);

    // Generate unique sale number
    const unp = `DY000001-OP${settings.fiscal_operator_id.padStart(2, "0")}-${String(Date.now() % 10000000).padStart(7, "0")}`;
    args.push(`UNS\t${unp}`);

    // Sale items: STG\tText\tTaxGroup\tPrice\tDiscount[\tQuantity]
    for (const item of items) {
      const taxGr = mapTaxGroupToLatin(item.taxGroup);
      args.push(
        `STG\t${item.name}\t${taxGr}\t${item.unitPrice.toFixed(2)}\t0\t${item.quantity.toFixed(3)}`,
      );
    }

    // Subtotal
    args.push("STL");

    // Total/payment: TTL\tText\tPaymentType\tAmount
    const paymentMap: Record<string, string> = {
      cash: "CASH",
      card: "CARD",
      bank: "CHECK",
    };
    const total = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    args.push(
      `TTL\tTotal:\t${paymentMap[paymentType] || "CASH"}\t${total.toFixed(2)}`,
    );

    const result = await fpgateJsonRpc(settings, "PrintFiscalCheck", {
      arguments: args,
      printer: settings.fiscal_printer_id
        ? { ID: settings.fiscal_printer_id }
        : undefined,
    });

    return {
      success: true,
      receiptNumber: result?.ReceiptNumber || result?.DocNum || undefined,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function fpgateGetStatus(
  settings: FiscalSettings,
): Promise<FiscalStatusResult> {
  try {
    const result = await fpgateJsonRpc(settings, "PrinterStatus", {
      arguments: [],
      printer: settings.fiscal_printer_id
        ? { ID: settings.fiscal_printer_id }
        : undefined,
    });
    return {
      connected: true,
      hasError: result?.HasError === true,
      paperOk: result?.NoPaper !== true,
      fiscalReceiptOpen: result?.FiscalCheckOpen === true,
      details: result,
    };
  } catch (err: any) {
    return {
      connected: false,
      hasError: true,
      paperOk: false,
      fiscalReceiptOpen: false,
      error: err.message,
    };
  }
}

async function fpgateDailyReport(
  settings: FiscalSettings,
  type: "Z" | "X" = "Z",
): Promise<FiscalReceiptResult> {
  try {
    const result = await fpgateJsonRpc(settings, "PrintDailyReport", {
      arguments: [`ReportType=${type}`],
      printer: settings.fiscal_printer_id
        ? { ID: settings.fiscal_printer_id }
        : undefined,
    });
    return {
      success: true,
      receiptNumber: result?.Closure || result?.DocNum || undefined,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Direct Serial (DAISY binary protocol) ───────────────────────────────────
// Protocol: STX(01h) LEN SEQ CMD DATA Postamble1(05h) BCC(4 bytes) ETX(03h)

const STX = 0x01;
const ETX = 0x03;
const POSTAMBLE = 0x05;
const NAK = 0x15;
const SYN = 0x16;

let serialSequence = 0x20; // Sequence counter, starts at 0x20

function nextSequence(): number {
  const seq = serialSequence;
  serialSequence = serialSequence >= 0xff ? 0x20 : serialSequence + 1;
  return seq;
}

function buildDaisyPacket(cmd: number, data: string = ""): Buffer {
  const dataBytes = Buffer.from(data, "ascii");
  // LEN = count of bytes from pos 2 (LEN itself) to pos 6 (Postamble1) inclusive
  // = 1(LEN) + 1(SEQ) + 1(CMD) + dataLen + 1(Postamble) = dataLen + 4
  // But per protocol: LEN = byte count from pos 2 to pos 6 (inclusive) + 0x20 offset
  // Positions: 2=LEN, 3=SEQ, 4=CMD, 5=DATA(0..200), 6=Postamble1
  // So LEN = (SEQ + CMD + DATA + Postamble) + 0x20 = (1 + 1 + dataLen + 1) + 0x20
  const len = dataBytes.length + 3 + 0x20;
  const seq = nextSequence();

  // Build the bytes to checksum: LEN, SEQ, CMD, DATA, POSTAMBLE
  const checksumBytes: number[] = [len, seq, cmd + 0x20];
  for (const b of dataBytes) {
    checksumBytes.push(b);
  }
  checksumBytes.push(POSTAMBLE);

  // BCC = sum of bytes from pos 2 to pos 6 inclusive
  let bcc = 0;
  for (const b of checksumBytes) {
    bcc += b;
  }

  // BCC transmitted as 4 ASCII chars: each nibble + 0x30
  const bcc4 = [
    ((bcc >> 12) & 0x0f) + 0x30,
    ((bcc >> 8) & 0x0f) + 0x30,
    ((bcc >> 4) & 0x0f) + 0x30,
    (bcc & 0x0f) + 0x30,
  ];

  const packet = Buffer.alloc(dataBytes.length + 8);
  let pos = 0;
  packet[pos++] = STX;
  packet[pos++] = len;
  packet[pos++] = seq;
  packet[pos++] = cmd + 0x20;
  dataBytes.copy(packet, pos);
  pos += dataBytes.length;
  packet[pos++] = POSTAMBLE;
  packet[pos++] = bcc4[0];
  packet[pos++] = bcc4[1];
  packet[pos++] = bcc4[2];
  packet[pos++] = bcc4[3];
  packet[pos++] = ETX;

  return packet.subarray(0, pos);
}

function parseDaisyResponse(buf: Buffer): {
  cmd: number;
  data: string;
  status: number[];
  error: boolean;
} {
  // Response: STX LEN SEQ CMD DATA Postamble2(04h) STATUS(6 bytes) Postamble1(05h) BCC(4) ETX
  if (buf[0] !== STX || buf[buf.length - 1] !== ETX) {
    throw new Error("Invalid DAISY response framing");
  }

  const len = buf[1];
  const seq = buf[2];
  const cmd = buf[3] - 0x20;

  // Find Postamble2 (0x04)
  let dataEnd = 4;
  while (dataEnd < buf.length && buf[dataEnd] !== 0x04) {
    dataEnd++;
  }

  const data = buf.subarray(4, dataEnd).toString("ascii");

  // STATUS is 6 bytes after Postamble2
  const statusStart = dataEnd + 1;
  const status: number[] = [];
  for (let i = 0; i < 6 && statusStart + i < buf.length; i++) {
    status.push(buf[statusStart + i]);
  }

  // Check error flags in status byte 0
  const hasError = status.length > 0 && (status[0] & 0x20) !== 0; // bit 5 = general error

  return { cmd, data, status, error: hasError };
}

async function serialSendCommand(
  portPath: string,
  cmd: number,
  data: string = "",
  timeoutMs: number = 5000,
): Promise<{ data: string; status: number[] }> {
  // Dynamic import to avoid hard dependency on serialport
  let SerialPort: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sp = require("serialport");
    SerialPort = sp.SerialPort;
  } catch {
    throw new Error(
      "serialport package not installed. Run: npm install serialport",
    );
  }

  return new Promise((resolve, reject) => {
    const port = new SerialPort({
      path: portPath,
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      autoOpen: false,
    });

    const timer = setTimeout(() => {
      port.close();
      reject(new Error("Serial communication timeout"));
    }, timeoutMs);

    const responseChunks: Buffer[] = [];

    port.on("data", (chunk: Buffer) => {
      // Handle NAK — resend
      if (chunk.length === 1 && chunk[0] === NAK) {
        port.write(buildDaisyPacket(cmd, data));
        return;
      }
      // Handle SYN — printer busy, keep waiting
      if (chunk.length === 1 && chunk[0] === SYN) {
        return;
      }

      responseChunks.push(chunk);
      const full = Buffer.concat(responseChunks);

      // Check if we have a complete response (ends with ETX)
      if (full[full.length - 1] === ETX) {
        clearTimeout(timer);
        port.close();
        try {
          const parsed = parseDaisyResponse(full);
          if (parsed.error) {
            reject(
              new Error(
                `Fiscal device error. Status: ${parsed.status.map((s) => s.toString(16)).join(",")}`,
              ),
            );
          } else {
            resolve({ data: parsed.data, status: parsed.status });
          }
        } catch (e) {
          reject(e);
        }
      }
    });

    port.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });

    port.open((err: Error | null) => {
      if (err) {
        clearTimeout(timer);
        reject(
          new Error(`Cannot open serial port ${portPath}: ${err.message}`),
        );
        return;
      }
      port.write(buildDaisyPacket(cmd, data));
    });
  });
}

// DAISY command codes (decimal)
const CMD = {
  OPEN_FISCAL_RECEIPT: 48, // 30h
  SALE: 49, // 31h
  SUBTOTAL: 51, // 33h
  TOTAL: 53, // 35h
  PRINT_FISCAL_TEXT: 54, // 36h
  CLOSE_FISCAL_RECEIPT: 56, // 38h
  PRINT_CLIENT_INFO: 57, // 39h
  CANCEL_RECEIPT: 130, // 82h (actually 60h for non-fiscal, 82h for cancel)
  DAILY_REPORT: 69, // 45h
  STATUS: 74, // 4Ah
  RECEIPT_STATUS: 76, // 4Ch
  DIAGNOSTIC_INFO: 71, // 47h
};

async function serialPrintReceipt(
  settings: FiscalSettings,
  items: FiscalSaleItem[],
  paymentType: "cash" | "card" | "bank" = "cash",
): Promise<FiscalReceiptResult> {
  const port = settings.fiscal_serial_port;
  if (!port) {
    return { success: false, error: "Serial port not configured" };
  }

  try {
    // Generate UNP (unique sale number): DeviceID-OperatorCode-SeqNum
    // Format: XX######-XXXX-#######
    const unp = `DY000001-OP${settings.fiscal_operator_id.padStart(2, "0")}-${String(Date.now() % 10000000).padStart(7, "0")}`;

    // 1. Open fiscal receipt: CMD 48 (0x30)
    // Data: {OperatorNum},{Password},{UNP}
    const openData = `${settings.fiscal_operator_id},${settings.fiscal_operator_password},${unp}`;
    await serialSendCommand(port, CMD.OPEN_FISCAL_RECEIPT, openData);

    // 2. Sale items: CMD 49 (0x31)
    // Data: {Text1}\t{TaxGr}{Sign}{Price}*{QTY}
    for (const item of items) {
      const taxGr = mapTaxGroupToLatin(item.taxGroup);
      const saleData = `${item.name}\t${taxGr}+${item.unitPrice.toFixed(2)}*${item.quantity.toFixed(3)}`;
      await serialSendCommand(port, CMD.SALE, saleData);
    }

    // 3. Total: CMD 53 (0x35)
    // Data: {Text1}\t{Payment}{Amount}
    const payCode =
      paymentType === "cash" ? "P" : paymentType === "card" ? "N" : "C";
    const totalData = `\t${payCode}`;
    await serialSendCommand(port, CMD.TOTAL, totalData);

    // 4. Close receipt: CMD 56 (0x38)
    const closeResult = await serialSendCommand(port, CMD.CLOSE_FISCAL_RECEIPT);
    // Response contains AllReceipt, FiscReceipt
    const parts = closeResult.data.split(",");

    return {
      success: true,
      receiptNumber: parts[1] || parts[0] || undefined,
    };
  } catch (err: any) {
    // Try to cancel on error
    try {
      if (port) {
        await serialSendCommand(port, CMD.CANCEL_RECEIPT);
      }
    } catch {
      // Ignore
    }
    return { success: false, error: err.message };
  }
}

async function serialGetStatus(
  settings: FiscalSettings,
): Promise<FiscalStatusResult> {
  const port = settings.fiscal_serial_port;
  if (!port) {
    return {
      connected: false,
      hasError: true,
      paperOk: false,
      fiscalReceiptOpen: false,
      error: "Serial port not configured",
    };
  }

  try {
    const result = await serialSendCommand(port, CMD.STATUS);
    const status = result.status;

    // Parse status bytes per DAISY protocol section 5
    const byte0 = status[0] || 0;
    const byte2 = status[2] || 0;

    return {
      connected: true,
      hasError: (byte0 & 0x20) !== 0, // bit 5 = general error OR
      paperOk: (byte2 & 0x01) === 0, // bit 2.0 = no paper
      fiscalReceiptOpen: (byte2 & 0x08) !== 0, // bit 2.3 = fiscal receipt open
      details: {
        statusBytes: status.map((s) => s.toString(16)),
      },
    };
  } catch (err: any) {
    return {
      connected: false,
      hasError: true,
      paperOk: false,
      fiscalReceiptOpen: false,
      error: err.message,
    };
  }
}

async function serialDailyReport(
  settings: FiscalSettings,
  type: "Z" | "X" = "Z",
): Promise<FiscalReceiptResult> {
  const port = settings.fiscal_serial_port;
  if (!port) {
    return { success: false, error: "Serial port not configured" };
  }

  try {
    // CMD 69 (0x45): Daily report
    // Data: {Operation} — "0" or "1" for Z-report, "2" or "3" for X-report
    const operation = type === "Z" ? "0" : "2";
    const result = await serialSendCommand(port, CMD.DAILY_REPORT, operation);
    const parts = result.data.split(",");
    return { success: true, receiptNumber: parts[0] || undefined };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapTaxGroupToLatin(group: string): string {
  // Accept both Cyrillic and Latin
  const map: Record<string, string> = {
    А: "A",
    Б: "B",
    В: "C",
    Г: "D",
    Д: "E",
    Е: "F",
    Ж: "G",
    З: "H",
    A: "A",
    B: "B",
    C: "C",
    D: "D",
  };
  return map[group] || "B"; // Default to B (20% VAT)
}

// ─── Public API (dispatches to FPGate or Serial) ─────────────────────────────

export async function printFiscalReceipt(
  items: FiscalSaleItem[],
  paymentType: "cash" | "card" | "bank" = "cash",
  settings?: FiscalSettings,
): Promise<FiscalReceiptResult> {
  const cfg = settings || (await getFiscalSettings());

  if (!cfg.fiscal_enabled) {
    return { success: false, error: "Fiscal printer is not enabled" };
  }

  if (cfg.fiscal_connection_type === "serial") {
    return serialPrintReceipt(cfg, items, paymentType);
  }
  return fpgatePrintReceipt(cfg, items, paymentType);
}

export async function getFiscalStatus(
  settings?: FiscalSettings,
): Promise<FiscalStatusResult> {
  const cfg = settings || (await getFiscalSettings());

  if (!cfg.fiscal_enabled) {
    return {
      connected: false,
      hasError: false,
      paperOk: false,
      fiscalReceiptOpen: false,
      error: "Fiscal printer is not enabled",
    };
  }

  if (cfg.fiscal_connection_type === "serial") {
    return serialGetStatus(cfg);
  }
  return fpgateGetStatus(cfg);
}

export async function printDailyReport(
  type: "Z" | "X" = "Z",
  settings?: FiscalSettings,
): Promise<FiscalReceiptResult> {
  const cfg = settings || (await getFiscalSettings());

  if (!cfg.fiscal_enabled) {
    return { success: false, error: "Fiscal printer is not enabled" };
  }

  if (cfg.fiscal_connection_type === "serial") {
    return serialDailyReport(cfg, type);
  }
  return fpgateDailyReport(cfg, type);
}

/**
 * Print a fiscal receipt for an order by loading its items from DB.
 * Updates invoice fiscal_status if an invoice is linked.
 */
export async function printReceiptForOrder(
  orderId: number,
): Promise<FiscalReceiptResult> {
  const cfg = await getFiscalSettings();
  if (!cfg.fiscal_enabled) {
    return { success: false, error: "Fiscal printer is not enabled" };
  }

  // Load order items with category info
  const { rows: items } = await query(
    `SELECT oi.quantity, oi.unit_price,
            COALESCE(c.name_bg, p.group_name, 'Други стоки') AS category_name
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     LEFT JOIN categories c ON p.category_id = c.id
     WHERE oi.order_id = $1`,
    [orderId],
  );

  if (items.length === 0) {
    return { success: false, error: "No items found for this order" };
  }

  // Group items by category and sum totals
  const categoryTotals = new Map<string, number>();
  for (const i of items) {
    const cat = i.category_name || "Други стоки";
    const lineTotal = parseFloat(i.quantity) * parseFloat(i.unit_price);
    categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + lineTotal);
  }

  const saleItems: FiscalSaleItem[] = Array.from(categoryTotals.entries()).map(
    ([name, total]) => ({
      name,
      quantity: 1,
      unitPrice: Math.round(total * 100) / 100,
      taxGroup: "Б", // Standard 20% VAT
    }),
  );

  const result = await printFiscalReceipt(saleItems, "cash", cfg);

  if (result.success) {
    // Mark order as receipt printed
    await query(
      "UPDATE orders SET receipt_printed = TRUE, receipt_printed_at = NOW() WHERE id = $1",
      [orderId],
    );

    // If order has an invoice, update fiscal status
    const {
      rows: [order],
    } = await query("SELECT invoice_id FROM orders WHERE id = $1", [orderId]);
    if (order?.invoice_id) {
      await query(
        "UPDATE invoices SET fiscal_status = 'printed', fiscal_receipt_number = $1, fiscal_printed_at = NOW() WHERE id = $2",
        [result.receiptNumber || null, order.invoice_id],
      );
    }
  }

  return result;
}
