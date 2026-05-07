/**
 * Permission registry — central catalog of all permission flags.
 * Backend route checks reference these constants; admin UI gets the
 * full catalog via GET /permissions/registry.
 */
/**
 * Permission registry — central catalog of all permission flags.
 * Backend route checks reference these constants; admin UI gets the
 * full catalog via GET /permissions/registry.
 */

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
  // Sales overrides (admin-only by default)
  BELOW_COST_OVERRIDE: "orders.below_cost_override",
  ORDERS_EDIT_AFTER_FULFILL: "orders.edit_after_fulfill",
  // Procurement (admin-only by default — no role grants this)
  PURCHASE_ORDERS_MANAGE: "purchase_orders.manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export type UserRole = "admin" | "warehouse" | "accountant" | "sales";

/**
 * Role default permissions. Admin is special: the helper short-circuits
 * before consulting this map. Listing it here is intentional for
 * documentation / typing parity.
 */
export const ROLE_DEFAULTS: Record<UserRole, Permission[]> = {
  admin: Object.values(PERMISSIONS),
  accountant: [
    PERMISSIONS.INVOICES_MANAGE,
    PERMISSIONS.INVOICES_CANCEL,
    PERMISSIONS.RAZPISKA_MANAGE,
    PERMISSIONS.INVENTORY_VIEW,
    PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE,
    PERMISSIONS.INCOMING_MANAGE,
    PERMISSIONS.PARTNERS_MANAGE,
    PERMISSIONS.PRODUCTS_VIEW,
    PERMISSIONS.PAYMENTS_MANAGE,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.EXPORT_CREATE,
  ],
  warehouse: [
    PERMISSIONS.ORDERS_MANAGE,
    PERMISSIONS.RAZPISKA_MANAGE,
    PERMISSIONS.ECONT_MANAGE,
    PERMISSIONS.INVENTORY_VIEW,
    PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE,
    PERMISSIONS.INCOMING_MANAGE,
    PERMISSIONS.PARTNERS_MANAGE,
    PERMISSIONS.PRODUCTS_VIEW,
    PERMISSIONS.PRODUCTS_MANAGE,
  ],
  sales: [
    PERMISSIONS.ORDERS_MANAGE,
    PERMISSIONS.INVOICES_MANAGE,
    PERMISSIONS.RAZPISKA_MANAGE,
    PERMISSIONS.ECONT_MANAGE,
    PERMISSIONS.INVENTORY_VIEW,
    // INVENTORY_VIEW_PURCHASE_PRICE intentionally excluded
    PERMISSIONS.PARTNERS_MANAGE,
    PERMISSIONS.PRODUCTS_VIEW,
    PERMISSIONS.PAYMENTS_MANAGE,
  ],
};

/**
 * Display metadata for the admin UI registry endpoint.
 * Order in this list determines display order in the matrix.
 */
export const PERMISSION_REGISTRY: Array<{
  permission: Permission;
  group: string;
  label: string;
  description: string;
}> = [
  // Продажби
  {
    permission: PERMISSIONS.ORDERS_MANAGE,
    group: "Продажби",
    label: "Поръчки — управление",
    description: "Създаване, редакция и отказ на поръчки",
  },
  {
    permission: PERMISSIONS.INVOICES_MANAGE,
    group: "Продажби",
    label: "Фактури — управление",
    description: "Създаване, редакция и email на фактури",
  },
  {
    permission: PERMISSIONS.INVOICES_CANCEL,
    group: "Продажби",
    label: "Анулиране фактури",
    description: "Анулиране на издадена фактура",
  },
  {
    permission: PERMISSIONS.RAZPISKA_MANAGE,
    group: "Продажби",
    label: "Стокови разписки",
    description: "Създаване и редакция на стокови разписки",
  },
  {
    permission: PERMISSIONS.ECONT_MANAGE,
    group: "Продажби",
    label: "Товарителници Еконт",
    description: "Създаване и tracking на товарителници",
  },
  {
    permission: PERMISSIONS.BELOW_COST_OVERRIDE,
    group: "Продажби",
    label: "Продажба под доставна цена",
    description: "Одобрение на поръчки с артикули под cost (admin override)",
  },
  {
    permission: PERMISSIONS.ORDERS_EDIT_AFTER_FULFILL,
    group: "Продажби",
    label: "Редакция на приключени поръчки",
    description:
      "Редакция на артикули в поръчки със статус 'Изпълнена' или 'Фактурирана'",
  },
  // Складова видимост
  {
    permission: PERMISSIONS.INVENTORY_VIEW,
    group: "Складова видимост",
    label: "Складова наличност",
    description: "Виждане на наличности в склада",
  },
  {
    permission: PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE,
    group: "Складова видимост",
    label: "Доставни цени",
    description: "Виждане на доставни (cost) цени в каталога",
  },
  {
    permission: PERMISSIONS.INCOMING_MANAGE,
    group: "Складова видимост",
    label: "Входяща стока",
    description: "Сканиране и потвърждение на входящи фактури",
  },
  // Master data
  {
    permission: PERMISSIONS.PARTNERS_MANAGE,
    group: "Master data",
    label: "Партньори",
    description: "Виж/създай/редактирай партньори",
  },
  {
    permission: PERMISSIONS.PRODUCTS_VIEW,
    group: "Master data",
    label: "Продукти — виж",
    description: "Виждане на продуктовия каталог",
  },
  {
    permission: PERMISSIONS.PRODUCTS_MANAGE,
    group: "Master data",
    label: "Продукти — управление",
    description: "Създаване и редакция на продукти",
  },
  // Счетоводство
  {
    permission: PERMISSIONS.PAYMENTS_MANAGE,
    group: "Счетоводство",
    label: "Плащания",
    description: "Записване и преглед на плащания",
  },
  {
    permission: PERMISSIONS.REPORTS_VIEW,
    group: "Счетоводство",
    label: "Аналитики",
    description: "Dashboards + аналитични отчети",
  },
  {
    permission: PERMISSIONS.EXPORT_CREATE,
    group: "Счетоводство",
    label: "Делта Про експорт",
    description: "CP1251 експорт за счетоводна програма",
  },
  // Снабдяване
  {
    permission: PERMISSIONS.PURCHASE_ORDERS_MANAGE,
    group: "Снабдяване",
    label: "Заявки към доставчици",
    description:
      "Създаване и проследяване на заявки към доставчици (PDF за пращане)",
  },
  // Система
  {
    permission: PERMISSIONS.USERS_MANAGE,
    group: "Система",
    label: "Потребители",
    description: "Управление на потребители и техните разрешения",
  },
  {
    permission: PERMISSIONS.SETTINGS_MANAGE,
    group: "Система",
    label: "Настройки",
    description: "Системни настройки на приложението",
  },
];

// ---------------------------------------------------------------------------
// Runtime helpers — require DB + Redis; imported lazily so that the constant
// exports above remain usable in contexts without those dependencies.
// ---------------------------------------------------------------------------

import { query } from "../db.js";
import { getRedis } from "./redis.js";

const CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = "perms:user:";

/**
 * Resolve the effective permission set for a user.
 * Checks Redis cache first; on miss, queries DB and caches result.
 */
export async function getUserPermissions(
  userId: string,
): Promise<Set<Permission>> {
  const cacheKey = CACHE_KEY_PREFIX + userId;
  const redis = await getRedis();

  const cached = await redis.get(cacheKey);
  if (cached) {
    return new Set(JSON.parse(cached) as Permission[]);
  }

  const { rows } = await query(
    `
      SELECT u.role,
             COALESCE(json_agg(
               json_build_object('permission', upo.permission, 'granted', upo.granted)
             ) FILTER (WHERE upo.id IS NOT NULL), '[]') AS overrides
      FROM users u
      LEFT JOIN user_permission_overrides upo ON upo.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id
    `,
    [userId],
  );

  if (rows.length === 0) return new Set();

  const role = rows[0].role as UserRole;
  const overrides = rows[0].overrides as Array<{
    permission: Permission;
    granted: boolean;
  }>;

  const effective = new Set<Permission>(ROLE_DEFAULTS[role] ?? []);
  for (const { permission, granted } of overrides) {
    if (granted) effective.add(permission);
    else effective.delete(permission);
  }

  await redis.setex(
    cacheKey,
    CACHE_TTL_SECONDS,
    JSON.stringify([...effective]),
  );
  return effective;
}

export async function invalidateUserPermissions(userId: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(CACHE_KEY_PREFIX + userId);
}

/**
 * Authorization check. Admin always returns true without consulting DB.
 */
export async function hasPermission(
  user: { id: string; role: string },
  perm: Permission,
): Promise<boolean> {
  if (user.role === "admin") return true;
  const perms = await getUserPermissions(user.id);
  return perms.has(perm);
}

import type { FastifyReply, FastifyRequest } from "fastify";

export function requirePermission(perm: Permission) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    const allowed = await hasPermission(
      request.user as { id: string; role: string },
      perm,
    );
    if (!allowed) {
      reply.status(403).send({
        error: "Forbidden",
        required_permission: perm,
        message: `Missing permission: ${perm}`,
      });
    }
  };
}

/**
 * Remove sensitive fields from response rows when the user lacks the
 * required permission. Returns a new array of new objects (does not
 * mutate the input).
 */
export async function stripFieldsForUser<T extends Record<string, unknown>>(
  user: { id: string; role: string },
  rows: T[],
  rules: { permission: Permission; fields: string[] }[],
): Promise<T[]> {
  if (rows.length === 0) return rows;
  let result = rows;
  for (const rule of rules) {
    if (await hasPermission(user, rule.permission)) continue;
    result = result.map((row) => {
      const stripped = { ...row };
      for (const f of rule.fields) delete stripped[f];
      return stripped;
    });
  }
  return result;
}
