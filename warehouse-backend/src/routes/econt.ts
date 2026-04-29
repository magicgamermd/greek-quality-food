import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db.js";
import {
  resolveSender,
  __primeSenderFromEnv,
  __resetSenderCache,
} from "./econt-sender.js";

const ECONT_BASE = "http://ee.econt.com/services";

// In-memory cache for nomenclature (refreshed on restart)
let citiesCache: any[] | null = null;
let officesCache: any[] | null = null;

// Exported for tests that need to reset cache between runs.
export function __resetEcontCaches() {
  citiesCache = null;
  officesCache = null;
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
    throw Object.assign(new Error(`Econt API error: ${res.status} ${text}`), {
      statusCode: 502,
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
      return reply.send({
        price: priceEUR,
        priceBGN,
        currency: "EUR",
      });
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
        shipmentType,
        weight,
        packCount: 1,
        shipmentDescription: body.shipmentDescription || "Кухненско оборудване",
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

      // Recalculate COD from current order items (with VAT)
      const { rows: items } = await query(
        "SELECT SUM(total_price) as total FROM order_items WHERE order_id = $1",
        [body.order_id],
      );
      const totalNet = parseFloat(items[0]?.total || "0");
      const totalWithVat = totalNet * 1.2;

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
        shipmentType:
          weight <= 50 ? "pack" : weight <= 500 ? "cargo" : "pallet",
        weight,
        packCount: 1,
        shipmentDescription: body.description || "Кухненско оборудване",
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
      const newCodAmount = hadCod ? totalWithVat : 0;
      if (hadCod && totalWithVat > 0) {
        label.services = {
          cdAmount: Math.round(totalWithVat * 1.95583 * 100) / 100,
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
