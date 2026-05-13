import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface AppSettings {
  company_name?: string;
  // Integration master switch (мигр. 081)
  econt_enabled?: boolean;
  // Document toggles (мигр. 082)
  warranty_enabled?: boolean;
  acceptance_protocol_enabled?: boolean;
  replacement_enabled?: boolean;
  commercial_doc_enabled?: boolean;
  // Fiscal + display
  fiscal_enabled?: boolean;
  show_bgn_on_invoice?: boolean;
  zebra_printer_name?: string;
}

/**
 * Кешира /settings отговора във всички компоненти. Ползва се за
 * master switch-овете върнати в Settings → Интеграции/Документи:
 *   - econtEnabled              → крие Econt UI навсякъде
 *   - warrantyEnabled           → крие "Гаранция" бутон в Orders
 *   - acceptanceProtocolEnabled → крие "Приемо-предавателен" бутон
 *   - replacementEnabled        → крие "Замяна" toggle + "Замени" филтър
 *   - commercialDocEnabled      → крие "Търговски документ" бутон
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
    warrantyEnabled: data?.warranty_enabled !== false,
    acceptanceProtocolEnabled: data?.acceptance_protocol_enabled !== false,
    replacementEnabled: data?.replacement_enabled !== false,
    commercialDocEnabled: data?.commercial_doc_enabled !== false,
  };
}
