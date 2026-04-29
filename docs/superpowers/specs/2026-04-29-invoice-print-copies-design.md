# Invoice Print Copies — избор на 1 или 2 копия при принтиране

**Date:** 2026-04-29
**Status:** Approved (brainstorming)
**Owner:** magic
**Branch target:** new feature branch from `main` (например `feature/MERTM-invoice-print-copies`)

## 1. Контекст и проблем

В момента `generateInvoicePdf()` ([warehouse-backend/src/services/invoice-pdf.ts:1128-1130](../../warehouse-backend/src/services/invoice-pdf.ts)) **винаги** генерира PDF с 2 страници:

- Страница 1: с лейбъл „Оригинал"
- Страница 2: без лейбъл (потребителят я възприема като „копие")

Когато потребителят натисне „Отвори" в детайлния модал на поръчка ([warehouse-frontend/src/pages/Orders.tsx:1373-1380](../../warehouse-frontend/src/pages/Orders.tsx)), системата принтира и двете страници — независимо дали реално му трябват две.

**Бизнес изискване (от собственика на MERT-M):**

1. Да се добави избор „1 копие" / „2 копия" при принтиране, без да се претрупва UI-я.
2. Когато се принтират 2 копия, **и двете** трябва да са с лейбъл „Оригинал" (а не 1 оригинал + 1 без лейбъл).

## 2. Решение (high-level)

### Frontend

Бутонът „Отвори" се превръща в **split button**:

```
┌──────────────┬───┐
│  📄 Отвори   │ ▼ │
└──────────────┴───┘
```

- Клик на главната част → принтира **1 копие** (нов default).
- Клик на стрелката ▼ → dropdown с две опции:
  - `📄 1 копие (Оригинал)` — маркирано като default
  - `📄📄 2 копия (и двете Оригинал)`

Места в UI където се прилага:

- Orders детайлен модал — бутон „Отвори" за фактура (Orders.tsx:1373).
- Страница „Фактури" — същата структура.
- Auto-open след „Създай фактура" (Orders.tsx:662) → ползва default-а (1 копие), без UI dropdown.
- **Имейл към партньор** → винаги 1 копие (без UI промяна).

Ползва се съществуващият `DropdownMenu` от shadcn/ui (`warehouse-frontend/src/components/ui/dropdown-menu.tsx`).

### Backend

**1. `generateInvoicePdf()` приема нов параметър `copies`:**

```typescript
interface GenerateInvoicePdfArgs {
  // ... съществуващи полета
  copies?: 1 | 2; // default: 1
}
```

В тялото на функцията — replace на текущите два хардкоднати `renderCopy` извикa:

```typescript
renderCopy("Оригинал");
if (copies === 2) {
  doc.addPage({ size: "A4", margins: pageMargins });
  renderCopy("Оригинал"); // и втората страница е "Оригинал", не null
}
```

**2. `GET /invoices/:id/pdf` приема query параметър `copies`:**

| Request                                      | Behavior                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /invoices/:id/pdf`                      | Default `copies=1`. Ако `pdf_path` съществува на диск → сервира го. Иначе → генерира с `copies=1`, кешира на диск, сервира. |
| `GET /invoices/:id/pdf?copies=1`             | Идентично на горното.                                                                                                       |
| `GET /invoices/:id/pdf?copies=2`             | **Винаги** генерира on-the-fly в memory buffer. **Не пише на диск.** Сервира директно.                                      |
| `GET /invoices/:id/pdf?copies=N` (N ∉ {1,2}) | `400 Bad Request`.                                                                                                          |

**3. Местата където PDF се пише на диск ползват `copies=1`:**

- `POST /invoices` (нова фактура) → `copies=1`.
- `PUT /invoices/:id/regenerate` → `copies=1`.
- Email endpoint → използва кеширания 1-страничен файл.

## 3. Защо точно така

- **Default = 1 копие**: по-малко мастило/хартия по подразбиране; имейлът към клиента и без това винаги изпраща 1 копие.
- **Кеш само за 1 копие**: 2-копийният случай е rare path (експлицитно избран от потребителя за принт). Не държим 2 версии на диск — опростява backup и storage; 2-page генерацията in-memory отнема ~100-300 ms, приемливо за UX.
- **И двете страници „Оригинал"**: текущото „Оригинал + без лейбъл" обърква счетоводно (втората изглежда като полугенерирано копие). Повечето български фирми принтират два оригинала когато искат и клиентът, и архивът да имат идентични документи.
- **Без UI избор за имейла**: имейл фактурата е електронна; две копия в един PDF файл за имейл нямат бизнес смисъл.

## 4. API контракти

### `GET /invoices/:id/pdf?copies={1|2}`

**Query параметри:**

- `copies` (optional, default `1`): валидни стойности `1` или `2`.
- `t` (optional): cache-busting timestamp (съществуващ; не променяме).

**Response:**

- `200 OK` — `Content-Type: application/pdf`, тяло = PDF bytes.
- `400 Bad Request` — `{ error: "Invalid copies value. Must be 1 or 2." }` (consistent JSON shape от backend-а).
- `404 Not Found` — фактура с този id не съществува.
- `403 Forbidden` — потребителят няма INVOICES_VIEW permission (запазваме съществуващото permission gating).

### Frontend helper: `openInvoicePdf(invoiceId, copies)`

```typescript
async function openInvoicePdf(
  invoiceId: number,
  copies: 1 | 2 = 1,
): Promise<void>;
```

Сигнатурата на `openInvoicePdf` ([Orders.tsx:181](../../warehouse-frontend/src/pages/Orders.tsx)) става `(invoiceId, copies?)` с default `1`. URL става `/invoices/:id/pdf?copies={copies}&t={ts}`.

## 5. Тестове

### Backend — unit тестове

**Нов файл `warehouse-backend/src/__tests__/invoice-pdf.test.ts`:**

- `generateInvoicePdf` с `copies=1` → генерираният PDF има точно 1 страница; на нея присъства текстът „Оригинал".
- `generateInvoicePdf` с `copies=2` → 2 страници; **и двете** съдържат „Оригинал" (regression test срещу връщане към null label-а).
- `generateInvoicePdf` без `copies` (default) → 1 страница (regression срещу старото хардкоднато 2).

**Допълнения към `warehouse-backend/src/__tests__/invoices.test.ts`** (ако съществува; иначе се добавя `invoices-pdf-route.test.ts`):

- `GET /invoices/:id/pdf` (без query) → сервира 1-page файла; `pdf_path` на диск не се променя при последователни заявки.
- `GET /invoices/:id/pdf?copies=2` → отговаря с 2-page PDF; `pdf_path` на диск **остава 1-page**.
- `GET /invoices/:id/pdf?copies=99` → `400`.
- `GET /invoices/:id/pdf?copies=abc` → `400`.

### Frontend — ръчна верификация

UI компонентът е тривиален (DropdownMenu вече е тестван от shadcn). Тества се през браузъра:

1. Отваряне на фактура → клик на „Отвори" → принтира 1 страница с „Оригинал".
2. Клик на ▼ → избор „2 копия" → принтира 2 страници, двете с „Оригинал".
3. Auto-open след „Създай фактура" → 1 страница.
4. „Регенерирай" → 1-page файлът се пресъздава на диск.
5. „Имейл" → клиентът получава 1-page PDF в attachment-а.

### Edge cases (документирани, не нужно да се тестват изрично)

| Случай                                         | Поведение                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| Стара фактура със закеширан 2-page PDF на диск | `copies=1` сервира 2-page файла (както е); „Регенерирай" го пресъздава като 1-page. |
| Кредитно известие (КИ)                         | Ползва същия `generateInvoicePdf` → автоматично следва новата логика.               |
| Фактура със / без ДДС                          | `copies` е orthogonal на ДДС логиката.                                              |
| Сторнирана фактура                             | След regenerate е 1-page по default.                                                |

## 6. Backwards compatibility

- `GET /invoices/:id/pdf` без `copies` query → запазва съществуващия URL и не break-ва клиенти; само променя дефолтния брой страници (1 вм. 2).
- Frontend и backend се deploy-ват заедно (същият monorepo, същия release) → няма drift.
- Стари 2-page PDF-и на диска не изискват миграция — продължават да работят, докато не бъдат регенерирани.

## 7. Out of scope

- Запомняне на последния избор на потребителя (3 копия, custom стойности и т.н.) — YAGNI; ако потребителят поиска по-късно, добавяме localStorage.
- Поддръжка на > 2 копия — текущият бизнес case е 1 или 2.
- Промяна на лейбъла „Оригинал" към нещо друго (напр. „Екземпляр 1 / 2") — бизнесът е ясен, и двете трябва да изглеждат еднакво.
- Промени в Razpiska / Гаранция / Stokova razpiska PDF-ите — те не са обект на този design (различен flow, отделен service `document-pdf.ts`).

## 8. Open questions

Няма. Всички решения са взети през brainstorming-а и одобрени.
