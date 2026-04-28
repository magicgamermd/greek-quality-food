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
