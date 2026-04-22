# Partner Order History Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a side drawer inside the New Order modal that lets operators browse a partner's past orders (items, prices, discounts) and quickly copy items into the current order, without leaving the form.

**Architecture:** Frontend-only feature. New React component `PartnerHistoryDrawer` built on `@radix-ui/react-dialog` (no shadcn `sheet` installed — we build a thin `Sheet` primitive). Reuses existing `GET /orders?partner_id=…` and `GET /orders/:id` endpoints. Uses `useInfiniteQuery` for pagination and `useQuery` per expanded order for lazy item loading. Integrates with `CreateOrderModal` in `src/pages/Orders.tsx` via a trigger button near the partner combobox and two callbacks (`onAddItem`, `onRepeatOrder`).

**Tech Stack:** React 18, TypeScript, Tailwind v4, `@tanstack/react-query`, `@radix-ui/react-dialog`, `lucide-react`. No backend or DB changes.

**Branch:** `feature/MERTM-partner-order-history` (stacked on top of `feature/MERTM-warranty-tracking`).

---

## Preflight: create branch

- [ ] **Step P1: Create and switch to feature branch**

```bash
cd /Users/magic/Projects/mert-m
git checkout -b feature/MERTM-partner-order-history
git branch --show-current
```

Expected: `feature/MERTM-partner-order-history`

---

## Task 1: Sheet primitive + history data types

**Files:**

- Create: `warehouse-frontend/src/components/ui/sheet.tsx`
- Create: `warehouse-frontend/src/components/PartnerHistoryDrawer.tsx` (stub only in this task)
- Modify: `warehouse-frontend/src/types/index.ts` (add helper types if needed)

### Why this task

shadcn's `sheet` isn't installed in this repo, only `dialog`. We build a minimal right-side `Sheet` using the same `@radix-ui/react-dialog` primitives to keep the dependency list unchanged and match the existing UI style.

- [ ] **Step 1.1: Create `Sheet` primitive**

Write `warehouse-frontend/src/components/ui/sheet.tsx`:

```tsx
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/25 backdrop-blur-[1px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName;

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    side?: "right" | "left";
  }
>(({ className, children, side = "right", ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={ref}
      onPointerDownOutside={(e) => e.preventDefault()}
      onInteractOutside={(e) => {
        const originalEvent = (e.detail as { originalEvent?: Event })
          ?.originalEvent;
        if (originalEvent && originalEvent.type !== "keydown") {
          e.preventDefault();
        }
      }}
      className={cn(
        "fixed top-0 z-50 flex h-full w-full sm:max-w-[520px] flex-col gap-0 bg-white shadow-xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out",
        side === "right"
          ? "right-0 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right"
          : "left-0 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className="absolute right-3 top-3 p-2 rounded-md opacity-70 hover:opacity-100 hover:bg-gray-100 transition-all"
        aria-label="Затвори"
      >
        <X className="h-4 w-4" />
        <span className="sr-only">Затвори</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = DialogPrimitive.Content.displayName;

const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("px-6 pt-6 pb-4 border-b border-gray-200", className)}
    {...props}
  />
);

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold text-gray-900", className)}
    {...props}
  />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-gray-500", className)}
    {...props}
  />
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
};
```

- [ ] **Step 1.2: Create drawer stub**

Write `warehouse-frontend/src/components/PartnerHistoryDrawer.tsx`:

```tsx
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

export interface PartnerHistoryItem {
  product_id: number;
  product_name: string;
  quantity: number;
  unit: string;
  unit_price: number;
  discount_percent: number;
  stock_now: number;
}

export interface PartnerHistoryDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partnerId: string;
  partnerName: string;
  currentProductIds: Set<number>;
  onAddItem: (item: PartnerHistoryItem) => void;
  onRepeatOrder: (items: PartnerHistoryItem[]) => void;
}

export function PartnerHistoryDrawer({
  open,
  onOpenChange,
  partnerName,
}: PartnerHistoryDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>История на партньора</SheetTitle>
          <SheetDescription>{partnerName}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-6 py-4 text-sm text-gray-500">
          Зареждане…
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 1.3: Type-check**

Run:

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend && npm run typecheck 2>&1 | tail -5
```

Expected: no errors (or at most pre-existing ones, not introduced by this task).

If `typecheck` script doesn't exist, use:

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend && npx tsc --noEmit 2>&1 | tail -5
```

- [ ] **Step 1.4: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/components/ui/sheet.tsx warehouse-frontend/src/components/PartnerHistoryDrawer.tsx
git commit -m "$(cat <<'EOF'
feat(ui): add Sheet primitive and PartnerHistoryDrawer stub

Sheet is a right-side drawer built on @radix-ui/react-dialog, matching
the style of the existing Dialog component. PartnerHistoryDrawer stub
exposes the public API (props, item shape) that later tasks fill in.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire trigger button into CreateOrderModal

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` (around line 1852 — `CreateOrderModal` function)

### Why this task

Ship the button and drawer mount early so we can visually verify placement before investing in the drawer's internals. The drawer still shows "Зареждане…" at this point — that's fine.

- [ ] **Step 2.1: Add history-drawer state to `CreateOrderModal`**

In `warehouse-frontend/src/pages/Orders.tsx`, find the `CreateOrderModal` function (starts near line 1852). Add state right after the existing `useState` calls (look for `const [confirmOverstock, setConfirmOverstock]` around line 1895):

```tsx
const [historyOpen, setHistoryOpen] = useState(false);
```

- [ ] **Step 2.2: Import the drawer and icon**

At the top of `warehouse-frontend/src/pages/Orders.tsx`, add to the imports (keep alphabetical order where present):

```tsx
import { PartnerHistoryDrawer } from "@/components/PartnerHistoryDrawer";
import type { PartnerHistoryItem } from "@/components/PartnerHistoryDrawer";
```

Also add `History` to the existing `lucide-react` import (find the line `import { ... } from "lucide-react";` used in this file and append `History`).

- [ ] **Step 2.3: Auto-close drawer when partner changes or customer mode switches**

After the existing `useEffect` for `customerMode` sync (around line 1948), add:

```tsx
useEffect(() => {
  setHistoryOpen(false);
}, [form.partner_id, customerMode]);
```

- [ ] **Step 2.4: Add trigger button next to the partner Combobox**

In `CreateOrderModal`, locate the Combobox rendering (around line 2277, inside the `customerMode === "individual" ? ... : (<Combobox ... />)` branch). Wrap the Combobox in a flex row with the new button. Replace:

```tsx
<Combobox
  inputRef={partnerInputRef}
  items={partners
    .filter((p) => (p as any).partner_type !== "individual")
    .map((p) => ({
      value: String(p.id),
      label: p.name,
      hint: p.microinvest_code
        ? `Код: ${p.microinvest_code}${p.eik ? ` · ЕИК: ${p.eik}` : ""}`
        : p.eik
          ? `ЕИК: ${p.eik}`
          : undefined,
    }))}
  value={form.partner_id}
  onChange={(val) =>
    setForm((f) => ({
      ...f,
      partner_id: val,
    }))
  }
  onClear={() =>
    setForm((f) => ({
      ...f,
      partner_id: "",
    }))
  }
  onPickEnter={() => queueMicrotask(() => focusAndSelect(dateInputRef.current))}
  placeholder="Избери или потърси по код, име или ЕИК..."
  emptyMessage="Няма намерени партньори."
/>
```

with:

```tsx
<div className="flex items-stretch gap-2">
  <div className="flex-1">
    <Combobox
      inputRef={partnerInputRef}
      items={partners
        .filter((p) => (p as any).partner_type !== "individual")
        .map((p) => ({
          value: String(p.id),
          label: p.name,
          hint: p.microinvest_code
            ? `Код: ${p.microinvest_code}${p.eik ? ` · ЕИК: ${p.eik}` : ""}`
            : p.eik
              ? `ЕИК: ${p.eik}`
              : undefined,
        }))}
      value={form.partner_id}
      onChange={(val) =>
        setForm((f) => ({
          ...f,
          partner_id: val,
        }))
      }
      onClear={() =>
        setForm((f) => ({
          ...f,
          partner_id: "",
        }))
      }
      onPickEnter={() =>
        queueMicrotask(() => focusAndSelect(dateInputRef.current))
      }
      placeholder="Избери или потърси по код, име или ЕИК..."
      emptyMessage="Няма намерени партньори."
    />
  </div>
  <button
    type="button"
    onClick={() => setHistoryOpen(true)}
    disabled={!form.partner_id}
    title={
      form.partner_id
        ? "Виж минали поръчки от този партньор"
        : "Избери партньор"
    }
    className="shrink-0 inline-flex items-center gap-1.5 px-3 rounded-md border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
  >
    <History className="h-4 w-4" />
    <span className="hidden sm:inline">История</span>
  </button>
</div>
```

- [ ] **Step 2.5: Mount the drawer at the end of the modal content**

Inside `CreateOrderModal`, locate the closing `</DialogContent>` tag (at the bottom of the modal's JSX). **Right before** the closing `</Dialog>`, add:

```tsx
{
  customerMode === "legal" && form.partner_id && (
    <PartnerHistoryDrawer
      open={historyOpen}
      onOpenChange={setHistoryOpen}
      partnerId={form.partner_id}
      partnerName={
        partners.find((p) => String(p.id) === form.partner_id)?.name ?? ""
      }
      currentProductIds={
        new Set(
          items
            .map((i) => Number(i.product_id))
            .filter((id) => Number.isFinite(id) && id > 0),
        )
      }
      onAddItem={() => {
        // placeholder — wired up in Task 5
      }}
      onRepeatOrder={() => {
        // placeholder — wired up in Task 5
      }}
    />
  );
}
```

- [ ] **Step 2.6: Visual verification in browser**

Run:

```bash
# The frontend dev server should already be running on :5174 (mertm-frontend).
# If not, start it via preview_start "frontend".
```

Using the `preview_*` tools (or Chrome if preferred), do the following:

1. Navigate to `http://localhost:5174/orders`
2. Click "+ Нова поръчка" — modal opens
3. Verify: `История` button is visible next to the partner combobox, greyed out (disabled)
4. Pick a partner — button becomes active
5. Click button — drawer slides in from the right showing "История на партньора" + partner name + "Зареждане…"
6. Click X or Escape — drawer closes
7. Switch to "Физическо лице" tab — button disappears

If any of these fail, fix before committing.

- [ ] **Step 2.7: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "$(cat <<'EOF'
feat(orders): add history button + drawer mount to new-order modal

Button appears next to the partner combobox (legal-partner mode only),
opens PartnerHistoryDrawer. Drawer still shows a placeholder body — the
next task loads real data.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Load and render partner order list (collapsed cards)

**Files:**

- Modify: `warehouse-frontend/src/components/PartnerHistoryDrawer.tsx`

### Why this task

Replace "Зареждане…" with real paginated data. Each past order becomes a collapsed card showing date, order number, total, status, and item count. Cancelled orders are filtered out.

- [ ] **Step 3.1: Rewrite the drawer to fetch and render the list**

Replace the entire contents of `warehouse-frontend/src/components/PartnerHistoryDrawer.tsx` with:

```tsx
import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertCircle, Package, PackageX, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { Order } from "@/types";
import { Spinner } from "@/components/ui/spinner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

export interface PartnerHistoryItem {
  product_id: number;
  product_name: string;
  quantity: number;
  unit: string;
  unit_price: number;
  discount_percent: number;
  stock_now: number;
}

export interface PartnerHistoryDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partnerId: string;
  partnerName: string;
  currentProductIds: Set<number>;
  onAddItem: (item: PartnerHistoryItem) => void;
  onRepeatOrder: (items: PartnerHistoryItem[]) => void;
}

const PAGE_SIZE = 20;

interface HistoryPage {
  data: Order[];
  pagination: { page: number; limit: number; total: number };
}

function formatBGN(value: number | string | null | undefined): string {
  const num =
    typeof value === "number" ? value : parseFloat(String(value ?? 0));
  if (!Number.isFinite(num)) return "0,00 €";
  return `${num.toLocaleString("bg-BG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("bg-BG", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Чакаща",
  confirmed: "Потвърдена",
  processing: "В обработка",
  fulfilled: "Изпълнена",
  invoiced: "Фактурирана",
  cancelled: "Анулирана",
};

const STATUS_COLOR: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  confirmed: "bg-blue-100 text-blue-800",
  processing: "bg-indigo-100 text-indigo-800",
  fulfilled: "bg-green-100 text-green-800",
  invoiced: "bg-purple-100 text-purple-800",
  cancelled: "bg-red-100 text-red-800",
};

export function PartnerHistoryDrawer({
  open,
  onOpenChange,
  partnerId,
  partnerName,
}: PartnerHistoryDrawerProps) {
  const numericPartnerId = Number(partnerId);
  const enabled =
    open && Number.isFinite(numericPartnerId) && numericPartnerId > 0;

  const {
    data,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<HistoryPage>({
    queryKey: ["partner-history", numericPartnerId],
    queryFn: async ({ pageParam = 1 }) => {
      const res = await api.get(
        `/orders?partner_id=${numericPartnerId}&page=${pageParam}&limit=${PAGE_SIZE}`,
      );
      return res.data as HistoryPage;
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const { page, limit, total } = lastPage.pagination;
      return page * limit < total ? page + 1 : undefined;
    },
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

  const orders = useMemo<Order[]>(() => {
    const all = data?.pages.flatMap((p) => p.data) ?? [];
    return all.filter((o) => o.status !== "cancelled");
  }, [data]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col p-0">
        <SheetHeader>
          <SheetTitle>История на партньора</SheetTitle>
          <SheetDescription>
            {partnerName || "—"}
            {orders.length > 0 && (
              <span className="block text-xs text-gray-400 mt-1">
                {orders.length} {orders.length === 1 ? "поръчка" : "поръчки"}{" "}
                заредени
              </span>
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {isLoading && (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-20 bg-gray-100 rounded-lg animate-pulse"
                />
              ))}
            </div>
          )}

          {isError && (
            <div className="flex flex-col items-center text-center py-8">
              <AlertCircle className="h-10 w-10 text-red-400 mb-2" />
              <p className="text-sm text-red-700 mb-3">
                Грешка при зареждане на историята.
              </p>
              <button
                type="button"
                onClick={() => refetch()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-300 text-sm hover:bg-gray-50"
              >
                <RefreshCw className="h-4 w-4" />
                Опитай пак
              </button>
            </div>
          )}

          {!isLoading && !isError && orders.length === 0 && (
            <div className="flex flex-col items-center text-center py-12 text-gray-500">
              <PackageX className="h-12 w-12 mb-3 text-gray-300" />
              <p className="text-sm">Няма минали поръчки от този партньор.</p>
            </div>
          )}

          {!isLoading &&
            !isError &&
            orders.map((o) => <OrderCard key={o.id} order={o} />)}

          {hasNextPage && (
            <button
              type="button"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="w-full py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-md border border-gray-200 disabled:opacity-50"
            >
              {isFetchingNextPage ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner size="sm" /> Зареждане…
                </span>
              ) : (
                "Зареди още"
              )}
            </button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function OrderCard({ order }: { order: Order }) {
  const statusLabel = STATUS_LABEL[order.status] ?? order.status;
  const statusColor = STATUS_COLOR[order.status] ?? "bg-gray-100 text-gray-700";
  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="px-4 py-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Package className="h-4 w-4 text-gray-400 shrink-0" />
            <span>
              #{order.order_number ?? order.id} · {formatDate(order.order_date)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs">
            <span className={`px-2 py-0.5 rounded-full ${statusColor}`}>
              {statusLabel}
            </span>
            <span className="text-gray-500">
              {order.item_count ?? 0}{" "}
              {(order.item_count ?? 0) === 1 ? "артикул" : "артикула"}
            </span>
          </div>
        </div>
        <div className="text-sm font-semibold text-gray-900 whitespace-nowrap">
          {formatBGN(order.total_amount)}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3.2: Visual verification**

1. Reload the preview page (`window.location.reload()` via preview_eval).
2. Open "+ Нова поръчка" → pick a partner that has past orders (e.g. `INT-TEST Partner`).
3. Click `История` — drawer should display a list of cards, newest first.
4. Each card: order number, date, status badge, item count, total.
5. Cancelled orders should NOT appear.
6. Pick a partner with zero orders → empty state "Няма минали поръчки от този партньор."
7. If the partner has more than 20 orders → `Зареди още` button appears at bottom.

Verify via `preview_snapshot` and/or `preview_screenshot`.

- [ ] **Step 3.3: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/components/PartnerHistoryDrawer.tsx
git commit -m "$(cat <<'EOF'
feat(orders): render partner order history list in drawer

Uses useInfiniteQuery against GET /orders?partner_id to page through
orders 20 at a time. Cards show order number, date, status, item count,
total. Cancelled orders are filtered client-side.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Expandable cards with item list and "+" buttons

**Files:**

- Modify: `warehouse-frontend/src/components/PartnerHistoryDrawer.tsx`

### Why this task

Click a card → it expands and fetches `/orders/:id` to show items with their prices and discounts. Each item has a `+` button that calls `onAddItem` with the product + pricing snapshot. Duplicate products (already in current order) show a disabled button with tooltip.

- [ ] **Step 4.1: Extend `PartnerHistoryItem` usage and add expanded-card logic**

In `warehouse-frontend/src/components/PartnerHistoryDrawer.tsx`:

a) Update the imports section at the top to add icons and the query hook:

```tsx
import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Package,
  PackageX,
  Plus,
  RefreshCw,
} from "lucide-react";
```

b) Below `formatDate` (but above the `STATUS_LABEL` constants), add:

```tsx
interface OrderDetailResponse {
  id: number;
  items: Array<{
    product_id: number;
    name_bg?: string;
    name_en?: string;
    unit?: string;
    quantity: number | string;
    unit_price: number | string;
    discount_percent?: number | string;
    total_stock?: number | string | null;
    product_is_deleted?: boolean;
  }>;
}

function parseNum(v: unknown): number {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}
```

c) Update the `PartnerHistoryDrawer` component so it passes `currentProductIds` and `onAddItem` to `OrderCard`:

Replace the `orders.map((o) => (<OrderCard key={o.id} order={o} />))` with:

```tsx
{
  !isLoading &&
    !isError &&
    orders.map((o) => (
      <OrderCard
        key={o.id}
        order={o}
        currentProductIds={currentProductIds}
        onAddItem={onAddItem}
        onRepeatOrder={onRepeatOrder}
      />
    ));
}
```

And update the destructuring at the top of `PartnerHistoryDrawer`:

```tsx
export function PartnerHistoryDrawer({
  open,
  onOpenChange,
  partnerId,
  partnerName,
  currentProductIds,
  onAddItem,
  onRepeatOrder,
}: PartnerHistoryDrawerProps) {
```

d) Replace the existing `OrderCard` function entirely with:

```tsx
function OrderCard({
  order,
  currentProductIds,
  onAddItem,
  onRepeatOrder,
}: {
  order: Order;
  currentProductIds: Set<number>;
  onAddItem: (item: PartnerHistoryItem) => void;
  onRepeatOrder: (items: PartnerHistoryItem[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const statusLabel = STATUS_LABEL[order.status] ?? order.status;
  const statusColor = STATUS_COLOR[order.status] ?? "bg-gray-100 text-gray-700";

  const {
    data: detail,
    isLoading: detailLoading,
    isError: detailError,
  } = useQuery<OrderDetailResponse>({
    queryKey: ["partner-history-detail", order.id],
    queryFn: async () => {
      const res = await api.get(`/orders/${order.id}`);
      const raw = res.data?.data ?? res.data;
      return raw as OrderDetailResponse;
    },
    enabled: expanded,
    staleTime: 2 * 60_000,
    gcTime: 10 * 60_000,
  });

  const items: PartnerHistoryItem[] = useMemo(() => {
    if (!detail) return [];
    return detail.items.map((it) => ({
      product_id: it.product_id,
      product_name: it.name_bg || it.name_en || `Продукт #${it.product_id}`,
      quantity: parseNum(it.quantity),
      unit: it.unit || "бр.",
      unit_price: parseNum(it.unit_price),
      discount_percent: parseNum(it.discount_percent),
      stock_now: parseNum(it.total_stock),
    }));
  }, [detail]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-3 flex items-start justify-between gap-3 text-left hover:bg-gray-50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Package className="h-4 w-4 text-gray-400 shrink-0" />
            <span>
              #{order.order_number ?? order.id} · {formatDate(order.order_date)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs">
            <span className={`px-2 py-0.5 rounded-full ${statusColor}`}>
              {statusLabel}
            </span>
            <span className="text-gray-500">
              {order.item_count ?? 0}{" "}
              {(order.item_count ?? 0) === 1 ? "артикул" : "артикула"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900 whitespace-nowrap">
            {formatBGN(order.total_amount)}
          </span>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-200 px-4 py-3 space-y-2">
          {detailLoading && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Spinner size="sm" />
              Зареждане на артикули…
            </div>
          )}

          {detailError && (
            <div className="text-xs text-red-700">
              Грешка при зареждане на артикулите.
            </div>
          )}

          {!detailLoading && !detailError && items.length === 0 && (
            <div className="text-xs text-gray-500">Няма артикули.</div>
          )}

          {!detailLoading && !detailError && items.length > 0 && (
            <>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRepeatOrder(items);
                  }}
                  className="text-xs px-2.5 py-1 rounded-md border border-gray-300 hover:bg-gray-50"
                >
                  Повтори цялата поръчка
                </button>
              </div>
              <ul className="space-y-2">
                {items.map((it) => {
                  const already = currentProductIds.has(it.product_id);
                  const outOfStock = it.stock_now <= 0;
                  const disabled = already || outOfStock;
                  const disabledReason = already
                    ? "Вече в поръчката"
                    : outOfStock
                      ? "Няма наличност"
                      : "";
                  return (
                    <li
                      key={it.product_id}
                      className="flex items-start gap-2 text-sm"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-900 truncate">
                          {it.product_name}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {it.quantity} {it.unit} × {formatBGN(it.unit_price)}
                          {it.discount_percent > 0 && (
                            <>
                              {" "}
                              · отст.{" "}
                              {it.discount_percent.toFixed(
                                it.discount_percent % 1 === 0 ? 0 : 2,
                              )}
                              %
                            </>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!disabled) onAddItem(it);
                        }}
                        disabled={disabled}
                        title={disabledReason || "Добави в поръчката"}
                        className="shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4.2: Visual verification**

Reload the preview page and:

1. Open new-order modal, pick a partner, open history drawer.
2. Click a card — it expands, shows a spinner, then item list.
3. Item row shows `name · quantity unit × price · отст. X%`.
4. `+` button is a 28×28 icon button on the right.
5. Click chevron/card again — collapses.

Don't wire onAddItem behavior yet — we'll do that in Task 5. For now, clicking `+` should be a no-op (because Orders.tsx still has `() => {}` placeholders).

- [ ] **Step 4.3: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/components/PartnerHistoryDrawer.tsx
git commit -m "$(cat <<'EOF'
feat(orders): expandable cards with item list and "+" buttons

Click a card → lazy-loads /orders/:id and shows items with price and
discount. Each item has a [+] to copy into current order, disabled when
the product is already added or out of stock.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire `onAddItem`, `onRepeatOrder`, and invalidation

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx`

### Why this task

Connect the drawer's callbacks to `CreateOrderModal`'s `setItems`. Make "+" add a single row (quantity=1) with the historic unit_price and discount_percent. Make "Повтори цялата поръчка" iterate and report skipped items via toast. Add `["partner-history"]` to the `invalidateAllOrderRelated` helper so new orders show up in future drawer openings.

- [ ] **Step 5.1: Find and export the stock lookup helper path**

The add flow needs the current stock for the added product (to populate `OrderItemRow.stock`). The `products-for-order` endpoint returns products with stock; the drawer's item already has `stock_now` from `/orders/:id`, so we can use that directly and skip a round-trip.

No code change here — just confirms we use `it.stock_now` as the initial stock for the new row.

- [ ] **Step 5.2: Add `addHistoryItems` helper inside `CreateOrderModal`**

In `warehouse-frontend/src/pages/Orders.tsx`, inside `CreateOrderModal`, directly above the existing `const addItem = () => setItems((i) => [...i, emptyItem()]);` line (near line 2058), add:

```tsx
const addHistoryItems = useCallback(
  (newItems: PartnerHistoryItem[]) => {
    if (newItems.length === 0) return;
    const existingIds = new Set(
      items
        .map((i) => Number(i.product_id))
        .filter((id) => Number.isFinite(id) && id > 0),
    );
    const toAdd = newItems.filter((ni) => !existingIds.has(ni.product_id));
    const skippedAsDupes = newItems.length - toAdd.length;
    const skippedOutOfStock = toAdd.filter((ni) => ni.stock_now <= 0).length;
    const adding = toAdd.filter((ni) => ni.stock_now > 0);

    if (adding.length > 0) {
      setItems((prev) => {
        const base = prev.filter(
          (row) => row.product_id !== "" || Number(row.quantity) > 0,
        );
        const newRows = adding.map((ni) =>
          makeOrderItemRow({
            product_id: String(ni.product_id),
            product_name: ni.product_name,
            quantity: "1",
            unit_price: String(ni.unit_price),
            discount_percent: String(ni.discount_percent),
            unit: ni.unit,
            stock: ni.stock_now,
          }),
        );
        const combined = [...base, ...newRows];
        return combined.length > 0 ? combined : [emptyItem()];
      });
    }

    const parts: string[] = [];
    if (adding.length > 0)
      parts.push(
        `Добавени ${adding.length} ${adding.length === 1 ? "артикул" : "артикула"}`,
      );
    if (skippedAsDupes > 0)
      parts.push(`пропуснати ${skippedAsDupes} (вече в поръчката)`);
    if (skippedOutOfStock > 0)
      parts.push(`пропуснати ${skippedOutOfStock} (няма наличност)`);

    if (parts.length > 0) {
      toast({
        title: parts.join(" · "),
      });
    }
  },
  [items],
);
```

- [ ] **Step 5.3: Import `useCallback`, `toast`, `makeOrderItemRow`**

At the top of `warehouse-frontend/src/pages/Orders.tsx`:

1. Ensure `useCallback` is in the React import (it's likely already there; check the `import { ... } from "react";` line).
2. Find or add the `toast` helper. Check if the project already has one:

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend && grep -rn "export.*toast\b\|useToast" src/ | head -5
```

Expected: if a `toast` helper exists (e.g. `src/components/ui/toast.tsx` or `src/hooks/use-toast.ts`), import it. If NOT found, fall back to the existing notification mechanism used elsewhere in `Orders.tsx`:

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend && grep -n "alert\|notify\|toast" src/pages/Orders.tsx | head -20
```

**Fallback plan if no toast helper exists:** replace the `toast({ title: … })` call in Step 5.2 with:

```tsx
setErrorMsg(parts.join(" · "));
setTimeout(() => setErrorMsg(""), 4000);
```

This piggybacks on the `errorMsg` state the modal already has and clears after 4s. The message isn't technically an error but is surfaced in the same spot — acceptable for this small feature.

3. `makeOrderItemRow` is already defined at the top of the file (line 139). No import needed.

- [ ] **Step 5.4: Replace the drawer placeholder handlers**

Find the `<PartnerHistoryDrawer … />` block added in Task 2.5 (in `CreateOrderModal`, near the bottom of the modal JSX). Replace the two placeholder arrow functions with real handlers:

```tsx
{
  customerMode === "legal" && form.partner_id && (
    <PartnerHistoryDrawer
      open={historyOpen}
      onOpenChange={setHistoryOpen}
      partnerId={form.partner_id}
      partnerName={
        partners.find((p) => String(p.id) === form.partner_id)?.name ?? ""
      }
      currentProductIds={
        new Set(
          items
            .map((i) => Number(i.product_id))
            .filter((id) => Number.isFinite(id) && id > 0),
        )
      }
      onAddItem={(hi) => addHistoryItems([hi])}
      onRepeatOrder={(his) => addHistoryItems(his)}
    />
  );
}
```

- [ ] **Step 5.5: Extend `invalidateAllOrderRelated` with the new cache key**

In `warehouse-frontend/src/pages/Orders.tsx`, find `invalidateAllOrderRelated` (around line 486). Add one more line to it:

```tsx
const invalidateAllOrderRelated = () => {
  qc.invalidateQueries({ queryKey: ["orders"] });
  qc.invalidateQueries({ queryKey: ["order-detail"] });
  qc.invalidateQueries({ queryKey: ["invoices"] });
  qc.invalidateQueries({ queryKey: ["unpaid-invoices"] });
  qc.invalidateQueries({ queryKey: ["inventory"] });
  qc.invalidateQueries({ queryKey: ["products"] });
  qc.invalidateQueries({ queryKey: ["partner-history"] });
};
```

This helper lives in the `Orders` page component (parent of `CreateOrderModal`). The modal's submit mutation already calls `onCreated` which triggers refetch of `["orders"]`. But since the drawer is its own query tree, inside `CreateOrderModal` we also need to invalidate on successful submit.

- [ ] **Step 5.6: Invalidate partner-history after a successful create in the modal**

Find `CreateOrderModal`'s submit mutation (search for `mutationFn.*POST\|/orders.*post\|api\.post.*orders` inside the `CreateOrderModal` block between lines 1852 and ~2220). The relevant mutation has an `onSuccess` that already calls `onCreated(...)` and resets items. Add one line:

```tsx
onSuccess: (res) => {
  // ... existing lines (clear form, call onCreated, etc.)
  qc.invalidateQueries({ queryKey: ["partner-history"] });
};
```

The exact insertion point: after the existing `qc.invalidateQueries(...)` call(s) inside the modal's onSuccess (there's at least one for `["orders"]`). If that call doesn't exist, add the `["partner-history"]` line alongside whatever cleanup the onSuccess does.

**Note for implementer:** if the modal already pipes through the parent's `invalidateAllOrderRelated` (via `onCreated` + Orders page propagation), the Step 5.5 change is enough and Step 5.6 is a no-op. Inspect the code and skip Step 5.6 if redundant. Do NOT add duplicate invalidations.

- [ ] **Step 5.7: Visual verification**

1. Reload preview.
2. Open new-order modal, pick partner with history, open drawer, expand an order.
3. Click `+` on a product → modal's items table should gain a new row with that product (qty=1, price + discount copied). Drawer stays open.
4. Click `+` on the same product again → button is disabled; the current-order items don't duplicate.
5. Click `Повтори цялата поръчка` on a different card → all items added; a toast/banner reports "Добавени N артикула".
6. Verify: items with 0 stock are skipped and reported.
7. Create the order (submit the form). Reopen the new-order modal, pick the same partner, open history — the brand-new order appears on top of the list.

- [ ] **Step 5.8: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "$(cat <<'EOF'
feat(orders): wire partner history drawer add/repeat + invalidation

"+" on a history item copies product + price + discount into the new
order (quantity=1). "Повтори цялата" adds all eligible items with a
summary toast for duplicates/out-of-stock. partner-history cache is
invalidated alongside other order-related queries on any mutation.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Final E2E smoke + handoff

- [ ] **Step 6.1: Run full E2E smoke (manual, via preview browser)**

Walk through every case below. If any fail, fix before declaring done. For each, capture either a `preview_snapshot` or a `preview_screenshot` confirming the outcome.

1. **Trigger visibility:** In the new-order modal, button is disabled when no partner is picked; enabled after pick; hidden in "Физическо лице" mode.
2. **Drawer open/close:** Open via button; close via X or Escape.
3. **Empty state:** Pick a partner with zero orders — drawer shows empty-state illustration.
4. **List:** Pick partner with orders — collapsed cards render, sorted newest first, cancelled excluded.
5. **Pagination:** If >20 orders, "Зареди още" loads next page appended.
6. **Expand:** Click a card — items load lazily.
7. **"+" behavior:** Adds a row with correct price + discount; disabled on duplicate (`Вече в поръчката`) and zero stock (`Няма наличност`).
8. **"Повтори":** Adds all eligible items; toast reports adds + skips.
9. **Drawer persistence:** After adding items, drawer stays open for further picks.
10. **Partner change resets drawer:** Change the partner in the combobox — drawer auto-closes.
11. **Mode change resets drawer:** Switch to "Физическо лице" — drawer closes, button disappears.
12. **Post-submit invalidation:** Create an order, reopen modal + drawer for same partner — the new order is at the top.
13. **Error state:** Stop backend (`lsof -ti:3003 | xargs kill -9`), open drawer — error banner with retry. Restart backend (`cd warehouse-backend && npm run dev > /tmp/mertm-backend.log 2>&1 &`), click retry — list loads.

- [ ] **Step 6.2: Run existing test suite to confirm no regressions**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend && npm test 2>&1 | tail -20
```

Expected: same pass/fail ratio as before this feature. Two tests in `payments-razpiska.test.ts` were already failing pre-feature — those do not count as regressions.

- [ ] **Step 6.3: Typecheck**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend && npx tsc --noEmit 2>&1 | tail -10
```

Expected: no new errors.

- [ ] **Step 6.4: Hand off via finishing-a-development-branch skill**

Use the `superpowers:finishing-a-development-branch` skill to present merge/push options to the user.

---

## File Structure Summary

| File                                                         | Role                                                                                                | New/Modified |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------ |
| `warehouse-frontend/src/components/ui/sheet.tsx`             | Side-drawer primitive (Radix Dialog wrapper)                                                        | New          |
| `warehouse-frontend/src/components/PartnerHistoryDrawer.tsx` | Drawer UI: list, cards, item rows, "+"/"Повтори"                                                    | New          |
| `warehouse-frontend/src/pages/Orders.tsx`                    | Trigger button, state, handlers, invalidation in `CreateOrderModal` and `invalidateAllOrderRelated` | Modified     |

No backend files change.
