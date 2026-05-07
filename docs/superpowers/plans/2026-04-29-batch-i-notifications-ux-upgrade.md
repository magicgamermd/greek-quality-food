# Batch I — Notifications UX upgrade Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Modernize notifications across the app — systematic toasts via sonner, 30s TanStack Query polling, an improved bell-dropdown center with groups + read indicators + mark-all, and a unified feed that combines computed alerts (low stock, expiring) with persistent DB events (`pending_order_ready`, `order_*`).

**Architecture:** No new table — `notification_reads (user_id UUID, notification_id VARCHAR, read_at, dismissed)` already exists. The GET /notifications endpoint is rewritten to merge two feeds: (1) currently computed (low_stock, expiring) and (2) the persistent `notifications` table. Both share a unified shape `{id: string, type, message, payload, created_at, is_read, read_at}`. Persistent IDs are prefixed `db-{n.id}` to avoid collision with computed `low-X` / `exp-X`. Frontend Layout.tsx bell dropdown rewritten with groupings + read indicators + mark-all. A `useNotificationsPolling` hook adds `refetchInterval: 30000` and toasts new items whose type is in a small `TOAST_WORTHY_TYPES` allowlist. Mutations app-wide gain `onSuccess`/`onError` toast hooks.

**Tech Stack:** PostgreSQL 16, Fastify+TypeScript, sonner toast library (already mounted), TanStack Query, React.

**Spec:** [docs/superpowers/specs/2026-04-29-batch-i-notifications-ux-upgrade-design.md](../specs/2026-04-29-batch-i-notifications-ux-upgrade-design.md)

---

## Pre-flight

- Branch from `main`: `git checkout main && git pull && git checkout -b feature/MERTM-batch-i-notifications-ux`
- Backend tests: `cd warehouse-backend && npx vitest run`
- Type-check: `cd warehouse-backend && npx tsc --noEmit` (and same in `warehouse-frontend/`)
- Verify schemas:
  ```bash
  docker exec mertm-postgres-1 psql -U warehouse -d mertm_warehouse -tAc \
    "SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name IN ('notifications','notification_reads') ORDER BY table_name, ordinal_position"
  ```

---

## Task 1: Drop legacy `notifications.read` column

**Files:**

- Create: `warehouse-backend/migrations/067_drop_notifications_read_column.sql`

**Step 1: Migration**

```sql
-- 067_drop_notifications_read_column.sql
-- Per-user read state lives in notification_reads (user_id,
-- notification_id, read_at). The global notifications.read boolean is
-- vestigial — drop it. Anything currently using it falls back to
-- notification_reads.read_at IS NOT NULL.

BEGIN;

ALTER TABLE notifications DROP COLUMN IF EXISTS read;

COMMIT;
```

**Step 2: Apply + register**

```bash
docker exec -i mertm-postgres-1 psql -U warehouse -d mertm_warehouse \
  -v ON_ERROR_STOP=1 --single-transaction \
  < warehouse-backend/migrations/067_drop_notifications_read_column.sql

docker exec mertm-postgres-1 psql -U warehouse -d mertm_warehouse -tAc \
  "INSERT INTO _migrations (name) VALUES ('067_drop_notifications_read_column.sql') ON CONFLICT DO NOTHING"
```

**Step 3: Verify**

```bash
docker exec mertm-postgres-1 psql -U warehouse -d mertm_warehouse -tAc \
  "SELECT column_name FROM information_schema.columns
   WHERE table_name='notifications' AND column_name='read'"
```

Expected: empty (column gone).

**Step 4: Commit**

```bash
git add warehouse-backend/migrations/067_drop_notifications_read_column.sql
git commit -m "feat(db): drop vestigial notifications.read global column (067)"
```

---

## Task 2: Backend — unified GET /notifications feed

**Files:**

- Modify: `warehouse-backend/src/routes/notifications.ts:8-79` (GET handler)

**Step 1: Replace handler — merge computed + persistent**

```ts
app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
  await requireAuth(request, reply);
  const user = (request as any).user;
  const userId = user.sub || user.id;

  const notifications: any[] = [];

  // ─── Computed: Low stock alerts ───
  const { rows: lowStock } = await query(`
    SELECT p.id, p.name_bg, p.sku, COALESCE(SUM(i.quantity),0)::numeric AS qty, p.low_stock_threshold
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.id
    WHERE EXISTS (SELECT 1 FROM batches pb WHERE pb.product_id = p.id)
       OR EXISTS (SELECT 1 FROM inventory i2 WHERE i2.product_id = p.id AND i2.quantity <> 0)
    GROUP BY p.id, p.name_bg, p.sku, p.low_stock_threshold
    HAVING COALESCE(SUM(i.quantity),0) <= p.low_stock_threshold
    ORDER BY qty ASC LIMIT 20
  `);
  for (const r of lowStock) {
    notifications.push({
      id: `low-${r.id}`,
      type: "low_stock",
      message: `${r.name_bg} — само ${parseFloat(r.qty)} бр`,
      severity: "warning",
      payload: { product_id: r.id, sku: r.sku },
      created_at: new Date().toISOString(),
    });
  }

  // ─── Computed: Expiring batches (legacy — MERT-M has no batches but keep) ───
  const { rows: expiring } = await query(`
    SELECT b.id, b.expiry_date, p.name_bg, (b.expiry_date - CURRENT_DATE) AS days_left
    FROM batches b
    JOIN products p ON p.id = b.product_id
    JOIN inventory i ON i.batch_id = b.id
    WHERE b.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
      AND i.quantity > 0
    ORDER BY b.expiry_date ASC LIMIT 10
  `);
  for (const r of expiring) {
    notifications.push({
      id: `exp-${r.id}`,
      type: "expiring",
      message: `${r.name_bg} — изтича след ${r.days_left} дни`,
      severity: r.days_left <= 7 ? "critical" : "warning",
      payload: { batch_id: r.id },
      created_at: new Date().toISOString(),
    });
  }

  // ─── Persistent: rows from the notifications table ───
  // Last 50 — newest first.
  const { rows: persistent } = await query(`
    SELECT id, type, message, payload, created_at
      FROM notifications
     ORDER BY created_at DESC
     LIMIT 50
  `);
  for (const r of persistent) {
    notifications.push({
      id: `db-${r.id}`,
      type: r.type,
      message: r.message,
      severity: "info",
      payload: r.payload,
      created_at:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : r.created_at,
    });
  }

  // ─── Per-user read/dismissed status ───
  const { rows: reads } = await query(
    `SELECT notification_id, dismissed, read_at
       FROM notification_reads WHERE user_id = $1`,
    [userId],
  );
  const readMap = new Map(reads.map((r: any) => [r.notification_id, r]));

  const result = notifications
    .filter((n) => !readMap.get(n.id)?.dismissed)
    .map((n) => {
      const entry = readMap.get(n.id);
      return {
        ...n,
        is_read: !!entry?.read_at,
        read_at: entry?.read_at ?? null,
      };
    })
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  return { data: result, count: result.length };
});
```

**Step 2: Type-check + commit**

```bash
cd warehouse-backend && npx tsc --noEmit
git add warehouse-backend/src/routes/notifications.ts
git commit -m "feat(notifications): unified feed (computed + persistent) with per-user read"
```

---

## Task 3: Backend — `GET /notifications/unread-count` endpoint

**Files:**

- Modify: `warehouse-backend/src/routes/notifications.ts` — add new endpoint

**Step 1: Add the endpoint**

```ts
// GET /notifications/unread-count — fast path for the bell badge
app.get("/unread-count", async (request, reply) => {
  await requireAuth(request, reply);
  const user = (request as any).user;
  const userId = user.sub || user.id;

  // Reuse the GET handler logic by invoking the underlying queries
  // would couple too much; instead, count distinct unread items
  // across both feeds at the SQL level when possible.
  // Computed feeds (low_stock, expiring) are dynamic — count in JS
  // after re-running the cheap aggregations.

  const { rows: lowStock } = await query(`
    SELECT p.id FROM products p
     LEFT JOIN inventory i ON i.product_id = p.id
     GROUP BY p.id, p.low_stock_threshold
    HAVING COALESCE(SUM(i.quantity),0) <= p.low_stock_threshold
     LIMIT 100
  `);
  const { rows: expiring } = await query(`
    SELECT b.id FROM batches b
     JOIN inventory i ON i.batch_id = b.id
    WHERE b.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
      AND i.quantity > 0
     LIMIT 100
  `);
  const { rows: persistent } = await query(`
    SELECT id FROM notifications ORDER BY created_at DESC LIMIT 50
  `);

  const allIds = [
    ...lowStock.map((r: any) => `low-${r.id}`),
    ...expiring.map((r: any) => `exp-${r.id}`),
    ...persistent.map((r: any) => `db-${r.id}`),
  ];

  if (allIds.length === 0) return { count: 0 };

  const { rows: reads } = await query(
    `SELECT notification_id, dismissed, read_at
       FROM notification_reads
      WHERE user_id = $1 AND notification_id = ANY($2::text[])`,
    [userId, allIds],
  );
  const readMap = new Map(reads.map((r: any) => [r.notification_id, r]));

  let count = 0;
  for (const id of allIds) {
    const entry = readMap.get(id);
    if (!entry?.dismissed && !entry?.read_at) count++;
  }
  return { count };
});
```

**Step 2: Commit**

```bash
git add warehouse-backend/src/routes/notifications.ts
git commit -m "feat(notifications): GET /unread-count for bell badge"
```

---

## Task 4: Backend integration tests — per-user read isolation

**Files:**

- Create: `warehouse-backend/src/__tests__/notifications-per-user-read.test.ts`

**Step 1: Test skeleton**

```ts
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn() }));

import { query } from "../db.js";
import notificationRoutes from "../routes/notifications.js";

const mockQuery = vi.mocked(query);

async function buildApp(userId: string) {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: userId, sub: userId };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(notificationRoutes, { prefix: "/notifications" });
  return app;
}

describe("GET /notifications — per-user read state", () => {
  beforeEach(() => mockQuery.mockReset());

  it("user A's read state does not affect user B's view", async () => {
    // 1st query: low_stock — empty
    // 2nd query: expiring — empty
    // 3rd query: persistent — 1 row (id 5)
    // 4th query (for user A): notification_reads — db-5 read_at=NOW
    mockQuery
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 5,
            type: "pending_order_ready",
            message: "X",
            payload: {},
            created_at: new Date(),
          },
        ],
      } as any)
      .mockResolvedValueOnce({
        rows: [
          { notification_id: "db-5", dismissed: false, read_at: new Date() },
        ],
      } as any);

    const appA = await buildApp("user-A");
    const resA = await appA.inject({ method: "GET", url: "/notifications" });
    expect(JSON.parse(resA.body).data[0].is_read).toBe(true);
    await appA.close();

    // Same setup but user B has no read row
    mockQuery
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 5,
            type: "pending_order_ready",
            message: "X",
            payload: {},
            created_at: new Date(),
          },
        ],
      } as any)
      .mockResolvedValueOnce({ rows: [] } as any); // user B has no reads

    const appB = await buildApp("user-B");
    const resB = await appB.inject({ method: "GET", url: "/notifications" });
    expect(JSON.parse(resB.body).data[0].is_read).toBe(false);
    await appB.close();
  });

  it("PUT /:id/read inserts a row for the calling user only", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);
    const app = await buildApp("user-A");
    await app.inject({ method: "PUT", url: "/notifications/db-5/read" });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO notification_reads"),
      expect.arrayContaining(["user-A", "db-5"]),
    );
    await app.close();
  });

  it("DELETE /:id sets dismissed=true for the user (no other user affected)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);
    const app = await buildApp("user-A");
    await app.inject({ method: "DELETE", url: "/notifications/db-5" });
    expect(mockQuery.mock.calls[0][0]).toContain("dismissed");
    await app.close();
  });
});
```

**Step 2: Run + commit**

```bash
cd warehouse-backend && npx vitest run src/__tests__/notifications-per-user-read.test.ts
git add warehouse-backend/src/__tests__/notifications-per-user-read.test.ts
git commit -m "test(notifications): per-user read isolation between users"
```

---

## Task 5: Frontend — shared notification types constant

**Files:**

- Create: `warehouse-frontend/src/lib/notificationTypes.ts`

**Step 1: Constants**

```ts
// Types eligible for a toast when arriving via polling.
// Keep the list small to avoid spam; extend deliberately for new
// critical events.
export const TOAST_WORTHY_TYPES = ["pending_order_ready"] as const;

export type ToastWorthyType = (typeof TOAST_WORTHY_TYPES)[number];

// UI grouping in the bell dropdown. Unmapped types fall under "Общи".
export const NOTIFICATION_GROUPS: Record<string, string> = {
  // Поръчки
  order_created: "Поръчки",
  order_updated: "Поръчки",
  order_fulfilled: "Поръчки",
  pending_order_ready: "Поръчки",
  // Склад
  low_stock: "Склад",
  expiring: "Склад",
  stock_in: "Склад",
  // Общи – fallback (no entry needed)
};

export function groupForType(type: string): string {
  return NOTIFICATION_GROUPS[type] ?? "Общи";
}

export function isToastWorthy(type: string): boolean {
  return (TOAST_WORTHY_TYPES as readonly string[]).includes(type);
}
```

**Step 2: Commit**

```bash
git add warehouse-frontend/src/lib/notificationTypes.ts
git commit -m "feat(fe): notificationTypes — TOAST_WORTHY + grouping helpers"
```

---

## Task 6: Frontend — useNotificationsPolling hook

**Files:**

- Create: `warehouse-frontend/src/hooks/useNotificationsPolling.ts`

**Step 1: Hook with toast-on-new-arrival**

```ts
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { isToastWorthy } from "@/lib/notificationTypes";

export interface NotificationItem {
  id: string;
  type: string;
  message: string;
  severity?: "info" | "warning" | "critical";
  payload?: any;
  created_at: string;
  is_read: boolean;
  read_at: string | null;
}

interface NotificationsResponse {
  data: NotificationItem[];
  count: number;
}

export function useNotificationsPolling(
  opts: { onClickPayload?: (payload: any, type: string) => void } = {},
) {
  const seenIds = useRef<Set<string>>(new Set());
  const isFirstRun = useRef(true);

  const query = useQuery<NotificationsResponse>({
    queryKey: ["notifications"],
    queryFn: () => api.get("/notifications").then((r) => r.data),
    refetchInterval: 30000,
    staleTime: 0,
  });

  useEffect(() => {
    const items = query.data?.data ?? [];
    if (items.length === 0) {
      isFirstRun.current = false;
      return;
    }

    if (isFirstRun.current) {
      // Prime the set without toasting on initial mount
      for (const n of items) seenIds.current.add(n.id);
      isFirstRun.current = false;
      return;
    }

    for (const n of items) {
      if (seenIds.current.has(n.id)) continue;
      seenIds.current.add(n.id);
      if (n.is_read) continue;
      if (!isToastWorthy(n.type)) continue;
      toast.success(n.message, {
        action: opts.onClickPayload
          ? {
              label: "Виж",
              onClick: () => opts.onClickPayload!(n.payload, n.type),
            }
          : undefined,
      });
    }
  }, [query.data, opts.onClickPayload]);

  return query;
}
```

**Step 2: Commit**

```bash
git add warehouse-frontend/src/hooks/useNotificationsPolling.ts
git commit -m "feat(fe): useNotificationsPolling — 30s interval + toast on new"
```

---

## Task 7: Frontend — rewrite Layout.tsx bell dropdown

**Files:**

- Modify: `warehouse-frontend/src/components/Layout.tsx:170-360` (notifications query + Bell rendering)

**Step 1: Replace the existing notifications useQuery with the new hook**

Find around `:175-185`:

```ts
const { data: notifications = [], isLoading } = useQuery({
  queryKey: ["notifications"],
  queryFn: () => api.get("/notifications").then((r) => r.data),
});
```

Replace with:

```ts
import {
  useNotificationsPolling,
  type NotificationItem,
} from "@/hooks/useNotificationsPolling";
import { groupForType } from "@/lib/notificationTypes";
import { useNavigate } from "react-router-dom";

const navigate = useNavigate();

const navigateFromPayload = (payload: any, type: string) => {
  // Route to the appropriate page based on payload contents.
  if (payload?.order_id) {
    navigate(`/orders?highlight=${payload.order_id}`);
  } else if (payload?.product_id) {
    navigate(`/products?highlight=${payload.product_id}`);
  }
};

const { data: notificationsResp } = useNotificationsPolling({
  onClickPayload: navigateFromPayload,
});
const notifications: NotificationItem[] = notificationsResp?.data ?? [];
const unreadCount = notifications.filter((n) => !n.is_read).length;
```

**Step 2: Update the markRead / markAllRead / dismiss mutations to match new API shape**

Around `:195-215`:

```ts
const markReadMutation = useMutation({
  mutationFn: (id: string) => api.put(`/notifications/${id}/read`),
  onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
});

const markAllReadMutation = useMutation({
  mutationFn: () =>
    api.post("/notifications/read-all", {
      ids: notifications.filter((n) => !n.is_read).map((n) => n.id),
    }),
  onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
});

const dismissMutation = useMutation({
  mutationFn: (id: string) => api.delete(`/notifications/${id}`),
  onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
});
```

**Step 3: Group notifications and rewrite the bell dropdown JSX**

Find the `<Bell className="h-5 w-5" />` block (around `:340-450`) and replace its dropdown content. Use a `useMemo` to group:

```ts
const grouped = useMemo(() => {
  const out: Record<string, NotificationItem[]> = {};
  for (const n of notifications) {
    const g = groupForType(n.type);
    (out[g] ??= []).push(n);
  }
  return out;
}, [notifications]);
```

Replace the dropdown body:

```tsx
<DropdownMenuContent align="end" className="w-96 p-0">
  <div className="flex items-center justify-between p-3 border-b">
    <span className="font-semibold">Известия</span>
    {unreadCount > 0 && (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => markAllReadMutation.mutate()}
        disabled={markAllReadMutation.isPending}
      >
        Маркирай всички
      </Button>
    )}
  </div>
  <div className="max-h-96 overflow-y-auto">
    {notifications.length === 0 && (
      <div className="p-6 text-center text-sm text-gray-400">
        Нямаш нови известия
      </div>
    )}
    {Object.entries(grouped).map(([group, items]) => (
      <div key={group}>
        <div className="px-3 py-1 text-xs font-semibold text-gray-500 bg-gray-50 sticky top-0">
          {group}
        </div>
        {items.map((n) => (
          <button
            key={n.id}
            onClick={() => {
              if (!n.is_read) markReadMutation.mutate(n.id);
              navigateFromPayload(n.payload, n.type);
            }}
            className={`w-full text-left px-3 py-2 hover:bg-gray-50 border-b last:border-b-0 ${
              n.is_read ? "opacity-60" : ""
            }`}
          >
            <div className="flex items-start gap-2">
              <span className="mt-1 text-xs">{n.is_read ? "✓" : "•"}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm">{n.message}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {new Date(n.created_at).toLocaleString("bg-BG")}
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>
    ))}
  </div>
</DropdownMenuContent>
```

**Step 4: Type-check + manual smoke test**

```bash
cd warehouse-frontend && npx tsc --noEmit
```

Manual: open the app → bell icon appears with correct unread count → click → grouped list with read indicators → click an item → navigate + read state updated → bell badge decrements.

**Step 5: Commit**

```bash
git add warehouse-frontend/src/components/Layout.tsx
git commit -m "feat(fe): improved bell dropdown — groups, read indicators, mark-all"
```

---

## Task 8: Frontend — systematic action toasts in mutations

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx`, `Invoices.tsx`, `Payments.tsx`, `Partners.tsx`, `Products.tsx`, `Settings.tsx`

**Step 1: Audit each file**

For every `useMutation` that's currently silent on success/error (no `toast` call), add minimal feedback. Pattern:

```ts
const someMutation = useMutation({
  mutationFn: …,
  onSuccess: () => {
    qc.invalidateQueries({ … });
    toast.success("Действието е успешно");      // ← ADD if missing
  },
  onError: (err: any) => {
    toast.error(err?.response?.data?.message ?? "Грешка");   // ← ADD if missing
  },
});
```

Use Bulgarian, contextual messages (e.g. "Поръчка създадена", "Фактурата е генерирана", "Плащането е записано").

**Step 2: Bulk grep + identify missing toasts**

```bash
cd warehouse-frontend
grep -rn "useMutation" src/pages | grep -v "test"
```

Open each file, scan each mutation; if no `toast.*` call inside `onSuccess`/`onError`, add one. Skip mutations that already have toast — don't double-up.

**Step 3: Commit (single commit, scoped per file or one big sweep)**

```bash
git add warehouse-frontend/src/pages/
git commit -m "feat(fe): systematic action toasts on all mutations"
```

(Optional: split per page file if you prefer smaller commits.)

---

## Task 9: Manual end-to-end verification

Run `./scripts/start-mertm.sh`, then:

1. **Login admin** → confirm bell shows correct unread count.
2. **Group view** → click bell → see "Поръчки" / "Склад" group headers; items have `•` (unread) or `✓` (read).
3. **Mark all** → click "Маркирай всички" → unread count drops to 0; items show `✓`.
4. **Click navigation** → click a notification → marks read + navigates to relevant page (orders or products).
5. **Per-user isolation** — open second browser as a different user (e.g. sales) → bell should still show items unread (admin's reads are not visible to sales).
6. **Polling** — leave the tab idle 35s; trigger a `pending_order_ready` notification by approving an incoming-goods document covering a paid_not_taken order → toast appears within 30s with "Виж" action button.
7. **Action toast** — generate a new order, generate an invoice, record a payment → each emits a green success toast.
8. **Error toast** — try to issue a fulfill on a quoted order → red error toast surfaces the message.

If anything fails — debug, fix, re-commit.

---

## Task 10: Update STATUS.md

```markdown
**Batch I — Notifications UX upgrade** (2026-04-29):

- Migration 067 — drop vestigial notifications.read column
- GET /notifications — unified feed (computed + persistent) with per-user read via existing notification_reads
- New endpoint GET /notifications/unread-count for bell badge
- Per-user read isolation verified by integration tests
- Frontend bell dropdown rewritten — groupings, read indicators, mark-all
- New useNotificationsPolling hook (30s) + toast on new TOAST_WORTHY_TYPES
- Systematic action toasts across Orders / Invoices / Payments / Partners / Products / Settings mutations
- Deferred to Batch I.2: banners, per-type prefs, browser desktop notifications, full /notifications page
```

```bash
git add STATUS.md
git commit -m "docs(status): Batch I complete — notifications UX upgrade"
```

---

## Verification checklist (`superpowers:verification-before-completion`)

- [ ] Migration 067 applied; `notifications.read` column gone
- [ ] Backend tests pass: `npx vitest run`
- [ ] Backend type-check clean
- [ ] Frontend type-check clean
- [ ] Manual E2E (Task 9) — all 8 steps green
- [ ] STATUS.md updated
- [ ] Per-user read state isolated (verified manually with two users)
- [ ] Toasts not spamming for routine notifications
- [ ] All commits use conventional format

---

## Future work — Batch I.2

Out of scope for Batch I:

- **Banner alerts** — full-width strips for critical events
- **Per-type user preferences** — settings page to mute / promote types
- **Desktop browser notifications** — Web Notifications API
- **Full /notifications page** — searchable, paginated history
- **Group collapse/expand** in bell dropdown
- **Realtime via SSE** if 30s latency becomes uncomfortable
