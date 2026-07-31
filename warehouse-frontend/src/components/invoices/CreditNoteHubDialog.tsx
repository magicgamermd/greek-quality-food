// Единен вход за кредитни известия (страница Фактури):
//   1) тип — за ПРОДАЖБА (ние издаваме на клиент) или за ПОКУПКА
//      (доставчикът ни издава по негова фактура);
//   2) партньор / доставчик;
//   3) от коя фактура;
//   4) на коя дата се издава;
//   5) редове (цялата фактура или избрани продукти / корекции).
//
// Продажба  → POST /invoices/credit-note (свой номер КИ-*, печат /invoices/:id/pdf)
// Покупка   → POST /incoming/:id/credit-note (номерът е на доставчика,
//             печат /incoming/:id/receipt)
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, FileText } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import type { Invoice } from "@/types";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Combobox } from "@/components/ui/combobox";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Kind = "sale" | "purchase";

type SaleItemRow = {
  order_item_id: number;
  name_bg: string | null;
  sku: string | null;
  unit: string | null;
  quantity: string;
  unit_price: string;
  // UI state
  checked: boolean;
  qty: string;
};

type PurchaseLineRow = {
  incoming_item_id: number;
  name: string;
  quantity: string;
  unit_price: string;
  new_unit_price: string;
  returned_quantity: string;
};

const todayISO = () => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
};

// Печат: blob → скрит iframe → print() (същият пайплайн като останалите
// печати в приложението; fallback — отваряне в нов таб).
async function printPdf(url: string) {
  const res = await api.get(url, { responseType: "blob" });
  const blob = new Blob([res.data], { type: "application/pdf" });
  const objectUrl = URL.createObjectURL(blob);
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.src = objectUrl;
  document.body.appendChild(iframe);
  iframe.onload = () => {
    try {
      iframe.contentWindow?.print();
    } catch {
      const link = document.createElement("a");
      link.href = objectUrl;
      link.target = "_blank";
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };
  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
    if (iframe.parentNode) document.body.removeChild(iframe);
  }, 60000);
}

export function CreditNoteHubDialog({
  open,
  onOpenChange,
  invoices,
  initialInvoice = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Списъкът от страницата — диалогът сам си филтрира издаваемите.
  invoices: Invoice[];
  // От бутона на ред фактура: отваря директно „за продажба" с предизбрана
  // фактура и частичен режим (тикчета по продукти).
  initialInvoice?: Invoice | null;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind | null>(null);

  // ── Общи полета ──────────────────────────────────────────────────
  const [issueDate, setIssueDate] = useState(todayISO());
  const [reason, setReason] = useState("");

  // ── Продажба ─────────────────────────────────────────────────────
  const [salePartnerId, setSalePartnerId] = useState("");
  const [saleInvoiceId, setSaleInvoiceId] = useState("");
  const [saleScope, setSaleScope] = useState<"full" | "partial">("full");
  const [saleItems, setSaleItems] = useState<SaleItemRow[]>([]);
  const [restoreStock, setRestoreStock] = useState(false);

  // ── Покупка ──────────────────────────────────────────────────────
  const [supplierId, setSupplierId] = useState("");
  const [purchaseDocId, setPurchaseDocId] = useState("");
  const [purchaseNumber, setPurchaseNumber] = useState("");
  const [purchaseLines, setPurchaseLines] = useState<PurchaseLineRow[]>([]);

  // Нулиране при всяко отваряне — старият избор не бива да „светне"
  // при следващото известие. При отваряне от ред фактура: направо
  // „за продажба" с предизбрана фактура и частичен режим (тикчета).
  useEffect(() => {
    if (!open) return;
    setKind(initialInvoice ? "sale" : null);
    setIssueDate(todayISO());
    setReason("");
    setSalePartnerId(initialInvoice ? String(initialInvoice.partner_id) : "");
    setSaleInvoiceId(initialInvoice ? String(initialInvoice.id) : "");
    setSaleScope(initialInvoice ? "partial" : "full");
    setSaleItems([]);
    setRestoreStock(false);
    setSupplierId("");
    setPurchaseDocId("");
    setPurchaseNumber("");
    setPurchaseLines([]);
  }, [open, initialInvoice]);

  // ── Продажба: избираеми фактури (активни, без вече издадено КИ) ──
  const eligibleSaleInvoices = useMemo(
    () =>
      invoices.filter(
        (inv) =>
          inv.document_type !== "credit_note" &&
          inv.document_type !== "proforma" &&
          inv.status !== "cancelled" &&
          !inv.credit_note_id,
      ),
    [invoices],
  );

  const salePartners = useMemo(() => {
    const seen = new Map<number, string>();
    for (const inv of eligibleSaleInvoices) {
      if (inv.partner_id && !seen.has(inv.partner_id)) {
        seen.set(
          inv.partner_id,
          inv.partner_name ?? `Партньор ${inv.partner_id}`,
        );
      }
    }
    return [...seen.entries()].map(([id, name]) => ({
      value: String(id),
      label: name,
    }));
  }, [eligibleSaleInvoices]);

  const partnerInvoices = useMemo(
    () =>
      eligibleSaleInvoices.filter(
        (inv) => String(inv.partner_id) === salePartnerId,
      ),
    [eligibleSaleInvoices, salePartnerId],
  );

  const selectedSaleInvoice = useMemo(
    () =>
      partnerInvoices.find((inv) => String(inv.id) === saleInvoiceId) ?? null,
    [partnerInvoices, saleInvoiceId],
  );

  // Редовете на избраната фактура (за частично КИ)
  const saleItemsQuery = useQuery({
    queryKey: ["invoice-items", saleInvoiceId],
    enabled:
      open && kind === "sale" && !!saleInvoiceId && saleScope === "partial",
    queryFn: async () => {
      const res = await api.get(`/invoices/${saleInvoiceId}/items`);
      return res.data as { order_id: number | null; data: any[] };
    },
  });

  useEffect(() => {
    const rows = saleItemsQuery.data?.data;
    if (!rows) return;
    setSaleItems(
      rows.map((r: any) => ({
        order_item_id: Number(r.order_item_id),
        name_bg: r.name_bg ?? null,
        sku: r.sku ?? null,
        unit: r.unit ?? null,
        quantity: String(r.quantity ?? ""),
        unit_price: String(r.unit_price ?? ""),
        checked: false,
        qty: String(r.quantity ?? ""),
      })),
    );
  }, [saleItemsQuery.data]);

  // ── Покупка: доставчици + потвърдени доставки ────────────────────
  const suppliersQuery = useQuery({
    queryKey: ["suppliers"],
    enabled: open && kind === "purchase",
    queryFn: async () => {
      const res = await api.get("/suppliers");
      return (res.data?.data ?? res.data) as { id: number; name: string }[];
    },
  });

  const purchaseDocsQuery = useQuery({
    queryKey: ["incoming-by-supplier", supplierId],
    enabled: open && kind === "purchase" && !!supplierId,
    queryFn: async () => {
      const res = await api.get(
        `/incoming?supplier_id=${supplierId}&status=confirmed&limit=100`,
      );
      return (res.data?.data ?? []) as {
        id: number;
        invoice_number: string | null;
        invoice_date: string | null;
        total_amount: string | null;
        document_type?: string | null;
      }[];
    },
  });

  // КИ документите също са в incoming_goods — не предлагаме КИ върху КИ.
  const purchaseDocs = useMemo(
    () =>
      (purchaseDocsQuery.data ?? []).filter(
        (d) => (d.document_type ?? "invoice") !== "credit_note",
      ),
    [purchaseDocsQuery.data],
  );

  const purchaseDetailQuery = useQuery({
    queryKey: ["incoming-detail", purchaseDocId],
    enabled: open && kind === "purchase" && !!purchaseDocId,
    queryFn: async () => {
      const res = await api.get(`/incoming/${purchaseDocId}`);
      return res.data as any;
    },
  });

  useEffect(() => {
    const detail = purchaseDetailQuery.data;
    if (!detail) return;
    const items = Array.isArray(detail.items) ? detail.items : [];
    setPurchaseLines(
      items.map((it: any) => ({
        incoming_item_id: Number(it.id),
        name:
          it.name_bg ??
          it.name_en ??
          it.product_name ??
          `Продукт ${it.product_id}`,
        quantity: String(it.quantity ?? ""),
        unit_price: String(it.unit_price ?? ""),
        new_unit_price: "",
        returned_quantity: "",
      })),
    );
  }, [purchaseDetailQuery.data]);

  // ── Издаване ─────────────────────────────────────────────────────
  const saleMutation = useMutation({
    mutationFn: async () => {
      if (!selectedSaleInvoice) throw new Error("Избери фактура.");
      if (!reason.trim()) throw new Error("Въведи причина за известието.");
      const payload: any = {
        related_invoice_id: selectedSaleInvoice.id,
        reason: reason.trim(),
        include_vat: selectedSaleInvoice.include_vat !== false,
        credit_note_date: issueDate || undefined,
        restore_stock: restoreStock,
      };
      if (saleScope === "partial") {
        const chosen = saleItems.filter((i) => i.checked && Number(i.qty) > 0);
        if (chosen.length === 0) {
          throw new Error("Избери поне един ред с количество.");
        }
        payload.items = chosen.map((i) => ({
          order_item_id: i.order_item_id,
          quantity: Number(i.qty),
        }));
      }
      const res = await api.post("/invoices/credit-note", payload);
      return res.data;
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      toast.success(
        `Кредитно известие ${data?.invoice_number ?? ""} е издадено`,
      );
      if (data?.id) void printPdf(`/invoices/${data.id}/pdf?t=${Date.now()}`);
      onOpenChange(false);
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          err?.message ??
          "Грешка при издаване на кредитно известие",
      ),
  });

  const purchaseMutation = useMutation({
    mutationFn: async () => {
      if (!purchaseDocId) throw new Error("Избери доставка/фактура.");
      if (!purchaseNumber.trim()) {
        throw new Error("Въведи номера на известието от доставчика.");
      }
      const items = purchaseLines
        .map((l) => {
          const newPrice = l.new_unit_price.trim();
          const retQty = l.returned_quantity.trim();
          if (newPrice !== "") {
            return {
              incoming_item_id: l.incoming_item_id,
              new_unit_price: Number(newPrice),
            };
          }
          if (retQty !== "") {
            return {
              incoming_item_id: l.incoming_item_id,
              returned_quantity: Number(retQty),
            };
          }
          return null;
        })
        .filter(Boolean);
      if (items.length === 0) {
        throw new Error(
          "Въведи нова цена или върнато количество поне на един ред.",
        );
      }
      const res = await api.post(`/incoming/${purchaseDocId}/credit-note`, {
        credit_note_number: purchaseNumber.trim(),
        credit_note_date: issueDate || undefined,
        reason: reason.trim() || undefined,
        items,
      });
      return res.data;
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["incoming"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success("Кредитното известие е заведено");
      if (data?.id) void printPdf(`/incoming/${data.id}/receipt`);
      onOpenChange(false);
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          err?.message ??
          "Грешка при завеждане на кредитно известие",
      ),
  });

  const busy = saleMutation.isPending || purchaseMutation.isPending;

  const canSubmit =
    kind === "sale"
      ? !!selectedSaleInvoice &&
        !!reason.trim() &&
        (saleScope === "full" ||
          saleItems.some((i) => i.checked && Number(i.qty) > 0))
      : kind === "purchase"
        ? !!purchaseDocId &&
          !!purchaseNumber.trim() &&
          purchaseLines.some(
            (l) =>
              l.new_unit_price.trim() !== "" ||
              l.returned_quantity.trim() !== "",
          )
        : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[95vw] lg:max-w-[1000px] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-amber-600" />
            Кредитно известие
          </DialogTitle>
          <DialogDescription>
            Избери вид, партньор и фактура — известието се издава с избраната
            дата.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          {/* Стъпка 1: вид */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setKind("sale")}
              className={`rounded-lg border p-4 text-left transition ${
                kind === "sale"
                  ? "border-[#6c3dff] bg-[#6c3dff]/5 ring-1 ring-[#6c3dff]"
                  : "hover:border-gray-400"
              }`}
            >
              <div className="flex items-center gap-2 font-medium">
                <ArrowUpFromLine className="h-4 w-4 text-[#6c3dff]" />
                За продажба
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Ние издаваме КИ на клиент по наша фактура (връщане или
                намаление).
              </div>
            </button>
            <button
              type="button"
              onClick={() => setKind("purchase")}
              className={`rounded-lg border p-4 text-left transition ${
                kind === "purchase"
                  ? "border-[#6c3dff] bg-[#6c3dff]/5 ring-1 ring-[#6c3dff]"
                  : "hover:border-gray-400"
              }`}
            >
              <div className="flex items-center gap-2 font-medium">
                <ArrowDownToLine className="h-4 w-4 text-amber-600" />
                За покупка
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Доставчик ни издава КИ по негова фактура (сгрешена цена или
                върната стока).
              </div>
            </button>
          </div>

          {/* Стъпка 2+: продажба */}
          {kind === "sale" && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label>Партньор</Label>
                  <Combobox
                    items={salePartners}
                    value={salePartnerId}
                    onChange={(v) => {
                      setSalePartnerId(v);
                      setSaleInvoiceId("");
                    }}
                    onClear={() => {
                      setSalePartnerId("");
                      setSaleInvoiceId("");
                    }}
                    placeholder="Избери партньор..."
                    emptyMessage="Няма фактури, по които може да се издаде КИ."
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Фактура</Label>
                  <Combobox
                    items={partnerInvoices.map((inv) => ({
                      value: String(inv.id),
                      label: `${inv.invoice_number} · ${formatDate(inv.invoice_date)} · ${formatCurrency(Number(inv.total_gross ?? 0))}`,
                    }))}
                    value={saleInvoiceId}
                    onChange={setSaleInvoiceId}
                    onClear={() => setSaleInvoiceId("")}
                    placeholder={
                      salePartnerId ? "Избери фактура..." : "Първо партньор"
                    }
                    emptyMessage="Партньорът няма активни фактури без КИ."
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Дата на издаване</Label>
                  <Input
                    type="date"
                    value={issueDate}
                    onChange={(e) => setIssueDate(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex items-center gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={saleScope === "full"}
                    onChange={() => setSaleScope("full")}
                  />
                  Цялата фактура
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={saleScope === "partial"}
                    onChange={() => setSaleScope("partial")}
                  />
                  Избрани продукти
                </label>
                <label className="flex items-center gap-2 ml-auto">
                  <input
                    type="checkbox"
                    checked={restoreStock}
                    onChange={(e) => setRestoreStock(e.target.checked)}
                  />
                  Върни стоката в склада
                </label>
              </div>

              {saleScope === "partial" && saleInvoiceId && (
                <div className="rounded-lg border overflow-hidden">
                  {saleItemsQuery.isLoading ? (
                    <div className="flex items-center justify-center py-6">
                      <Spinner size="sm" />
                    </div>
                  ) : saleItems.length === 0 ? (
                    <div className="p-4 text-sm text-gray-500">
                      Фактурата няма редове (няма свързана поръчка).
                    </div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-left text-xs text-gray-500">
                        <tr>
                          <th className="p-2 w-8"></th>
                          <th className="p-2">Продукт</th>
                          <th className="p-2 text-right">Фактурирано</th>
                          <th className="p-2 text-right">Ед. цена</th>
                          <th className="p-2 text-right w-32">
                            Количество в КИ
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {saleItems.map((item, idx) => (
                          <tr key={item.order_item_id} className="border-t">
                            <td className="p-2">
                              <input
                                type="checkbox"
                                checked={item.checked}
                                onChange={(e) =>
                                  setSaleItems((rows) =>
                                    rows.map((r, i) =>
                                      i === idx
                                        ? { ...r, checked: e.target.checked }
                                        : r,
                                    ),
                                  )
                                }
                              />
                            </td>
                            <td className="p-2">
                              <div className="font-medium">
                                {item.name_bg ?? "—"}
                              </div>
                              {item.sku && (
                                <div className="text-xs text-gray-400">
                                  {item.sku}
                                </div>
                              )}
                            </td>
                            <td className="p-2 text-right">
                              {item.quantity} {item.unit ?? ""}
                            </td>
                            <td className="p-2 text-right">
                              {formatCurrency(Number(item.unit_price))}
                            </td>
                            <td className="p-2">
                              <Input
                                type="number"
                                min="0"
                                max={item.quantity}
                                step="any"
                                value={item.qty}
                                disabled={!item.checked}
                                onChange={(e) =>
                                  setSaleItems((rows) =>
                                    rows.map((r, i) =>
                                      i === idx
                                        ? { ...r, qty: e.target.value }
                                        : r,
                                    ),
                                  )
                                }
                                className="text-right"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <Label>Причина</Label>
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="напр. Върната стока / търговска отстъпка"
                />
              </div>
            </div>
          )}

          {/* Стъпка 2+: покупка */}
          {kind === "purchase" && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label>Доставчик</Label>
                  <Combobox
                    items={(suppliersQuery.data ?? []).map((s) => ({
                      value: String(s.id),
                      label: s.name,
                    }))}
                    value={supplierId}
                    onChange={(v) => {
                      setSupplierId(v);
                      setPurchaseDocId("");
                    }}
                    onClear={() => {
                      setSupplierId("");
                      setPurchaseDocId("");
                    }}
                    placeholder="Избери доставчик..."
                    emptyMessage="Няма доставчици."
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Фактура / доставка</Label>
                  <Combobox
                    items={purchaseDocs.map((d) => ({
                      value: String(d.id),
                      label: `${d.invoice_number ?? `Доставка ${d.id}`} · ${
                        d.invoice_date ? formatDate(d.invoice_date) : "без дата"
                      }`,
                    }))}
                    value={purchaseDocId}
                    onChange={setPurchaseDocId}
                    onClear={() => setPurchaseDocId("")}
                    placeholder={
                      supplierId ? "Избери доставка..." : "Първо доставчик"
                    }
                    emptyMessage="Няма потвърдени доставки от този доставчик."
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Дата на издаване</Label>
                  <Input
                    type="date"
                    value={issueDate}
                    onChange={(e) => setIssueDate(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Номер на КИ (от доставчика)</Label>
                  <Input
                    value={purchaseNumber}
                    onChange={(e) => setPurchaseNumber(e.target.value)}
                    placeholder="номерът от документа на доставчика"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Причина</Label>
                  <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="напр. Сгрешена цена по фактура"
                  />
                </div>
              </div>

              {purchaseDocId && (
                <div className="rounded-lg border overflow-hidden">
                  {purchaseDetailQuery.isLoading ? (
                    <div className="flex items-center justify-center py-6">
                      <Spinner size="sm" />
                    </div>
                  ) : purchaseLines.length === 0 ? (
                    <div className="p-4 text-sm text-gray-500">
                      Доставката няма редове.
                    </div>
                  ) : (
                    <>
                      <div className="p-2 text-xs text-gray-500 bg-gray-50 border-b">
                        На всеки ред попълни ЛИБО нова цена (ценова корекция —
                        стоката остава), ЛИБО върнато количество (стоката се
                        връща на доставчика). Празните редове не влизат в
                        известието.
                      </div>
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs text-gray-500">
                          <tr>
                            <th className="p-2">Продукт</th>
                            <th className="p-2 text-right">К-во</th>
                            <th className="p-2 text-right">Ед. цена</th>
                            <th className="p-2 text-right w-32">Нова цена</th>
                            <th className="p-2 text-right w-32">
                              Върнато к-во
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {purchaseLines.map((line, idx) => (
                            <tr
                              key={line.incoming_item_id}
                              className="border-t"
                            >
                              <td className="p-2">{line.name}</td>
                              <td className="p-2 text-right">
                                {line.quantity}
                              </td>
                              <td className="p-2 text-right">
                                {formatCurrency(Number(line.unit_price))}
                              </td>
                              <td className="p-2">
                                <Input
                                  type="number"
                                  min="0"
                                  step="0.001"
                                  value={line.new_unit_price}
                                  disabled={
                                    line.returned_quantity.trim() !== ""
                                  }
                                  onChange={(e) =>
                                    setPurchaseLines((rows) =>
                                      rows.map((r, i) =>
                                        i === idx
                                          ? {
                                              ...r,
                                              new_unit_price: e.target.value,
                                            }
                                          : r,
                                      ),
                                    )
                                  }
                                  className="text-right"
                                />
                              </td>
                              <td className="p-2">
                                <Input
                                  type="number"
                                  min="0"
                                  max={line.quantity}
                                  step="any"
                                  value={line.returned_quantity}
                                  disabled={line.new_unit_price.trim() !== ""}
                                  onChange={(e) =>
                                    setPurchaseLines((rows) =>
                                      rows.map((r, i) =>
                                        i === idx
                                          ? {
                                              ...r,
                                              returned_quantity: e.target.value,
                                            }
                                          : r,
                                      ),
                                    )
                                  }
                                  className="text-right"
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Откажи
          </Button>
          <Button
            onClick={() =>
              kind === "sale"
                ? saleMutation.mutate()
                : purchaseMutation.mutate()
            }
            disabled={!canSubmit || busy}
          >
            {busy ? <Spinner size="sm" /> : null}
            Издай известието
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
