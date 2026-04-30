import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import type { Order } from "../types";
import {
  EcontShippingPicker,
  type EcontShippingValue,
} from "./EcontShippingPicker";

interface Props {
  order: Order;
  apiBaseUrl?: string;
  token: string;
  onOrderUpdated?: () => void;
}

async function apiPost<T>(
  baseUrl: string,
  token: string,
  path: string,
  body: unknown,
): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function apiPut<T>(
  baseUrl: string,
  token: string,
  path: string,
  body: unknown,
): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function apiGet<T>(
  baseUrl: string,
  token: string,
  path: string,
): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function buildInitialForm(order: Order): Partial<EcontShippingValue> {
  return {
    econt_delivery_type: order.econt_delivery_type ?? "office",
    econt_receiver_name: order.econt_receiver_name ?? "",
    econt_receiver_phone: order.econt_receiver_phone ?? "",
    econt_city: order.econt_city ?? "",
    econt_office_code: order.econt_office_code ?? undefined,
    econt_office_name: order.econt_office_name ?? undefined,
    econt_street: order.econt_street ?? undefined,
    econt_street_num: order.econt_street_num ?? undefined,
    econt_weight: order.econt_weight ?? 1,
    econt_cod_amount: order.econt_cod_amount ?? 0,
    econt_payer: order.econt_payer ?? "sender",
    econt_has_cod: (order.econt_cod_amount ?? 0) > 0,
    econt_shipment_description: order.econt_shipment_description ?? "",
    econt_shipment_date:
      order.econt_shipment_date ??
      (() => {
        const t = new Date();
        t.setDate(t.getDate() + 1);
        return t.toISOString().slice(0, 10);
      })(),
  };
}

export function EcontShipmentActions({
  order,
  apiBaseUrl = "/api",
  token,
  onOrderUpdated,
}: Props) {
  const qc = useQueryClient();
  const hasShipment = !!order.econt_shipment_number;
  const hasEcontData = !!order.econt_city;

  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState<Partial<EcontShippingValue>>(() =>
    buildInitialForm(order),
  );

  const orderTotal = Number(order.total_amount ?? 0);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiPut<{ id: number }>(apiBaseUrl, token, `/orders/${order.id}`, {
        econt_receiver_name: form.econt_receiver_name || null,
        econt_receiver_phone: form.econt_receiver_phone || null,
        econt_delivery_type: form.econt_delivery_type || null,
        econt_city: form.econt_city || null,
        econt_office_code: form.econt_office_code || null,
        econt_office_name: form.econt_office_name || null,
        econt_street: form.econt_street || null,
        econt_street_num: form.econt_street_num || null,
        econt_weight: form.econt_weight || null,
        econt_cod_amount: form.econt_has_cod ? form.econt_cod_amount || 0 : 0,
        econt_payer: form.econt_payer || "sender",
        econt_shipment_description: form.econt_shipment_description || null,
        econt_shipment_date: form.econt_shipment_date || null,
      }),
    onSuccess: () => {
      toast.success("Данните за Еконт са запазени");
      qc.invalidateQueries({ queryKey: ["orders"] });
      setIsEditing(false);
      onOrderUpdated?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiPost<{ shipmentNumber: string; pdfURL: string }>(
        apiBaseUrl,
        token,
        "/econt/create-shipment",
        {
          order_id: order.id,
          receiverName: order.econt_receiver_name,
          receiverPhone: order.econt_receiver_phone,
          receiverCity: order.econt_city,
          // Send EITHER office OR address — backend treats a truthy
          // receiverOfficeCode as "office delivery" regardless of street.
          // Use the order's stored delivery type (or fall back to "office"
          // if a code is present).
          ...(order.econt_delivery_type === "address"
            ? {
                receiverStreet: order.econt_street,
                receiverNum: order.econt_street_num,
              }
            : { receiverOfficeCode: order.econt_office_code }),
          weight: order.econt_weight || 1,
          codAmount: order.econt_cod_amount || undefined,
          servicesPayer:
            order.econt_payer === "receiver" ? "RECEIVER" : "SENDER",
          shipmentDescription: order.econt_shipment_description || undefined,
          shipmentDate: order.econt_shipment_date || undefined,
        },
      ),
    onSuccess: (data) => {
      toast.success(`Товарителница ${data.shipmentNumber} създадена`);
      qc.invalidateQueries({ queryKey: ["orders"] });
      onOrderUpdated?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: () =>
      apiPost<{ shipmentNumber: string }>(
        apiBaseUrl,
        token,
        "/econt/update-shipment",
        { order_id: order.id },
      ),
    onSuccess: (data) => {
      toast.success(`Товарителница обновена: ${data.shipmentNumber}`);
      qc.invalidateQueries({ queryKey: ["orders"] });
      onOrderUpdated?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const openPdf = async () => {
    if (order.econt_pdf_url) {
      window.open(order.econt_pdf_url, "_blank");
      return;
    }
    try {
      const r = await apiGet<{ pdfURL: string | null }>(
        apiBaseUrl,
        token,
        `/econt/label-pdf/${order.econt_shipment_number}`,
      );
      if (r.pdfURL) window.open(r.pdfURL, "_blank");
      else toast.error("PDF не е намерен");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const openTracking = () => {
    if (order.econt_tracking_url) {
      window.open(order.econt_tracking_url, "_blank");
    }
  };

  const startEdit = () => {
    setForm(buildInitialForm(order));
    setIsEditing(true);
  };

  const canCreate =
    hasEcontData &&
    !!order.econt_receiver_name &&
    !!order.econt_receiver_phone &&
    (order.econt_delivery_type === "address"
      ? !!order.econt_street
      : !!order.econt_office_code);

  if (isEditing) {
    return (
      <div className="border border-accent-light rounded-md p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-semibold text-sm">Редактиране на Еконт</div>
        </div>
        <EcontShippingPicker
          value={form}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          token={token}
          defaultOpen
          defaultCodAmount={orderTotal}
        />
        <div className="flex gap-2">
          <button
            type="button"
            className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-60"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? "Запазване…" : "Запази"}
          </button>
          <button
            type="button"
            className="px-3 py-1.5 border rounded text-sm"
            onClick={() => setIsEditing(false)}
            disabled={saveMutation.isPending}
          >
            Откажи
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-accent-light rounded-md p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-sm">Еконт товарителница</div>
        {hasShipment && (
          <code className="text-xs bg-white px-2 py-0.5 rounded">
            {order.econt_shipment_number}
          </code>
        )}
      </div>

      {hasEcontData && !hasShipment && (
        <div className="text-xs text-gray-600">
          {order.econt_receiver_name && (
            <div>
              <span className="font-medium">Получател:</span>{" "}
              {order.econt_receiver_name}
              {order.econt_receiver_phone
                ? ` · ${order.econt_receiver_phone}`
                : ""}
            </div>
          )}
          <div>
            <span className="font-medium">Доставка:</span> {order.econt_city}
            {order.econt_delivery_type === "office" && order.econt_office_name
              ? ` — ${order.econt_office_name}`
              : order.econt_delivery_type === "address" && order.econt_street
                ? ` — ${order.econt_street}${order.econt_street_num ? ` №${order.econt_street_num}` : ""}`
                : ""}
          </div>
          {order.econt_weight ? (
            <div>
              <span className="font-medium">Тегло:</span>{" "}
              {Number(order.econt_weight).toFixed(1)} кг
            </div>
          ) : null}
        </div>
      )}

      {!hasEcontData && !hasShipment && (
        <div className="text-xs text-gray-500">
          Няма въведени данни за Еконт доставка.
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        {!hasShipment && (
          <>
            <button
              type="button"
              className="px-3 py-1.5 border rounded text-sm flex items-center gap-1.5"
              onClick={startEdit}
            >
              <Pencil className="h-3.5 w-3.5" />
              {hasEcontData ? "Редактирай Еконт" : "Въведи Еконт данни"}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-60"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || !canCreate}
              title={
                !canCreate
                  ? "Попълни данните за Еконт преди създаване"
                  : undefined
              }
            >
              {createMutation.isPending ? "Създаване…" : "Създай товарителница"}
            </button>
          </>
        )}
        {hasShipment && (
          <>
            <button
              type="button"
              className="px-3 py-1.5 border rounded text-sm flex items-center gap-1.5"
              onClick={startEdit}
              title="Редактирай данните и натисни Актуализирай за да се обнови товарителницата в Еконт"
            >
              <Pencil className="h-3.5 w-3.5" />
              Редактирай
            </button>
            <button
              type="button"
              className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-60"
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending}
              title="Преиздай товарителницата в Еконт с актуалните данни от поръчката"
            >
              {updateMutation.isPending ? "Актуализиране…" : "Актуализирай"}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 border rounded text-sm"
              onClick={openPdf}
            >
              Отвори PDF
            </button>
            <button
              type="button"
              className="px-3 py-1.5 border rounded text-sm"
              onClick={openTracking}
            >
              Проследи
            </button>
          </>
        )}
      </div>
    </div>
  );
}
