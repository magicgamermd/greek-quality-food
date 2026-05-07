# Batch I — Notifications UX upgrade design

**Date:** 2026-04-29
**Status:** Approved (brainstorm complete, ready for implementation plan)
**Scope:** Cross-cutting upgrade of the notifications system. Phase 1
adds toasts (systematic), 30s polling, an improved bell-dropdown
center, and a per-user read-state migration that fixes the current
multi-user `notifications.read` bug.

---

## Understanding Summary

**What we're building:**

1. **Toast system (sonner — already mounted)** — used systematically:
   - Action feedback on every mutation success/error (новa поръчка,
     регенерирана фактура, плащане, etc.)
   - Background-event toast only when a fresh notification's `type` is
     in `TOAST_WORTHY_TYPES` (initially just `pending_order_ready`)

2. **Polling** — TanStack Query `refetchInterval: 30000` for the
   `["notifications"]` query. New notifications surface within 30s.

3. **Notification Center upgrade** (improved bell dropdown):
   - Group headers ("Поръчки", "Плащания", "Склад", …)
   - Read indicators (`•` unread / `✓` read)
   - "Маркирай всички като прочетени" button
   - Click an item → navigate to the relevant page (e.g. order drawer)
   - Recent ~20 items; footer link "Виж всички" → reserved for Phase 2

4. **Per-user read state** — fixes today's global-`read` bug:
   - New table `user_notification_reads (user_id, notification_id,
read_at)`
   - Lazy population — row exists only when a user has marked the
     notification as read; absence ⇒ unread.
   - Drop `notifications.read` column.
   - Update existing endpoints to LEFT JOIN with the new table.
   - New endpoint `GET /notifications/unread-count` for the bell
     badge.

**Why:**

- Direct user request — modern software feel; current bell+badge is
  primitive.
- The `read` boolean on `notifications` is a multi-user bug: when one
  user reads a notification, every user sees it as read.
- Toasts massively improve perceived responsiveness — users know
  immediately that their action succeeded.

**For whom:** All MERT-M users (admin, sales, warehouse, accountant).
No new permission.

**Key constraints:**

- Polling 30s (no SSE/WebSocket).
- Background-event toasts limited to `TOAST_WORTHY_TYPES` to avoid
  spam.
- Bell dropdown shows the last ~20 notifications; older history
  available via Phase 2 page (out of scope here).

**Non-goals (deferred to a future Batch I.2):**

- No banner alerts (full-width strips for critical events).
- No per-type user preferences page.
- No desktop browser notifications (Web Notifications API).
- No SSE / WebSocket realtime.
- No full `/notifications` page route.

---

## Assumptions

1. `sonner` is already installed; `<Toaster>` is mounted in `App.tsx`
   (top-right, 4s, richColors). Verified.
2. `lib/toast.ts` wrapper exists with helpers like `toast.success`,
   `toast.error`. Verified.
3. The 4 existing notification endpoints (GET, PUT /:id/read, POST
   /read-all, DELETE /:id) all exist in `routes/notifications.ts`.
   Verified.
4. `notifications` table has `payload JSONB` column (added in Batch
   F1). Verified.
5. Auth context provides `request.user.id` on every authenticated
   request. Verified.
6. The bell dropdown component lives somewhere in the layout/header —
   exact file located during implementation (likely
   `components/Layout.tsx` or a `NotificationBell` component).
7. Migration backfill: pre-existing `read=true` notifications are
   marked as read for **every admin user** (pessimistic — assumes
   admins have seen them). Sales / warehouse / accountant users get
   them as unread on day one.

---

## Decision Log

| #   | Decision                                               | Alternatives                                          | Reason                                                              |
| --- | ------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | Phase 1 = Toasts + Polling + Center + Per-user read    | Toasts-only minimum; full 7-feature maximum           | Balanced: fixes architectural read bug AND delivers visible upgrade |
| 2   | Polling 30s via TanStack Query                         | SSE; WebSocket                                        | Internal tool — 30s is acceptable; zero new infra                   |
| 3   | Per-user read = new `user_notification_reads` table    | JSONB `read_by` array; user_notifications duplication | Normalized, scales, lazy population                                 |
| 4   | Toasts = action feedback + important background events | Only actions; everything toasted                      | Balance: critical events surface, routine spam blocked              |
| 5   | Backend minimum — update existing + add unread-count   | Filter/group endpoints; cursor pagination             | Phase 1 scope; expandable later                                     |
| 6   | Improved bell dropdown (not side-panel/page)           | Side drawer; full page                                | Standard pattern, minimum work, 95% coverage                        |
| 7   | `TOAST_WORTHY_TYPES = ['pending_order_ready']`         | + order_fulfilled; all order-related                  | Zero spam; list is extensible                                       |

---

## Final Design

### DB migration (066)

```sql
-- 066_user_notification_reads.sql
-- Per-user read tracking for notifications.
--
-- Why: notifications.read was a global boolean — one user clicking
-- "read" hid the notification from everyone. Now each user has their
-- own read state.

BEGIN;

CREATE TABLE IF NOT EXISTS user_notification_reads (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id  INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  read_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, notification_id)
);

CREATE INDEX IF NOT EXISTS idx_user_notification_reads_user_id
  ON user_notification_reads(user_id);

-- Backfill: every admin user "has read" all currently-read notifications.
-- (We don't know who actually marked them; pessimistic = mark for all admins.)
INSERT INTO user_notification_reads (user_id, notification_id, read_at)
SELECT u.id, n.id, COALESCE(n.created_at, NOW())
  FROM users u
 CROSS JOIN notifications n
 WHERE u.role = 'admin'
   AND n.read = TRUE
ON CONFLICT (user_id, notification_id) DO NOTHING;

-- Drop the global read column.
ALTER TABLE notifications DROP COLUMN IF EXISTS read;

COMMIT;
```

### Backend — endpoint updates

**`GET /notifications`** — return per-user `read_at`:

```ts
const userId = (request.user as any).id;
const { rows } = await query(
  `SELECT n.*,
          unr.read_at,
          (unr.read_at IS NOT NULL) AS is_read
     FROM notifications n
     LEFT JOIN user_notification_reads unr
            ON unr.notification_id = n.id AND unr.user_id = $1
    ORDER BY n.created_at DESC
    LIMIT 50`,
  [userId],
);
```

Optional `?unread_only=true` adds `WHERE unr.read_at IS NULL`.

**`PUT /notifications/:id/read`** — INSERT into `user_notification_reads`:

```ts
const userId = (request.user as any).id;
await query(
  `INSERT INTO user_notification_reads (user_id, notification_id)
   VALUES ($1, $2)
   ON CONFLICT (user_id, notification_id) DO NOTHING`,
  [userId, id],
);
```

**`POST /notifications/read-all`** — bulk insert for current user:

```ts
const userId = (request.user as any).id;
await query(
  `INSERT INTO user_notification_reads (user_id, notification_id)
   SELECT $1, n.id FROM notifications n
   ON CONFLICT (user_id, notification_id) DO NOTHING`,
  [userId],
);
```

**`GET /notifications/unread-count`** — new endpoint:

```ts
const userId = (request.user as any).id;
const {
  rows: [row],
} = await query(
  `SELECT COUNT(*)::int AS count
     FROM notifications n
    WHERE NOT EXISTS (
      SELECT 1 FROM user_notification_reads unr
       WHERE unr.notification_id = n.id AND unr.user_id = $1
    )`,
  [userId],
);
return { count: row.count };
```

**`DELETE /notifications/:id`** — admin-only (existing); unchanged.

### Frontend — shared constant

`warehouse-frontend/src/lib/notificationTypes.ts`:

```ts
// Notification types eligible for toast display when arriving via polling.
// Keep small to avoid spam; extend deliberately for new critical types.
export const TOAST_WORTHY_TYPES = ["pending_order_ready"] as const;

// Display grouping in the bell dropdown.
export const NOTIFICATION_GROUPS: Record<string, string> = {
  order_created: "Поръчки",
  order_updated: "Поръчки",
  order_fulfilled: "Поръчки",
  pending_order_ready: "Поръчки",
  // future:
  // payment_received: "Плащания",
  // low_stock_alert: "Склад",
};
```

### Frontend — polling + toast on new

The notifications query is already consumed by the bell. Wrap it with
`refetchInterval` and watch for newly-arrived items:

```ts
const previousIdsRef = useRef<Set<number>>(new Set());

const { data: notifications = [] } = useQuery({
  queryKey: ["notifications"],
  queryFn: () => api.get("/notifications").then((r) => r.data),
  refetchInterval: 30000,
});

useEffect(() => {
  if (!notifications.length) return;
  const seen = previousIdsRef.current;
  for (const n of notifications) {
    if (!seen.has(n.id) && TOAST_WORTHY_TYPES.includes(n.type)) {
      toast.success(n.message, {
        action: { label: "Виж", onClick: () => navigateFromPayload(n.payload) },
      });
    }
  }
  previousIdsRef.current = new Set(notifications.map((n) => n.id));
}, [notifications]);
```

The first run primes the set without toasting (initial mount).

### Frontend — improved bell dropdown

Replace existing dropdown content:

```tsx
// Group + sort by NOTIFICATION_GROUPS
const grouped = useMemo(() => {
  const out: Record<string, Notification[]> = {};
  for (const n of notifications) {
    const g = NOTIFICATION_GROUPS[n.type] ?? "Общи";
    (out[g] ??= []).push(n);
  }
  return out;
}, [notifications]);

return (
  <DropdownMenu>
    <DropdownMenuTrigger>
      <BellIcon />
      {unreadCount > 0 && <Badge>{unreadCount}</Badge>}
    </DropdownMenuTrigger>
    <DropdownMenuContent className="w-96">
      <div className="flex items-center justify-between p-2 border-b">
        <span className="font-semibold">Известия</span>
        <Button size="sm" variant="ghost" onClick={() => markAllRead.mutate()}>
          Маркирай всички
        </Button>
      </div>
      <div className="max-h-96 overflow-y-auto">
        {Object.entries(grouped).map(([group, items]) => (
          <div key={group}>
            <div className="px-3 py-1 text-xs text-gray-500 bg-gray-50">
              {group}
            </div>
            {items.map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  markRead.mutate(n.id);
                  navigateFromPayload(n.payload);
                }}
                className={`w-full text-left px-3 py-2 hover:bg-gray-50 ${
                  n.is_read ? "opacity-60" : ""
                }`}
              >
                <span className="mr-2">{n.is_read ? "✓" : "•"}</span>
                {n.message}
                <div className="text-xs text-gray-400">
                  {formatRelativeTime(n.created_at)}
                </div>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="p-2 text-center text-xs text-gray-400 border-t">
        {/* Phase 2 — turn into Link to /notifications */}
        Виж всички (скоро)
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
);
```

### Frontend — systematic action toasts

In each mutation that's currently silent, add an `onSuccess` /
`onError` toast:

```ts
const invoiceMutation = useMutation({
  mutationFn: …,
  onSuccess: () => toast.success("Фактура генерирана"),
  onError: (e) => toast.error(`Грешка: ${e.message}`),
});
```

Audit all mutations in: Orders.tsx, Invoices.tsx, Payments.tsx,
Partners.tsx, Products.tsx, Settings.tsx. Add toast helpers where
missing. (Pure refactor; no behaviour change beyond visible feedback.)

### Test strategy

- **Backend integration tests:**
  - GET /notifications returns `read_at` from join
  - PUT /:id/read inserts user_notification_reads row
  - POST /read-all bulk-inserts for current user only
  - GET /unread-count uses NOT EXISTS clause and returns correct count
  - User A reading notification ≠ user B reading state
- **Frontend smoke (manual):**
  - Polling: leave tab idle 35s → new notification appears
  - Toast: trigger pending_order_ready event → toast pops up
  - Center: group headers render; mark-all clears badge
  - Two browsers: user A reads notification; user B's bell badge unchanged

---

## Non-Functional Requirements

- **Performance:** LEFT JOIN per request is cheap (PK on
  `user_notification_reads`); polling load = 1 query per user per
  30s. Add `LIMIT 50` on GET /notifications to cap response size.
- **Scale:** lazy read-state population keeps the table sparse. With
  1k notifications × 5 users, max ~5k rows; trivial.
- **Security:** read endpoints scoped by `request.user.id`; users
  can't see / mark each other's reads.
- **Reliability:** ON CONFLICT DO NOTHING ensures idempotent writes
  (e.g. re-mark already-read).
- **Maintenance:** +1 migration, +1 endpoint, +1 shared constant,
  +bell dropdown rewrite, +systematic toast in mutations. Medium-
  sized batch but contained scope.

---

## Implementation Plan

(Generated next by `writing-plans` skill.)
