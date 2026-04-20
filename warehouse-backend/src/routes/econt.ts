import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db.js";
import { getSender } from "./econt-sender.js";

const ECONT_BASE = "http://ee.econt.com/services";

// In-memory cache for nomenclature (refreshed on restart)
let citiesCache: any[] | null = null;
let officesCache: any[] | null = null;

// Exported for tests that need to reset cache between runs.
export function __resetEcontCaches() {
  citiesCache = null;
  officesCache = null;
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
        ...getSender(),
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
      };

      const weight = body.weight || 1;
      const shipmentType =
        weight > 500 ? "pallet" : weight > 50 ? "cargo" : "pack";

      const label: any = {
        ...getSender(),
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

  // Routes /update-shipment, /label-pdf, /track, /label-pdf-download
  // land in later tasks.
}
