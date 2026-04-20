import { useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";

interface City {
  id: number;
  name: string;
  nameEn: string;
  postCode: string;
}
interface Office {
  code: string;
  name: string;
  address: string;
  city: string;
}

export interface EcontShippingValue {
  econt_delivery_type: "office" | "address";
  econt_receiver_name: string;
  econt_receiver_phone: string;
  econt_city: string;
  econt_office_code?: string;
  econt_office_name?: string;
  econt_street?: string;
  econt_street_num?: string;
  econt_weight: number;
  econt_cod_amount?: number;
}

export interface EcontShippingPickerProps {
  value: Partial<EcontShippingValue>;
  onChange: (patch: Partial<EcontShippingValue>) => void;
  apiBaseUrl?: string;
  token: string;
}

function useDebouncedValue<T>(value: T, ms = 250): T {
  const [state, setState] = useState(value);
  useMemo(() => {
    const t = setTimeout(() => setState(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return state;
}

async function apiGet<T>(
  baseUrl: string,
  token: string,
  path: string,
): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
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
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export function EcontShippingPicker({
  value,
  onChange,
  apiBaseUrl = "/api",
  token,
}: EcontShippingPickerProps) {
  const deliveryType = value.econt_delivery_type || "office";
  const cityInput = value.econt_city ?? "";
  const debouncedCity = useDebouncedValue(cityInput);

  const citiesQuery = useQuery({
    queryKey: ["econt-cities", debouncedCity],
    queryFn: () =>
      apiGet<{ data: City[] }>(
        apiBaseUrl,
        token,
        `/econt/cities?q=${encodeURIComponent(debouncedCity)}`,
      ),
    enabled: debouncedCity.length >= 2,
    placeholderData: keepPreviousData,
  });

  const officesQuery = useQuery({
    queryKey: ["econt-offices", cityInput],
    queryFn: () =>
      apiGet<{ data: Office[] }>(
        apiBaseUrl,
        token,
        `/econt/offices?city=${encodeURIComponent(cityInput)}`,
      ),
    enabled: deliveryType === "office" && cityInput.length >= 2,
    placeholderData: keepPreviousData,
  });

  const weight = value.econt_weight ?? 1;
  const cod = value.econt_cod_amount ?? 0;
  const debouncedWeight = useDebouncedValue(weight);
  const debouncedCod = useDebouncedValue(cod);

  const priceQuery = useQuery({
    queryKey: [
      "econt-price",
      cityInput,
      value.econt_office_code,
      value.econt_street,
      debouncedWeight,
      debouncedCod,
    ],
    queryFn: () =>
      apiPost<{ price: number; priceBGN: number }>(
        apiBaseUrl,
        token,
        "/econt/calculate",
        {
          receiverCity: cityInput,
          receiverOfficeCode: value.econt_office_code,
          receiverStreet: value.econt_street,
          receiverNum: value.econt_street_num,
          weight: debouncedWeight,
          codAmount: debouncedCod || undefined,
        },
      ),
    enabled:
      cityInput.length >= 2 &&
      debouncedWeight > 0 &&
      (deliveryType === "office"
        ? !!value.econt_office_code
        : !!value.econt_street),
  });

  return (
    <div className="space-y-3 border border-accent-light rounded-md p-3 bg-accent-light/20">
      <div className="font-semibold text-sm">Еконт доставка</div>

      <div className="flex gap-2 text-sm">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={deliveryType === "office"}
            onChange={() => onChange({ econt_delivery_type: "office" })}
          />
          Офис
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={deliveryType === "address"}
            onChange={() => onChange({ econt_delivery_type: "address" })}
          />
          Адрес
        </label>
      </div>

      <input
        className="w-full border rounded px-2 py-1 text-sm"
        placeholder="Име на получател"
        value={value.econt_receiver_name ?? ""}
        onChange={(e) => onChange({ econt_receiver_name: e.target.value })}
      />
      <input
        className="w-full border rounded px-2 py-1 text-sm"
        placeholder="Телефон"
        value={value.econt_receiver_phone ?? ""}
        onChange={(e) => onChange({ econt_receiver_phone: e.target.value })}
      />

      <input
        className="w-full border rounded px-2 py-1 text-sm"
        placeholder="Град"
        value={cityInput}
        onChange={(e) => onChange({ econt_city: e.target.value })}
        list="econt-city-list"
      />
      <datalist id="econt-city-list">
        {(citiesQuery.data?.data || []).map((c) => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>

      {deliveryType === "office" ? (
        <select
          className="w-full border rounded px-2 py-1 text-sm"
          value={value.econt_office_code ?? ""}
          onChange={(e) => {
            const code = e.target.value;
            const office = (officesQuery.data?.data || []).find(
              (o) => o.code === code,
            );
            onChange({
              econt_office_code: code || undefined,
              econt_office_name: office?.name,
            });
          }}
        >
          <option value="">— изберете офис —</option>
          {(officesQuery.data?.data || []).map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
            </option>
          ))}
        </select>
      ) : (
        <div className="grid grid-cols-[3fr_1fr] gap-2">
          <input
            className="border rounded px-2 py-1 text-sm"
            placeholder="Улица"
            value={value.econt_street ?? ""}
            onChange={(e) => onChange({ econt_street: e.target.value })}
          />
          <input
            className="border rounded px-2 py-1 text-sm"
            placeholder="№"
            value={value.econt_street_num ?? ""}
            onChange={(e) => onChange({ econt_street_num: e.target.value })}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">
          Тегло (кг)
          <input
            type="number"
            min="0.1"
            step="0.1"
            className="w-full border rounded px-2 py-1 text-sm"
            value={value.econt_weight ?? ""}
            onChange={(e) =>
              onChange({ econt_weight: parseFloat(e.target.value) || 0 })
            }
          />
        </label>
        <label className="text-xs">
          Наложен платеж (€)
          <input
            type="number"
            min="0"
            step="0.01"
            className="w-full border rounded px-2 py-1 text-sm"
            value={value.econt_cod_amount ?? ""}
            onChange={(e) =>
              onChange({
                econt_cod_amount: parseFloat(e.target.value) || 0,
              })
            }
          />
        </label>
      </div>

      {priceQuery.isFetching && (
        <div className="text-xs text-muted-foreground">Калкулация…</div>
      )}
      {priceQuery.data && (
        <div className="text-sm font-semibold">
          Цена: {priceQuery.data.price.toFixed(2)} € (
          {priceQuery.data.priceBGN.toFixed(2)} лв.)
        </div>
      )}
      {priceQuery.error && (
        <div className="text-xs text-red-600">
          Грешка при калкулация: {(priceQuery.error as Error).message}
        </div>
      )}
    </div>
  );
}
