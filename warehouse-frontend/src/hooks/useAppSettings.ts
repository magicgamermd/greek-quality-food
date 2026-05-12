import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface AppSettings {
  company_name?: string;
  econt_enabled?: boolean;
  fiscal_enabled?: boolean;
  show_bgn_on_invoice?: boolean;
  zebra_printer_name?: string;
}

/**
 * Кешира /settings отговора във всички компоненти. Ползва се главно
 * за master switch-ове като econt_enabled (мигр. 081) — когато
 * админът изключи Еконт в Настройки, всички EcontShippingPicker и
 * EcontShipmentActions се скриват автоматично.
 *
 * Default-ите матчват backend поведението (truthy по подразбиране).
 */
export function useAppSettings() {
  const { data } = useQuery<AppSettings>({
    queryKey: ["settings"],
    queryFn: () => api.get("/settings").then((r) => r.data ?? {}),
    staleTime: 60_000,
  });
  return {
    settings: data ?? {},
    econtEnabled: data?.econt_enabled !== false,
  };
}
