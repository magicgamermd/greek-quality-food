import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Order } from "../types";

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

export function EcontShipmentActions({
  order,
  apiBaseUrl = "/api",
  token,
  onOrderUpdated,
}: Props) {
  const qc = useQueryClient();
  const hasShipment = !!order.econt_shipment_number;

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
          receiverOfficeCode: order.econt_office_code,
          receiverStreet: order.econt_street,
          receiverNum: order.econt_street_num,
          weight: order.econt_weight || 1,
          codAmount: order.econt_cod_amount || undefined,
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

  if (!order.econt_city) {
    return null;
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
      <div className="flex gap-2 flex-wrap">
        {!hasShipment && (
          <button
            type="button"
            className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-60"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "Създаване…" : "Създай товарителница"}
          </button>
        )}
        {hasShipment && (
          <>
            <button
              type="button"
              className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-60"
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending}
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
