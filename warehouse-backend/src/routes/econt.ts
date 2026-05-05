import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db.js";
import {
  resolveSender,
  __primeSenderFromEnv,
  __resetSenderCache,
} from "./econt-sender.js";

const ECONT_BASE = "http://ee.econt.com/services";

/**
 * Normalize any ISO date / datetime / Date object to plain YYYY-MM-DD
 * (Econt's `sendDate` field format). Returns tomorrow's date when input
 * is missing / unparseable so address shipments never error out on a
 * forgotten field.
 */
function normalizeIsoDate(input: unknown): string {
  let d: Date | null = null;
  if (input instanceof Date && !isNaN(input.getTime())) {
    d = input;
  } else if (typeof input === "string" && input.trim()) {
    const parsed = new Date(input);
    if (!isNaN(parsed.getTime())) d = parsed;
  }
  if (!d) {
    d = new Date();
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

// In-memory cache for nomenclature (refreshed on restart)
let citiesCache: any[] | null = null;
let officesCache: any[] | null = null;

// In-memory cache for /validate-shipment-date — keyed by route+date,
// 24h TTL. Spares the Econt API from re-validating the same calendar
// cell after the user clicks back to it.
type ValidateCacheEntry = {
  value: { valid: boolean; reason?: string };
  expiresAt: number;
};
const validateDateCache = new Map<string, ValidateCacheEntry>();

// Exported for tests that need to reset cache between runs.
export function __resetEcontCaches() {
  citiesCache = null;
  officesCache = null;
  validateDateCache.clear();
  __resetSenderCache();
  __primeSenderFromEnv();
}

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    await (request as any).jwtVerify();
  } catch {
    return reply.status(401).send({ error: "Unauthorized" });
  }
}

function getEcontAuth(): string {
  const user = process.env.ECONT_USERNAME;
  const pass = process.env.ECONT_PASSWORD;
  if (!user || !pass) {
    throw Object.assign(new Error("Econt credentials not configured"), {
      statusCode: 500,
    });
  }
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

/** Extract the deepest human-readable message from Econt's nested error JSON. */
function extractEcontErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as any;
    const walk = (n: any): string | null => {
      if (!n) return null;
      const inner = n.innerErrors;
      if (Array.isArray(inner) && inner.length > 0) {
        for (const child of inner) {
          const m = walk(child);
          if (m) return m;
        }
      }
      const msg = (n.message || "").toString().trim();
      return msg && msg !== "Error" ? msg : null;
    };
    return walk(parsed) || parsed.message || text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

async function econtPost(
  path: string,
  body: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(`${ECONT_BASE}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: getEcontAuth(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    // Surface Econt's deepest message so the UI shows the real cause
    // ("Моля, изберете ден за доставка на пратката", "Невалидно населено
    // място", etc.) instead of a wall of nested JSON.
    const friendly = extractEcontErrorMessage(text);
    throw Object.assign(new Error(`Еконт: ${friendly}`), {
      statusCode: 400,
    });
  }
  return res.json();
}

export default async function econtRoutes(app: FastifyInstance) {
  // GET /econt/sender-info — non-sensitive origin city/address for UI display
  app.get(
    "/sender-info",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRes = await requireAuth(request, reply);
      if (authRes) return authRes;
      try {
        const s = await resolveSender();
        return reply.send({
          city: s.senderAddress.city.name,
          quarter: s.senderAddress.quarter ?? null,
          street: s.senderAddress.street ?? null,
          num: s.senderAddress.num ?? null,
        });
      } catch {
        return reply.send({ city: null });
      }
    },
  );

  // GET /econt/cities?q=…
  app.get("/cities", async (request: FastifyRequest, reply: FastifyReply) => {
    const authRes = await requireAuth(request, reply);
    if (authRes) return authRes;
    const { q } = request.query as { q?: string };
    if (!q || q.length < 2) return reply.send({ data: [] });

    if (!citiesCache) {
      const res = await econtPost(
        "Nomenclatures/NomenclaturesService.getCities.json",
        { countryCode: "BGR" },
      );
      citiesCache = res.cities || [];
    }
    const cities = citiesCache!
      .filter(
        (c: any) =>
          c.name?.toLowerCase().includes(q.toLowerCase()) ||
          c.nameEn?.toLowerCase().includes(q.toLowerCase()),
      )
      .slice(0, 20)
      .map((c: any) => ({
        id: c.id,
        name: c.name,
        nameEn: c.nameEn,
        postCode: c.postCode,
      }));
    return reply.send({ data: cities });
  });

  // GET /econt/offices?city=…
  app.get("/offices", async (request: FastifyRequest, reply: FastifyReply) => {
    const authRes = await requireAuth(request, reply);
    if (authRes) return authRes;
    const { city } = request.query as { city?: string };
    if (!city) return reply.send({ data: [] });

    if (!officesCache) {
      const res = await econtPost(
        "Nomenclatures/NomenclaturesService.getOffices.json",
        { countryCode: "BGR" },
      );
      officesCache = res.offices || [];
    }
    const cityLower = city.toLowerCase();
    const offices = officesCache!
      .filter(
        (o: any) => (o.address?.city?.name || "").toLowerCase() === cityLower,
      )
      .map((o: any) => ({
        code: o.code,
        name: o.name,
        address: o.address?.fullAddress || "",
        city: o.address?.city?.name || city,
      }));
    return reply.send({ data: offices });
  });

  // GET /econt/streets?city_id=… — list streets for a city (autocomplete)
  app.get("/streets", async (request: FastifyRequest, reply: FastifyReply) => {
    const authRes = await requireAuth(request, reply);
    if (authRes) return authRes;
    const { city_id, q } = request.query as { city_id?: string; q?: string };
    if (!city_id) return reply.send({ data: [] });

    try {
      const res = await econtPost(
        "Nomenclatures/NomenclaturesService.getStreets.json",
        { cityID: Number(city_id) },
      );
      const all = (res.streets || []) as any[];
      const ql = (q || "").toLowerCase();
      const filtered = ql
        ? all.filter(
            (s: any) =>
              (s.name || "").toLowerCase().includes(ql) ||
              (s.nameEn || "").toLowerCase().includes(ql),
          )
        : all;
      return reply.send({
        data: filtered.slice(0, 50).map((s: any) => ({
          id: s.id,
          name: s.name,
          nameEn: s.nameEn,
        })),
      });
    } catch {
      return reply.send({ data: [] });
    }
  });

  // POST /econt/calculate
  app.post(
    "/calculate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRes = await requireAuth(request, reply);
      if (authRes) return authRes;
      const {
        receiverCity,
        receiverPostCode,
        receiverOfficeCode,
        receiverStreet,
        receiverNum,
        weight,
        codAmount,
      } = request.body as {
        receiverCity: string;
        receiverPostCode?: string;
        receiverOfficeCode?: string;
        receiverStreet?: string;
        receiverNum?: string;
        weight: number;
        codAmount?: number;
        shippingPayer?: string;
      };

      if (!receiverCity || !weight) {
        return reply
          .status(400)
          .send({ error: "receiverCity and weight are required" });
      }

      const shipmentType =
        weight > 500 ? "pallet" : weight > 50 ? "cargo" : "pack";

      const label: any = {
        ...(await resolveSender()),
        receiverClient: { name: "Калкулация", phones: ["0000000000"] },
        shipmentType,
        weight,
        packCount: 1,
      };

      if (receiverOfficeCode) {
        label.receiverOfficeCode = receiverOfficeCode;
      } else {
        label.receiverAddress = {
          city: { name: receiverCity, postCode: receiverPostCode || "" },
          street: receiverStreet || "Тест",
          num: receiverNum || "1",
        };
      }

      if (codAmount && codAmount > 0) {
        label.services = {
          cdAmount: Math.round(codAmount * 1.95583 * 100) / 100,
          cdType: "get",
          cdCurrency: "BGN",
        };
      }

      const reqBody = request.body as any;
      if (reqBody.shippingPayer === "receiver") {
        label.payAfterAccept = true;
        label.payAfterTest = false;
      }

      const result = await econtPost(
        "Shipments/LabelService.createLabel.json",
        {
          mode: "calculate",
          label,
        },
      );

      const priceBGN = result.label?.totalPrice ?? result.totalPrice ?? 0;
      const priceEUR = Math.round((priceBGN / 1.95583) * 100) / 100;
      // Diagnostic log gated by env var. Set ECONT_DEBUG=1 to surface what
      // the API actually returned for office vs address mode comparison.
      if (process.env.ECONT_DEBUG === "1") {
        const mode = receiverOfficeCode ? "office" : "address";
        console.log(
          `[econt/calculate] mode=${mode} city=${receiverCity} weight=${weight} → priceBGN=${priceBGN} (totalPrice=${result.label?.totalPrice ?? "—"}, top-level=${result.totalPrice ?? "—"})`,
        );
      }
      return reply.send({
        price: priceEUR,
        priceBGN,
        currency: "EUR",
      });
    },
  );

  // POST /econt/validate-shipment-date — does Econt accept this sendDate
  // for the given route + weight? Wraps the createLabel API in
  // mode:"validate". Office delivery: Econt accepts every date, so we
  // short-circuit. Address delivery: Econt's validate-mode requires a
  // complete payload (senderAgent + shipmentDescription, plus the same
  // receiverAgent dance create-shipment uses) before it'll even
  // consider date validity. Errors that don't mention the date — sender
  // misconfiguration, missing fields — are treated as soft-fail
  // ({valid:true}) so a config issue can't silently disable the whole
  // calendar. Date-specific rejections ("Моля, изберете ден за доставка")
  // surface as {valid:false, reason}. Cached in-memory for 24h.
  app.post(
    "/validate-shipment-date",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRes = await requireAuth(request, reply);
      if (authRes) return authRes;

      const {
        receiverCity,
        receiverPostCode,
        receiverOfficeCode,
        receiverStreet,
        receiverNum,
        weight,
        date,
      } = request.body as {
        receiverCity: string;
        receiverPostCode?: string;
        receiverOfficeCode?: string;
        receiverStreet?: string;
        receiverNum?: string;
        weight: number;
        date: string;
      };

      if (!receiverCity || !weight || !date) {
        return reply
          .status(400)
          .send({ error: "receiverCity, weight and date are required" });
      }

      // Office delivery — empirically Econt accepts every date for any
      // valid office. Skip the API call entirely; the create-shipment
      // path will catch the rare per-office cutoff itself.
      if (receiverOfficeCode) {
        return reply.send({ valid: true });
      }

      const sendDate = normalizeIsoDate(date);
      const cacheKey = `${receiverCity}|${receiverStreet ?? ""}/${receiverNum ?? ""}|${sendDate}`;
      const cached = validateDateCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return reply.send(cached.value);
      }

      const shipmentType =
        weight > 500 ? "pallet" : weight > 50 ? "cargo" : "pack";

      const sender = await resolveSender();
      // senderAgent is required when senderClient looks like a juridical
      // entity. Reuse the same name+phone from senderClient — the actual
      // Econt account holder IS the authorized person in MERT-M's setup.
      const senderAgent = {
        name: sender.senderClient.name,
        phones: sender.senderClient.phones,
      };

      const receiverName = "Валидация Еконт";
      const receiverPhone = "0888000000";
      const label: any = {
        ...sender,
        senderAgent,
        receiverClient: { name: receiverName, phones: [receiverPhone] },
        receiverAgent: { name: receiverName, phones: [receiverPhone] },
        receiverAddress: {
          city: { name: receiverCity, postCode: receiverPostCode || "" },
          street: receiverStreet || "Тест",
          num: receiverNum || "1",
        },
        shipmentType,
        weight,
        packCount: 1,
        shipmentDescription: "Валидация на дата",
        sendDate,
      };

      let response: { valid: boolean; reason?: string };
      try {
        await econtPost("Shipments/LabelService.createLabel.json", {
          mode: "validate",
          label,
        });
        response = { valid: true };
      } catch (err: any) {
        // econtPost throws with statusCode 400 + message "Еконт: <…>".
        // Distinguish DATE-rejections from CONFIG-rejections: if the
        // reason mentions "ден за доставка" (or a similar date phrase),
        // the date is the problem and we mark it unselectable. Any other
        // wording — sender misconfig, missing fields — is treated as
        // "Econt validation didn't get to the date check" and we soft-
        // fail to {valid:true} so the user can still pick the day.
        const raw = (err?.message ?? "").replace(/^Еконт:\s*/, "");
        const isDateError =
          /ден за доставка|дата|деня/i.test(raw) || /sendDate/i.test(raw);
        if (isDateError) {
          response = { valid: false, reason: raw || "Невалидна дата" };
        } else {
          if (process.env.ECONT_DEBUG === "1") {
            console.log(
              `[econt/validate-shipment-date] soft-fail (config issue): ${raw}`,
            );
          }
          response = { valid: true };
        }
      }

      validateDateCache.set(cacheKey, {
        value: response,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });
      return reply.send(response);
    },
  );

  // POST /econt/create-shipment
  app.post(
    "/create-shipment",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRes = await requireAuth(request, reply);
      if (authRes) return authRes;

      const body = request.body as {
        order_id?: number;
        receiverName: string;
        receiverPhone: string;
        receiverCity: string;
        receiverPostCode?: string;
        receiverOfficeCode?: string;
        receiverStreet?: string;
        receiverNum?: string;
        weight: number;
        codAmount?: number;
        shipmentDescription?: string;
        servicesPayer?: "SENDER" | "RECEIVER";
        /** ISO date YYYY-MM-DD. Required by Econt for address-based delivery. */
        shipmentDate?: string;
      };

      const weight = body.weight || 1;
      const shipmentType =
        weight > 500 ? "pallet" : weight > 50 ? "cargo" : "pack";

      const label: any = {
        ...(await resolveSender()),
        receiverClient: {
          name: body.receiverName,
          phones: [body.receiverPhone],
        },
        // Econt requires receiverAgent (authorized person) when receiverClient
        // looks like a juridical entity (ООД/ЕООД/АД/etc). Sending the same
        // name as the agent works for both private and corporate receivers
        // and avoids error 517 ("За юридическо лице, задължително се
        // попълва упълномощено лице"). If a real contact person is known
        // upstream, pass it via body.receiverAgentName.
        receiverAgent: {
          name: (body as any).receiverAgentName?.trim() || body.receiverName,
          phones: [body.receiverPhone],
        },
        shipmentType,
        weight,
        packCount: 1,
        shipmentDescription: body.shipmentDescription || "Кухненско оборудване",
        // Econt requires sendDate (YYYY-MM-DD) for address delivery.
        // Normalize ISO datetime / DATE column to plain date; fall back
        // to tomorrow if caller didn't pass one.
        sendDate: normalizeIsoDate(body.shipmentDate),
      };

      let officeCode = body.receiverOfficeCode?.trim();
      if (!officeCode && body.receiverCity && !body.receiverStreet) {
        try {
          if (!officesCache) {
            const oRes = await econtPost(
              "Nomenclatures/NomenclaturesService.getOffices.json",
              { countryCode: "BGR" },
            );
            officesCache = oRes.offices || [];
          }
          const cityLower = body.receiverCity.toLowerCase();
          const shipType = shipmentType === "pallet" ? "pallet" : "courier";
          const cityOffices = (officesCache || []).filter(
            (o: any) =>
              (o.address?.city?.name || "").toLowerCase() === cityLower &&
              (o.shipmentTypes || []).includes(shipType),
          );
          if (cityOffices.length > 0) {
            const main =
              cityOffices.find((o: any) => o.name === body.receiverCity) ||
              cityOffices[0];
            officeCode = main.code;
          }
        } catch {
          /* swallow — handled below */
        }
      }

      if (officeCode && !body.receiverStreet) {
        label.receiverOfficeCode = officeCode;
      } else if (body.receiverStreet) {
        label.receiverAddress = {
          city: { name: body.receiverCity },
          street: body.receiverStreet,
          num: body.receiverNum || "1",
        };
      } else {
        return reply.status(400).send({
          error: `Не мога да намеря офис на Еконт в ${body.receiverCity}. Уточнете офис или адрес.`,
        });
      }

      if (body.codAmount && body.codAmount > 0) {
        label.services = {
          cdAmount: Math.round(body.codAmount * 1.95583 * 100) / 100,
          cdType: "get",
          cdCurrency: "BGN",
        };
      }

      // Per Econt JSON API spec (http://ee.econt.com/services/Shipments/), the
      // payer is expressed via paymentSenderMethod / paymentReceiverMethod —
      // NOT via "servicesPayer"/"shipmentPayer" (those field names don't exist
      // in the API and are silently ignored, which is why receiver-pays
      // shipments were always going through as sender-pays).
      //
      // For "receiver pays the entire delivery": set paymentReceiverMethod to
      // "cash" with paymentReceiverAmount=100 and paymentReceiverAmountIsPercent=true.
      // For "sender pays" (default): set paymentSenderMethod to "cash".
      const servicesPayer = body.servicesPayer || "SENDER";
      if (servicesPayer === "RECEIVER") {
        label.paymentReceiverMethod = "cash";
        label.paymentReceiverAmount = 100;
        label.paymentReceiverAmountIsPercent = true;
      } else {
        label.paymentSenderMethod = "cash";
      }

      const result = await econtPost(
        "Shipments/LabelService.createLabel.json",
        {
          mode: "create",
          label,
        },
      );

      const shipmentNumber =
        result.label?.shipmentNumber ?? result.shipmentNumber ?? null;
      const pdfURL = result.label?.pdfURL ?? result.pdfURL ?? null;
      const trackingUrl = shipmentNumber
        ? `https://www.econt.com/services/track-shipment/${shipmentNumber}`
        : null;

      if (body.order_id && shipmentNumber) {
        await query(
          `UPDATE orders SET econt_shipment_number = $1, econt_tracking_url = $2, econt_pdf_url = $3, updated_at = NOW() WHERE id = $4`,
          [shipmentNumber, trackingUrl, pdfURL, body.order_id],
        );
      }

      return reply.send({ shipmentNumber, trackingUrl, pdfURL });
    },
  );

  // POST /econt/update-shipment
  app.post(
    "/update-shipment",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRes = await requireAuth(request, reply);
      if (authRes) return authRes;
      const body = request.body as { order_id: number; description?: string };

      const {
        rows: [order],
      } = await query("SELECT * FROM orders WHERE id = $1", [body.order_id]);
      if (!order) {
        return reply.status(404).send({ error: "Поръчката не е намерена" });
      }
      if (!order.econt_shipment_number) {
        return reply
          .status(400)
          .send({ error: "Няма товарителница за обновяване" });
      }

      // Delete old label — swallow errors (might already be processed by Econt)
      try {
        await econtPost("Shipments/LabelService.deleteLabels.json", {
          shipmentNumbers: [order.econt_shipment_number],
        });
      } catch {
        /* ignore */
      }

      // Recalculate COD from current order items. `order_items.total_price`
      // is already GROSS (Microinvest convention — selling_price stored
      // with VAT included; orders.total_amount mirrors SUM(total_price)).
      // The previous version named this `totalNet` and multiplied by 1.2,
      // which inflated COD by 20% on every label regeneration — caught
      // when the daily report's "Очакван наложен платеж" total didn't
      // match the order's gross amount (e.g. 536.86 → 644.23).
      const { rows: items } = await query(
        "SELECT SUM(total_price) as total FROM order_items WHERE order_id = $1",
        [body.order_id],
      );
      const totalGross = parseFloat(items[0]?.total || "0");

      // Recalculate total weight from items (quantity × weight_kg)
      const {
        rows: [w],
      } = await query(
        "SELECT COALESCE(SUM(oi.quantity * COALESCE(p.weight_kg, 0)), 1)::numeric AS tw FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1",
        [body.order_id],
      );
      const weight = parseFloat(w.tw) || 1;

      const label: any = {
        ...(await resolveSender()),
        receiverClient: {
          name: order.econt_receiver_name,
          phones: [order.econt_receiver_phone],
        },
        // See note in create-shipment: Econt requires receiverAgent for
        // juridical receivers; mirror the receiver name to satisfy that.
        receiverAgent: {
          name: order.econt_receiver_name,
          phones: [order.econt_receiver_phone],
        },
        shipmentType:
          weight <= 50 ? "pack" : weight <= 500 ? "cargo" : "pallet",
        weight,
        packCount: 1,
        shipmentDescription:
          body.description ||
          order.econt_shipment_description ||
          "Кухненско оборудване",
        sendDate: normalizeIsoDate(order.econt_shipment_date),
      };

      if (order.econt_office_code) {
        label.receiverOfficeCode = order.econt_office_code;
      } else if (order.econt_street) {
        label.receiverAddress = {
          city: { name: order.econt_city },
          street: order.econt_street,
          num: order.econt_street_num || "",
        };
      }

      // Only add COD if the order originally had COD requested. If the user
      // chose "no COD", we preserve that even when items change.
      const hadCod = parseFloat(order.econt_cod_amount ?? 0) > 0;
      const newCodAmount = hadCod ? totalGross : 0;
      if (hadCod && totalGross > 0) {
        label.services = {
          cdAmount: Math.round(totalGross * 1.95583 * 100) / 100,
          cdType: "get",
          cdCurrency: "BGN",
        };
      }

      // Preserve the payer choice (sender vs receiver). See create-shipment
      // for the full reasoning — the API uses paymentSenderMethod /
      // paymentReceiverMethod, not the made-up "servicesPayer"/"shipmentPayer".
      if (order.econt_payer === "receiver") {
        label.paymentReceiverMethod = "cash";
        label.paymentReceiverAmount = 100;
        label.paymentReceiverAmountIsPercent = true;
      } else {
        label.paymentSenderMethod = "cash";
      }

      const result = await econtPost(
        "Shipments/LabelService.createLabel.json",
        {
          mode: "create",
          label,
        },
      );
      const shipmentNumber = result.label?.shipmentNumber;
      const pdfURL = result.label?.pdfURL;
      const trackingUrl = shipmentNumber
        ? `https://www.econt.com/services/track-shipment/${shipmentNumber}`
        : null;

      await query(
        `UPDATE orders SET econt_shipment_number = $1, econt_tracking_url = $2, econt_pdf_url = $3,
           econt_cod_amount = $4, econt_weight = $5, updated_at = NOW() WHERE id = $6`,
        [
          shipmentNumber,
          trackingUrl,
          pdfURL,
          newCodAmount,
          weight,
          body.order_id,
        ],
      );

      return reply.send({
        shipmentNumber,
        trackingUrl,
        pdfURL,
        codAmount: newCodAmount,
        weight,
      });
    },
  );

  // GET /econt/label-pdf/:shipmentNumber — returns PDF URL (cached in DB or fresh)
  app.get(
    "/label-pdf/:shipmentNumber",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRes = await requireAuth(request, reply);
      if (authRes) return authRes;
      const { shipmentNumber } = request.params as { shipmentNumber: string };

      const { rows } = await query(
        "SELECT econt_pdf_url FROM orders WHERE econt_shipment_number = $1 LIMIT 1",
        [shipmentNumber],
      );

      if (rows[0]?.econt_pdf_url) {
        return reply.send({ pdfURL: rows[0].econt_pdf_url });
      }

      try {
        const pdfRes = await econtPost(
          "Shipments/LabelService.printLabels.json",
          { shipmentNumbers: [shipmentNumber], format: "pdf" },
        );
        if (pdfRes?.pdfURL) {
          await query(
            "UPDATE orders SET econt_pdf_url = $1 WHERE econt_shipment_number = $2",
            [pdfRes.pdfURL, shipmentNumber],
          );
          return reply.send({ pdfURL: pdfRes.pdfURL });
        }
      } catch {
        /* fallthrough */
      }

      return reply.send({ pdfURL: null, proxyAvailable: true });
    },
  );

  // GET /econt/track/:shipmentNumber
  app.get(
    "/track/:shipmentNumber",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRes = await requireAuth(request, reply);
      if (authRes) return authRes;
      const { shipmentNumber } = request.params as { shipmentNumber: string };

      const result = await econtPost(
        "Shipments/ShipmentService.getShipmentStatuses.json",
        { shipmentNumbers: [shipmentNumber] },
      );
      return reply.send({
        shipmentNumber,
        statuses: result.shipmentStatuses || [],
      });
    },
  );

  // GET /econt/label-pdf-download/:shipmentNumber — proxy PDF bytes
  app.get(
    "/label-pdf-download/:shipmentNumber",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRes = await requireAuth(request, reply);
      if (authRes) return authRes;
      const { shipmentNumber } = request.params as { shipmentNumber: string };

      try {
        const { rows } = await query(
          "SELECT econt_pdf_url FROM orders WHERE econt_shipment_number = $1 LIMIT 1",
          [shipmentNumber],
        );
        if (rows[0]?.econt_pdf_url) {
          const pdfRes = await fetch(rows[0].econt_pdf_url);
          if (pdfRes.ok) {
            const buf = Buffer.from(await pdfRes.arrayBuffer());
            if (buf.length > 500 && buf[0] === 0x25) {
              reply.header("Content-Type", "application/pdf");
              reply.header(
                "Content-Disposition",
                `attachment; filename="waybill-${shipmentNumber}.pdf"`,
              );
              return reply.send(buf);
            }
          }
        }
      } catch {
        /* fallthrough */
      }

      try {
        const result = await econtPost(
          "Shipments/LabelService.printLabels.json",
          { shipmentNumbers: [shipmentNumber], format: "pdf" },
        );
        if (result?.pdfURL) {
          await query(
            "UPDATE orders SET econt_pdf_url = $1 WHERE econt_shipment_number = $2",
            [result.pdfURL, shipmentNumber],
          ).catch(() => {});
          const pdfRes = await fetch(result.pdfURL);
          if (pdfRes.ok) {
            const buffer = Buffer.from(await pdfRes.arrayBuffer());
            reply.header("Content-Type", "application/pdf");
            reply.header(
              "Content-Disposition",
              `attachment; filename="waybill-${shipmentNumber}.pdf"`,
            );
            return reply.send(buffer);
          }
        }
      } catch {
        /* fallthrough */
      }

      return reply.status(404).send({ error: "PDF not available" });
    },
  );
}
