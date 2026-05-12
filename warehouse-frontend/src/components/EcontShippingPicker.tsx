import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Truck, ChevronDown, ChevronUp } from "lucide-react";
import { WorkingDayPicker } from "@/components/ui/WorkingDayPicker";
import { useAppSettings } from "@/hooks/useAppSettings";

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
  /**
   * Auto-filled from the Econt city catalogue (`getCities.postCode`)
   * the moment the picked city name matches an entry. Per Econt API
   * docs the `city.postCode` field is required when creating a label,
   * so the picker keeps it in sync with the selected city instead of
   * asking the cashier to type it manually.
   */
  econt_post_code?: string;
  econt_office_code?: string;
  econt_office_name?: string;
  econt_street?: string;
  econt_street_num?: string;
  econt_weight: number;
  econt_cod_amount?: number;
  econt_payer?: "sender" | "receiver";
  econt_has_cod?: boolean;
  /** Free-text — what's inside the parcel. Required by Econt. */
  econt_shipment_description?: string;
  /** ISO date YYYY-MM-DD. Required by Econt for address delivery; default = tomorrow. */
  econt_shipment_date?: string;
}

export interface EcontShippingPickerProps {
  value: Partial<EcontShippingValue>;
  onChange: (patch: Partial<EcontShippingValue>) => void;
  apiBaseUrl?: string;
  token: string;
  defaultOpen?: boolean;
  defaultCodAmount?: number;
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
  defaultOpen = true,
  defaultCodAmount,
}: EcontShippingPickerProps) {
  // Master switch: ако админът е изключил Еконт в Настройки → не
  // рендерираме picker-а изобщо (мигр. 081). Запазваме hook order
  // консистентен — useAppSettings първи, после early return.
  const { econtEnabled } = useAppSettings();
  if (!econtEnabled) return null;
  const [open, setOpen] = useState(defaultOpen);
  const deliveryType = value.econt_delivery_type || "office";
  const cityInput = value.econt_city ?? "";
  const debouncedCity = useDebouncedValue(cityInput);
  const payer = value.econt_payer || "sender";
  const hasCod = value.econt_has_cod ?? (value.econt_cod_amount || 0) > 0;

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

  // Resolve city ID + postCode by exact name match. ID drives street
  // autocomplete; postCode is a required Econt label field that we
  // auto-fill so the cashier doesn't have to look it up manually.
  const cityMatch = useMemo(() => {
    const list = citiesQuery.data?.data || [];
    return (
      list.find((c) => c.name === cityInput || c.nameEn === cityInput) ?? null
    );
  }, [citiesQuery.data, cityInput]);
  const cityId = cityMatch?.id ?? null;
  const cityPostCode = cityMatch?.postCode ?? "";

  // Mirror the matched postCode onto the form value so it travels with
  // /econt/calculate, /econt/shipment, and the order's persisted Econt
  // payload. Guarded with a ref because some parents don't memoize the
  // onChange prop AND don't propagate `econt_post_code` back into the
  // `value` prop — without the ref both conditions in the deps array
  // (`value.econt_post_code !== cityPostCode` stays true forever; new
  // `onChange` identity each render re-runs the effect) would loop.
  const syncedPostCodeRef = useRef<string>("");
  useEffect(() => {
    if (!cityPostCode) return;
    const key = `${cityInput}|${cityPostCode}`;
    if (syncedPostCodeRef.current === key) return;
    if (value.econt_post_code === cityPostCode) {
      syncedPostCodeRef.current = key;
      return;
    }
    syncedPostCodeRef.current = key;
    onChange({ econt_post_code: cityPostCode });
  }, [cityPostCode, cityInput, value.econt_post_code, onChange]);

  const streetInput = value.econt_street ?? "";
  const debouncedStreet = useDebouncedValue(streetInput);
  const streetsQuery = useQuery({
    queryKey: ["econt-streets", cityId, debouncedStreet],
    queryFn: () =>
      apiGet<{ data: { id: number; name: string; nameEn?: string }[] }>(
        apiBaseUrl,
        token,
        `/econt/streets?city_id=${cityId}&q=${encodeURIComponent(debouncedStreet)}`,
      ),
    enabled:
      deliveryType === "address" &&
      cityId !== null &&
      debouncedStreet.length >= 1,
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

  const senderInfoQuery = useQuery({
    queryKey: ["econt-sender-info"],
    queryFn: () =>
      apiGet<{
        city: string | null;
        street?: string | null;
        num?: string | null;
      }>(apiBaseUrl, token, "/econt/sender-info"),
    staleTime: 5 * 60 * 1000,
  });

  const priceQuery = useQuery({
    queryKey: [
      "econt-price",
      cityInput,
      deliveryType,
      value.econt_office_code,
      value.econt_street,
      value.econt_street_num,
      debouncedWeight,
      debouncedCod,
      payer,
    ],
    queryFn: () =>
      apiPost<{ price: number; priceBGN: number }>(
        apiBaseUrl,
        token,
        "/econt/calculate",
        {
          receiverCity: cityInput,
          // Per Econt API docs, `city.postCode` is a required field on
          // the receiver block — passed through here so the calculator
          // doesn't fall back to a different city with the same name.
          receiverPostCode: cityPostCode || undefined,
          // Send EITHER office OR address — never both. The backend treats a
          // truthy receiverOfficeCode as "office delivery" regardless of any
          // street fields, so leftover office_code from a previous picker
          // state would mask the address selection.
          ...(deliveryType === "office"
            ? { receiverOfficeCode: value.econt_office_code }
            : {
                receiverStreet: value.econt_street,
                receiverNum: value.econt_street_num,
              }),
          weight: debouncedWeight,
          codAmount: hasCod ? debouncedCod || undefined : undefined,
          servicesPayer: payer === "sender" ? "SENDER" : "RECEIVER",
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
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden border-l-4 border-l-[#6c3dff]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Truck className="h-5 w-5 text-[#6c3dff]" />
          <span className="font-medium text-gray-900">Доставка с Еконт</span>
        </div>
        {open ? (
          <ChevronUp className="h-5 w-5 text-gray-400" />
        ) : (
          <ChevronDown className="h-5 w-5 text-gray-400" />
        )}
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-4">
          {/* Row 1: Получател / Телефон */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Получател
              </label>
              <input
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6c3dff] focus:border-transparent"
                placeholder="Име на получател"
                value={value.econt_receiver_name ?? ""}
                onChange={(e) =>
                  onChange({ econt_receiver_name: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Телефон
              </label>
              <input
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6c3dff] focus:border-transparent"
                placeholder="0888 123 456"
                value={value.econt_receiver_phone ?? ""}
                onChange={(e) =>
                  onChange({ econt_receiver_phone: e.target.value })
                }
              />
            </div>
          </div>

          {/* Row 2: Тип доставка / Град */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Тип доставка
              </label>
              <select
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6c3dff] focus:border-transparent"
                value={deliveryType}
                onChange={(e) => {
                  const next = e.target.value as "office" | "address";
                  // Clear the other mode's fields so a stale office_code
                  // doesn't sneak past the address-mode UI and back into
                  // the calculate / create-shipment payload.
                  onChange(
                    next === "office"
                      ? {
                          econt_delivery_type: "office",
                          econt_street: undefined,
                          econt_street_num: undefined,
                        }
                      : {
                          econt_delivery_type: "address",
                          econt_office_code: undefined,
                          econt_office_name: undefined,
                        },
                  );
                }}
              >
                <option value="office">До офис на Еконт</option>
                <option value="address">До адрес</option>
              </select>
            </div>
            <div className="grid grid-cols-[1fr_110px] gap-2">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Град
                </label>
                <input
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6c3dff] focus:border-transparent"
                  placeholder="Започнете да пишете..."
                  value={cityInput}
                  onChange={(e) => {
                    // Reset post code when the city text is edited;
                    // the auto-fill effect re-applies it once the new
                    // input matches a known city. Without this reset
                    // the previously matched postCode would briefly
                    // travel with a half-typed wrong city.
                    onChange({
                      econt_city: e.target.value,
                      econt_post_code: undefined,
                    });
                  }}
                  list="econt-city-list"
                />
                <datalist id="econt-city-list">
                  {(citiesQuery.data?.data || []).map((c) => (
                    <option key={c.id} value={c.name}>
                      {c.postCode ? `${c.postCode}` : ""}
                    </option>
                  ))}
                </datalist>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Пощ. код
                </label>
                <input
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700"
                  placeholder="—"
                  value={value.econt_post_code ?? ""}
                  readOnly
                  title="Авто-попълва се при избор на град от списъка"
                />
              </div>
            </div>
          </div>

          {/* Row 3: Офис или Адрес */}
          {deliveryType === "office" ? (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Офис на Еконт
              </label>
              <select
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6c3dff] focus:border-transparent disabled:bg-gray-50 disabled:text-gray-400"
                value={value.econt_office_code ?? ""}
                disabled={!cityInput}
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
                <option value="">
                  {cityInput ? "— изберете офис —" : "Първо изберете град"}
                </option>
                {(officesQuery.data?.data || []).map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[3fr_1fr] gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Улица
                  </label>
                  <input
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6c3dff] focus:border-transparent"
                    placeholder={
                      cityId
                        ? "Започни да пишеш — Еконт ще предложи улици"
                        : "Първо избери град от списъка"
                    }
                    value={value.econt_street ?? ""}
                    onChange={(e) => onChange({ econt_street: e.target.value })}
                    list="econt-street-list"
                    autoComplete="off"
                  />
                  <datalist id="econt-street-list">
                    {(streetsQuery.data?.data || []).map((s) => (
                      <option key={s.id} value={s.name} />
                    ))}
                  </datalist>
                  {!cityId && cityInput && (
                    <p className="text-[11px] text-amber-600 mt-1">
                      ⚠ Избери град от автокомплит-списъка, за да тръгне
                      auto-complete на улиците
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    №
                  </label>
                  <input
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6c3dff] focus:border-transparent"
                    placeholder="№"
                    value={value.econt_street_num ?? ""}
                    onChange={(e) =>
                      onChange({ econt_street_num: e.target.value })
                    }
                  />
                </div>
              </div>
              {/* Date picker — Econt requires this for address delivery.
                  Custom WorkingDayPicker greys out weekends, BG holidays
                  and Econt-rejected dates for the chosen route. */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Дата на доставка *
                </label>
                <WorkingDayPicker
                  value={
                    value.econt_shipment_date ??
                    (() => {
                      const t = new Date();
                      t.setDate(t.getDate() + 1);
                      const y = t.getFullYear();
                      const m = String(t.getMonth() + 1).padStart(2, "0");
                      const d = String(t.getDate()).padStart(2, "0");
                      return `${y}-${m}-${d}`;
                    })()
                  }
                  onChange={(iso) => onChange({ econt_shipment_date: iso })}
                  apiBaseUrl={apiBaseUrl}
                  token={token}
                  econtRoute={
                    cityInput && (debouncedWeight ?? 0) > 0
                      ? {
                          receiverCity: cityInput,
                          receiverStreet: value.econt_street,
                          receiverNum: value.econt_street_num,
                          weight: debouncedWeight,
                        }
                      : null
                  }
                />
                <p className="text-[11px] text-gray-500 mt-1">
                  Сивите дни са почивни (събота / неделя / празник) или отказани
                  от Еконт за този маршрут. По подразбиране — утрешен ден.
                </p>
              </div>
            </>
          )}

          {/* Row 4: Тежест / Доставка за сметка на */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Тежест (кг)
              </label>
              <input
                type="number"
                min="0.1"
                step="0.1"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6c3dff] focus:border-transparent"
                placeholder="0.0"
                value={value.econt_weight ?? ""}
                onChange={(e) =>
                  onChange({ econt_weight: parseFloat(e.target.value) || 0 })
                }
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Доставка за сметка на:
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onChange({ econt_payer: "sender" })}
                  className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                    payer === "sender"
                      ? "bg-[#6c3dff] border-[#6c3dff] text-white"
                      : "bg-white border-gray-300 text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  <span>💳</span>
                  <span>Подател (ние)</span>
                </button>
                <button
                  type="button"
                  onClick={() => onChange({ econt_payer: "receiver" })}
                  className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                    payer === "receiver"
                      ? "bg-[#6c3dff] border-[#6c3dff] text-white"
                      : "bg-white border-gray-300 text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  <span>🏪</span>
                  <span>Получател (клиент)</span>
                </button>
              </div>
            </div>
          </div>

          {/* Row 4.5: Съдържание на пратката (Econt задължително) */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Съдържание на пратката *
            </label>
            <input
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6c3dff] focus:border-transparent"
              placeholder="напр. Кухненско оборудване, хардуерни артикули, мрежи..."
              value={value.econt_shipment_description ?? ""}
              onChange={(e) =>
                onChange({ econt_shipment_description: e.target.value })
              }
            />
            <p className="text-[11px] text-gray-500 mt-1">
              Описание какво е в кутията — Еконт изисква това поле.
            </p>
          </div>

          {/* Row 5: Наложен платеж */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hasCod}
                onChange={(e) => {
                  const checked = e.target.checked;
                  const existing = value.econt_cod_amount ?? 0;
                  onChange({
                    econt_has_cod: checked,
                    econt_cod_amount: checked
                      ? existing > 0
                        ? existing
                        : (defaultCodAmount ?? 0)
                      : 0,
                  });
                }}
                className="h-4 w-4 rounded border-gray-300 text-[#6c3dff] focus:ring-[#6c3dff]"
              />
              <span className="text-sm font-medium text-gray-700">
                Наложен платеж
              </span>
            </label>
            {hasCod && (
              <div className="mt-2">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6c3dff] focus:border-transparent"
                  placeholder="Сума (€)"
                  value={value.econt_cod_amount ?? ""}
                  onChange={(e) =>
                    onChange({
                      econt_cod_amount: parseFloat(e.target.value) || 0,
                    })
                  }
                />
              </div>
            )}
          </div>

          {/* Калкулация */}
          {priceQuery.isFetching && (
            <div className="text-xs text-gray-500">Калкулация…</div>
          )}
          {priceQuery.data && !priceQuery.isFetching && (
            <div className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 text-sm">
              <div className="flex items-center gap-2 font-semibold text-[#6c3dff] mb-1">
                <Truck className="h-4 w-4" />
                Доставка с Еконт
              </div>
              <div className="text-xs text-violet-900/80 leading-relaxed">
                {senderInfoQuery.data?.city && (
                  <>
                    {senderInfoQuery.data.city}
                    <span className="mx-1">→</span>
                  </>
                )}
                <span className="font-medium">{cityInput}</span>
                {deliveryType === "office" && value.econt_office_name && (
                  <>
                    <span className="mx-1">—</span>
                    {value.econt_office_name}
                  </>
                )}
                {deliveryType === "address" && value.econt_street && (
                  <>
                    <span className="mx-1">—</span>
                    {value.econt_street}
                    {value.econt_street_num
                      ? ` №${value.econt_street_num}`
                      : ""}
                  </>
                )}
              </div>
              <div className="text-xs text-violet-900/80">
                Тегло: {Number(weight).toFixed(1)} кг
              </div>
              <div className="text-base font-bold text-gray-900 mt-2">
                Цена доставка: {priceQuery.data.price.toFixed(2)} €
              </div>
              {hasCod && Number(cod) > 0 && (
                <div className="text-sm text-red-600 mt-1">
                  Наложен платеж: {Number(cod).toFixed(2)} EUR
                </div>
              )}
            </div>
          )}
          {priceQuery.error && (
            <div className="text-xs text-red-600">
              Грешка при калкулация: {(priceQuery.error as Error).message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
