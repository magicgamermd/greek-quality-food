# GQF Core Re-baseline (Phases 0–4 + Deploy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Издигаме Greek Quality Food (GQF) до качеството на доказания MERTM код, като пренасяме MERTM функциите, запазваме GQF-специфичното (партиди/срок/FEFO/брак, **нето ДДС**, брандинг, реални данни) и завършваме брандинга — без да чупим парите.

**Architecture:** Re-baseline по 4 кофи код. MERTM (`/Users/magic/Projects/mert-m`, branch `feat/MERTM-econt-worker-role`) се добавя като git remote `mertm` за reference/diff. ДДС-неутралният код се пренася почти 1:1; money/ДДС кодът взима MERTM структурата, но с нето конвенция; GQF-only модулите се пазят; брандингът става GQF навсякъде. GQF Postgres базата остава непокътната.

**Tech Stack:** Fastify 5 / TypeScript / PostgreSQL 16 (raw SQL, custom runner `src/migrate.ts`) / Redis / Vitest (backend); React 19 / Vite 7 / Tailwind v4 / TanStack Query v5 / Playwright (frontend); Docker + Railway (deploy).

---

## Обхват и декомпозиция

Този план покрива **фази 0–4 + деплой** = солиден GQF като MERTM + партиди + брандинг. Произвежда работещ, тестваем софтуер сам по себе си.

- **Фаза 5 (гласов AI асистент)** и **Фаза 6 (telegram-agent + MCP сървъри)** са в **отделни планове** — пишат се когато стигнем дотам; искат API ключове (ElevenLabs/OpenAI/Telegram).

## Тип на плана

Това е **migration runbook**, не greenfield. Затова:

- Genuine нов/редактиран код (NET helper, incoming fix) → пълен TDD цикъл с код.
- Bulk портове (копиране на доказани MERTM файлове) → точни команди + verification gate (build/тестове/grep одит/златни проби), не "напиши тест от нула".

## Ключови факти (grounding от recon 2026-06-18)

- Споделени миграции: `001`–`079`. GQF-only: `080_restore_batch_tracking_for_gqf`, `081_settings_integrations`, `082_settings_document_toggles`. MERTM-only (пост-fork): `080`–`093` (15 файла, вкл. двоен `088`). **Колизия 080–082.**
- Никоя MERTM пост-fork миграция не пипа партиди. Историческата `045_mertm_deprecate_batches` е отпреди fork-а (в двата), а GQF `080` я е неутрализирала + е **dropнала** `inventory_product_warehouse_nobatch_uidx` + е сложила `(product_id, warehouse_id, batch_id)` тройка като уникалност (от `030_uniqueness_constraints`).
- MERTM `warehouse-backend/src/lib/invoice-totals.ts` пази GROSS (`grossSum / 1.2`). GQF няма този файл → ще добавим NET вариант.
- GQF портове: backend `3005`, frontend `5175`, Postgres `5434`, Redis `6381`. **ai-service е споделен между проекти** (GQF на `:8001`) — внимание при деплой.
- GQF нето правило: `order_items.unit_price/total_price` са НЕТО; данъчна основа = Σ(нето редове); ДДС = основа × 0.20; за получаване = основа + ДДС.

---

## File Structure

**Създаваме:**

- `warehouse-backend/src/lib/invoice-totals.ts` — NET money helper (`computeInvoiceTotalsFromNet`), single source of truth за нето→ДДС→бруто.
- `warehouse-backend/src/lib/__tests__/invoice-totals.test.ts` — unit тестове за helper-а.
- `warehouse-backend/migrations/083_*`…`096_*` — пренаредените MERTM пост-fork миграции.
- `scripts/golden/capture-money-baseline.sh` — снима текущите нето суми като референция.
- `scripts/start-greekquality.sh` — преименуван от `start-mertm.sh`.

**Модифицираме (money/ДДС — кофа B):** `warehouse-backend/src/services/invoice-pdf.ts`, `daily-report-pdf.ts`, `monthly-report-pdf.ts`; `warehouse-backend/src/routes/reports.ts`, `payments.ts`, `orders.ts`; `warehouse-frontend/src/components/RecordPaymentModal.tsx`.

**Модифицираме (incoming партида fix — кофа C):** `warehouse-backend/src/routes/incoming.ts` (≈ред 2091–2105).

**Портваме ≈1:1 от MERTM (кофа A):** backend routes (products, partners, inventory, orders без totals, settings, users, permissions, econt, print, fiscal, analytics, agent), целия frontend UI/PWA (вкл. търсачки/филтри), econt роля.

**Пазим непокътнати (кофа C):** `warehouse-backend/src/routes/batches.ts`, `writeoffs.ts`, `services/writeoff-pdf.ts`, миграции `080`–`082`, FEFO логиката.

**Брандинг (кофа D):** `telegram-bot/bot.js` + `agent/{SOUL,MEMORY,TOOLS}.md`, `warehouse-backend/src/routes/agent.ts`, `ai-service/app/{config.py,main.py}`, `mobile-owner-app/app.json`, `mobile-app/app.json`, `macos-installer/`, `warehouse-frontend/src/pages/Dashboard.tsx`, `warehouse-backend/src/routes/invoices.ts` (BAKALIA fallback).

---

## Phase 0 — Safety net

### Task 0.1: MERTM като reference remote + работен branch

**Files:** няма (git операции)

- [ ] **Step 1: Потвърди branch и чисто дърво**

Run: `git -C /Users/magic/Projects/greek-quality-food status -sb`
Expected: на `feat/gqf-sync-from-mertm`, без неочаквани промени (освен plan файловете).

- [ ] **Step 2: Добави MERTM като read-only remote и fetch**

```bash
cd /Users/magic/Projects/greek-quality-food
git remote add mertm /Users/magic/Projects/mert-m || git remote set-url mertm /Users/magic/Projects/mert-m
git fetch mertm
git log --oneline mertm/feat/MERTM-econt-worker-role -1
```

Expected: вижда се последният MERTM commit (`0e5cb57 feat(pwa)…`).

- [ ] **Step 3: Commit (само ако има plan файлове за добавяне)**

```bash
git add docs/superpowers/plans/2026-06-18-gqf-core-rebaseline.md
git commit -m "docs(gqf): core re-baseline implementation plan"
```

### Task 0.2: Backup на GQF базата

**Files:** използва `scripts/backup/nightly-pg-dump.sh`

- [ ] **Step 1: Увери се, че GQF Postgres върви**

Run: `docker ps --format '{{.Names}}' | grep greekquality-postgres || echo "NOT RUNNING"`
Ако не върви: `cd /Users/magic/Projects/greek-quality-food/warehouse-backend && docker-compose up -d postgres redis`

- [ ] **Step 2: Направи pre-rebaseline дъмп**

```bash
cd /Users/magic/Projects/greek-quality-food
PGPASSWORD=$(grep -E '^POSTGRES_PASSWORD=' warehouse-backend/.env | cut -d= -f2) \
  pg_dump -h localhost -p 5434 -U warehouse greekquality_warehouse \
  | gzip > ~/gqf-backups/pre-rebaseline-$(date +%Y%m%d-%H%M%S).sql.gz
ls -lh ~/gqf-backups/ | tail -1
```

Expected: gzipped дъмп > 0 байта. (Ако пътищата/креденшъли се разминават — виж `warehouse-backend/.env` и `docker-compose.yml`.)

### Task 0.3: Златни проби по парите (нето регресия)

**Files:** Create `scripts/golden/capture-money-baseline.sh`

- [ ] **Step 1: Стартирай GQF backend (ако не върви)**

```bash
cd /Users/magic/Projects/greek-quality-food/warehouse-backend
nohup npx tsx src/index.ts > /tmp/gqf-backend.log 2>&1 &
sleep 4 && curl -s localhost:3005/health || tail -20 /tmp/gqf-backend.log
```

- [ ] **Step 2: Напиши скрипта за снимане**

```bash
#!/usr/bin/env bash
# scripts/golden/capture-money-baseline.sh
# Снима текущите нето/ДДС/бруто суми на последните N фактури + днешния
# дневен отчет, за да сверим, че НЕ мърдат след re-baseline на money кода.
set -euo pipefail
API="${API:-http://localhost:3005}"
TOKEN="${TOKEN:?export TOKEN=<admin JWT>}"
OUT="docs/superpowers/golden"; mkdir -p "$OUT"
curl -s -H "Authorization: Bearer $TOKEN" "$API/invoices?limit=10" \
  | jq '[.data[]? // .[]? | {invoice_number, total_net, total_vat, total_gross}]' \
  > "$OUT/invoices-baseline.json"
curl -s -H "Authorization: Bearer $TOKEN" "$API/reports/daily?date=$(date +%F)" \
  | jq '{date, totals}' > "$OUT/daily-report-baseline.json"
echo "Saved → $OUT/{invoices,daily-report}-baseline.json"
```

- [ ] **Step 3: Изпълни и закоментирай очаквания**

Run:

```bash
cd /Users/magic/Projects/greek-quality-food
chmod +x scripts/golden/capture-money-baseline.sh
TOKEN=<admin JWT от login> ./scripts/golden/capture-money-baseline.sh
cat docs/superpowers/golden/invoices-baseline.json
```

Expected: JSON с реални нето/ДДС/бруто числа (бруто ≈ нето × 1.2). Това е референцията за Phase 2.

- [ ] **Step 4: Commit**

```bash
git add scripts/golden/capture-money-baseline.sh docs/superpowers/golden/
git commit -m "test(gqf): money baseline snapshot преди re-baseline"
```

---

## Phase 1 — Re-baseline на ядрото (кофа A)

> Метод: за всеки ДДС-неутрален файл/папка взимаме MERTM версията в работното дърво с
> `git checkout mertm/feat/MERTM-econt-worker-role -- <path>`, после ревизираме за GQF портове/брандинг.
> **Внимание:** money/ДДС файловете (кофа B) и batch файловете (кофа C) НЕ се пипат тук.
> Брандинг остатъци, които портът връща (напр. „МЕРТ-М" в UI), се чистят в Phase 4 чрез grep одит.

### Task 1.1: Помиряване на миграциите

**Files:** Create `warehouse-backend/migrations/083_*`…`096_*` (от MERTM 080–093)

- [ ] **Step 1: Сравни съдържанието на потенциалните колизии**

```bash
cd /Users/magic/Projects/greek-quality-food
for n in 080 081 082; do
  echo "=== $n ===";
  for f in warehouse-backend/migrations/${n}_*.sql; do echo "GQF: $(basename "$f")"; done
done
git show mertm/feat/MERTM-econt-worker-role:warehouse-backend/migrations/080_assistant_telemetry.sql | head -5
```

Expected: потвърждава, че GQF 080–082 ≠ MERTM 080–082 (различно съдържание).

- [ ] **Step 2: Извади MERTM пост-fork миграциите и ги пренареди след GQF 082**

```bash
cd /Users/magic/Projects/greek-quality-food
mkdir -p /tmp/mertm-migr
for f in 080_assistant_telemetry 081_orders_warehouse_confirmed_at 082_orders_source_assistant \
         083_orders_warranty_months 084_orders_created_by 085_proforma_invoices \
         086_orders_goods_taken_unpaid 087_products_is_service 088_orders_econt_post_code \
         088_stock_movements 089_orders_econt_receiver_company 090_orders_econt_requested \
         091_users_role_econt 092_settings_document_printer 093_orders_formal; do
  git show "mertm/feat/MERTM-econt-worker-role:warehouse-backend/migrations/${f}.sql" > "/tmp/mertm-migr/${f}.sql"
done
ls /tmp/mertm-migr
```

Expected: 15 файла в `/tmp/mertm-migr`.

- [ ] **Step 3: Преномерирай 083→096 запазвайки реда (двата 088 стават 091+092)**

Пренареждане (нов номер ← стар файл):

```
083 ← 080_assistant_telemetry        090 ← 087_products_is_service
084 ← 081_orders_warehouse_confirmed  091 ← 088_orders_econt_post_code
085 ← 082_orders_source_assistant     092 ← 088_stock_movements
086 ← 083_orders_warranty_months      093 ← 089_orders_econt_receiver_company
087 ← 084_orders_created_by           094 ← 090_orders_econt_requested
088 ← 085_proforma_invoices           095 ← 091_users_role_econt
089 ← 086_orders_goods_taken_unpaid   096 ← 092_settings_document_printer
                                       (097 ← 093_orders_formal)
```

Копирай ги с новите имена в `warehouse-backend/migrations/` (запази оригиналното описание в името, само смени числото). Пример:

```bash
cp /tmp/mertm-migr/080_assistant_telemetry.sql warehouse-backend/migrations/083_assistant_telemetry.sql
# … и т.н. за всичките 15 (083_…097_)
```

- [ ] **Step 4: Провери за конфликт с GQF batch промените**

`092_stock_movements.sql` и econt миграциите не пипат `inventory`/`batches` unique индекси. Потвърди:

```bash
grep -l "nobatch_uidx\|inventory_product_warehouse" warehouse-backend/migrations/09{1,2,3,4,5,6,7}_*.sql || echo "OK — no batch-index touch"
```

Expected: `OK`.

- [ ] **Step 5: Изпълни миграциите срещу GQF базата**

Run: `cd warehouse-backend && npx tsx src/migrate.ts`
Expected: новите 083–097 минават без грешка; existing 080–082 се прескачат (вече приложени).

- [ ] **Step 6: Commit**

```bash
git add warehouse-backend/migrations/08[3-9]_*.sql warehouse-backend/migrations/09[0-7]_*.sql
git commit -m "feat(gqf): port MERTM пост-fork миграции (083–097), пренаредени след GQF 082"
```

### Task 1.2: Port на ДДС-неутрални backend routes

**Files:** Modify `warehouse-backend/src/routes/{products,partners,inventory,settings,users,permissions,econt,print,fiscal,analytics,categories,suppliers,notifications,import,export,product-aliases,auth,agent}.ts`

- [ ] **Step 1: Вземи MERTM версиите (без money/batch файлове)**

```bash
cd /Users/magic/Projects/greek-quality-food
for r in products partners inventory settings users permissions econt print fiscal \
         analytics categories suppliers notifications import export product-aliases auth translate; do
  git checkout mertm/feat/MERTM-econt-worker-role -- warehouse-backend/src/routes/$r.ts 2>/dev/null \
    && echo "ported: $r" || echo "skip (n/a): $r"
done
```

**НЕ** включвай: `orders.ts`, `payments.ts`, `reports.ts`, `invoices.ts`, `incoming.ts`, `batches.ts`, `writeoffs.ts` (кофи B/C — отделни задачи).

- [ ] **Step 2: Преглед за GQF портове/имена**

Run: `grep -rn "3004\|6380\|mertm\|МЕРТ-М" warehouse-backend/src/routes/agent.ts`
Поправи `service: "mertm-agent-api"` → `"gqf-agent-api"` и всякакви `localhost:3004`/`:6380` → `:3005`/`:6381`. (Останалите брандинг остатъци ще ги хване Phase 4.)

- [ ] **Step 3: Build gate**

Run: `cd warehouse-backend && npx tsc --noEmit`
Expected: без нови TS грешки от портнатите routes. Ако route ползва lib/util, който още не е портнат → портни и него (`git checkout mertm/… -- warehouse-backend/src/lib/<x>.ts`), пропускайки `invoice-totals.ts`.

- [ ] **Step 4: Commit**

```bash
git add warehouse-backend/src/routes/ warehouse-backend/src/lib/
git commit -m "feat(gqf): port ДДС-неутрални backend routes от MERTM (кофа A)"
```

### Task 1.3: Port на frontend UI/PWA + търсачки/филтри

**Files:** Modify `warehouse-frontend/src/{pages,components,hooks,api}` (без money компоненти)

- [ ] **Step 1: Вземи MERTM frontend src (после ще върнем GQF брандинга)**

```bash
cd /Users/magic/Projects/greek-quality-food
git checkout mertm/feat/MERTM-econt-worker-role -- warehouse-frontend/src
# Върни money-чувствителния компонент към GQF версия (ще се прави в Phase 2):
git checkout HEAD -- warehouse-frontend/src/components/RecordPaymentModal.tsx
```

- [ ] **Step 2: Възстанови GQF брандинг конфигa (не overwrite-вай PWA манифеста)**

```bash
git checkout HEAD -- warehouse-frontend/vite.config.ts warehouse-frontend/index.html \
  warehouse-frontend/src/index.css
```

Expected: лилавото `#6c3dff` и „Greek Quality Food" PWA остават; кодът е MERTM.

- [ ] **Step 3: Build gate**

Run: `cd warehouse-frontend && npx vite build`
Expected: билдът минава (използваме `vite build`, не `tsc && vite build` — има известна pre-existing TS грешка в `WarehousePacking.tsx`, заобикаля се). Поправи реални import грешки, ако се появят.

- [ ] **Step 4: Smoke в браузъра**

Стартирай dev (`npm run dev` → :5175), отвори, логни се, провери че **търсачките/филтрите по № заявка/поръчка и партньор** работят на Orders/Invoices страниците.

- [ ] **Step 5: Commit**

```bash
git add warehouse-frontend/src warehouse-frontend/vite.config.ts warehouse-frontend/index.html
git commit -m "feat(gqf): port MERTM frontend UI/PWA + търсачки (кофа A), запазен GQF брандинг конфиг"
```

### Task 1.4: Econt роля + опашка

**Files:** идва с миграция `095_users_role_econt` (Task 1.1) + портнатите `econt.ts` (1.2) + frontend (1.3)

- [ ] **Step 1: Потвърди ролята в схемата**

Run: `psql -h localhost -p 5434 -U warehouse greekquality_warehouse -c "\d+ users" | grep -i role`
Expected: role check/enum включва `econt` (от 095).

- [ ] **Step 2: Провери econt-queue endpoint-а**

Run: `grep -rn "econt-queue\|econt_requested_at" warehouse-backend/src/routes/orders.ts warehouse-backend/src/routes/econt.ts`
Бележка: `orders.ts` се портва в Phase 2 (money), но econt-queue частта е ДДС-неутрална — увери се, че е налична след Phase 2.

- [ ] **Step 3: e2e gate (по-късно, заедно с Phase 2)** — отбележи като зависимост.

---

## Phase 2 — Пари/ДДС помиряване (кофа B)

> Тук вземаме MERTM подобренията по фактури/отчети/плащания/поръчки, **но налагаме нето конвенцията**.
> Acceptance за цялата фаза: `scripts/golden/*` сумите са идентични отпреди.

### Task 2.1: NET money helper (TDD)

**Files:**

- Create: `warehouse-backend/src/lib/invoice-totals.ts`
- Test: `warehouse-backend/src/lib/__tests__/invoice-totals.test.ts`

- [ ] **Step 1: Напиши падащия тест**

```typescript
// warehouse-backend/src/lib/__tests__/invoice-totals.test.ts
import { describe, it, expect } from "vitest";
import { computeInvoiceTotalsFromNet } from "../invoice-totals";

describe("computeInvoiceTotalsFromNet (GQF нето конвенция)", () => {
  it("добавя 20% ДДС върху нето сумата", () => {
    const t = computeInvoiceTotalsFromNet(100, true);
    expect(t.totalNet).toBeCloseTo(100, 2);
    expect(t.totalVat).toBeCloseTo(20, 2);
    expect(t.totalGross).toBeCloseTo(120, 2);
    expect(t.vatRate).toBe(20);
  });
  it("при освобождаване от ДДС бруто = нето", () => {
    const t = computeInvoiceTotalsFromNet(100, false);
    expect(t.totalVat).toBe(0);
    expect(t.totalGross).toBeCloseTo(100, 2);
    expect(t.vatRate).toBe(0);
  });
  it("закръгля до 2 знака", () => {
    const t = computeInvoiceTotalsFromNet(182.46, true);
    expect(t.totalVat).toBeCloseTo(36.49, 2);
    expect(t.totalGross).toBeCloseTo(218.95, 2);
  });
});
```

- [ ] **Step 2: Пусни — трябва да падне**

Run: `cd warehouse-backend && npx vitest run src/lib/__tests__/invoice-totals.test.ts`
Expected: FAIL — `computeInvoiceTotalsFromNet is not a function`.

- [ ] **Step 3: Имплементирай helper-а**

```typescript
// warehouse-backend/src/lib/invoice-totals.ts
// Single source of truth за GQF нето/ДДС/бруто математиката.
//
// Greek Quality Food съхранява order_items.unit_price/total_price като НЕТО
// (без ДДС) — касиерът въвежда нето продажна цена. ДДС се ДОБАВЯ отгоре,
// никога не се вади. (Обратно на MERTM, който пази GROSS и дели на 1.2.)

export interface InvoiceTotals {
  totalNet: number;
  totalVat: number;
  totalGross: number;
  vatRate: number; // 20 когато има ДДС, иначе 0
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Извежда нето / ДДС / бруто от НЕТО сума (без ДДС).
 * @param netSum     сбор на order_items.total_price (вече без ДДС)
 * @param includeVat дали фактурата носи 20% ДДС (false → 0% / освободена)
 */
export function computeInvoiceTotalsFromNet(
  netSum: number,
  includeVat: boolean,
): InvoiceTotals {
  const vatRate = includeVat ? 20 : 0;
  const totalNet = round2(netSum);
  const totalVat = round2(includeVat ? netSum * (vatRate / 100) : 0);
  const totalGross = round2(totalNet + totalVat);
  return { totalNet, totalVat, totalGross, vatRate };
}
```

- [ ] **Step 4: Пусни — трябва да мине**

Run: `cd warehouse-backend && npx vitest run src/lib/__tests__/invoice-totals.test.ts`
Expected: PASS (3 теста).

- [ ] **Step 5: Commit**

```bash
git add warehouse-backend/src/lib/invoice-totals.ts warehouse-backend/src/lib/__tests__/invoice-totals.test.ts
git commit -m "feat(gqf): NET money helper (нето → +20% ДДС)"
```

### Task 2.2: Port на orders.ts + invoices.ts с нето totals

**Files:** Modify `warehouse-backend/src/routes/orders.ts`, `invoices.ts`

- [ ] **Step 1: Сравни MERTM vs GQF версиите**

Run:

```bash
cd /Users/magic/Projects/greek-quality-food
git diff HEAD mertm/feat/MERTM-econt-worker-role -- warehouse-backend/src/routes/orders.ts | head -120
```

Идентифицирай: (а) ДДС-неутралните подобрения (econt-queue, formal orders, replacements, line_status) — взимат се; (б) местата с totals/ДДС — остават нето.

- [ ] **Step 2: Пренеси неутралните подобрения, запази нето totals**

Замени всяко `computeInvoiceTotalsFromGross(grossSum, includeVat)` извикване с `computeInvoiceTotalsFromNet(netSum, includeVat)`, където сумата е Σ от нето `order_items.total_price`. Увери се, че **никъде не се дели на 1.2** за основа и че totals не добавят ДДС двойно.

- [ ] **Step 3: Build + unit gate**

Run: `cd warehouse-backend && npx tsc --noEmit && npx vitest run src/__tests__/`
Expected: компилира; invoice/totals тестовете минават (поправи fixtures към нето очаквания, ако MERTM версията носи GROSS fixtures).

- [ ] **Step 4: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts warehouse-backend/src/routes/invoices.ts warehouse-backend/src/__tests__/
git commit -m "feat(gqf): port orders/invoices подобрения с нето ДДС конвенция"
```

### Task 2.3: Invoice PDF + дневен/месечен отчет + плащания (нето)

**Files:** Modify `warehouse-backend/src/services/{invoice-pdf,daily-report-pdf,monthly-report-pdf}.ts`, `warehouse-backend/src/routes/{reports,payments}.ts`, `warehouse-frontend/src/components/RecordPaymentModal.tsx`

- [ ] **Step 1: За всеки — diff и пренеси MERTM подобренията, запазвайки нето**

За PDF-ите: редовете показват нето, footer-ът смята ДДС = основа × 0.20 и „Сума за получаване" = основа + ДДС (виж текущата GQF логика в `invoice-pdf.ts` ред ≈924–943, 1085–1138).
За `reports.ts`: дневен/месечен ползва `SUM(...) * 1.2` за GROSS показване (ред ≈189–211, 641–644, 794+).
За `payments.ts`: invoice плащане ползва `total_gross`; razpiska ползва `total_amount` (нето), × 1.2 се прави UI-side.
За `RecordPaymentModal.tsx`: razpiska събира GROSS = нето × 1.2 (ред ≈44–53) — запази GQF версията.

- [ ] **Step 2: Build + restart backend**

Run: `cd warehouse-backend && npx tsc --noEmit` → рестартирай tsx процеса.

- [ ] **Step 3: ЗЛАТНА ПРОБА gate**

```bash
cd /Users/magic/Projects/greek-quality-food
TOKEN=<admin JWT> ./scripts/golden/capture-money-baseline.sh
git diff --no-index docs/superpowers/golden/invoices-baseline.json <(curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3005/invoices?limit=10" | jq '[.data[]? // .[]? | {invoice_number, total_net, total_vat, total_gross}]')
```

Expected: **нулева разлика** в сумите. Ако има разлика → нето конвенцията е счупена някъде, поправи преди commit.

- [ ] **Step 4: Commit**

```bash
git add warehouse-backend/src/services/ warehouse-backend/src/routes/reports.ts warehouse-backend/src/routes/payments.ts warehouse-frontend/src/components/RecordPaymentModal.tsx
git commit -m "feat(gqf): port PDF/отчети/плащания с нето ДДС — златни проби съвпадат"
```

---

## Phase 3 — Партиди end-to-end (кофа C)

### Task 3.1: Batch-aware заприходяване в incoming confirm

**Files:** Modify `warehouse-backend/src/routes/incoming.ts` (≈ред 2091–2105)

- [ ] **Step 1: Прочети текущия confirm + incoming_items/batches схемата**

```bash
sed -n '2085,2125p' warehouse-backend/src/routes/incoming.ts
psql -h localhost -p 5434 -U warehouse greekquality_warehouse -c "\d incoming_items" -c "\d batches" -c "\d inventory"
```

Потвърди колоните: дали `incoming_items` носи `batch_number`/`expiry_date` или само `batch_id`; уникалния тройник на `inventory(product_id, warehouse_id, batch_id)`.

- [ ] **Step 2: Напиши e2e/integration тест (падащ)**

В `e2e-tests/` добави сценарий „confirm на входяща доставка с партида и срок → създава batch + inventory ред с batch_id". Pseudo-acceptance (адаптирай към реалния e2e helper):

```
създай incoming с item {product, qty:5, batch_number:'L-1', expiry_date:'2026-12-31'}
POST /incoming/:id/confirm
GET inventory за product → има ред с batch_id != NULL, quantity 5
GET batches → има batch 'L-1' с expiry 2026-12-31
```

Run и виж, че пада (заради стария nobatch ON CONFLICT).

- [ ] **Step 3: Поправи confirm пътя да е batch-aware**

Замени блока на ред ≈2099–2105. Когато item-ът има партида/срок — намери/създай `batches` ред и заприходи към `(product_id, warehouse_id, batch_id)`; иначе fallback към batch-aware NULL вариант, съвместим с GQF тройника (НЕ ползвай dropнатия `nobatch_uidx`). Скелет:

```typescript
// Намери/създай партида, ако incoming item-ът носи batch/expiry
let batchId: number | null = item.batch_id ?? null;
if (!batchId && (item.batch_number || item.expiry_date)) {
  const {
    rows: [b],
  } = await client.query(
    `INSERT INTO batches (product_id, batch_number, expiry_date, quantity, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (product_id, batch_number) DO UPDATE SET quantity = batches.quantity + EXCLUDED.quantity
     RETURNING id`,
    [
      item.product_id,
      item.batch_number ?? null,
      item.expiry_date ?? null,
      item.quantity,
    ],
  );
  batchId = b.id;
}
// Заприходи към inventory по пълния тройник (GQF 030 уникалност)
await client.query(
  `INSERT INTO inventory (product_id, warehouse_id, quantity, batch_id, updated_at)
   VALUES ($1, $2, $3, $4, NOW())
   ON CONFLICT (product_id, warehouse_id, batch_id)
   DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity, updated_at = NOW()`,
  [item.product_id, defaultWarehouseId, item.quantity, batchId],
);
```

**Бележка:** свери реалните имена на constraint-и/колони от Step 1 (напр. дали `ON CONFLICT (product_id, batch_number)` съществува; ако не — адаптирай към наличния уникален индекс или го добави с нова миграция `098_*`).

- [ ] **Step 4: Пусни теста — мине**

Run: `cd warehouse-backend && npx vitest run` + e2e сценария.
Expected: PASS — партида се създава и inventory ред носи batch_id.

- [ ] **Step 5: Commit**

```bash
git add warehouse-backend/src/routes/incoming.ts e2e-tests/
git commit -m "fix(gqf): batch-aware заприходяване при incoming confirm (nobatch индексът е dropнат за GQF)"
```

### Task 3.2: FEFO/брак регресия

**Files:** няма промени; verification на `batches.ts`/`writeoffs.ts`

- [ ] **Step 1: Пусни batch/writeoff тестовете**

Run: `cd warehouse-backend && npx vitest run src/__tests__/ -t "batch|writeoff|fefo"`
Expected: зелено. Ако портнатите routes (orders/inventory) са разместили нещо около FEFO — поправи.

- [ ] **Step 2: e2e — експедиране тегли по-кратък срок първо (FEFO)**

Run съответния `e2e-tests` сценарий. Expected: PASS.

---

## Phase 4 — Довършване на брандинга (кофа D)

### Task 4.1: grep одит — нула МЕРТ-М/чужди остатъци

**Files:** various (виж по-долу)

- [ ] **Step 1: Намери всички остатъци**

```bash
cd /Users/magic/Projects/greek-quality-food
grep -rni "МЕРТ-М\|MERT-M\|mertm\|BAKALIA\|Greek Foods Analytics" \
  --include=*.ts --include=*.tsx --include=*.js --include=*.py --include=*.json --include=*.md --include=*.sh \
  -l . | grep -v node_modules | grep -v docs/archive | grep -v "docs/superpowers"
```

Expected: списък файлове за чистене (telegram-bot, ai-service, mobile app.json-и, macos-installer, agent.ts, Dashboard.tsx localStorage ключ, invoices.ts BAKALIA fallback, start-mertm.sh).

- [ ] **Step 2: Поправи по файл (без node_modules/docs архив)**

- `telegram-bot/bot.js` → „Greek Quality Food EOOD", GQF адрес/тел/имейл (ред ≈388,451,478,1355,1367,1684); `agent/{SOUL,MEMORY,TOOLS}.md` → GQF персона + **хранителен** KB (не кухненско оборудване).
- `warehouse-backend/src/routes/invoices.ts` → BAKALIA fallback (ред ≈372–377) → GQF данни (или само от `settings`).
- `warehouse-frontend/src/pages/Dashboard.tsx` → localStorage ключ `mertm:` → `gqf:`.
- `ai-service/app/{config.py,main.py}` → title + defaults `:3004/:6380` → `:3005/:6381` (+ ai-service порт `:8001`).
- `mobile-owner-app/app.json` → name „Greek Quality Food Owner", slug `gqf-owner`, bundle `com.greekqualityfood.owner`.
- `mobile-app/app.json` → name/slug „greek-quality-food-analytics".
- `macos-installer/install.sh` + `.app` bundles → GQF; `scripts/start-mertm.sh` → `scripts/start-greekquality.sh`.

- [ ] **Step 3: Повторен одит — чисто**

Run: `grep -rni "МЕРТ-М\|MERT-M\|mertm\|BAKALIA\|Greek Foods Analytics" --include=*.{ts,tsx,js,py,json} -l . | grep -v node_modules | grep -v docs/`
Expected: празно (или само исторически docs).

- [ ] **Step 4: Build gate (двата проекта)**

Run: `cd warehouse-backend && npx tsc --noEmit` и `cd ../warehouse-frontend && npx vite build`
Expected: зелено.

- [ ] **Step 5: Commit**

```bash
git add -p   # стейджвай по файл, внимателно (без секрети)
git commit -m "chore(gqf): довършен брандинг — нула МЕРТ-М остатъци (telegram/mobile/ai-service/installer)"
```

### Task 4.2: Пълна регресия

- [ ] **Step 1: Backend unit тестове**

Run: `cd warehouse-backend && npx vitest run`
Expected: зелено (или само documented pre-existing fails).

- [ ] **Step 2: e2e Playwright**

Run: `cd e2e-tests && npx playwright test`
Expected: критичните потоци (auth, orders, invoices, incoming, payments, permissions, batches) минават.

- [ ] **Step 3: Ръчен smoke в браузъра** — логин по роли (admin/accountant/warehouse/sales/econt), фактура, стокова разписка, проформа, дневен отчет, партида при доставка, FEFO при експедиране.

- [ ] **Step 4: Update STATUS.md** (GQF конвенция) + commit.

---

## Phase 5 (Deploy) — Docker / Railway

### Task 5.1: Docker билд + миграции

**Files:** `warehouse-backend/Dockerfile`, `docker-compose.yml`, `railway.toml`

- [ ] **Step 1: Локален Docker билд**

Run: `cd warehouse-backend && docker build -t gqf-backend .`
Expected: успешен билд.

- [ ] **Step 2: Compose up + миграции**

Run: `cd warehouse-backend && docker-compose up -d && docker-compose logs -f backend | head -40`
Expected: `node dist/migrate.js` минава (083–097 + incoming fix миграция, ако е добавена), после `node dist/index.js` слуша на 3005.

- [ ] **Step 3: ai-service порт изолация**

Потвърди GQF ai-service на `:8001` (споделен контейнер между проекти!) и че backend сочи към него (`WAREHOUSE_API_URL`/AI URL в `.env`). Expected: няма конфликт с MERTM/:8000.

### Task 5.2: Railway env + smoke

- [ ] **Step 1: Env vars**

Свери в Railway/`.env`: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, ДДС=20, фирмени данни (име/ЕИК/ДДС/IBAN/MOL), Resend/SMTP (`RESEND_API_KEY`, `EMAIL_FROM`).

- [ ] **Step 2: Deploy + smoke**

Deploy; после health + критични пътища: `curl $URL/health`, login, фактура PDF, дневен отчет, партида.
Expected: зелено. Това е финалът на core re-baseline.

- [ ] **Step 3: Финален commit + (по желание) merge към main**

```bash
git add -A && git commit -m "chore(gqf): deploy конфиг готов (Docker/Railway)"
```

---

## Self-Review

**Spec coverage:** всяка секция от spec-а има задача —
re-baseline кофа A (Task 1.2/1.3), money/ДДС нето кофа B (Task 2.1–2.3 + златни проби), партиди кофа C (Task 3.1/3.2 + incoming fix), брандинг кофа D (Task 4.1), миграции (Task 1.1), Econt роля (Task 1.4), тестване/безопасност (Task 0.2/0.3, 2.3 gate, 4.2), деплой Docker/Railway (Task 5.x). Фази 5–6 от spec-а (гласов/telegram) са изрично изнесени в отделни планове.

**Placeholder scan:** код стъпките носят реален код (NET helper, incoming fix); порт стъпките носят точни команди + verification gate (build/тест/grep/златна проба). „Свери реалните имена на constraint" в Task 3.1 е честна migration реалност, не placeholder — придружена с конкретен скелет и acceptance.

**Type consistency:** `computeInvoiceTotalsFromNet` (Task 2.1) се ползва със същото име в Task 2.2; връща `InvoiceTotals { totalNet, totalVat, totalGross, vatRate }`. Миграционните номера 083–097 са консистентни между Task 1.1 и 5.1.

**Отворени зависимости (от spec т.13):** счетоводно потвърждение на нето (preferred преди прод); реални GQF фирмени данни за `settings`; API ключове за фази 5–6 (отделни планове).
