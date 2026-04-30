import { z } from "zod";

export const ORDER_LINE_STATUSES = [
  "normal",
  "paid_not_taken",
  "awaiting",
] as const;

export type OrderLineStatus = (typeof ORDER_LINE_STATUSES)[number];

export const ORDER_LINE_STATUS_LABELS: Record<OrderLineStatus, string> = {
  normal: "Нормално",
  paid_not_taken: "Платена невзета",
  awaiting: "На изчакване",
};

export const orderLineStatusSchema = z
  .enum(ORDER_LINE_STATUSES)
  .default("normal");
