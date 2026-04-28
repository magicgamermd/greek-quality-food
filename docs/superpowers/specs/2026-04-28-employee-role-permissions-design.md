# Employee Role + Per-User Permission Overrides — Design Spec

**Date:** 2026-04-28
**Status:** Approved by stakeholder, ready for implementation planning
**Scope:** Single coherent feature — DB + backend + frontend + admin UI
**Estimated effort:** ~21 work-days (~4 weeks for one developer)

---

## 1. Problem Statement

MERT-M software currently runs primarily under the `admin` role. The
existing role enum (`admin`, `warehouse`, `accountant`) is enforced by
scattered ad-hoc checks (`if request.user.role === "..."`) across ~12
backend route files, and the frontend renders the same UI to every
role — relying solely on backend rejection.

The business needs to onboard sales/operations employees who can run
the full sales workflow (orders, invoices, razpiska, Econt shipping,
stock visibility, payments) **but must not see purchase prices**
(`products.purchase_price`), because exposing supplier costs to
front-line staff is a commercial risk.

Additionally, the admin needs **dynamic per-user control** — the
ability to grant or revoke individual permissions for a specific
employee day-to-day, without changing the user's role and without
restarting their session.

## 2. Goals

1. Add a fourth role `sales` with sensible defaults for the workflow
   described above.
2. Introduce a 16-permission registry that captures every meaningful
   gate currently checked in the code (orders, invoices, razpiska,
   Econt, inventory views, products, payments, reports, exports,
   user management, settings).
3. Allow admin to override any individual permission for any
   non-admin user — both grant a permission the role doesn't give,
   and revoke a permission the role gives by default.
4. Hide `purchase_price` from API responses (not just UI) for users
   without `inventory.view_purchase_price` permission. Defense at the
   API boundary, not security theater.
5. Make permission changes take effect immediately (no logout
   required), backed by a Redis cache with 60-second TTL and explicit
   invalidation on every mutation.
6. Provide an admin UI that shows the role default + override
   breakdown per user and lets admin toggle any permission with one
   click + optional reason note.
7. Ship with **zero regression** for existing `admin`, `accountant`,
   and `warehouse` users — their effective permissions after the
   migration must exactly mirror today's scattered role checks.

## 3. Non-Goals

- Custom user-defined roles (admin can pick from the 4 fixed roles
  only). YAGNI — current team size doesn't warrant it.
- Per-resource scoping (e.g. "see only orders I created"). All
  permissions are global. The team is small (≤3 sales users
  realistically). Future extension if needed.
- Real-time push of permission changes to a connected client (no
  WebSocket). The 60-second cache TTL plus 403-triggered `/me`
  refresh on the frontend gives near-instant UX without WS
  infrastructure.
- Self-service permission requests (employee asking admin for a
  permission via the app). Admin sets things directly.

## 4. Architecture Overview

```
                    ┌────────────────────────┐
                    │  Permission Registry   │
                    │   (TS const, 16 perms) │
                    └────────────┬───────────┘
                                 │
                                 ▼
   ┌──────────────────┐   ┌─────────────┐   ┌───────────────┐
   │ users.role       │   │ ROLE_       │   │ user_perm-    │
   │ ('admin','ware-  │ + │ DEFAULTS    │ + │ ission_       │
   │  house','accnt', │   │  per role   │   │ overrides     │
   │  'sales')        │   │             │   │  (granted /   │
   └──────────────────┘   └─────────────┘   │   revoked)    │
                                            └───────────────┘
                                 │
                                 ▼
              ┌───────────────────────────────────────┐
              │ getUserPermissions(userId)             │
              │   ↳ Redis cache (TTL 60s)              │
              │   ↳ on miss: 1 SQL with LEFT JOIN     │
              │   ↳ admin role → bypass (return all)   │
              └───────────────────────────────────────┘
                                 │
                                 ▼
       ┌─────────────────────────────────────────────────┐
       │ Fastify routes:                                  │
       │   { preHandler: requirePermission(PERM) }        │
       │ + stripFieldsForUser() for sensitive columns     │
       └─────────────────────────────────────────────────┘
                                 │
                                 ▼
       ┌─────────────────────────────────────────────────┐
       │ React frontend:                                  │
       │   <PermissionProvider> + <Can> + <RequirePerm>   │
       │ + axios interceptor on 403 → refetch /me + toast │
       └─────────────────────────────────────────────────┘
```

### Key invariants

- **Effective permission rule:**
  ```
  effective(user, perm) =
    user.role === "admin"            → true
    override(user, perm).granted     → true / false (whichever set)
    perm in ROLE_DEFAULTS[user.role] → true
    otherwise                        → false
  ```
- **Admin bypass:** `hasPermission()` returns `true` for any admin
  user without consulting the override table. Backend rejects with
  HTTP 400 any attempt to write override rows for admin users
  (lockout protection).
- **Self-protection:** No user can modify their own permissions or
  role, even if they have `users.manage`.
- **Cache invalidation is the source of correctness.** Every code
  path that writes to `user_permission_overrides` or changes
  `users.role` MUST call `invalidateUserPermissions(userId)`. Tests
  enforce this.

## 5. Database Schema

Migration `migrations/050_user_permissions.sql` (additive, idempotent
where possible):

```sql
BEGIN;

-- 1. Extend the role enum
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'warehouse', 'accountant', 'sales'));

-- 2. New table for per-user overrides
CREATE TABLE user_permission_overrides (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL,
  granted     BOOLEAN NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (user_id, permission)
);

CREATE INDEX idx_user_permission_overrides_user_id
  ON user_permission_overrides(user_id);

COMMIT;
```

No data migration required. Existing users keep their role; their
effective permissions match previous behavior because the role
defaults (defined in code, see §6) intentionally reproduce the
existing scattered role checks.

Audit logging reuses the existing `audit_events` table:

```jsonc
// Example row written when admin grants a permission:
{
  event_type:    "permission_override",
  actor_user_id: "<admin-uuid>",
  target_type:   "user",
  target_id:     "<target-uuid>",
  payload: {
    permission: "invoices.cancel",
    action:     "grant" | "revoke" | "reset_to_default",
    previous:   true | false | null,
    new:        true | false | null,
    reason:     "Временно за месечни корекции"
  }
}
```

## 6. Permission Registry & Role Defaults

### Registry — 16 permissions in `warehouse-backend/src/lib/permissions.ts`

```typescript
export const PERMISSIONS = {
  // Sales / commercial
  ORDERS_MANAGE: "orders.manage",
  INVOICES_MANAGE: "invoices.manage",
  INVOICES_CANCEL: "invoices.cancel",
  RAZPISKA_MANAGE: "razpiska.manage",
  ECONT_MANAGE: "econt.manage",
  // Inventory & stock
  INVENTORY_VIEW: "inventory.view",
  INVENTORY_VIEW_PURCHASE_PRICE: "inventory.view_purchase_price",
  INCOMING_MANAGE: "incoming.manage",
  // Master data
  PARTNERS_MANAGE: "partners.manage",
  PRODUCTS_VIEW: "products.view",
  PRODUCTS_MANAGE: "products.manage",
  // Accounting
  PAYMENTS_MANAGE: "payments.manage",
  REPORTS_VIEW: "reports.view",
  EXPORT_CREATE: "export.create",
  // System
  USERS_MANAGE: "users.manage",
  SETTINGS_MANAGE: "settings.manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
```

### Role defaults

| Permission                      | admin | accountant | warehouse | **sales** |
| ------------------------------- | :---: | :--------: | :-------: | :-------: |
| `orders.manage`                 |  ✅   |     ❌     |    ✅     |    ✅     |
| `invoices.manage`               |  ✅   |     ✅     |    ❌     |    ✅     |
| `invoices.cancel`               |  ✅   |     ✅     |    ❌     |    ❌     |
| `razpiska.manage`               |  ✅   |     ✅     |    ✅     |    ✅     |
| `econt.manage`                  |  ✅   |     ❌     |    ✅     |    ✅     |
| `inventory.view`                |  ✅   |     ✅     |    ✅     |    ✅     |
| `inventory.view_purchase_price` |  ✅   |     ✅     |    ✅     |  **❌**   |
| `incoming.manage`               |  ✅   |     ✅     |    ✅     |    ❌     |
| `partners.manage`               |  ✅   |     ✅     |    ✅     |    ✅     |
| `products.view`                 |  ✅   |     ✅     |    ✅     |    ✅     |
| `products.manage`               |  ✅   |     ❌     |    ✅     |    ❌     |
| `payments.manage`               |  ✅   |     ✅     |    ❌     |    ✅     |
| `reports.view`                  |  ✅   |     ✅     |    ❌     |    ❌     |
| `export.create`                 |  ✅   |     ✅     |    ❌     |    ❌     |
| `users.manage`                  |  ✅   |     ❌     |    ❌     |    ❌     |
| `settings.manage`               |  ✅   |     ❌     |    ❌     |    ❌     |

These defaults intentionally mirror today's role checks. Admin always
returns true via short-circuit; the `admin` row of this table is
informational only.

### Permission groups for the admin UI

UI groups in this display order (most-frequently-toggled first):

1. **Продажби** — orders, invoices, invoices.cancel, razpiska, econt
2. **Складова видимост** — inventory.view, inventory.view_purchase_price, incoming
3. **Master data** — partners, products.view, products.manage
4. **Счетоводство** — payments, reports, export
5. **Система** — users, settings

The registry endpoint (`GET /permissions/registry`) returns the
catalog with Bulgarian labels, descriptions, and group names so the
UI doesn't hardcode them.

## 7. Backend Permission Helper

`warehouse-backend/src/lib/permissions.ts` exposes:

```typescript
async function getUserPermissions(userId: string): Promise<Set<Permission>>;
async function invalidateUserPermissions(userId: string): Promise<void>;
async function hasPermission(
  user: { id: string; role: string },
  perm: Permission,
): Promise<boolean>;
function requirePermission(perm: Permission): FastifyOnRequestHook;
async function stripFieldsForUser<T>(
  user: { id: string; role: string },
  rows: T[],
  rules: { permission: Permission; fields: string[] }[],
): Promise<T[]>;
```

### Caching contract

- **Key:** `perms:user:<uuid>`
- **Value:** JSON array of permission strings (effective set)
- **TTL:** 60 seconds
- **Invalidation:** explicit `redis.del()` on every mutation that
  changes a user's effective permissions (override write/delete,
  role change, user delete).

Cache miss path executes one SQL query that joins `users` to
`user_permission_overrides`, returns role + overrides as JSON, and
the helper computes the effective set in memory.

### Performance budget

| Path                              | p95 latency added |
| --------------------------------- | ----------------- |
| Cache hit (~99% of requests)      | 1–2 ms            |
| Cache miss (1 SQL with LEFT JOIN) | 5–10 ms           |

The 60-second TTL means a logged-in user pays at most one cache miss
per minute on average — negligible against existing route work.

### Refactoring scope

**41 occurrences of `request.user.role === "..."` across 12 route
files** (verified by `grep -rcn 'request\.user\.role' warehouse-backend/src/routes/`)
get replaced with `requirePermission(...)` middleware or inline
`hasPermission(...)` calls:

| File          |  Sites | Notes                                                                             |
| ------------- | -----: | --------------------------------------------------------------------------------- | --- | ------------------- |
| `invoices.ts` |     10 | Mostly `accountant` checks; some admin+accountant gates                           |
| `orders.ts`   |      8 | `accountant` and `admin                                                           |     | warehouse` patterns |
| `incoming.ts` |      7 | `accountant` and `admin                                                           |     | warehouse` patterns |
| `products.ts` |      3 | `accountant` and `admin` checks                                                   |
| `payments.ts` |      3 | `warehouse` exclusion                                                             |
| `partners.ts` |      3 | mixed                                                                             |
| `export.ts`   |      2 | `admin                                                                            |     | accountant`         |
| `users.ts`    |      1 | `admin`-only gate (will become `users.manage`)                                    |
| `settings.ts` |      1 | `admin`-only (will become `settings.manage`)                                      |
| `import.ts`   |      1 | mixed                                                                             |
| `fiscal.ts`   |      1 | mixed                                                                             |
| `auth.ts`     |      1 | `admin`-only gate on the registration endpoint (line 82) — becomes `users.manage` |
| **Total**     | **41** |                                                                                   |

`inventory.ts` has 0 role checks but DOES return `purchase_price` —
no `requirePermission` change needed, but `stripFieldsForUser` must
be added at the response stage.

The implementation plan will enumerate each site individually with
its current behavior and the target permission, so refactoring is
mechanical and reviewable site-by-site.

### `purchase_price` stripping

Three SQL queries currently return `purchase_price`:

- `inventory.ts:104` — inventory list view
- `incoming.ts:769–770` — incoming detail (joined with product)
- `products.ts` — product catalog (verify)

After the helper rolls out, these endpoints call
`stripFieldsForUser(user, rows, [{ permission: INVENTORY_VIEW_PURCHASE_PRICE, fields: ['purchase_price', 'product_purchase_price'] }])`
before returning.

## 8. API Endpoints for Permission Management

| Method   | Path                                 | Permission      | Purpose                                                       |
| -------- | ------------------------------------ | --------------- | ------------------------------------------------------------- |
| `GET`    | `/me`                                | (authenticated) | Current user + effective permissions                          |
| `GET`    | `/permissions/registry`              | (authenticated) | Permission catalog with BG labels and groups                  |
| `GET`    | `/users`                             | `users.manage`  | List users (existing endpoint, add `has_overrides` flag)      |
| `GET`    | `/users/:id/permissions`             | `users.manage`  | Role defaults + overrides + effective for one user            |
| `PATCH`  | `/users/:id/permissions/:permission` | `users.manage`  | Set/update an override (`{ granted: bool, reason?: string }`) |
| `DELETE` | `/users/:id/permissions/:permission` | `users.manage`  | Remove an override (revert to role default)                   |
| `PATCH`  | `/users/:id` (existing)              | `users.manage`  | Already exists; add cache invalidation when `role` changes    |

### Validation rules

- The `:permission` path param is validated against the registry
  (Zod enum) — unknown permissions return 400 with the valid list.
- The body schema for PATCH is `{ granted: boolean, reason?: string ≤255 }`.
- Target user is loaded; if `target.role === "admin"`, return 400
  with `{ error: "admin_lockout_protection" }`.
- If `target.id === actor.id`, return 400 with
  `{ error: "self_modification_forbidden" }`.

### Sample responses

**`GET /me`:**

```json
{
  "user": {
    "id": "0b5786ba-...",
    "email": "ivan@mertm.bg",
    "name": "Иван Петров",
    "role": "sales"
  },
  "permissions": [
    "orders.manage",
    "invoices.manage",
    "razpiska.manage",
    "econt.manage",
    "inventory.view",
    "partners.manage",
    "products.view",
    "payments.manage"
  ]
}
```

**`GET /users/:id/permissions`:**

```json
{
  "user_id": "...",
  "role": "sales",
  "role_defaults": ["orders.manage", "invoices.manage", "..."],
  "overrides": [
    {
      "permission": "invoices.cancel",
      "granted": true,
      "reason": "Временно — затваряне на месечни корекции",
      "created_at": "2026-04-28T...",
      "created_by": { "id": "...", "email": "admin@mertm.bg", "name": "..." }
    }
  ],
  "effective": ["orders.manage", "invoices.manage", "invoices.cancel", "..."]
}
```

## 9. Frontend Integration

### React context — `src/contexts/PermissionContext.tsx`

Wraps the entire app inside `<PermissionProvider>`. Uses TanStack
Query (`queryKey: ["me"]`) with `staleTime: 60_000` and
`refetchOnWindowFocus: true` so when admin changes a permission and
the user switches back to their tab, the UI updates within seconds.

Exposes `usePermissions()` hook returning
`{ user, permissions, isLoading, hasPermission, refresh }`.

### Declarative gate — `<Can>`

```tsx
<Can permission="invoices.cancel">
  <Button onClick={cancelInvoice}>Анулирай</Button>
</Can>

<Can permission="inventory.view_purchase_price">
  <th>Доставна цена</th>
</Can>
```

`mode="all" | "any"` (default `any`) when an array is passed.
`fallback` prop renders an alternative when the permission is
absent.

### Route guard — `<RequirePermission>`

```tsx
<Route
  path="/settings/users/*"
  element={
    <RequirePermission permission="users.manage">
      <UsersAdminPage />
    </RequirePermission>
  }
/>
```

Redirects to `/` if the permission is missing. Shows a skeleton
while `/me` is loading.

### Dynamic sidebar

The sidebar reads the `permissions` set and filters its menu list:

| Path         | Required permission     |
| ------------ | ----------------------- |
| `/`          | (none — always visible) |
| `/orders`    | `orders.manage`         |
| `/invoices`  | `invoices.manage`       |
| `/payments`  | `payments.manage`       |
| `/inventory` | `inventory.view`        |
| `/products`  | `products.view`         |
| `/partners`  | `partners.manage`       |
| `/incoming`  | `incoming.manage`       |
| `/reports`   | `reports.view`          |
| `/settings`  | `settings.manage`       |

A sales user sees ~7 items instead of the full 10.

### 403 axios interceptor

```typescript
api.interceptors.response.use(
  (r) => r,
  async (error) => {
    if (
      error.response?.status === 403 &&
      error.response.data?.required_permission
    ) {
      queryClient.invalidateQueries({ queryKey: ["me"] });
      toast.warning("Разрешенията ти са променени. Опитай пак.");
    }
    return Promise.reject(error);
  },
);
```

Mid-session permission revoke → user clicks the disallowed action →
backend returns 403 → toast + UI refresh, button disappears.

### Pages to refactor

| File                     | Change                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `App.tsx`                | Wrap in `<PermissionProvider>`; add `<RequirePermission>` route guards                   |
| `components/Sidebar.tsx` | Filter menu by permission                                                                |
| `pages/Inventory.tsx`    | `<Can permission="inventory.view_purchase_price">` around the cost column header + cells |
| `pages/Products.tsx`     | Same — hide cost column + edit button (`products.manage`)                                |
| `pages/Invoices.tsx`     | `<Can permission="invoices.cancel">` around the cancel button                            |
| `pages/Dashboard.tsx`    | Hide margin/cost widgets behind `inventory.view_purchase_price`                          |
| `pages/Settings.tsx`     | Add link to Users sub-page (`<Can permission="users.manage">`)                           |

The `purchase_price` column will already be `undefined` in API
responses for users without the permission — wrapping the column
header in `<Can>` keeps an empty column from rendering.

## 10. Admin UI — Permission Management

### Routes

```
/settings/users          → UsersListPage
/settings/users/:id      → UserDetailPage
```

### Users list

A simple table: name + email, role badge, override count
(`default` or `N overrides`), click-row to navigate to detail.
Filter by role and search by email/name. A `[+ Нов user]` button
links to the existing user creation flow.

### User detail

Single page with three sections stacked vertically:

1. **Header** — name, email, last login, role dropdown.
2. **Permission matrix** — grouped by category. Each row:
   - Checkbox showing **effective** state.
   - Label and description.
   - Annotation `default ✓ от sales` / `default ✗ от sales`.
   - If overridden, an `✏️ override` badge with the reason note and
     a `[Reset]` button to remove the override.
3. **Audit history** — last ~5 permission/role changes for this
   user (formatted from `audit_events`).

### Interaction model — three states per row

| Override row exists? | Granted? | Visual                                                  |
| -------------------- | -------- | ------------------------------------------------------- |
| No                   | (n/a)    | Plain checkbox = role default; click to create override |
| Yes                  | true     | `☑️` + `✏️ override` badge + `[Reset]`                  |
| Yes                  | false    | `☐` + `✏️ override` badge + `[Reset]`                   |

Click any checkbox → opens `OverrideDialog` with optional reason
field → confirms → PATCH `/users/:id/permissions/:perm`. The dialog
distinguishes:

- **Grant** (turning ON a normally-off permission)
- **Revoke** (turning OFF a default-on permission)
- **Reset** (removing an existing override — DELETE endpoint)

### Edge UI cases

- **Admin user opened** → matrix is read-only with a banner: "Admin
  има всички разрешения. За да управляваш правата му, смени ролята
  първо."
- **Self opened** → matrix is read-only with a banner: "Не можеш
  да променяш собствените си разрешения."
- **Role change** → confirm dialog warning that "промяната на
  ролята изтрива всички overrides за този user" → upon confirm,
  PATCH role + cascade delete overrides server-side.

### Components

```
warehouse-frontend/src/pages/admin/
  UsersListPage.tsx
  UserDetailPage.tsx
  components/
    PermissionMatrix.tsx       // groups + rows
    PermissionRow.tsx          // single row with checkbox + reset
    OverrideDialog.tsx         // grant/revoke modal with reason
    RoleSelector.tsx           // role dropdown with confirm
    AuditTrail.tsx             // last N changes for this user
```

## 11. Test Plan

### Unit tests (`lib/permissions.test.ts`)

- `getUserPermissions` returns role defaults when no overrides
- `getUserPermissions` applies grant + revoke overrides
- `getUserPermissions` admin returns full permission set
- `getUserPermissions` cache hit avoids DB on second call
- `invalidateUserPermissions` forces fresh DB read
- `stripFieldsForUser` removes `purchase_price` for sales user
- `stripFieldsForUser` keeps `purchase_price` for admin / accountant /
  warehouse / sales-with-override

### Integration tests (Fastify inject)

- `PATCH /users/:id/permissions/:perm` — happy path: grants
  override, invalidates cache, writes audit row
- `PATCH` rejects 400 when target is admin (lockout protection)
- `PATCH` rejects 400 when target is self
- `PATCH` rejects 403 when actor lacks `users.manage`
- `PATCH` rejects 400 for unknown permission
- `DELETE /users/:id/permissions/:perm` removes override + audit
- `GET /me` returns correct permissions for each of 4 roles
- `GET /permissions/registry` returns the full catalog with BG
  labels and groups
- `GET /inventory` as sales user — response JSON does not contain
  `purchase_price`
- `GET /inventory` as accountant user — response JSON contains
  `purchase_price`

### Regression tests

Critical: for each of the ~30 existing role checks in the codebase,
add a test demonstrating that `admin`, `accountant`, and `warehouse`
users still get the same access they had before the migration.
These are the most likely places for regression.

### E2E tests (`e2e-tests/tests/permissions.spec.ts`)

- Sales user logs in → sidebar has 7 items, no "Аналитики" or
  "Настройки" or "Входяща стока"
- Sales user opens `/inventory` → no "Доставна цена" column
- Admin grants `invoices.cancel` to sales user → user sees the
  Cancel button after window-focus refresh
- Admin revokes `orders.manage` from sales user → next attempted
  action returns 403 → toast appears → UI hides Order menu item
- Admin opens another admin's user detail → matrix is read-only
  with the banner

### Manual smoke checklist

(Listed in §8 of the brainstorming flow — copy into the implementation
plan when scheduling.)

## 12. Migration & Rollout

The 21-day estimate divides into 9 phases (one developer):

| #   | Phase                                                                                     | Days |
| --- | ----------------------------------------------------------------------------------------- | ---- |
| 1   | Backend foundation: migration + permission helper + middleware                            | 2    |
| 2   | Refactor backend route checks (12 files, 41 sites)                                        | 3    |
| 3   | Permission management API endpoints                                                       | 2    |
| 4   | `purchase_price` stripping integration                                                    | 1    |
| 5   | Frontend `PermissionProvider`, `<Can>`, `<RequirePermission>`, axios interceptor, sidebar | 2    |
| 6   | Refactor existing pages with `<Can>`                                                      | 2    |
| 7   | Admin UI — users list + detail + matrix + dialogs                                         | 4    |
| 8   | Tests (unit, integration, e2e)                                                            | 3    |
| 9   | Production rollout + admin training (~30 min walkthrough)                                 | 2    |

Each phase is independently deployable and reversible — if Phase 7
admin UI hits a snag, Phases 1–6 still ship value (refactored
permission system + invisible-to-end-users defaults).

## 13. Risk Assessment

| Risk                                                           | Probability | Mitigation                                                                                                                                                      |
| -------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regression of admin/accountant/warehouse behavior              | High        | Phase 2 ships only after the regression test suite (built in Phase 1) is green. Role defaults explicitly mirror current scattered checks.                       |
| Cache invalidation bug (admin's change doesn't take effect)    | Medium      | Unit test for `invalidateUserPermissions` in every mutation code path. Integration test that PATCH then GET reflects the change without sleeping.               |
| Sales user accidentally sees `purchase_price` in some endpoint | Medium      | Audit grep of all SELECT queries returning `purchase_price`; integration test asserts the field is absent in JSON for sales user across all relevant endpoints. |
| Admin lockout                                                  | Low         | Admin role bypass + UI block + backend 400 on admin lockout attempts.                                                                                           |
| Performance regression from cache misses                       | Low         | TTL 60s keeps cache hit ratio ~99%. p95 effect ~0. Cache load tested in Phase 8.                                                                                |

## 14. Out of Scope (Future Extensions)

- **Custom roles defined by admin.** Could be added via a `roles`
  table with `default_permissions JSONB`. Not needed today.
- **Permission scoping** — "see only orders I created" requires a
  `created_by` predicate in queries. Add when the team grows.
- **Self-service permission requests** — employee asks admin via a
  workflow. Add when the team grows.
- **Audit log dedicated page** — current design shows last 5 entries
  per user; a `/settings/audit` browse page can come later.
- **Session-level permissions cache in JWT** — current design hits
  Redis once per minute per user; if that ever becomes a bottleneck
  (it won't, until thousands of users), JWT-embedded permissions
  with shorter TTL could be added.

## 15. Open Questions

None remaining after the brainstorming session. All design decisions
are confirmed by stakeholder.
