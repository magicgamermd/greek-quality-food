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
