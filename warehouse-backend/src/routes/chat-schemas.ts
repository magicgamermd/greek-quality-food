import { z } from "zod";

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});

export const ChatRequestSchema = z.object({
  message: z.string().min(1),
  history: z.array(ChatMessageSchema).max(20).optional().default([]),
  system_context: z.string().max(8000).optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ToolArgsSearchProducts = z.object({
  query: z.string().min(1),
});
export const ToolArgsGetOrder = z.object({ id: z.number().int().positive() });
export const ToolArgsListOrders = z.object({
  status: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
});
export const ToolArgsCancelOrder = z.object({
  id: z.number().int().positive(),
  reason: z.string().optional(),
});
export const ToolArgsGenerateInvoice = z.object({
  order_id: z.number().int().positive(),
  include_vat: z.boolean().optional().default(true),
});
export const ToolArgsSendInvoiceEmail = z.object({
  invoice_id: z.number().int().positive(),
  to_email: z.string().email(),
});
export const ToolArgsCreateEcontShipment = z.object({
  order_id: z.number().int().positive(),
});
export const ToolArgsTrackShipment = z.object({
  shipment_number: z.string().min(1),
});

export const TOOL_NAMES = [
  "search_products",
  "get_order",
  "list_orders",
  "cancel_order",
  "generate_invoice",
  "send_invoice_email",
  "get_inventory_report",
  "create_econt_shipment",
  "track_shipment",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
