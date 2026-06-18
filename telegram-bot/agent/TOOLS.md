# Инструменти (достъпни през /chat на warehouse-backend)

## LLM tool calls (автоматично от Claude)

- **search_products(query)** — търсене на продукти по SKU/име
- **get_order(id)** — детайли за поръчка с артикули
- **list_orders(status?, date_from?, date_to?)** — списък поръчки
- **generate_invoice(order_id, include_vat?)** — издаване на фактура
- **create_econt_shipment(order_id)** — създаване на товарителница
- **track_shipment(shipment_number)** — статус на пратка

## Hardcoded actions в bot.js (бързи shortcut-и)

- **"справка" / "наличност"** → GET /inventory, връща топ 30 стокирани
- **"поръчки"** → GET /orders?status=pending
- **"статистика" / "dashboard"** → GET /analytics/dashboard
- **"здрав" / "/health"** → GET /health
- **Товарителница** → POST /econt/create-shipment (handleCreateWaybill)
- **Email фактура** → SMTP send с PDF от /invoices/:id/pdf

## API Endpoints

- Backend: http://localhost:3003 (dev) / self-hosted (prod)
- Econt: http://ee.econt.com/services/ (чрез /econt/\* роути на backend-а)
- OpenRouter: https://openrouter.ai/api/v1 (LLM)

## Sender (за Еконт — чете се от backend .env)

- Greek Quality Food EOOD, ul. Example 1, Sofia, Bulgaria
- ЕИК: 123456789, ДДС №: BG123456789

## Важно

- **НЯМА** срокове на годност — МЕРТ-М не продава хранителни стоки
- **НЯМА** партиди — дълготрайна стока
- Валута: BGN, ДДС: 20%
