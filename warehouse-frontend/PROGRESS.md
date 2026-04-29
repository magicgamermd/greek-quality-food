# МЕРТ-М Warehouse Frontend — Progress

## Status: ✅ Complete & Building

## Tech Stack

- React 19 + Vite 7 + TypeScript
- Tailwind CSS v4 (CSS-first config)
- @tanstack/react-query v5 for data fetching
- React Router v6 for routing
- Axios with JWT interceptors
- Recharts for analytics charts
- Radix UI primitives for accessible components
- lucide-react for icons

## Architecture

### Entry

- `src/main.tsx` — app entry, StrictMode
- `src/App.tsx` — QueryClient, AuthProvider, BrowserRouter, routes

### Contexts

- `src/contexts/AuthContext.tsx` — JWT auth (login/logout, persisted in localStorage)

### API

- `src/lib/api.ts` — Axios instance with JWT interceptor, auto-redirect on 401
- Base URL: `/api` → proxied to `http://localhost:3000` in dev

### Utilities

- `src/lib/utils.ts` — cn(), formatCurrency(), formatDate(), formatDateTime(), isExpiringSoon()
- `src/types/index.ts` — All TypeScript interfaces matching backend schema

### UI Components (`src/components/ui/`)

- `button.tsx` — CVA-based Button with variants
- `input.tsx` — Styled input
- `label.tsx` — Radix label
- `card.tsx` — Card/Header/Title/Content/Footer
- `dialog.tsx` — Radix dialog modal
- `badge.tsx` — CVA-based Badge (default/secondary/destructive/success/warning/info)
- `table.tsx` — Table/Header/Body/Row/Head/Cell
- `select.tsx` — Native select with custom arrow
- `spinner.tsx` — Spinner, LoadingOverlay, ErrorMessage
- `textarea.tsx` — Styled textarea

### Layout

- `src/components/Layout.tsx` — Dark sidebar (#1a1a2e), collapsible, header with user/notifications

## Pages Implemented

| Page           | Route        | File                      | Status |
| -------------- | ------------ | ------------------------- | ------ |
| Login          | `/login`     | `pages/Login.tsx`         | ✅     |
| Dashboard      | `/`          | `pages/Dashboard.tsx`     | ✅     |
| Products       | `/products`  | `pages/Products.tsx`      | ✅     |
| Inventory      | `/inventory` | `pages/Inventory.tsx`     | ✅     |
| Incoming Goods | `/incoming`  | `pages/IncomingGoods.tsx` | ✅     |
| Orders         | `/orders`    | `pages/Orders.tsx`        | ✅     |
| Partners       | `/partners`  | `pages/Partners.tsx`      | ✅     |
| Invoices       | `/invoices`  | `pages/Invoices.tsx`      | ✅     |
| Payments       | `/payments`  | `pages/Payments.tsx`      | ✅     |
| Analytics      | `/analytics` | `pages/Analytics.tsx`     | ✅     |

## Page Feature Checklist

### Dashboard

- [x] KPI cards: stock value, today's orders, low stock, pending payments, expiring batches
- [x] Recent orders list with status badges
- [x] Low stock items list
- [x] Auto-refresh every 30s

### Products

- [x] Searchable/filterable product list
- [x] Add/Edit modal with all fields
- [x] Delete with confirm
- [x] Stock quantity per product shown
- [x] Category filter

### Inventory

- [x] All/Low-stock/Expiring tabs
- [x] Per-batch expiry dates (red=expired, orange=expiring, grey=ok)
- [x] Status badges (Нисък запас, Изтичащо, ОК)
- [x] Search filter

### Incoming Goods

- [x] File/image upload → AI scan (POST /incoming/scan)
- [x] Scanned data preview with editable fields
- [x] Items table from AI extraction
- [x] Confirm + save to backend
- [x] History table with confirm action
- [x] Status badges (draft/pending/confirmed)

### Orders

- [x] Order list with status filter pills
- [x] Create order form (partner, items, prices, delivery date)
- [x] Fulfill order button (confirmed → fulfilled)
- [x] Generate invoice button (fulfilled → invoiced)
- [x] Status badges

### Partners

- [x] Partner list with contact info
- [x] Add/Edit partner modal
- [x] Price list management per partner
- [x] Phone/email links

### Invoices

- [x] Invoice archive table
- [x] Payment status badges (Платена/Неплатена/Частично)
- [x] PDF download
- [x] Send email button
- [x] Unpaid total summary

### Payments

- [x] Payment history table
- [x] Record payment modal (select invoice, amount, method, date, reference)
- [x] Payment method badges
- [x] AI-matched badge for agent payments
- [x] Summary stats (received, pending, transactions)

### Analytics

- [x] Sales area chart by period (week/month/quarter/year)
- [x] Top products horizontal bar chart
- [x] Stock forecast with progress bars + depletion dates
- [x] Orders line chart

## Design

- Sidebar: #1a1a2e (dark navy)
- Accent: #6c3dff (purple)
- Content: white with gray-50 background
- Bulgarian UI text throughout
- Responsive (sidebar collapses to icon-only mode)

## API Proxy

Vite dev server proxies `/api/*` → `http://localhost:3000/*`

## Build

```
npm run dev    # Development server
npm run build  # Production build (✅ successful)
npm run preview # Preview production build
```

## Last Build

- ✅ TypeScript compilation: clean
- ✅ Vite build: successful
- Bundle: 816KB JS, 28KB CSS (gzipped: 246KB / 5.9KB)
