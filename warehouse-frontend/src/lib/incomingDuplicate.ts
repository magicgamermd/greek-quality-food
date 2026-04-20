export interface DuplicateInvoiceInfo {
  duplicate: boolean;
  existing_id?: number;
  status?: string;
  created_at?: string;
}

export function formatDuplicateInvoiceStatus(status?: string) {
  if (status === "confirmed") return "✅ Потвърдена";
  if (status === "cancelled") return "❌ Отказана";
  if (status === "pending") return "⏳ Чакаща";
  return "ℹ️ Неизвестен";
}

export function formatDuplicateInvoiceStatusLabel(status?: string) {
  if (status === "pending") return "чакаща";
  if (status === "confirmed") return "потвърдена";
  if (status === "cancelled") return "отказана";
  return status || "неизвестен";
}

export function formatDuplicateInvoiceDate(createdAt?: string) {
  return createdAt
    ? new Date(createdAt).toLocaleDateString("bg-BG")
    : "неизвестна дата";
}

export function buildDuplicateInvoiceConfirmMessage(
  invoiceNumber: string,
  duplicateInfo: DuplicateInvoiceInfo,
) {
  return `⚠️ Дублирана фактура\n\nФактура ${invoiceNumber} вече е вкарана.\nДата: ${formatDuplicateInvoiceDate(duplicateInfo.created_at)}\nСтатус: ${formatDuplicateInvoiceStatus(duplicateInfo.status)}\n\nИскате ли да сканирате отново?`;
}

export function buildDuplicateInvoiceCancelledMessage(invoiceNumber: string) {
  return `Сканирането е прекратено: фактура ${invoiceNumber} вече съществува.`;
}
