export const PERMISSIONS = {
  ORDERS_MANAGE: "orders.manage",
  INVOICES_MANAGE: "invoices.manage",
  INVOICES_CANCEL: "invoices.cancel",
  RAZPISKA_MANAGE: "razpiska.manage",
  REPLACEMENT_CREATE: "replacement.create",
  ECONT_MANAGE: "econt.manage",
  INVENTORY_VIEW: "inventory.view",
  INVENTORY_VIEW_PURCHASE_PRICE: "inventory.view_purchase_price",
  INCOMING_MANAGE: "incoming.manage",
  STOCK_MOVEMENTS_MANAGE: "stock_movements.manage",
  PARTNERS_MANAGE: "partners.manage",
  PRODUCTS_VIEW: "products.view",
  PRODUCTS_MANAGE: "products.manage",
  PAYMENTS_MANAGE: "payments.manage",
  REPORTS_VIEW: "reports.view",
  EXPORT_CREATE: "export.create",
  USERS_MANAGE: "users.manage",
  SETTINGS_MANAGE: "settings.manage",
  BELOW_COST_OVERRIDE: "orders.below_cost_override",
  ORDERS_EDIT_AFTER_FULFILL: "orders.edit_after_fulfill",
  PURCHASE_ORDERS_MANAGE: "purchase_orders.manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export type UserRole = "admin" | "warehouse" | "accountant" | "sales";

export interface PermissionRegistryEntry {
  permission: Permission;
  group: string;
  label: string;
  description: string;
}

export interface UserPermissionsResponse {
  user_id: string;
  role: UserRole;
  role_defaults: Permission[];
  overrides: Array<{
    permission: Permission;
    granted: boolean;
    reason: string | null;
    created_at: string;
    created_by: { id: string; email: string; name: string } | null;
  }>;
  effective: Permission[];
}
