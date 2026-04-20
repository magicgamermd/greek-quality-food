# Ekont Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Ekont (Еконт) shipping integration to MERT-M production app — city/office autocomplete, price calculation, waybill creation, PDF retrieval, and shipment tracking, plugged into the existing Orders flow.

**Architecture:** Backend Fastify routes at `/econt/*` proxy to Econt JSON API; shipment info persists on the `orders` table (new columns in migration 046). Frontend exposes two reusable React components (`EcontShippingPicker`, `EcontShipmentActions`) mounted inside `Orders.tsx`. SENDER address configured via env vars (no hardcoded values).

**Tech Stack:** Fastify 5 + TypeScript 5.7, Zod for input validation, node-postgres, React 19 + TanStack Query + Tailwind v4. Tests via Vitest with `vi.mock("../db.js")` + mocked `global.fetch`.

**Spec:** `docs/superpowers/specs/2026-04-21-ekont-integration-design.md`

---

## File Structure

**Backend — new files:**

- `warehouse-backend/migrations/046_mertm_econt_fields.sql` — adds 13 new `econt_*` columns to `orders`
- `warehouse-backend/src/routes/econt.ts` — Fastify plugin with 8 routes, ~500 lines
- `warehouse-backend/src/routes/econt-sender.ts` — `getSender()` helper (env-var based)
- `warehouse-backend/src/__tests__/econt-sender.test.ts`
- `warehouse-backend/src/__tests__/econt-cities-offices.test.ts`
- `warehouse-backend/src/__tests__/econt-calculate.test.ts`
- `warehouse-backend/src/__tests__/econt-create-shipment.test.ts`
- `warehouse-backend/src/__tests__/econt-update-shipment.test.ts`
- `warehouse-backend/src/__tests__/econt-label-pdf.test.ts`

**Backend — modified files:**

- `warehouse-backend/src/index.ts` — register `econtRoutes` at prefix `/econt`
- `warehouse-backend/src/routes/orders.ts` — extend `createOrderSchema` + INSERT with 11 new optional econt fields
- `warehouse-backend/.env.example` — add Econt section
- `warehouse-backend/.env` — add Econt section (placeholder)

**Frontend — new files:**

- `warehouse-frontend/src/components/EcontShippingPicker.tsx` — city/office picker + weight/COD + price preview
- `warehouse-frontend/src/components/EcontShipmentActions.tsx` — create/update/print/track buttons

**Frontend — modified files:**

- `warehouse-frontend/src/types/order.ts` (or wherever Order type lives — see Task 8) — add optional `econt_*` fields
- `warehouse-frontend/src/pages/Orders.tsx` — mount picker + actions in the right modals

**Docs:**

- Update `warehouse-backend/README.md` with Econt env section (brief).

---

## Task 1: Migration 046 — Econt columns

**Files:**

- Create: `warehouse-backend/migrations/046_mertm_econt_fields.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- MERT-M Econt shipping fields (v0.2.0).
-- Columns use demo naming convention (econt_office_code + econt_office_name
-- instead of a single econt_office) for precision.
-- Legacy columns from 019_order_econt_fields.sql (econt_office, econt_tracking)
-- stay as vestigial/deprecated — drop planned for v1.1.

COMMENT ON COLUMN orders.econt_office IS
  'DEPRECATED v0.2.0 — use econt_office_code + econt_office_name instead. Will be dropped in v1.1.';
COMMENT ON COLUMN orders.econt_tracking IS
  'DEPRECATED v0.2.0 — use econt_shipment_number + econt_tracking_url instead. Will be dropped in v1.1.';

ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_receiver_name   VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_receiver_phone  VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_delivery_type   VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_office_code     VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_office_name     VARCHAR(500);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_street          VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_street_num      VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_cod_amount      NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_weight          NUMERIC(10,3);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_shipping_cost   NUMERIC(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_shipment_number VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_tracking_url    TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_pdf_url         TEXT;
```

- [ ] **Step 2: Apply the migration against the dev DB**

Run: `cd warehouse-backend && npm run migrate`
Expected: logs include `046_mertm_econt_fields.sql applied` (or equivalent), exit 0.

- [ ] **Step 3: Verify columns exist**

Run (psql via docker):

```
docker exec -i warehouse-backend-postgres-1 psql -U warehouse -d mertm_warehouse -c \
  "SELECT column_name FROM information_schema.columns WHERE table_name='orders' AND column_name LIKE 'econt_%' ORDER BY column_name;"
```

Expected output includes these rows at minimum:

```
 econt_cod_amount
 econt_delivery_type
 econt_office_code
 econt_office_name
 econt_pdf_url
 econt_receiver_name
 econt_receiver_phone
 econt_shipment_number
 econt_shipping_cost
 econt_street
 econt_street_num
 econt_tracking_url
 econt_weight
```

- [ ] **Step 4: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/migrations/046_mertm_econt_fields.sql
git commit -m "feat(db): add Econt shipping columns to orders (migration 046)"
```

---

## Task 2: Sender config helper + tests

**Files:**

- Create: `warehouse-backend/src/routes/econt-sender.ts`
- Create: `warehouse-backend/src/__tests__/econt-sender.test.ts`

Purpose: central helper that reads MERT-M's sender address from env. Throws a 500-shaped error if required fields are missing. Kept in its own file so it can be unit-tested without spinning up a Fastify app.

- [ ] **Step 1: Write the failing test**

File: `warehouse-backend/src/__tests__/econt-sender.test.ts`

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSender } from "../routes/econt-sender.js";

const KEYS = [
  "ECONT_SENDER_NAME",
  "ECONT_SENDER_PHONE",
  "ECONT_SENDER_CITY",
  "ECONT_SENDER_POSTCODE",
  "ECONT_SENDER_QUARTER",
  "ECONT_SENDER_STREET",
  "ECONT_SENDER_STREET_NUM",
  "ECONT_SENDER_OTHER",
] as const;

describe("getSender", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("throws 500 when name is missing", () => {
    process.env.ECONT_SENDER_PHONE = "0888111222";
    expect(() => getSender()).toThrow(/sender not configured/i);
  });

  it("throws 500 when phone is missing", () => {
    process.env.ECONT_SENDER_NAME = "MERT-M";
    expect(() => getSender()).toThrow(/sender not configured/i);
  });

  it("returns a SENDER object for office-style config", () => {
    process.env.ECONT_SENDER_NAME = "MERT-M ЕООД";
    process.env.ECONT_SENDER_PHONE = "0888111222";
    process.env.ECONT_SENDER_CITY = "София";
    process.env.ECONT_SENDER_POSTCODE = "1000";
    process.env.ECONT_SENDER_QUARTER = "Център";
    process.env.ECONT_SENDER_OTHER = "бл.1";

    const sender = getSender();

    expect(sender.senderClient).toEqual({
      name: "MERT-M ЕООД",
      phones: ["0888111222"],
    });
    expect(sender.senderAddress.city).toEqual({
      name: "София",
      postCode: "1000",
    });
    expect(sender.senderAddress.quarter).toBe("Център");
    expect(sender.senderAddress.other).toBe("бл.1");
  });

  it("returns a SENDER object for street-style config", () => {
    process.env.ECONT_SENDER_NAME = "MERT-M ЕООД";
    process.env.ECONT_SENDER_PHONE = "0888111222";
    process.env.ECONT_SENDER_CITY = "Пловдив";
    process.env.ECONT_SENDER_STREET = "ул. Тест";
    process.env.ECONT_SENDER_STREET_NUM = "15";

    const sender = getSender();

    expect(sender.senderAddress.street).toBe("ул. Тест");
    expect(sender.senderAddress.num).toBe("15");
  });

  it("defaults city to София when not set", () => {
    process.env.ECONT_SENDER_NAME = "X";
    process.env.ECONT_SENDER_PHONE = "0888";
    const sender = getSender();
    expect(sender.senderAddress.city.name).toBe("София");
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd warehouse-backend && npx vitest run src/__tests__/econt-sender.test.ts`
Expected: FAIL with "Cannot find module './routes/econt-sender'".

- [ ] **Step 3: Implement the helper**

File: `warehouse-backend/src/routes/econt-sender.ts`

```typescript
export interface EcontSender {
  senderClient: { name: string; phones: string[] };
  senderAddress: {
    city: { name: string; postCode?: string };
    quarter?: string;
    street?: string;
    num?: string;
    other?: string;
  };
}

export function getSender(): EcontSender {
  const name = process.env.ECONT_SENDER_NAME?.trim();
  const phone = process.env.ECONT_SENDER_PHONE?.trim();
  if (!name || !phone) {
    throw Object.assign(
      new Error(
        "Econt sender not configured. Set ECONT_SENDER_NAME and ECONT_SENDER_PHONE.",
      ),
      { statusCode: 500 },
    );
  }
  const city = process.env.ECONT_SENDER_CITY?.trim() || "София";
  const postCode = process.env.ECONT_SENDER_POSTCODE?.trim();
  const quarter = process.env.ECONT_SENDER_QUARTER?.trim();
  const street = process.env.ECONT_SENDER_STREET?.trim();
  const num = process.env.ECONT_SENDER_STREET_NUM?.trim();
  const other = process.env.ECONT_SENDER_OTHER?.trim();

  const senderAddress: EcontSender["senderAddress"] = {
    city: { name: city, ...(postCode ? { postCode } : {}) },
    ...(quarter ? { quarter } : {}),
    ...(street ? { street } : {}),
    ...(num ? { num } : {}),
    ...(other ? { other } : {}),
  };

  return {
    senderClient: { name, phones: [phone] },
    senderAddress,
  };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd warehouse-backend && npx vitest run src/__tests__/econt-sender.test.ts`
Expected: PASS (5/5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/econt-sender.ts warehouse-backend/src/__tests__/econt-sender.test.ts
git commit -m "feat(econt): add env-var based getSender() helper + tests"
```

---

## Task 3: Econt route scaffold — HTTP helper + auth + cities/offices

**Files:**

- Create: `warehouse-backend/src/routes/econt.ts`
- Create: `warehouse-backend/src/__tests__/econt-cities-offices.test.ts`

Scope: the shared internals (`econtPost`, `requireAuth`, `getEcontAuth`, in-process caches) plus the two read-only nomenclature routes.

- [ ] **Step 1: Write the failing test**

File: `warehouse-backend/src/__tests__/econt-cities-offices.test.ts`

```typescript
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import econtRoutes from "../routes/econt.js";

async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = { id: "u-1", email: "a@b.c", role: "admin" };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(econtRoutes, { prefix: "/econt" });
  return app;
}

describe("econt cities/offices", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.ECONT_USERNAME = "u";
    process.env.ECONT_PASSWORD = "p";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty list for short query", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/econt/cities?q=П" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters cities by name substring (case-insensitive)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cities: [
          { id: 1, name: "София", nameEn: "Sofia", postCode: "1000" },
          { id: 2, name: "Пловдив", nameEn: "Plovdiv", postCode: "4000" },
          { id: 3, name: "Варна", nameEn: "Varna", postCode: "9000" },
        ],
      }),
    });

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/econt/cities?q=plo" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({
      id: 2,
      name: "Пловдив",
      nameEn: "Plovdiv",
      postCode: "4000",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches cities across requests", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cities: [{ id: 1, name: "София", nameEn: "Sofia", postCode: "1000" }],
      }),
    });

    const app = await buildApp();
    await app.inject({ method: "GET", url: "/econt/cities?q=соф" });
    await app.inject({ method: "GET", url: "/econt/cities?q=sof" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("filters offices by city (case-insensitive exact match)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        offices: [
          {
            code: "1001",
            name: "София Офис 1",
            address: { fullAddress: "бул. X", city: { name: "София" } },
          },
          {
            code: "4001",
            name: "Пловдив Офис 1",
            address: { fullAddress: "ул. Y", city: { name: "Пловдив" } },
          },
        ],
      }),
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/econt/offices?city=пловдив",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].code).toBe("4001");
  });

  it("rejects unauthenticated requests", async () => {
    const app = Fastify();
    await app.register(econtRoutes, { prefix: "/econt" });
    const res = await app.inject({
      method: "GET",
      url: "/econt/cities?q=sofia",
    });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

Run: `cd warehouse-backend && npx vitest run src/__tests__/econt-cities-offices.test.ts`
Expected: FAIL with "Cannot find module './routes/econt'".

- [ ] **Step 3: Implement the route file (scaffold + cities/offices)**

File: `warehouse-backend/src/routes/econt.ts`

```typescript
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

  // NOTE: /calculate, /create-shipment, /update-shipment, /label-pdf, /track,
  // /label-pdf-download land in later tasks.
  // getSender() is imported but not used yet — suppress unused warning.
  void getSender;
}
```

- [ ] **Step 4: Reset cache between tests inside the test file**

Edit `warehouse-backend/src/__tests__/econt-cities-offices.test.ts`:

Add import at top:

```typescript
import { __resetEcontCaches } from "../routes/econt.js";
```

Add `__resetEcontCaches();` to the `beforeEach` block (right after `fetchMock.mockReset();`).

- [ ] **Step 5: Run the test — confirm it passes**

Run: `cd warehouse-backend && npx vitest run src/__tests__/econt-cities-offices.test.ts`
Expected: PASS (5/5 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/econt.ts warehouse-backend/src/__tests__/econt-cities-offices.test.ts
git commit -m "feat(econt): add cities + offices routes with in-process cache"
```

---

## Task 4: Calculate route + tests

**Files:**

- Modify: `warehouse-backend/src/routes/econt.ts` (append new route)
- Create: `warehouse-backend/src/__tests__/econt-calculate.test.ts`

- [ ] **Step 1: Write the failing test**

File: `warehouse-backend/src/__tests__/econt-calculate.test.ts`

```typescript
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import econtRoutes, { __resetEcontCaches } from "../routes/econt.js";

async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = { id: "u-1", email: "a@b.c", role: "admin" };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(econtRoutes, { prefix: "/econt" });
  return app;
}

describe("POST /econt/calculate", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    __resetEcontCaches();
    vi.stubGlobal("fetch", fetchMock);
    process.env.ECONT_USERNAME = "u";
    process.env.ECONT_PASSWORD = "p";
    process.env.ECONT_SENDER_NAME = "MERT-M";
    process.env.ECONT_SENDER_PHONE = "0888111222";
    process.env.ECONT_SENDER_CITY = "София";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects missing receiverCity", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/calculate",
      payload: { weight: 5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("calls Econt with calculate mode and converts BGN→EUR", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ label: { totalPrice: 19.56 } }),
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/calculate",
      payload: {
        receiverCity: "Пловдив",
        receiverOfficeCode: "4001",
        weight: 5,
        codAmount: 100,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.priceBGN).toBe(19.56);
    // 19.56 / 1.95583 ≈ 10.00 EUR
    expect(body.price).toBeCloseTo(10.0, 2);
    expect(body.currency).toBe("EUR");

    // Verify the request payload sent to Econt
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toMatch(/createLabel\.json$/);
    const sentBody = JSON.parse(call[1].body);
    expect(sentBody.mode).toBe("calculate");
    expect(sentBody.label.receiverOfficeCode).toBe("4001");
    expect(sentBody.label.shipmentType).toBe("pack"); // weight 5 → pack
    expect(sentBody.label.weight).toBe(5);
    // COD converted EUR→BGN (100 * 1.95583 ≈ 195.58)
    expect(sentBody.label.services.cdAmount).toBeCloseTo(195.58, 2);
    expect(sentBody.label.services.cdCurrency).toBe("BGN");
  });

  it("uses receiverAddress when no office code is given", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ label: { totalPrice: 0 } }),
    });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/econt/calculate",
      payload: {
        receiverCity: "Варна",
        receiverStreet: "ул. Тест",
        receiverNum: "1",
        weight: 10,
      },
    });
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.label.receiverAddress.city.name).toBe("Варна");
    expect(sentBody.label.receiverAddress.street).toBe("ул. Тест");
    expect(sentBody.label.receiverOfficeCode).toBeUndefined();
  });

  it("chooses cargo shipmentType for 50<weight<=500", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ label: { totalPrice: 0 } }),
    });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/econt/calculate",
      payload: { receiverCity: "София", receiverOfficeCode: "1", weight: 100 },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).label.shipmentType).toBe(
      "cargo",
    );
  });

  it("chooses pallet shipmentType for weight>500", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ label: { totalPrice: 0 } }),
    });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/econt/calculate",
      payload: { receiverCity: "София", receiverOfficeCode: "1", weight: 800 },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).label.shipmentType).toBe(
      "pallet",
    );
  });
});
```

- [ ] **Step 2: Run test — confirm it fails**

Run: `cd warehouse-backend && npx vitest run src/__tests__/econt-calculate.test.ts`
Expected: FAIL with 404 (route not yet implemented).

- [ ] **Step 3: Append the route to econt.ts**

Edit `warehouse-backend/src/routes/econt.ts`. Replace the `void getSender;` line at the end of `econtRoutes` with:

```typescript
// POST /econt/calculate
app.post("/calculate", async (request: FastifyRequest, reply: FastifyReply) => {
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

  const shipmentType = weight > 500 ? "pallet" : weight > 50 ? "cargo" : "pack";

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

  const result = await econtPost("Shipments/LabelService.createLabel.json", {
    mode: "calculate",
    label,
  });

  const priceBGN = result.label?.totalPrice ?? result.totalPrice ?? 0;
  const priceEUR = Math.round((priceBGN / 1.95583) * 100) / 100;
  return reply.send({
    price: priceEUR,
    priceBGN,
    currency: "EUR",
  });
});
```

- [ ] **Step 4: Run test — confirm it passes**

Run: `cd warehouse-backend && npx vitest run src/__tests__/econt-calculate.test.ts`
Expected: PASS (5/5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/econt.ts warehouse-backend/src/__tests__/econt-calculate.test.ts
git commit -m "feat(econt): add calculate route (pack/cargo/pallet + BGN COD)"
```

---

## Task 5: Create-shipment route + tests

**Files:**

- Modify: `warehouse-backend/src/routes/econt.ts`
- Create: `warehouse-backend/src/__tests__/econt-create-shipment.test.ts`

- [ ] **Step 1: Write the failing test**

File: `warehouse-backend/src/__tests__/econt-create-shipment.test.ts`

```typescript
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from "../db.js";
import econtRoutes, { __resetEcontCaches } from "../routes/econt.js";

const mockQuery = vi.mocked(query);

async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = { id: "u-1", email: "a@b.c", role: "admin" };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(econtRoutes, { prefix: "/econt" });
  return app;
}

describe("POST /econt/create-shipment", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    mockQuery.mockReset();
    __resetEcontCaches();
    vi.stubGlobal("fetch", fetchMock);
    process.env.ECONT_USERNAME = "u";
    process.env.ECONT_PASSWORD = "p";
    process.env.ECONT_SENDER_NAME = "MERT-M";
    process.env.ECONT_SENDER_PHONE = "0888111222";
    process.env.ECONT_SENDER_CITY = "София";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates shipment with office code, persists to order", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        label: { shipmentNumber: "ABC123", pdfURL: "https://econt/x.pdf" },
      }),
    });
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/create-shipment",
      payload: {
        order_id: 42,
        receiverName: "Иван Петров",
        receiverPhone: "0888999000",
        receiverCity: "Пловдив",
        receiverOfficeCode: "4001",
        weight: 10,
        codAmount: 200,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shipmentNumber).toBe("ABC123");
    expect(body.pdfURL).toBe("https://econt/x.pdf");
    expect(body.trackingUrl).toBe(
      "https://www.econt.com/services/track-shipment/ABC123",
    );

    // Assert DB update persisted shipment fields
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE orders SET econt_shipment_number/);
    expect(params).toEqual([
      "ABC123",
      "https://www.econt.com/services/track-shipment/ABC123",
      "https://econt/x.pdf",
      42,
    ]);
  });

  it("falls back to searching offices by city when no code given", async () => {
    // First fetch = getOffices, second = createLabel
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          offices: [
            {
              code: "4001",
              name: "Пловдив Офис 1",
              shipmentTypes: ["courier"],
              address: { city: { name: "Пловдив" } },
            },
            {
              code: "4002",
              name: "Пловдив",
              shipmentTypes: ["courier"],
              address: { city: { name: "Пловдив" } },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          label: { shipmentNumber: "DEF456", pdfURL: "https://econt/y.pdf" },
        }),
      });
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/create-shipment",
      payload: {
        order_id: 43,
        receiverName: "Мария",
        receiverPhone: "0888",
        receiverCity: "Пловдив",
        weight: 5,
      },
    });
    expect(res.statusCode).toBe(200);
    // Main office fallback = the one whose name equals the city
    const createCall = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(createCall.label.receiverOfficeCode).toBe("4002");
  });

  it("uses receiverAddress when street is provided", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        label: { shipmentNumber: "GHI", pdfURL: "u" },
      }),
    });
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/econt/create-shipment",
      payload: {
        order_id: 44,
        receiverName: "X",
        receiverPhone: "0",
        receiverCity: "Варна",
        receiverStreet: "ул. Y",
        receiverNum: "5",
        weight: 3,
      },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.label.receiverAddress.street).toBe("ул. Y");
    expect(body.label.receiverAddress.num).toBe("5");
    expect(body.label.receiverOfficeCode).toBeUndefined();
  });

  it("returns 400 when no office found and no street given", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ offices: [] }),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/create-shipment",
      payload: {
        order_id: 45,
        receiverName: "X",
        receiverPhone: "0",
        receiverCity: "НеизвестенГрад",
        weight: 3,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/НеизвестенГрад/);
  });

  it("does not UPDATE order when order_id is missing", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        label: { shipmentNumber: "JKL", pdfURL: "u" },
      }),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/create-shipment",
      payload: {
        receiverName: "X",
        receiverPhone: "0",
        receiverCity: "София",
        receiverOfficeCode: "1001",
        weight: 3,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test — confirm it fails**

Run: `cd warehouse-backend && npx vitest run src/__tests__/econt-create-shipment.test.ts`
Expected: FAIL with 404.

- [ ] **Step 3: Append the route to econt.ts**

Add at the end of `econtRoutes` (just before the closing `}`):

```typescript
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
    if (!officeCode && body.receiverCity) {
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

    const result = await econtPost("Shipments/LabelService.createLabel.json", {
      mode: "create",
      label,
    });

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
```

- [ ] **Step 4: Run test — confirm it passes**

Run: `cd warehouse-backend && npx vitest run src/__tests__/econt-create-shipment.test.ts`
Expected: PASS (5/5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/econt.ts warehouse-backend/src/__tests__/econt-create-shipment.test.ts
git commit -m "feat(econt): add create-shipment route with office fallback"
```

---

## Task 6: Update-shipment route + tests

**Files:**

- Modify: `warehouse-backend/src/routes/econt.ts`
- Create: `warehouse-backend/src/__tests__/econt-update-shipment.test.ts`

- [ ] **Step 1: Write the failing test**

File: `warehouse-backend/src/__tests__/econt-update-shipment.test.ts`

```typescript
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from "../db.js";
import econtRoutes, { __resetEcontCaches } from "../routes/econt.js";

const mockQuery = vi.mocked(query);

async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = { id: "u-1", email: "a@b.c", role: "admin" };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(econtRoutes, { prefix: "/econt" });
  return app;
}

describe("POST /econt/update-shipment", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    mockQuery.mockReset();
    __resetEcontCaches();
    vi.stubGlobal("fetch", fetchMock);
    process.env.ECONT_USERNAME = "u";
    process.env.ECONT_PASSWORD = "p";
    process.env.ECONT_SENDER_NAME = "MERT-M";
    process.env.ECONT_SENDER_PHONE = "0888111222";
    process.env.ECONT_SENDER_CITY = "София";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("404 when order not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/update-shipment",
      payload: { order_id: 99 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 when order has no shipment number", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, econt_shipment_number: null }],
    } as any);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/update-shipment",
      payload: { order_id: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("recalculates COD/weight, deletes old, creates new", async () => {
    mockQuery
      // SELECT orders
      .mockResolvedValueOnce({
        rows: [
          {
            id: 7,
            econt_shipment_number: "OLD1",
            econt_receiver_name: "Иван",
            econt_receiver_phone: "0888",
            econt_office_code: "4001",
            econt_city: "Пловдив",
            econt_street: null,
            econt_street_num: null,
          },
        ],
      } as any)
      // SELECT SUM total_price
      .mockResolvedValueOnce({ rows: [{ total: "100.00" }] } as any)
      // SELECT weight sum
      .mockResolvedValueOnce({ rows: [{ tw: "5" }] } as any)
      // UPDATE orders
      .mockResolvedValueOnce({ rows: [] } as any);

    // fetch[0] = deleteLabels, fetch[1] = createLabel
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          label: { shipmentNumber: "NEW2", pdfURL: "https://econt/new.pdf" },
        }),
      });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/update-shipment",
      payload: { order_id: 7 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shipmentNumber).toBe("NEW2");
    expect(body.codAmount).toBeCloseTo(120, 2); // 100 * 1.2 VAT
    expect(body.weight).toBe(5);

    // Assert deleteLabels was called with the old number
    const deleteBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(deleteBody.shipmentNumbers).toEqual(["OLD1"]);

    // Assert the UPDATE SQL was issued
    const updateSql = mockQuery.mock.calls.at(-1)![0];
    expect(updateSql).toMatch(/UPDATE orders SET econt_shipment_number/);
  });

  it("continues when deleteLabels fails", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 8,
            econt_shipment_number: "OLDX",
            econt_receiver_name: "X",
            econt_receiver_phone: "0",
            econt_office_code: "1",
            econt_city: "София",
          },
        ],
      } as any)
      .mockResolvedValueOnce({ rows: [{ total: "0" }] } as any)
      .mockResolvedValueOnce({ rows: [{ tw: "1" }] } as any)
      .mockResolvedValueOnce({ rows: [] } as any);

    fetchMock
      .mockRejectedValueOnce(new Error("delete failed"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ label: { shipmentNumber: "N2", pdfURL: "u" } }),
      });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/update-shipment",
      payload: { order_id: 8 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().shipmentNumber).toBe("N2");
  });
});
```

- [ ] **Step 2: Run test — confirm it fails**

Run: `cd warehouse-backend && npx vitest run src/__tests__/econt-update-shipment.test.ts`
Expected: FAIL with 404 (route missing).

- [ ] **Step 3: Append the route to econt.ts**

```typescript
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
      ...getSender(),
      receiverClient: {
        name: order.econt_receiver_name,
        phones: [order.econt_receiver_phone],
      },
      shipmentType: weight <= 50 ? "pack" : weight <= 500 ? "cargo" : "pallet",
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

    if (totalWithVat > 0) {
      label.services = {
        cdAmount: Math.round(totalWithVat * 1.95583 * 100) / 100,
        cdType: "get",
        cdCurrency: "BGN",
      };
    }

    const result = await econtPost("Shipments/LabelService.createLabel.json", {
      mode: "create",
      label,
    });
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
        totalWithVat,
        weight,
        body.order_id,
      ],
    );

    return reply.send({
      shipmentNumber,
      trackingUrl,
      pdfURL,
      codAmount: totalWithVat,
      weight,
    });
  },
);
```

- [ ] **Step 4: Run test — confirm it passes**

Run: `cd warehouse-backend && npx vitest run src/__tests__/econt-update-shipment.test.ts`
Expected: PASS (4/4 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/econt.ts warehouse-backend/src/__tests__/econt-update-shipment.test.ts
git commit -m "feat(econt): add update-shipment route with COD/weight recalc"
```

---

## Task 7: Label-PDF + track + download routes + tests

**Files:**

- Modify: `warehouse-backend/src/routes/econt.ts`
- Create: `warehouse-backend/src/__tests__/econt-label-pdf.test.ts`

- [ ] **Step 1: Write the failing test**

File: `warehouse-backend/src/__tests__/econt-label-pdf.test.ts`

```typescript
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from "../db.js";
import econtRoutes, { __resetEcontCaches } from "../routes/econt.js";

const mockQuery = vi.mocked(query);

async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = { id: "u-1", email: "a@b.c", role: "admin" };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(econtRoutes, { prefix: "/econt" });
  return app;
}

describe("econt label-pdf / track / download", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    mockQuery.mockReset();
    __resetEcontCaches();
    vi.stubGlobal("fetch", fetchMock);
    process.env.ECONT_USERNAME = "u";
    process.env.ECONT_PASSWORD = "p";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET /label-pdf returns cached DB URL without API call", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ econt_pdf_url: "https://econt/cached.pdf" }],
    } as any);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/econt/label-pdf/ABC",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pdfURL).toBe("https://econt/cached.pdf");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GET /label-pdf fetches and caches when DB empty", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{}] } as any) // no cached URL
      .mockResolvedValueOnce({ rows: [] } as any); // UPDATE
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ pdfURL: "https://econt/fresh.pdf" }),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/econt/label-pdf/XYZ",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pdfURL).toBe("https://econt/fresh.pdf");
    // Second mockQuery call is the UPDATE caching step
    expect(mockQuery.mock.calls[1][0]).toMatch(
      /UPDATE orders SET econt_pdf_url/,
    );
  });

  it("GET /track returns statuses", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        shipmentStatuses: [
          { status: "delivered", time: "2026-04-21T10:00:00Z" },
        ],
      }),
    });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/econt/track/SN42" });
    expect(res.statusCode).toBe(200);
    expect(res.json().shipmentNumber).toBe("SN42");
    expect(res.json().statuses).toHaveLength(1);
  });

  it("GET /label-pdf-download streams PDF binary from cached URL", async () => {
    const pdfBytes = Buffer.concat([
      Buffer.from([0x25, 0x50, 0x44, 0x46]), // "%PDF" magic
      Buffer.alloc(600, 0x20),
    ]);
    mockQuery.mockResolvedValueOnce({
      rows: [{ econt_pdf_url: "https://econt/cached.pdf" }],
    } as any);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () =>
        pdfBytes.buffer.slice(
          pdfBytes.byteOffset,
          pdfBytes.byteOffset + pdfBytes.byteLength,
        ),
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/econt/label-pdf-download/SN99",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/waybill-SN99/);
  });
});
```

- [ ] **Step 2: Run test — confirm it fails**

Run: `cd warehouse-backend && npx vitest run src/__tests__/econt-label-pdf.test.ts`
Expected: FAIL with 404.

- [ ] **Step 3: Append three routes to econt.ts**

```typescript
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
```

- [ ] **Step 4: Run test — confirm it passes**

Run: `cd warehouse-backend && npx vitest run src/__tests__/econt-label-pdf.test.ts`
Expected: PASS (4/4 tests).

- [ ] **Step 5: Run the full Econt suite**

Run: `cd warehouse-backend && npx vitest run src/__tests__/econt-`
Expected: all Econt tests pass (sum of prior tasks).

- [ ] **Step 6: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/econt.ts warehouse-backend/src/__tests__/econt-label-pdf.test.ts
git commit -m "feat(econt): add label-pdf, track, and pdf-download routes"
```

---

## Task 8: Register econtRoutes + extend Orders schema + .env

**Files:**

- Modify: `warehouse-backend/src/index.ts`
- Modify: `warehouse-backend/src/routes/orders.ts`
- Modify: `warehouse-backend/.env.example`
- Modify: `warehouse-backend/.env`

- [ ] **Step 1: Register the route in index.ts**

Read `warehouse-backend/src/index.ts` to find the last `app.register(...)` call. Add after it (and add the import near the top where the other route imports live):

At the imports block:

```typescript
import econtRoutes from "./routes/econt.js";
```

At the registrations block (immediately after an existing route register like `partnersRoutes`):

```typescript
await app.register(econtRoutes, { prefix: "/econt" });
```

- [ ] **Step 2: Extend createOrderSchema in orders.ts**

Read `warehouse-backend/src/routes/orders.ts` to locate `createOrderSchema`. Inside the schema object, add these optional fields (place after existing `notes` or similar field):

```typescript
econt_receiver_name:  z.string().trim().max(255).optional(),
econt_receiver_phone: z.string().trim().max(50).optional(),
econt_delivery_type:  z.enum(["office", "address"]).optional(),
econt_city:           z.string().trim().max(255).optional(),
econt_office_code:    z.string().trim().max(50).optional(),
econt_office_name:    z.string().trim().max(500).optional(),
econt_street:         z.string().trim().max(255).optional(),
econt_street_num:     z.string().trim().max(20).optional(),
econt_cod_amount:     z.coerce.number().nonnegative().optional(),
econt_weight:         z.coerce.number().positive().optional(),
econt_shipping_cost:  z.coerce.number().nonnegative().optional(),
```

In the `POST /orders` handler's `INSERT INTO orders` statement, extend the column list and VALUES with these 11 fields (also extend the parameter array passed to `query()`).

Exact INSERT edit guidance: the current INSERT likely looks like `INSERT INTO orders (partner_id, ..., notes) VALUES ($1, ..., $N) RETURNING *`. Append the new columns in the same order as the schema fields above and map their values with `body.econt_receiver_name ?? null`, etc.

- [ ] **Step 3: Update .env.example**

File: `warehouse-backend/.env.example` — append at the end:

```
# Econt shipping (https://ee.econt.com)
ECONT_USERNAME=
ECONT_PASSWORD=
ECONT_SENDER_NAME=
ECONT_SENDER_PHONE=
ECONT_SENDER_CITY=София
ECONT_SENDER_POSTCODE=
ECONT_SENDER_QUARTER=
ECONT_SENDER_STREET=
ECONT_SENDER_STREET_NUM=
ECONT_SENDER_OTHER=
```

- [ ] **Step 4: Update .env with placeholder values**

File: `warehouse-backend/.env` — append the same block (kept as placeholders; admin fills at deploy time).

- [ ] **Step 5: Build to verify no type/compile errors**

Run: `cd warehouse-backend && npm run build`
Expected: exit 0 (or specific error if so fix and retry).

- [ ] **Step 6: Run all backend tests**

Run: `cd warehouse-backend && npx vitest run`
Expected: all tests pass (160+ existing + new Econt tests).

- [ ] **Step 7: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/index.ts warehouse-backend/src/routes/orders.ts warehouse-backend/.env warehouse-backend/.env.example
git commit -m "feat(econt): register route + extend orders createOrderSchema with econt fields"
```

---

## Task 9: Frontend Order type extension

**Files:**

- Modify: `warehouse-frontend/src/types/order.ts` or equivalent (find with grep)

- [ ] **Step 1: Locate the Order type**

Run: `cd warehouse-frontend && grep -rn "export.*interface Order\b\|export.*type Order\b" src/ | head -5`
Expected: a single file (likely `src/types/order.ts` or `src/types/index.ts`).

- [ ] **Step 2: Extend the Order type**

Add these optional fields inside the `Order` interface (alphabetised among existing `econt_*` or at the end):

```typescript
econt_receiver_name?: string | null;
econt_receiver_phone?: string | null;
econt_delivery_type?: "office" | "address" | null;
econt_city?: string | null;
econt_office_code?: string | null;
econt_office_name?: string | null;
econt_street?: string | null;
econt_street_num?: string | null;
econt_cod_amount?: number | null;
econt_weight?: number | null;
econt_shipping_cost?: number | null;
econt_shipment_number?: string | null;
econt_tracking_url?: string | null;
econt_pdf_url?: string | null;
```

- [ ] **Step 3: Verify type-check passes**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: exit 0 (no new errors introduced).

- [ ] **Step 4: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/types/
git commit -m "feat(frontend): extend Order type with Econt fields"
```

---

## Task 10: EcontShippingPicker component

**Files:**

- Create: `warehouse-frontend/src/components/EcontShippingPicker.tsx`

Purpose: a controlled component that lets the user pick city → office (or custom address), enter weight, optionally enable COD, and see a price preview.

- [ ] **Step 1: Inspect how API calls are made elsewhere**

Run: `cd warehouse-frontend && grep -rn "useQuery\|import.*api\b" src/pages/Orders.tsx | head -10`
Identify: (a) the query-client/api helper import path (something like `../lib/api` or `@/lib/api`), (b) whether tanstack-query is used directly.

- [ ] **Step 2: Write the component**

File: `warehouse-frontend/src/components/EcontShippingPicker.tsx`

```typescript
import { useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";

interface City {
  id: number;
  name: string;
  nameEn: string;
  postCode: string;
}
interface Office {
  code: string;
  name: string;
  address: string;
  city: string;
}

export interface EcontShippingValue {
  econt_delivery_type: "office" | "address";
  econt_receiver_name: string;
  econt_receiver_phone: string;
  econt_city: string;
  econt_office_code?: string;
  econt_office_name?: string;
  econt_street?: string;
  econt_street_num?: string;
  econt_weight: number;
  econt_cod_amount?: number;
}

export interface EcontShippingPickerProps {
  value: Partial<EcontShippingValue>;
  onChange: (patch: Partial<EcontShippingValue>) => void;
  apiBaseUrl?: string; // optional override; defaults to /api
  token: string;
}

function useDebouncedValue<T>(value: T, ms = 250): T {
  const [state, setState] = useState(value);
  useMemo(() => {
    const t = setTimeout(() => setState(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return state;
}

async function apiGet<T>(
  baseUrl: string,
  token: string,
  path: string,
): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function apiPost<T>(
  baseUrl: string,
  token: string,
  path: string,
  body: unknown,
): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export function EcontShippingPicker({
  value,
  onChange,
  apiBaseUrl = "/api",
  token,
}: EcontShippingPickerProps) {
  const deliveryType = value.econt_delivery_type || "office";
  const cityInput = value.econt_city ?? "";
  const debouncedCity = useDebouncedValue(cityInput);

  const citiesQuery = useQuery({
    queryKey: ["econt-cities", debouncedCity],
    queryFn: () =>
      apiGet<{ data: City[] }>(
        apiBaseUrl,
        token,
        `/econt/cities?q=${encodeURIComponent(debouncedCity)}`,
      ),
    enabled: debouncedCity.length >= 2,
    placeholderData: keepPreviousData,
  });

  const officesQuery = useQuery({
    queryKey: ["econt-offices", cityInput],
    queryFn: () =>
      apiGet<{ data: Office[] }>(
        apiBaseUrl,
        token,
        `/econt/offices?city=${encodeURIComponent(cityInput)}`,
      ),
    enabled: deliveryType === "office" && cityInput.length >= 2,
    placeholderData: keepPreviousData,
  });

  const weight = value.econt_weight ?? 1;
  const cod = value.econt_cod_amount ?? 0;
  const debouncedWeight = useDebouncedValue(weight);
  const debouncedCod = useDebouncedValue(cod);

  const priceQuery = useQuery({
    queryKey: [
      "econt-price",
      cityInput,
      value.econt_office_code,
      value.econt_street,
      debouncedWeight,
      debouncedCod,
    ],
    queryFn: () =>
      apiPost<{ price: number; priceBGN: number }>(
        apiBaseUrl,
        token,
        "/econt/calculate",
        {
          receiverCity: cityInput,
          receiverOfficeCode: value.econt_office_code,
          receiverStreet: value.econt_street,
          receiverNum: value.econt_street_num,
          weight: debouncedWeight,
          codAmount: debouncedCod || undefined,
        },
      ),
    enabled:
      cityInput.length >= 2 &&
      debouncedWeight > 0 &&
      (deliveryType === "office"
        ? !!value.econt_office_code
        : !!value.econt_street),
  });

  return (
    <div className="space-y-3 border border-accent-light rounded-md p-3 bg-accent-light/20">
      <div className="font-semibold text-sm">Еконт доставка</div>

      {/* Delivery type toggle */}
      <div className="flex gap-2 text-sm">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={deliveryType === "office"}
            onChange={() => onChange({ econt_delivery_type: "office" })}
          />
          Офис
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={deliveryType === "address"}
            onChange={() => onChange({ econt_delivery_type: "address" })}
          />
          Адрес
        </label>
      </div>

      {/* Receiver */}
      <input
        className="w-full border rounded px-2 py-1 text-sm"
        placeholder="Име на получател"
        value={value.econt_receiver_name ?? ""}
        onChange={(e) => onChange({ econt_receiver_name: e.target.value })}
      />
      <input
        className="w-full border rounded px-2 py-1 text-sm"
        placeholder="Телефон"
        value={value.econt_receiver_phone ?? ""}
        onChange={(e) => onChange({ econt_receiver_phone: e.target.value })}
      />

      {/* City input with autocomplete */}
      <input
        className="w-full border rounded px-2 py-1 text-sm"
        placeholder="Град"
        value={cityInput}
        onChange={(e) => onChange({ econt_city: e.target.value })}
        list="econt-city-list"
      />
      <datalist id="econt-city-list">
        {(citiesQuery.data?.data || []).map((c) => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>

      {/* Office dropdown OR street fields */}
      {deliveryType === "office" ? (
        <select
          className="w-full border rounded px-2 py-1 text-sm"
          value={value.econt_office_code ?? ""}
          onChange={(e) => {
            const code = e.target.value;
            const office = (officesQuery.data?.data || []).find(
              (o) => o.code === code,
            );
            onChange({
              econt_office_code: code || undefined,
              econt_office_name: office?.name,
            });
          }}
        >
          <option value="">— изберете офис —</option>
          {(officesQuery.data?.data || []).map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
            </option>
          ))}
        </select>
      ) : (
        <div className="grid grid-cols-[3fr_1fr] gap-2">
          <input
            className="border rounded px-2 py-1 text-sm"
            placeholder="Улица"
            value={value.econt_street ?? ""}
            onChange={(e) => onChange({ econt_street: e.target.value })}
          />
          <input
            className="border rounded px-2 py-1 text-sm"
            placeholder="№"
            value={value.econt_street_num ?? ""}
            onChange={(e) => onChange({ econt_street_num: e.target.value })}
          />
        </div>
      )}

      {/* Weight + COD */}
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">
          Тегло (кг)
          <input
            type="number"
            min="0.1"
            step="0.1"
            className="w-full border rounded px-2 py-1 text-sm"
            value={value.econt_weight ?? ""}
            onChange={(e) =>
              onChange({ econt_weight: parseFloat(e.target.value) || 0 })
            }
          />
        </label>
        <label className="text-xs">
          Наложен платеж (€)
          <input
            type="number"
            min="0"
            step="0.01"
            className="w-full border rounded px-2 py-1 text-sm"
            value={value.econt_cod_amount ?? ""}
            onChange={(e) =>
              onChange({
                econt_cod_amount: parseFloat(e.target.value) || 0,
              })
            }
          />
        </label>
      </div>

      {/* Price preview */}
      {priceQuery.isFetching && (
        <div className="text-xs text-muted-foreground">Калкулация…</div>
      )}
      {priceQuery.data && (
        <div className="text-sm font-semibold">
          Цена: {priceQuery.data.price.toFixed(2)} € (
          {priceQuery.data.priceBGN.toFixed(2)} лв.)
        </div>
      )}
      {priceQuery.error && (
        <div className="text-xs text-red-600">
          Грешка при калкулация: {(priceQuery.error as Error).message}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/components/EcontShippingPicker.tsx
git commit -m "feat(frontend): add EcontShippingPicker component"
```

---

## Task 11: EcontShipmentActions component

**Files:**

- Create: `warehouse-frontend/src/components/EcontShipmentActions.tsx`

Purpose: show buttons for create/update/print/track inside the order detail modal, plus display shipment status if already created.

- [ ] **Step 1: Write the component**

File: `warehouse-frontend/src/components/EcontShipmentActions.tsx`

```typescript
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Order } from "../types";

interface Props {
  order: Order;
  apiBaseUrl?: string;
  token: string;
  onOrderUpdated?: () => void;
}

async function apiPost<T>(
  baseUrl: string,
  token: string,
  path: string,
  body: unknown,
): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function apiGet<T>(
  baseUrl: string,
  token: string,
  path: string,
): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export function EcontShipmentActions({
  order,
  apiBaseUrl = "/api",
  token,
  onOrderUpdated,
}: Props) {
  const qc = useQueryClient();
  const hasShipment = !!order.econt_shipment_number;

  const createMutation = useMutation({
    mutationFn: () =>
      apiPost<{ shipmentNumber: string; pdfURL: string }>(
        apiBaseUrl,
        token,
        "/econt/create-shipment",
        {
          order_id: order.id,
          receiverName: order.econt_receiver_name,
          receiverPhone: order.econt_receiver_phone,
          receiverCity: order.econt_city,
          receiverOfficeCode: order.econt_office_code,
          receiverStreet: order.econt_street,
          receiverNum: order.econt_street_num,
          weight: order.econt_weight || 1,
          codAmount: order.econt_cod_amount || undefined,
        },
      ),
    onSuccess: (data) => {
      toast.success(`Товарителница ${data.shipmentNumber} създадена`);
      qc.invalidateQueries({ queryKey: ["orders"] });
      onOrderUpdated?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: () =>
      apiPost<{ shipmentNumber: string }>(
        apiBaseUrl,
        token,
        "/econt/update-shipment",
        { order_id: order.id },
      ),
    onSuccess: (data) => {
      toast.success(`Товарителница обновена: ${data.shipmentNumber}`);
      qc.invalidateQueries({ queryKey: ["orders"] });
      onOrderUpdated?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const openPdf = async () => {
    if (order.econt_pdf_url) {
      window.open(order.econt_pdf_url, "_blank");
      return;
    }
    try {
      const r = await apiGet<{ pdfURL: string | null }>(
        apiBaseUrl,
        token,
        `/econt/label-pdf/${order.econt_shipment_number}`,
      );
      if (r.pdfURL) window.open(r.pdfURL, "_blank");
      else toast.error("PDF не е намерен");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const openTracking = () => {
    if (order.econt_tracking_url) {
      window.open(order.econt_tracking_url, "_blank");
    }
  };

  if (!order.econt_city) {
    return null; // No Econt shipping configured for this order
  }

  return (
    <div className="border border-accent-light rounded-md p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-sm">Еконт товарителница</div>
        {hasShipment && (
          <code className="text-xs bg-white px-2 py-0.5 rounded">
            {order.econt_shipment_number}
          </code>
        )}
      </div>
      <div className="flex gap-2 flex-wrap">
        {!hasShipment && (
          <button
            type="button"
            className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-60"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "Създаване…" : "Създай товарителница"}
          </button>
        )}
        {hasShipment && (
          <>
            <button
              type="button"
              className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-60"
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? "Актуализиране…" : "Актуализирай"}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 border rounded text-sm"
              onClick={openPdf}
            >
              Отвори PDF
            </button>
            <button
              type="button"
              className="px-3 py-1.5 border rounded text-sm"
              onClick={openTracking}
            >
              Проследи
            </button>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/components/EcontShipmentActions.tsx
git commit -m "feat(frontend): add EcontShipmentActions component"
```

---

## Task 12: Wire components into Orders.tsx

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx`

Purpose: mount `EcontShippingPicker` inside the create/edit-order form, and `EcontShipmentActions` inside the order detail modal.

- [ ] **Step 1: Locate the create-order form state**

Run: `cd warehouse-frontend && grep -n "useState\|const \[form" src/pages/Orders.tsx | head -20`

Identify the state variable that holds the form values for creating/editing an order (likely something like `formData` or `orderForm`).

- [ ] **Step 2: Locate the order detail modal**

Run: `cd warehouse-frontend && grep -n "OrderDetailModal\|detailOrder\|selectedOrder" src/pages/Orders.tsx | head -15`

Identify where the order detail is rendered (a modal component or inline block).

- [ ] **Step 3: Mount EcontShippingPicker inside create/edit form**

Import at the top:

```typescript
import { EcontShippingPicker } from "../components/EcontShippingPicker";
import { EcontShipmentActions } from "../components/EcontShipmentActions";
```

In the form JSX, after the existing delivery/notes fields, add:

```tsx
<EcontShippingPicker
  value={{
    econt_delivery_type: formData.econt_delivery_type,
    econt_receiver_name: formData.econt_receiver_name,
    econt_receiver_phone: formData.econt_receiver_phone,
    econt_city: formData.econt_city,
    econt_office_code: formData.econt_office_code,
    econt_office_name: formData.econt_office_name,
    econt_street: formData.econt_street,
    econt_street_num: formData.econt_street_num,
    econt_weight: formData.econt_weight,
    econt_cod_amount: formData.econt_cod_amount,
  }}
  onChange={(patch) => setFormData((f) => ({ ...f, ...patch }))}
  token={authToken}
/>
```

Replace `formData`/`setFormData` with the actual state variable/setter names found in Step 1. Replace `authToken` with whatever auth-token accessor the file uses (look for any existing `fetch(...)` call with `Authorization: Bearer` to find it).

- [ ] **Step 4: Mount EcontShipmentActions inside order detail**

Inside the order detail modal (next to the order header), add:

```tsx
<EcontShipmentActions
  order={selectedOrder}
  token={authToken}
  onOrderUpdated={() => refetchOrders()}
/>
```

Replace `selectedOrder` and `refetchOrders` with actual symbols in the file.

- [ ] **Step 5: Extend form state default**

Find where the form state is initialised (likely `useState({...initial values})`). Add the following keys with `undefined`/`""` defaults so the form doesn't lose these fields on open/close:

```typescript
econt_delivery_type: "office" as "office" | "address",
econt_receiver_name: "",
econt_receiver_phone: "",
econt_city: "",
econt_office_code: "",
econt_office_name: "",
econt_street: "",
econt_street_num: "",
econt_weight: 1,
econt_cod_amount: 0,
```

- [ ] **Step 6: Extend the POST /orders payload**

Find the body of the "create order" submit handler (`mutationFn`/`api.post("/orders", ...)`). Ensure the body includes all `econt_*` fields from the form state. Example:

```typescript
{
  ...existing fields,
  econt_delivery_type: formData.econt_delivery_type,
  econt_receiver_name: formData.econt_receiver_name || undefined,
  econt_receiver_phone: formData.econt_receiver_phone || undefined,
  econt_city: formData.econt_city || undefined,
  econt_office_code: formData.econt_office_code || undefined,
  econt_office_name: formData.econt_office_name || undefined,
  econt_street: formData.econt_street || undefined,
  econt_street_num: formData.econt_street_num || undefined,
  econt_weight: formData.econt_weight || undefined,
  econt_cod_amount: formData.econt_cod_amount || undefined,
}
```

- [ ] **Step 7: Type-check**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: exit 0 (no new errors).

- [ ] **Step 8: Build the frontend**

Run: `cd warehouse-frontend && npm run build`
Expected: Vite bundle builds successfully.

- [ ] **Step 9: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(frontend): wire EcontShippingPicker + EcontShipmentActions into Orders.tsx"
```

---

## Task 13: End-to-end smoke verification

**Files:** no source changes — run-time verification only.

- [ ] **Step 1: Ensure Docker Postgres/Redis are running**

Run: `cd warehouse-backend && docker compose up -d postgres redis`
Expected: both services healthy.

- [ ] **Step 2: Apply any new migrations**

Run: `cd warehouse-backend && npm run migrate`
Expected: exit 0; no pending migrations afterwards.

- [ ] **Step 3: Start backend in background**

Run: `cd warehouse-backend && npm run dev` (or `npm start`) — launch as a background process.
Expected: "Server listening on http://0.0.0.0:3000".

- [ ] **Step 4: Probe the new routes without auth**

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/econt/cities?q=sof`
Expected: `401` (auth required; route is mounted).

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/econt/track/X`
Expected: `401`.

- [ ] **Step 5: Start frontend**

Run: `cd warehouse-frontend && npm run dev` — background process.
Expected: Vite prints a local URL (5173 or next free port).

- [ ] **Step 6: Verify frontend loads**

Run: `curl -s http://localhost:5173 | grep -o '<title>[^<]*'` (adjust port if needed).
Expected: output contains `МЕРТ-М Склад`.

- [ ] **Step 7: Run all backend tests one more time**

Run: `cd warehouse-backend && npx vitest run`
Expected: all tests pass.

- [ ] **Step 8: Stop dev processes**

Run: kill any background processes started above.

- [ ] **Step 9: Tag the milestone**

```bash
cd /Users/magic/Projects/mert-m
git tag v0.2.0-ekont -m "Ekont shipping integration (autonomous overnight build)"
git log --oneline v0.1.0-foundation..HEAD | head -30
```

Expected: commit log shows the Ekont-related commits made during this plan.

- [ ] **Step 10: Final commit if any leftover uncommitted work**

```bash
cd /Users/magic/Projects/mert-m
git status
# if clean, skip; otherwise commit with a 'chore: cleanup' message
```

---

## Exit Criteria

All boxes ticked in Tasks 1–13 **AND**:

- `npm run build` succeeds for both backend and frontend.
- `npx vitest run` passes in warehouse-backend (includes all new Econt tests).
- `curl http://localhost:3000/econt/cities?q=sof` returns `401` without a token and `200` with a valid JWT.
- Migration 046 applied — all 13 new columns visible in `orders` via psql.
- `.env.example` documents all Econt env vars.
- No Greek Foods changes — `cd /Users/magic/Projects/greek-foods-platform && git rev-parse HEAD` is still `9f55c3205d60ba41a7d7c706a25553d94d95c71a`.
- Tag `v0.2.0-ekont` exists.
